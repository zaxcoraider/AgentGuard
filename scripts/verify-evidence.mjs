#!/usr/bin/env node
// Re-checks AgentGuard's evidence against NEAR testnet itself. Read-only, no keys, no dependencies.
//
//   node scripts/verify-evidence.mjs                       # check everything (~3 minutes, public RPC)
//   node scripts/verify-evidence.mjs --json evidence.json  # also write every result as JSON
//   node scripts/verify-evidence.mjs --all-stress-tx       # also re-read all 240 stress txs (slow: ~6 min)
//
// 1. Every transaction linked in docs/TESTNET-RESULTS.md exists and is final. Where a row states an
//    outcome (paid / pending / blocked and a reason), it must match the vault's own on-chain event.
// 2. All 240 stress-test requests (docs/stress-run.json) are compared with the stress vault's own
//    on-chain records (its contract state), and a sample of their transactions (always including every
//    paid one) is re-read to tie records to transactions. Every "paid" must be a real transfer to an
//    allowlisted, unflagged account.
// 3. Live state: vault code hashes, no full-access keys, Sentinel's vault locked with one limited key.
//
// Exit code 0 only if every check passes.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
// Regular RPC nodes forget transactions after ~2 days, so transactions are read from archival
// nodes. Both public ones are used side by side, each at the pace it accepts.
const ARCHIVAL = (process.env.NEAR_ARCHIVAL_RPC_URLS ?? "https://archival-rpc.testnet.fastnear.com,https://archival-rpc.testnet.near.org")
  .split(",").map((url) => ({ url: url.trim(), gap: url.includes("fastnear") ? 1000 : 300, next: 0 }));
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
const allStressTx = process.argv.includes("--all-stress-tx");
const STRESS_SAMPLE = 16;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = last + 250 - Date.now(); // stay under public RPC rate limits
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = await res.json();
      if (body.error && /rate|429|too many/i.test(JSON.stringify(body.error))) throw new Error("rate limited");
      if (body.error) return { error: body.error };
      return { result: body.result };
    } catch (e) {
      await sleep(1000 * 2 ** Math.min(attempt, 4));
    }
  }
  return { error: { message: "RPC unreachable or rate limited after retries" } };
}

// One archival request: take the endpoint with the earliest free slot, back off on rate limits.
async function archival(method, params) {
  let lastError = { message: "archival RPC unreachable or rate limited after retries" };
  for (let attempt = 0; attempt < 20; attempt++) {
    const ep = ARCHIVAL.reduce((a, b) => (a.next <= b.next ? a : b));
    const at = Math.max(Date.now(), ep.next);
    ep.next = at + ep.gap;
    if (at > Date.now()) await sleep(at - Date.now());
    try {
      const res = await fetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) throw new Error("rate limited");
      const body = await res.json();
      if (body.error && /rate|429|too many/i.test(JSON.stringify(body.error))) throw new Error("rate limited");
      if (body.error) { lastError = body.error; if (attempt < 1) continue; return { error: body.error }; } // one retry elsewhere
      return { result: body.result };
    } catch {
      ep.next = Date.now() + ep.gap * 3 * 2 ** Math.min(attempt, 4); // rest this endpoint, the other one takes over
    }
  }
  return { error: lastError };
}

// Read many transactions in parallel (each endpoint still keeps its own pace), cached for the checks.
const txCache = new Map();
async function prefetch(hashes, label) {
  const queue = [...new Set(hashes)].filter((h) => !txCache.has(h));
  let done = 0;
  await Promise.all(Array.from({ length: 1 }, async () => {
    while (queue.length) {
      const h = queue.shift();
      txCache.set(h, await readTx(h));
      if (++done % 25 === 0) console.log(`  ... ${label}: ${done}/${done + queue.length} read`);
    }
  }));
}

