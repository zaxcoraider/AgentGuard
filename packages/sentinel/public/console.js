// AgentGuard Console: create a vault, set its rules, manage its agent keys and approve or deny
// held payments. Reads go straight to a NEAR RPC node; writes are signed by the user's wallet
// (NEAR Connect, vendored at a pinned version). Nothing here holds funds or keys on a server.
import { NearConnector } from "/vendor/near-connect-0.11.4.mjs";

const RPC = "https://rpc.testnet.fastnear.com";
const FACTORY = "agentguard.testnet";
const EXPLORER = "https://testnet.nearblocks.io";
const TGAS = 10n ** 12n;
const YOCTO = 10n ** 24n;
const $ = (id) => document.getElementById(id);

// On the real domain, Sentinel has its own address: send "/sentinel" links to sentinel.agentguard.app.
if (location.hostname === "agentguard.app" || location.hostname === "www.agentguard.app") {
  for (const a of document.querySelectorAll('a[href="/sentinel"]')) a.href = "https://sentinel.agentguard.app/";
}
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  n.append(...kids.filter((k) => k !== null && k !== undefined));
  return n;
};

// ---------- guilloche seal (same as the Sentinel page) ----------
document.querySelectorAll("[data-rosette]").forEach((g) => {
  for (let i = 0; i < 5; i++) {
    let d = "";
    for (let s = 0; s <= 360; s++) {
      const t = (s / 360) * Math.PI * 2;
      const r = 38 + 7 * Math.sin(12 * t + i * 0.55);
      d += `${s ? "L" : "M"}${(r * Math.cos(t)).toFixed(2)} ${(r * Math.sin(t)).toFixed(2)}`;
    }
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d + "Z");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.4");
    g.appendChild(p);
  }
});

// ---------- units ----------
function toYocto(near) {
  const s = String(near).trim();
  if (!/^\d+(\.\d{1,24})?$/.test(s)) throw new Error(`"${near}" is not a NEAR amount (use a number like 0.5)`);
  const [w, f = ""] = s.split(".");
  return BigInt(w) * YOCTO + BigInt(f.padEnd(24, "0"));
}
function toNear(yocto, digits = 4) {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

// ---------- reads (plain JSON-RPC) ----------
async function rpc(params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }) });
  const body = await res.json();
  if (body.error || body.result?.error) throw new Error(body.error?.cause?.name ?? body.result?.error ?? "RPC error");
  return body.result;
}
async function view(contract, method, args = {}) {
  const r = await rpc({ request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)) || "null");
}

// ---------- wallet ----------
// The library loads its wallet list from GitHub first and only falls back to its jsDelivr mirror
// on an error; a slow or hanging GitHub never errors, so the modal would never open. Use the mirror.
const MANIFEST = "https://cdn.jsdelivr.net/gh/azbang/hot-connector/repository/manifest.json";
const connector = new NearConnector({ network: "testnet", manifest: MANIFEST });
let wallet = null;
let me = "";

connector.on("wallet:signIn", (p) => {
  wallet = p.wallet;
  me = p.accounts?.[0]?.accountId ?? "";
  route();
});
connector.on("wallet:signOut", () => {
  wallet = null;
  me = "";
  route();
});

async function restore() {
  try {
    wallet = await connector.wallet();
    me = (await wallet.getAccounts())[0]?.accountId ?? "";
  } catch {
    wallet = null;
    me = "";
  }
}

async function connect() {
  const btns = [$("connect"), ...document.querySelectorAll("[data-connect]")];
  const labels = btns.map((b) => b.textContent);
  btns.forEach((b) => {
    b.disabled = true;
    b.textContent = "Loading wallets…";
  });
  try {
    // The wallet list is fetched from NEAR Connect's public manifest; it can take a few seconds.
    await connector.whenManifestLoaded;
    btns.forEach((b, i) => {
      b.disabled = false;
      b.textContent = labels[i];
    });
    wallet = await connector.connect();
    me = (await wallet.getAccounts())[0]?.accountId ?? "";
    route();
  } catch (e) {
    if (e?.message) toast(`Couldn't connect: ${e.message}`, true);
  } finally {
    btns.forEach((b, i) => {
      b.disabled = false;
      b.textContent = labels[i];
    });
  }
}
$("connect").addEventListener("click", connect);
document.querySelectorAll("[data-connect]").forEach((b) => b.addEventListener("click", connect));
$("disconnect").addEventListener("click", async () => {
  if (wallet) await connector.disconnect(wallet).catch(() => {});
  wallet = null;
  me = "";
  route();
});

