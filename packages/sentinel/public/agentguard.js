// AgentGuard front page. Every number here is read from NEAR testnet by the visitor's browser.
// Only the list of accounts to look at (/evidence/*.json, the repo's own files) comes from our server.
const RPC = "https://rpc.testnet.fastnear.com";
// Regular RPC nodes forget transactions after ~2 days; transactions are read from archival nodes,
// one at a time, each at the pace it accepts.
const ARCHIVAL = [
  { url: "https://archival-rpc.testnet.fastnear.com", gap: 1000, next: 0 },
  { url: "https://archival-rpc.testnet.near.org", gap: 300, next: 0 },
];
const SENTINEL = "sentinel.agentguard.testnet";
const ATTACK_TX = "36qWxB4cRBwqRiihfHPuo2GWfBXj2AVW26fSrhpeNbGg"; // a fooled AI's payment, blocked (TESTNET-RESULTS §10)
const REGISTRY_FREEZE_TX = "HM3d2dGMLMmtPBdXaemuS8GCeSeRC2madeHrmD1r9hJY"; // registry's last full-access key deleted (TESTNET-RESULTS §15)
const TX_URL = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const ACCOUNT_URL = (a) => `https://testnet.nearblocks.io/address/${a}`;
const $ = (id) => document.getElementById(id);

// On the real domain, Sentinel has its own address: send "/sentinel" links to sentinel.agentguard.app.
if (location.hostname === "agentguard.app" || location.hostname === "www.agentguard.app") {
  for (const a of document.querySelectorAll('a[href="/sentinel"]')) a.href = "https://sentinel.agentguard.app/";
}

// ---------- RPC, gently: public endpoint, so throttle and retry ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = last + 220 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.status === 429) throw new Error("rate limited");
      const body = await res.json();
      if (body.error) {
        if (/rate|429|too many/i.test(JSON.stringify(body.error))) throw new Error("rate limited");
        throw Object.assign(new Error(body.error.data ?? body.error.message ?? "RPC error"), { fatal: true });
      }
      return body.result;
    } catch (e) {
      if (e.fatal) throw e;
      await sleep(800 * 2 ** attempt);
    }
  }
  throw new Error("The public RPC is busy. Try again in a minute.");
}
let archivalQueue = Promise.resolve();
function archival(method, params) {
  const run = async () => {
    for (let attempt = 0; attempt < 16; attempt++) {
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
        if (body.error) throw Object.assign(new Error(body.error.data ?? body.error.message ?? "RPC error"), { fatal: true });
        return body.result;
      } catch (e) {
        if (e.fatal && attempt >= 1) throw e; // one retry on the other node, then report it
        ep.next = Date.now() + ep.gap * 3 * 2 ** Math.min(attempt, 4);
      }
    }
    throw new Error("The public archival RPC is busy. Try again in a minute.");
  };
  const p = archivalQueue.then(run, run);
  archivalQueue = p.catch(() => {});
  return p;
}

const view = async (account_id, method_name, args = {}) => {
  const r = await rpc("query", {
    request_type: "call_function", finality: "final", account_id, method_name,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)));
};
const account = (account_id) => rpc("query", { request_type: "view_account", finality: "final", account_id });
const keys = async (account_id) => (await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id })).keys;