const view = async (account_id, method_name, args = {}) => {
  const { result, error } = await rpc("query", {
    request_type: "call_function", finality: "final", account_id, method_name,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (error) throw new Error(`${account_id}.${method_name}: ${JSON.stringify(error).slice(0, 200)}`);
  return JSON.parse(Buffer.from(result.result).toString());
};
const query = async (request_type, account_id) => {
  const { result, error } = await rpc("query", { request_type, finality: "final", account_id });
  if (error) throw new Error(`${request_type} ${account_id}: ${JSON.stringify(error).slice(0, 200)}`);
  return result;
};

// ---- one transaction: does it exist, did it succeed, what did the vault decide ----
async function inspectTx(hash) {
  if (!txCache.has(hash)) txCache.set(hash, await readTx(hash));
  return txCache.get(hash);
}
async function readTx(hash) {
  const { result, error } = await archival("EXPERIMENTAL_tx_status", {
    tx_hash: hash, sender_account_id: "agentguard.testnet", wait_until: "NONE",
  });
  if (error || !result?.transaction) return { hash, found: false, error: JSON.stringify(error).slice(0, 200) };
  const outcomes = new Map(result.receipts_outcome.map((o) => [o.id, o.outcome]));
  const events = [];
  for (const o of result.receipts_outcome)
    for (const log of o.outcome.logs)
      if (log.startsWith("EVENT_JSON:")) {
        try {
          const e = JSON.parse(log.slice(11));
          if (e.standard === "agentguard") events.push({ ...e, executor: o.outcome.executor_id });
        } catch {}
      }
  // Real NEAR transfers made by contracts (gas refunds come from "system" and are skipped).
  const transfers = [];
  for (const r of result.receipts ?? []) {
    if (r.predecessor_id === "system") continue;
    for (const a of r.receipt?.Action?.actions ?? [])
      if (a.Transfer) {
        const st = outcomes.get(r.receipt_id)?.status ?? {};
        transfers.push({ from: r.predecessor_id, to: r.receiver_id, amount: a.Transfer.deposit, ok: !("Failure" in st) });
      }
  }
  const pay = events.find((e) => /^payment_(paid|pending|blocked)$/.test(e.event));
  const decision = pay
    ? { vault: pay.executor, status: pay.event.slice(8), reason: pay.data.reason ?? null, recipient: pay.data.recipient, amount: pay.data.amount, id: pay.data.id }
    : null;
  const failedTransfer = events.some((e) => e.event === "payment_resolved" && e.data.status === "failed");
  return {
    hash, found: true, final: result.final_execution_status, signer: result.transaction.signer_id,
    receiver: result.transaction.receiver_id, success: !("Failure" in (result.status ?? {})),
    events: events.map((e) => e.event), decision, transfers, failedTransfer,
  };
}

const results = { rpc: RPC, archival: ARCHIVAL.map((e) => e.url), checked_at: new Date().toISOString(), docs: [], stress: null, live: [] };
let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  ok    ${msg}`);

// ---- 1. TESTNET-RESULTS.md ----
console.log(`Checking against ${RPC} (state) and ${ARCHIVAL.map((e) => e.url).join(" + ")} (transactions)\n\n1. Every transaction linked in docs/TESTNET-RESULTS.md`);
const doc = readFileSync(join(ROOT, "docs/TESTNET-RESULTS.md"), "utf8").split("\n");
await prefetch([...doc.join("\n").matchAll(/nearblocks\.io\/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})/g)].map((m) => m[1]), "transactions");
let section = "";
const statusWords = { paid: /\bpaid\b/i, pending: /\b(pending|held)\b/i, blocked: /\bblocked\b/i };
const seen = new Set();
let docTx = 0, docClaims = 0;
for (const line of doc) {
  if (line.startsWith("## ")) section = line.slice(3).trim();
  const hashes = [...line.matchAll(/nearblocks\.io\/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})/g)].map((m) => m[1]);
  for (const hash of hashes) {
    if (seen.has(`${section}/${hash}`)) continue;
    seen.add(`${section}/${hash}`);
    docTx++;
    const tx = await inspectTx(hash);
    const entry = { section, hash, ...tx, claim_checked: false };
    results.docs.push(entry);
    const short = `§${section.split(".")[0]} ${hash.slice(0, 4)}…`;
    if (!tx.found) { fail(`${short} not found on-chain (${tx.error})`); continue; }
    if (tx.final !== "FINAL") { fail(`${short} not final (${tx.final})`); continue; }
    // A row with one tx that states an outcome: the vault's event must say the same.
    const statesOutcome = /\*\*(paid|pending|blocked)\*\*|\bheld\b|`[a-z_]+`/.test(line);
    if (tx.decision && hashes.length <= 4 && statesOutcome) {
      const d = tx.decision;
      const okStatus = statusWords[d.status].test(line);
      const okReason = !d.reason || line.includes(d.reason);
      entry.claim_checked = true;
      docClaims++;
      if (!okStatus || !okReason) { fail(`${short} doc row disagrees with chain: chain says ${d.status}${d.reason ? ` (${d.reason})` : ""}`); continue; }
      if (d.status === "paid" && !tx.transfers.some((t) => t.from === d.vault && t.to === d.recipient && t.amount === d.amount && t.ok))
        { fail(`${short} says paid but no matching transfer in the tx`); continue; }
      pass(`${short} ${d.vault} -> ${d.status}${d.reason ? ` ${d.reason}` : ""}, as the doc says`);
    } else if (!tx.success) {
      fail(`${short} transaction failed`);
    } else {
      pass(`${short} exists, final${tx.events.length ? ` (${[...new Set(tx.events)].join(", ")})` : ""}`);
    }
  }
}
console.log(`  -> ${docTx} transactions, ${docClaims} stated outcomes compared with the chain`);

// ---- 2. Stress test ----
console.log("\n2. Stress test: all 240 outcomes vs the vault's own on-chain records, plus their transactions (docs/stress-run.json)");
const stress = JSON.parse(readFileSync(join(ROOT, "docs/stress-run.json"), "utf8"));
const vault = stress.summary.vault;
const allowlist = new Set(await view(vault, "get_allowlist"));
const registry = await view(vault, "get_registry");
const flaggedNow = new Set(registry ? await view(registry, "get_flagged", { limit: 500 }) : []);
// The vault's own record of every request it decided (contract state: no archival node needed).
const records = [];
for (let before; ; ) {
  const page = await view(vault, "get_history", before ? { before, limit: 100 } : { limit: 100 });
  records.push(...page);
  if (page.length < 100 || page.at(-1).id === "0") break;
  before = page.at(-1).id;
}
// records are newest first; a short trial run before the test used the same memo labels, so the
// newest record with each label is the one from the test itself.
const byMemo = new Map();
for (const p of records) {
  const n = /^stress #(\d+):/.exec(p.memo ?? "")?.[1];
  if (n !== undefined && !byMemo.has(n)) byMemo.set(n, p);
}
const toYocto = (n) => { const [w, f = ""] = n.split("."); return (BigInt(w) * 10n ** 24n + BigInt((f + "0".repeat(24)).slice(0, 24))).toString(); };
// A held request stays "pending" until the owner acts or it expires; both keep the reason.
const recordOutcome = (p) => (p.status === "paid" ? "paid" : `${["pending", "expired", "denied"].includes(p.status) ? "pending" : p.status}:${p.reason}`);
console.log(`  vault's own records: ${records.length} (ids ${records.at(-1)?.id}..${records[0]?.id})`);

// Transactions to re-read: every paid one, plus a random sample (or all, with --all-stress-tx).
const paidRows = stress.results.filter((r) => r.expected === "paid");
const others = stress.results.filter((r) => r.expected !== "paid").sort(() => Math.random() - 0.5);
const txRows = allStressTx ? stress.results : [...paidRows, ...others.slice(0, STRESS_SAMPLE)];
await prefetch(txRows.map((r) => r.tx.split("/").pop()), "stress transactions");
const sampled = new Set(txRows.map((r) => r.i));

const tally = {};
let matched = 0, paidBad = 0, notFound = 0, txChecked = 0;
const stressRows = [];
for (const r of stress.results) {
  const hash = r.tx.split("/").pop();
  const p = byMemo.get(String(r.i));
  const chain = p ? recordOutcome(p) : "no_record";
  if (!p) notFound++;
  tally[chain] = (tally[chain] ?? 0) + 1;
  let ok = chain === r.expected && p?.recipient === r.to && p?.amount === toYocto(r.amount_near);
  if (!ok) fail(`request ${r.i} (${r.kind}): expected ${r.expected}, vault's record says ${chain}`);
  if (sampled.has(r.i)) {
    // The transaction must carry the same decision as the record, for the same payment id.
    const tx = await inspectTx(hash);
    const d = tx.decision;
    const txOutcome = d ? `${d.status}${d.reason ? `:${d.reason}` : ""}` : tx.found ? "no_decision" : "not_found";
    txChecked++;
    if (!d || d.vault !== vault || d.id !== p?.id || txOutcome !== r.expected) {
      ok = false;
      fail(`request ${r.i}: tx ${hash.slice(0, 4)}… says ${txOutcome}${d ? ` (payment #${d.id})` : ""}, record #${p?.id} says ${chain}`);
    } else if (d.status === "paid" && !tx.transfers.some((t) => t.from === vault && t.to === d.recipient && t.amount === d.amount && t.ok)) {
      ok = false;
      fail(`request ${r.i}: tx says paid but has no matching transfer`);
    }
  }
  if (ok) matched++;
  if (p?.status === "paid" && (!allowlist.has(p.recipient) || flaggedNow.has(p.recipient))) {
    paidBad++;
    fail(`request ${r.i}: paid ${p.recipient}, which is not allowlisted or is flagged`);
  }
  stressRows.push({ i: r.i, kind: r.kind, expected: r.expected, chain, record_id: p?.id ?? null, tx: hash, tx_checked: sampled.has(r.i), ok });
}
// Every yoctoNEAR the vault ever paid is accounted for by its paid records.
const stats = await view(vault, "get_stats");
const paidSum = records.filter((p) => p.status === "paid" || p.status === "approved").reduce((a, p) => a + BigInt(p.amount), 0n);
(paidSum.toString() === stats.total_paid ? pass : fail)(`vault's total_paid ${stats.total_paid} = sum of its paid records`);
pass(`${txChecked} transactions re-read (all ${paidRows.length} paid + ${txChecked - paidRows.length} ${allStressTx ? "others" : "random"}): each matches its record`);
results.stress = { vault, allowlist: [...allowlist], requests: stress.results.length, matched, no_record: notFound, tx_checked: txChecked, paid_to_anyone_not_allowed: paidBad, outcomes: tally, rows: stressRows };
const same = JSON.stringify(Object.entries(tally).sort()) === JSON.stringify(Object.entries(stress.summary.outcomes).sort());
(matched === stress.results.length ? pass : fail)(`${matched}/${stress.results.length} match the expected outcome in the vault's own on-chain records`);
(paidBad === 0 ? pass : fail)(`paid to anyone not allowed: ${paidBad}`);
(same ? pass : fail)(`on-chain tally equals the published summary: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(", ")}`);

// ---- 3. Live state ----
console.log("\n3. Live state on testnet now");
const dep = JSON.parse(readFileSync(join(ROOT, "deployments/testnet.json"), "utf8"));
const codeHashes = { [dep.vault_code_v1.global_contract_hash]: "v1", [dep.vault_code.global_contract_hash]: "v2" };
const live = (name, ok, detail) => { results.live.push({ name, ok, detail }); (ok ? pass : fail)(`${name}: ${detail}`); };
for (const name of Object.keys(dep.vaults)) {
  try {
    const acct = await query("view_account", name);
    const keys = (await query("view_access_key_list", name)).keys;
    const full = keys.filter((k) => k.access_key.permission === "FullAccess").length;
    const limited = keys.every((k) => k.access_key.permission.FunctionCall?.receiver_id === name
      && JSON.stringify(k.access_key.permission.FunctionCall.method_names) === '["request_payment"]');
    const code = codeHashes[acct.global_contract_hash];
    live(name, !!code && full === 0 && limited,
      `code ${code ?? `UNKNOWN (${acct.global_contract_hash})`} by hash, ${keys.length} key(s), ${full} full-access, ${limited ? "all limited to request_payment" : "SOME KEY CAN DO MORE"}`);
  } catch (e) { live(name, false, e.message); }
}
try {
  const s = "sentinel.agentguard.testnet";
  const locked = await view(s, "is_locked");
  const al = await view(s, "get_allowlist");
  const keys = (await query("view_access_key_list", s)).keys;
  live("Sentinel's vault locked", locked === true, `is_locked = ${locked}`);
  live("Sentinel can only pay compute", JSON.stringify(al) === '["compute.agentguard.testnet"]', `allowlist ${JSON.stringify(al)}`);
  live("Sentinel has exactly one key", keys.length === 1, `${keys.length} key(s)`);
} catch (e) { live("Sentinel", false, e.message); }
try {
  const f = await query("view_account", dep.factory.account);
  live("Factory code", f.code_hash === dep.factory.code_sha256_base58, `code_hash ${f.code_hash}`);
  const evil = await view(dep.registry.account, "get_status", { account: dep.demo_accounts.attacker });
  live("Attacker flagged in the registry", JSON.stringify(evil).includes("flagged"), JSON.stringify(evil).slice(0, 120));
} catch (e) { live("Factory / registry", false, e.message); }

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify({ ...results, failures }, null, 1)); console.log(`Wrote ${jsonOut}`); }
process.exit(failures === 0 ? 0 : 1);