/** Sign and send one function call; throws with the contract's own message on failure. */
async function call(receiverId, methodName, args, { deposit = 1n, gas = 30n } = {}) {
  if (!wallet) throw new Error("Connect your wallet first");
  const result = await wallet.signAndSendTransaction({
    receiverId,
    actions: [{ type: "FunctionCall", params: { methodName, args, gas: String(gas * TGAS), deposit: String(deposit) } }],
  });
  const failure = result?.status?.Failure ?? result?.receipts_outcome?.find((o) => o.outcome?.status?.Failure)?.outcome.status.Failure;
  if (failure) throw new Error(panicText(failure));
  return result?.transaction?.hash ?? result?.transaction_outcome?.id ?? "";
}
function panicText(f) {
  const s = JSON.stringify(f);
  const m = s.match(/Smart contract panicked: ([^"\\]+)/) ?? s.match(/"ExecutionError":"([^"]+)"/);
  return m ? m[1] : s.slice(0, 200);
}

// ---------- toast ----------
let toastTimer;
function toast(msg, isError = false, txHash = "") {
  const t = $("toast");
  t.replaceChildren(msg);
  if (txHash) t.append(" ", el("a", { href: `${EXPLORER}/txns/${txHash}`, target: "_blank", rel: "noopener" }, "View transaction"));
  t.classList.toggle("err", isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 9000 : 6000);
}

/** Run an action from a button or form: disable it, report the outcome, refresh. */
async function act(btn, label, fn, after) {
  if (btn) btn.disabled = true;
  try {
    const hash = await fn();
    toast(`${label}: done.`, false, hash);
    await after?.();
  } catch (e) {
    toast(`${label} failed: ${e?.message ?? e}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- routing ----------
function go(url) {
  history.pushState({}, "", url);
  route();
}
addEventListener("popstate", route);

function route() {
  $("connect").hidden = Boolean(me);
  $("who").hidden = !me;
  $("who-name").textContent = me;
  const vault = new URL(location.href).searchParams.get("vault");
  $("home").hidden = Boolean(vault);
  $("vault").hidden = !vault;
  if (vault) renderVault(vault);
  else renderHome();
}

// ---------- home ----------
$("lookup").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("lookup-input").value.trim().toLowerCase();
  if (!ACCOUNT_RE.test(v)) return toast("That isn't a NEAR account id.", true);
  go(`/console?vault=${encodeURIComponent(v)}`);
});
document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => go(`/console?vault=${b.dataset.open}`)));

async function renderHome() {
  $("signed-out-cta").hidden = Boolean(me);
  $("mine").hidden = !me;
  $("create").hidden = !me;
  if (!me) return;
  const list = $("vault-list");
  list.replaceChildren(el("li", { class: "empty" }, "Loading…"));
  try {
    const vaults = await view(FACTORY, "get_vaults_by_owner", { owner: me });
    list.replaceChildren(
      ...vaults.map((v) => {
        const a = el("a", { href: `/console?vault=${encodeURIComponent(v.vault)}` }, el("strong", {}, v.vault), el("span", { class: "meta" }, `created ${new Date(Number(BigInt(v.created_at) / 1_000_000n)).toLocaleDateString()}`));
        a.addEventListener("click", (e) => {
          e.preventDefault();
          go(a.getAttribute("href"));
        });
        return el("li", {}, a);
      }),
    );
    $("mine-empty").hidden = vaults.length > 0;
  } catch (e) {
    list.replaceChildren(el("li", { class: "empty" }, `Couldn't load your vaults: ${e.message}`));
  }
}

const createForm = $("create");
createForm.elements.name.addEventListener("input", (e) => ($("name-preview").textContent = e.target.value || "name"));

function policyFrom(f) {
  const ttl = Number(f.ttl_hours.value);
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 24 * 30) throw new Error("Expiry must be between 1 hour and 30 days");
  const policy = {
    max_per_payment: toYocto(f.max_per_payment.value).toString(),
    daily_limit: toYocto(f.daily_limit.value).toString(),
    approval_threshold: toYocto(f.approval_threshold.value).toString(),
    unknown_recipient: f.unknown.value,
    pending_ttl_ns: (BigInt(Math.round(ttl * 3600)) * 1_000_000_000n).toString(),
  };
  if (BigInt(policy.max_per_payment) > BigInt(policy.daily_limit)) throw new Error("The most per payment can't be more than the daily limit");
  return policy;
}

createForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = createForm.elements;
  const btn = createForm.querySelector("button[type=submit]");
  let name, policy, deposit, allowlist;
  try {
    name = f.name.value.trim();
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new Error("Name: 1–32 characters, a–z, 0–9, - and _");
    deposit = toYocto(f.deposit.value);
    if (deposit < YOCTO) throw new Error("Fund it with at least 1 NEAR");
    policy = policyFrom(f);
    allowlist = f.allowlist.value.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = allowlist.find((a) => !ACCOUNT_RE.test(a));
    if (bad) throw new Error(`"${bad}" isn't a NEAR account id`);
  } catch (err) {
    return toast(err.message, true);
  }
  const vault = `${name}.${FACTORY}`;
  act(btn, `Creating ${vault}`, async () => {
    const hash = await call(FACTORY, "create_vault", { name, policy, allowlist }, { deposit, gas: 150n });
    // The factory refunds the deposit if creation fails, so check the vault really exists.
    await view(vault, "get_owner").catch(() => {
      throw new Error("the vault wasn't created (the name may be taken); your deposit was refunded");
    });
    return hash;
  }, () => go(`/console?vault=${encodeURIComponent(vault)}`));
});

// ---------- vault ----------
let current = null;

async function renderVault(id) {
  $("v-name").textContent = id;
  $("v-meta").textContent = "Loading…";
  $("keybox").hidden = true;
  let d;
  try {
    const [owner, policy, allowlist, agents, stats, pending, historyRows, locked, registry] = await Promise.all([
      view(id, "get_owner"),
      view(id, "get_policy"),
      view(id, "get_allowlist"),
      view(id, "get_agents"),
      view(id, "get_stats"),
      view(id, "get_pending"),
      view(id, "get_history", { limit: 25 }),
      view(id, "is_locked").catch(() => false),
      view(id, "get_registry").catch(() => null),
    ]);
    d = { id, owner, policy, allowlist, agents, stats, pending, history: historyRows, locked, registry };
  } catch {
    $("v-meta").textContent = `${id} isn't an AgentGuard vault on testnet, or it couldn't be read.`;
    for (const x of ["v-balance", "v-available"]) $(x).textContent = "";
    return;
  }
  current = d;
  const mine = Boolean(me) && me === d.owner;

  // header
  $("v-meta").replaceChildren(
    ...[
    "Owner ",
    el("strong", {}, d.owner),
    d.locked ? el("span", { class: "badge badge-lock" }, "Rules locked") : null,
    d.stats.paused ? el("span", { class: "badge badge-pause" }, "Paused") : null,
    " · ",
    el("a", { href: `${EXPLORER}/address/${d.id}`, target: "_blank", rel: "noopener" }, "On NearBlocks"),
    ].filter(Boolean),
  );
  $("v-balance").textContent = toNear(d.stats.balance);
  $("v-available").textContent = toNear(d.stats.available);
  const banner = $("v-banner");
  banner.hidden = false;
  banner.textContent = d.locked
    ? "These rules are locked for good. Nobody, the owner included, can loosen them or take money out. Anyone can still add funds."
    : mine
      ? "You own this vault. Changes are signed by your wallet; each costs 1 yoctoNEAR plus gas."
      : me
        ? `Read-only: this vault belongs to ${d.owner}.`
        : "Read-only. Connect the owner's wallet to manage this vault.";

  document.querySelectorAll(".owner-only").forEach((n) => (n.hidden = !mine));
  document.querySelectorAll(".unlocked-only").forEach((n) => (n.hidden = d.locked));

  renderPending(d, mine);
  renderRules(d, mine);
  renderAllowlist(d, mine);
  renderAgents(d, mine);
  renderHistory(d);
  renderControls(d, mine);
}

const REASONS = {
  unknown_recipient: "not on the allowlist",
  over_approval_threshold: "above your approval threshold",
  repeat_payment: "same payment twice in 10 minutes",
  recipient_reported: "reported in the scam registry",
  flagged_for_review: "the agent asked you to review it",
  recipient_not_allowlisted: "not on the allowlist",
  over_per_payment_limit: "over the per-payment limit",
  over_daily_limit: "over the daily limit",
  recipient_flagged: "flagged in the scam registry",
  insufficient_funds: "not enough funds",
  registry_unavailable: "the scam registry didn't answer",
  vault_paused: "the vault was paused",
  cannot_pay_self: "the vault can't pay itself",
  too_many_pending: "too many payments waiting",
};
const why = (r) => (r ? REASONS[r] ?? r : "");
const when = (ns) => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function renderPending(d, mine) {
  const list = $("pending");
  list.replaceChildren(
    ...d.pending.map((p) => {
      const acts = el("div", { class: "acts" });
      if (mine && !d.locked) {
        const ok = el("button", { class: "btn btn-ink", type: "button" }, "Approve");
        ok.addEventListener("click", () => act(ok, `Approving payment #${p.id}`, () => call(d.id, "approve", { id: p.id }, { gas: 60n }), () => renderVault(d.id)));
        acts.append(ok);
      }
      if (mine) {
        const no = el("button", { class: "btn", type: "button" }, "Deny");
        no.addEventListener("click", () => act(no, `Denying payment #${p.id}`, () => call(d.id, "deny", { id: p.id }), () => renderVault(d.id)));
        acts.append(no);
      }
      return el("li", {}, el("span", { class: "amt" }, `${toNear(p.amount, 6)} NEAR to ${p.recipient}`), el("span", { class: "why" }, `Held: ${why(p.reason)}. Asked ${when(p.created_at)}${p.memo ? ` · "${p.memo}"` : ""}`), acts);
    }),
  );
  $("pending-empty").hidden = d.pending.length > 0;
}

function renderRules(d, mine) {
  const p = d.policy;
  const hours = Number(BigInt(p.pending_ttl_ns) / 3_600_000_000_000n);
  const rows = [
    ["Most per payment", `${toNear(p.max_per_payment)} NEAR`],
    ["Most per 24 hours", `${toNear(p.daily_limit)} NEAR`],
    ["Ask the owner above", `${toNear(p.approval_threshold)} NEAR`],
    ["Anyone not on the allowlist", p.unknown_recipient === "block" ? "Blocked" : "Held for the owner"],
    ["Held payments expire after", `${hours} h`],
    ["Scam registry", d.registry ?? "off"],
    ["Spent in the last 24 h", `${toNear(d.stats.spent_24h)} NEAR`],
  ];
  $("rules-view").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
  const f = $("rules-form");
  f.hidden = !mine || d.locked;
  if (!f.hidden) {
    f.elements.max_per_payment.value = toNear(p.max_per_payment, 24);
    f.elements.daily_limit.value = toNear(p.daily_limit, 24);
    f.elements.approval_threshold.value = toNear(p.approval_threshold, 24);
    f.elements.ttl_hours.value = String(hours);
    f.querySelector(`input[name=unknown][value=${p.unknown_recipient}]`).checked = true;
  }
}
$("rules-form").addEventListener("submit", (e) => {
  e.preventDefault();
  let policy;
  try {
    policy = policyFrom(e.target.elements);
  } catch (err) {
    return toast(err.message, true);
  }
  act(e.target.querySelector("button"), "Saving rules", () => call(current.id, "set_policy", { policy }), () => renderVault(current.id));
});

function renderAllowlist(d, mine) {
  $("allowlist").replaceChildren(
    ...d.allowlist.map((a) => {
      const li = el("li", {}, a);
      if (mine) {
        // Removing someone only makes the vault stricter, so it works even after locking.
        const x = el("button", { type: "button", "aria-label": `Remove ${a}` }, "×");
        x.addEventListener("click", () => act(x, `Removing ${a}`, () => call(d.id, "remove_from_allowlist", { accounts: [a] }), () => renderVault(d.id)));
        li.append(x);
      }
      return li;
    }),
  );
  $("allow-empty").hidden = d.allowlist.length > 0;
  $("allow-form").hidden = !mine || d.locked;
}
$("allow-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const a = e.target.elements.account.value.trim().toLowerCase();
  if (!ACCOUNT_RE.test(a)) return toast(`"${a}" isn't a NEAR account id`, true);
  act(e.target.querySelector("button"), `Adding ${a}`, () => call(current.id, "add_to_allowlist", { accounts: [a] }), () => {
    e.target.reset();
    return renderVault(current.id);
  });
});

function renderAgents(d, mine) {
  const active = d.agents.filter((a) => a.active);
  $("agents").replaceChildren(
    ...active.map((a) => {
      const li = el("li", {}, el("span", {}, el("strong", {}, a.label || "agent"), " ", el("code", {}, a.public_key)));
      if (mine) {
        const r = el("button", { class: "btn", type: "button" }, "Revoke");
        r.addEventListener("click", () => act(r, `Revoking ${a.label}`, () => call(d.id, "revoke_agent", { public_key: a.public_key }), () => renderVault(d.id)));
        li.append(r);
      }
      return li;
    }),
  );
  $("agents-empty").hidden = active.length > 0;
  $("agent-add").hidden = !mine || d.locked;
}

// Agent keys are made in the browser (WebCrypto Ed25519). The private key goes into a file the
// user downloads FIRST, then only the public key is sent to the vault. It never leaves the page.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = BigInt("0x" + ([...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

$("agent-new").addEventListener("click", async () => {
  const d = current;
  const label = $("agent-label").value.trim().slice(0, 64) || "agent";
  let keys;
  try {
    keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  } catch {
    return toast("This browser can't make Ed25519 keys. Use scripts/gen-agent-key.mjs from the repo instead.", true);
  }
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const seed = pkcs8.slice(-32);
  const publicKey = `ed25519:${base58(pub)}`;
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(pub, 32);
  const file = JSON.stringify({ account_id: d.id, public_key: publicKey, private_key: `ed25519:${base58(secret)}` }, null, 2);

  const box = $("keybox");
  const dl = $("key-download");
  dl.href = URL.createObjectURL(new Blob([file], { type: "application/json" }));
  dl.download = `${d.id}.json`;
  dl.textContent = "1. Download key file";
  $("mcp-cmd").textContent = [
    `mkdir -p ~/.near-credentials/testnet && mv ~/Downloads/${d.id}.json ~/.near-credentials/testnet/`,
    `git clone https://github.com/zaxcoraider/AgentGuard && cd AgentGuard/packages/mcp && npm install && npm run build`,
    `claude mcp add agentguard -e AGENTGUARD_VAULT=${d.id} -- node "$PWD/dist/index.js"`,
  ].join("\n");
  let add = box.querySelector("#key-add");
  add?.remove();
  add = el("button", { class: "btn", type: "button", id: "key-add", disabled: "" }, "2. Add this key to the vault");
  dl.after(" ", add);
  dl.addEventListener("click", () => add.removeAttribute("disabled"), { once: true });
  add.addEventListener("click", () =>
    act(add, `Adding agent key "${label}"`, () => call(d.id, "add_agent", { public_key: publicKey, label }), () => {
      add.remove();
      return renderVault(d.id).then(() => (box.hidden = false));
    }),
  );
  box.hidden = false;
});

function renderHistory(d) {
  $("history").replaceChildren(
    ...d.history.map((p) =>
      el(
        "tr",
        {},
        el("td", {}, String(p.id)),
        el("td", {}, p.recipient),
        el("td", {}, `${toNear(p.amount, 6)} NEAR`),
        el("td", {}, el("span", { class: `st st-${p.status}` }, p.status)),
        el("td", {}, why(p.reason)),
        el("td", {}, when(p.created_at)),
      ),
    ),
  );
  $("history-empty").hidden = d.history.length > 0;
}

function renderControls(d, mine) {
  $("danger").hidden = !mine;
  if (!mine) return;
  const paused = d.stats.paused;
  $("pause-title").textContent = paused ? "Resume" : "Pause";
  $("pause-hint").textContent = paused ? "The vault is paused: every payment request is blocked." : "While paused, every payment request is blocked.";
  $("pause-btn").textContent = paused ? "Resume the vault" : "Pause the vault";
}
$("pause-btn").addEventListener("click", (e) => {
  const paused = current.stats.paused;
  act(e.target, paused ? "Resuming" : "Pausing", () => call(current.id, "set_paused", { paused: !paused }), () => renderVault(current.id));
});
$("withdraw-form").addEventListener("submit", (e) => {
  e.preventDefault();
  let amount;
  try {
    amount = toYocto(e.target.elements.amount.value).toString();
  } catch (err) {
    return toast(err.message, true);
  }
  act(e.target.querySelector("button"), "Withdrawing", () => call(current.id, "withdraw", { amount }), () => {
    e.target.reset();
    return renderVault(current.id);
  });
});
$("lock-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (e.target.elements.confirm.value.trim() !== current.id) return toast(`Type ${current.id} exactly to confirm.`, true);
  act(e.target.querySelector("button"), "Locking the rules", () => call(current.id, "lock_rules", {}), () => renderVault(current.id));
});

// ---------- start ----------
// Render right away; restoring a wallet session waits for the wallet manifest, which can be slow.
route();
restore().then(() => me && route());