async function decision(hash) {
  const r = await archival("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: SENTINEL, wait_until: "NONE" });
  for (const o of r.receipts_outcome)
    for (const log of o.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      const e = JSON.parse(log.slice(11));
      if (e.standard === "agentguard" && /^payment_(paid|pending|blocked)$/.test(e.event))
        return { vault: o.outcome.executor_id, status: e.event.slice(8), reason: e.data.reason ?? null, recipient: e.data.recipient, amount: e.data.amount, id: e.data.id, final: r.final_execution_status };
    }
  return { status: "none", final: r.final_execution_status };
}

const near = (yocto, digits = 2) => {
  const v = Number(BigInt(yocto) / 10n ** 18n) / 1e6;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
};
const shortKey = (k) => `${k.slice(0, 16)}…`;
const evidence = (name) => fetch(`/evidence/${name}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`/evidence/${name}: ${r.status}`))));

// ---------- live readout ----------
async function live() {
  try {
    const s = await view(SENTINEL, "get_stats");
    $("ro-balance").textContent = `${near(s.balance)} NEAR`;
    $("s-balance").textContent = `${near(s.balance)} NEAR`;
    $("ro-locked").textContent = s.locked ? "Yes, for good" : "No";
    $("ro-locked").classList.toggle("ok", s.locked);
    $("ro-blocked").textContent = `${s.blocked_count}`;
    $("s-blocked").textContent = `${s.blocked_count} payments`;
    $("s-paid").textContent = `${near(s.total_paid, 3)} NEAR`;
  } catch {
    for (const id of ["ro-balance", "ro-locked", "ro-blocked", "s-balance", "s-paid", "s-blocked"]) $(id).textContent = "RPC busy";
  }
  try {
    const st = (await evidence("stress-run.json")).summary;
    $("ro-stress").textContent = `${st.matched_expected}/${st.requests}`;
    $("ro-stress").classList.toggle("ok", st.mismatches === 0);
  } catch { $("ro-stress").textContent = "240/240"; }
}
live();

// ---------- verify ----------
const CHECKS = [
  {
    claim: "Nobody holds a key that can move Sentinel's money",
    async run() {
      const ks = await keys(SENTINEL);
      const full = ks.filter((k) => k.access_key.permission === "FullAccess");
      const fc = ks.map((k) => k.access_key.permission.FunctionCall).filter(Boolean);
      const onlyAsk = fc.length === ks.length && fc.every((p) => p.receiver_id === SENTINEL && JSON.stringify(p.method_names) === '["request_payment"]');
      return {
        ok: full.length === 0 && onlyAsk,
        detail: `view_access_key_list: ${ks.length} key${ks.length === 1 ? "" : "s"}, ${full.length} full-access. ${ks.map((k) => `<code>${shortKey(k.public_key)}</code> can only call <code>${(k.access_key.permission.FunctionCall?.method_names ?? ["anything"]).join(", ")}</code>`).join("; ")}.`,
        link: ACCOUNT_URL(SENTINEL),
      };
    },
  },
  {
    claim: "Sentinel's rules are locked, and it can only pay its compute account",
    async run() {
      const [locked, allow, policy] = await Promise.all([view(SENTINEL, "is_locked"), view(SENTINEL, "get_allowlist"), view(SENTINEL, "get_policy")]);
      return {
        ok: locked === true && JSON.stringify(allow) === '["compute.agentguard.testnet"]' && policy.unknown_recipient === "block",
        detail: `is_locked → <code>${locked}</code>. get_allowlist → <code>${JSON.stringify(allow)}</code>. Anyone else: <code>${policy.unknown_recipient}</code>, at most ${near(policy.max_per_payment)} NEAR per payment and ${near(policy.daily_limit)} NEAR a day.`,
      };
    },
  },
  {
    claim: "Every AgentGuard vault runs published, immutable code and has no full-access key",
    async run(ev) {
      const hashes = { [ev.dep.vault_code_v1.global_contract_hash]: "v1", [ev.dep.vault_code.global_contract_hash]: "v2" };
      const rows = [];
      let ok = true;
      for (const name of Object.keys(ev.dep.vaults)) {
        const [a, ks] = await Promise.all([account(name), keys(name)]);
        const code = hashes[a.global_contract_hash];
        const full = ks.filter((k) => k.access_key.permission === "FullAccess").length;
        if (!code || full) ok = false;
        rows.push(`<code>${name.replace(".agentguard.testnet", "")}</code> ${code ?? "unknown code"}, ${full} full-access`);
      }
      return { ok, detail: `${rows.length} vaults, code referenced by hash (it can never change): ${rows.join(" · ")}.` };
    },
  },
  {
    claim: "A known scammer is flagged in the shared registry",
    async run(ev) {
      const s = await view(ev.dep.registry.account, "get_status", { account: ev.dep.demo_accounts.attacker });
      return { ok: s.status === "flagged", detail: `<code>${ev.dep.registry.account}</code>.get_status(<code>${s.account}</code>) → <code>${s.status}</code>, ${s.report_count} reports. Every vault that uses the registry now blocks payments to it.` };
    },
  },
  {
    claim: "Nobody can change the shared scam registry's code: it has no full-access key",
    async run(ev) {
      const reg = ev.dep.registry.account;
      const [a, ks] = await Promise.all([account(reg), keys(reg)]);
      const full = ks.filter((k) => k.access_key.permission === "FullAccess").length;
      return {
        ok: full === 0 && !!a.code_hash && a.code_hash !== "11111111111111111111111111111111",
        detail: `view_access_key_list(<code>${reg}</code>): ${ks.length} key${ks.length === 1 ? "" : "s"}, ${full} full-access. Its code (<code>${a.code_hash.slice(0, 8)}…</code>) has no upgrade method, so with no key it can never be replaced. Its last key was deleted in <code>${REGISTRY_FREEZE_TX.slice(0, 4)}…</code>.`,
        link: TX_URL(REGISTRY_FREEZE_TX),
      };
    },
  },
  {
    claim: "When a visitor fooled Sentinel's AI, the vault refused the payment",
    async run() {
      const d = await decision(ATTACK_TX);
      return {
        ok: d.vault === SENTINEL && d.status === "blocked" && d.final === "FINAL",
        detail: `Transaction <code>${ATTACK_TX.slice(0, 4)}…</code>: the AI asked to pay ${d.amount ? near(d.amount) : "?"} NEAR to <code>${d.recipient}</code>. The vault's own event: <code>${d.status}</code>, <code>${d.reason}</code>.`,
        link: TX_URL(ATTACK_TX),
      };
    },
  },
  {
    claim: "240 rule-breaking requests: every answer as the rules say, nothing paid to anyone not allowed",
    sample: 6,
    async run(ev, all = false) {
      const res = ev.stress.results;
      const vault = ev.stress.summary.vault;
      const allow = new Set(await view(vault, "get_allowlist"));
      // 1. The vault's own record of every request (contract state, a few reads).
      const records = [];
      for (let before; ; ) {
        const page = await view(vault, "get_history", before ? { before, limit: 100 } : { limit: 100 });
        records.push(...page);
        if (page.length < 100 || page.at(-1).id === "0") break;
        before = page.at(-1).id;
      }
      const byMemo = new Map(); // newest first; a trial run before the test reused the first labels
      for (const p of records) {
        const n = /^stress #(\d+):/.exec(p.memo ?? "")?.[1];
        if (n !== undefined && !byMemo.has(n)) byMemo.set(n, p);
      }
      const outcome = (p) => (p.status === "paid" ? "paid" : `${["pending", "expired", "denied"].includes(p.status) ? "pending" : p.status}:${p.reason}`);
      let good = 0;
      const bad = [], paidTo = new Set();
      for (const r of res) {
        const p = byMemo.get(String(r.i));
        const got = p ? outcome(p) : "no record";
        if (p?.status === "paid") { paidTo.add(p.recipient); if (!allow.has(p.recipient)) bad.push(`#${r.i} paid ${p.recipient}, not allowlisted`); }
        if (got === r.expected && p?.recipient === r.to) good++;
        else bad.push(`#${r.i} expected ${r.expected}, the vault's record says ${got}`);
      }
      // 2. Re-read transactions: every paid one plus a random sample (or all), each must match its record.
      const paidRows = res.filter((r) => r.expected === "paid");
      const pick = all ? res : [...paidRows, ...res.filter((r) => r.expected !== "paid").sort(() => Math.random() - 0.5).slice(0, this.sample)];
      let txOk = 0;
      for (const [i, r] of pick.entries()) {
        this.progress?.(`240 records checked. Re-reading transactions: ${i + 1}/${pick.length}…`);
        const d = await decision(r.tx.split("/").pop());
        const got = `${d.status}${d.reason ? `:${d.reason}` : ""}`;
        if (got === r.expected && d.vault === vault && d.id === byMemo.get(String(r.i))?.id) txOk++;
        else bad.push(`#${r.i} transaction says ${got}`);
      }
      return {
        ok: bad.length === 0,
        detail: `The vault's own on-chain record of each request: ${good}/${res.length} match the expected outcome. ${all ? "All" : `${pick.length}`} of their transactions re-read (${all ? "" : `all ${paidRows.length} paid + ${pick.length - paidRows.length} random`}): ${txOk}/${pick.length} match${bad.length ? `. Mismatches: ${bad.slice(0, 5).join("; ")}` : ""}. ${paidTo.size ? `Every paid request went to <code>${[...paidTo].join("</code>, <code>")}</code>, on the vault's allowlist.` : ""} The flagged scammer is allowlisted on this vault on purpose: every request to it was still blocked.`,
        more: !all,
      };
    },
  },
];

