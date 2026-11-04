#!/usr/bin/env node
// Re-checks AgentGuard's evidence against NEAR testnet itself. Read-only, no keys, no dependencies.
//
//   node scripts/verify-evidence.mjs                       # check everything (~2 minutes, public RPC)
//   node scripts/verify-evidence.mjs --json evidence.json  # also write every result as JSON
//
// 1. Every transaction linked in docs/TESTNET-RESULTS.md exists and is final. Where a row states an
//    outcome (paid / pending / blocked and a reason), it must match the vault's own on-chain event.
// 2. All 240 stress-test requests (docs/stress-run.json) are re-derived from the chain and compared
//    with the expected outcome. Every "paid" must be a real transfer to an allowlisted, unflagged account.
// 3. Live state: vault code hashes, no full-access keys, Sentinel's vault locked with one limited key.
//
// Exit code 0 only if every check passes.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

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
  const { result, error } = await rpc("EXPERIMENTAL_tx_status", {
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

const results = { rpc: RPC, checked_at: new Date().toISOString(), docs: [], stress: null, live: [] };
let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  ok    ${msg}`);

// ---- 1. TESTNET-RESULTS.md ----
console.log(`Checking against ${RPC}\n\n1. Every transaction linked in docs/TESTNET-RESULTS.md`);
const doc = readFileSync(join(ROOT, "docs/TESTNET-RESULTS.md"), "utf8").split("\n");
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
console.log("\n2. Stress test: re-deriving all 240 outcomes from the chain (docs/stress-run.json)");
const stress = JSON.parse(readFileSync(join(ROOT, "docs/stress-run.json"), "utf8"));
const vault = stress.summary.vault;
const allowlist = new Set(await view(vault, "get_allowlist"));
const registry = await view(vault, "get_registry");
const flaggedNow = new Set(registry ? await view(registry, "get_flagged", { limit: 500 }) : []);
const tally = {};
let matched = 0, paidBad = 0, notFound = 0;
const stressRows = [];
for (const r of stress.results) {
  const hash = r.tx.split("/").pop();
  const tx = await inspectTx(hash);
  const d = tx.decision;
  const chain = d ? `${d.status}${d.reason ? `:${d.reason}` : ""}` : tx.found ? "no_decision" : "not_found";
  if (!tx.found) notFound++;
  tally[chain] = (tally[chain] ?? 0) + 1;
  const ok = chain === r.expected && d?.vault === vault && d?.recipient === r.to;
  if (ok) matched++;
  else fail(`request ${r.i} (${r.kind}): expected ${r.expected}, chain says ${chain}`);
  if (d?.status === "paid") {
    const transferred = tx.transfers.some((t) => t.from === vault && t.to === d.recipient && t.amount === d.amount && t.ok);
    if (!allowlist.has(d.recipient) || flaggedNow.has(d.recipient) || !transferred) {
      paidBad++;
      fail(`request ${r.i}: paid ${d.recipient}, which is not an allowlisted, unflagged, real transfer`);
    }
  }
  stressRows.push({ i: r.i, kind: r.kind, expected: r.expected, chain, ok, tx: hash });
  if ((r.i + 1) % 40 === 0) console.log(`  ... ${r.i + 1}/${stress.results.length}`);
}
results.stress = { vault, allowlist: [...allowlist], requests: stress.results.length, matched, not_found: notFound, paid_to_anyone_not_allowed: paidBad, outcomes: tally, rows: stressRows };
const same = JSON.stringify(Object.entries(tally).sort()) === JSON.stringify(Object.entries(stress.summary.outcomes).sort());
(matched === stress.results.length ? pass : fail)(`${matched}/${stress.results.length} match the expected outcome on-chain`);
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