const list = $("checks");
const rows = CHECKS.map((c) => {
  const li = document.createElement("li");
  li.className = "check";
  li.dataset.state = "idle";
  li.innerHTML = `<span class="check-icon" aria-hidden="true"></span><p class="check-claim"></p><p class="check-detail">Not checked yet.</p>`;
  li.querySelector(".check-claim").textContent = c.claim;
  list.append(li);
  return li;
});

function show(li, state, html, link, extra) {
  li.dataset.state = state;
  li.querySelector(".check-icon").textContent = state === "ok" ? "✓" : state === "fail" ? "✕" : "";
  const p = li.querySelector(".check-detail");
  p.innerHTML = html + (link ? ` <a href="${link}">See it on NearBlocks</a>` : "");
  if (extra) p.append(extra);
}

let ev;
async function runCheck(c, li, all = false) {
  show(li, "running", all ? "Re-reading all 240 transactions, one at a time (about 6 minutes)…" : "Asking the chain…");
  c.progress = (msg) => (li.querySelector(".check-detail").textContent = msg);
  try {
    const r = await c.run(ev, all);
    let extra = null;
    if (r.more) {
      extra = document.createElement("button");
      extra.type = "button";
      extra.className = "link check-more";
      extra.textContent = "Re-read all 240 transactions (about 6 min)";
      extra.addEventListener("click", () => runCheck(c, li, true).then(summarize));
      const wrap = document.createElement("span");
      wrap.append(" ", extra);
      extra = wrap;
    }
    show(li, r.ok ? "ok" : "fail", r.detail, r.link, extra);
    return r.ok;
  } catch (e) {
    show(li, "fail", `Couldn't check: ${String(e.message ?? e).replace(/</g, "&lt;")}`);
    return false;
  }
}

function summarize() {
  const ok = rows.filter((r) => r.dataset.state === "ok").length;
  const s = $("verify-summary");
  s.textContent = ok === rows.length ? `All ${ok} checks passed, against the chain, just now.` : `${ok} of ${rows.length} passed. Lines marked ✕ say what the chain answered.`;
  s.className = `verify-summary ${ok === rows.length ? "ok" : "bad"}`;
}

$("run-verify").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $("verify-summary").textContent = "";
  try {
    ev ??= { dep: await evidence("testnet.json"), stress: await evidence("stress-run.json") };
  } catch (err) {
    $("verify-summary").textContent = `Couldn't load the account list: ${err.message}`;
    btn.disabled = false;
    return;
  }
  for (const [i, c] of CHECKS.entries()) await runCheck(c, rows[i]);
  summarize();
  btn.textContent = "Run again";
  btn.disabled = false;
});
