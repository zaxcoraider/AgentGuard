// Sentinel's page. No framework. All visitor text is inserted with textContent, never as HTML.
const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- guilloche: rings of phase-shifted waves, like the security print on a cheque ----------
function band(g, { R, a, n, count, phase, width, cls }) {
  for (let i = 0; i < count; i++) {
    let d = "";
    const steps = 720;
    for (let s = 0; s <= steps; s++) {
      const t = (s / steps) * Math.PI * 2;
      const r = R + a * Math.sin(n * t + i * phase);
      d += `${s ? "L" : "M"}${(r * Math.cos(t)).toFixed(2)} ${(r * Math.sin(t)).toFixed(2)}`;
    }
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d + "Z");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", String(width));
    if (cls) p.setAttribute("class", cls);
    g.appendChild(p);
  }
}

function rosette(g, size) {
  if (size === "small") {
    band(g, { R: 38, a: 7, n: 12, count: 5, phase: 0.55, width: 1.4 });
    return;
  }
  band(g, { R: 146, a: 7, n: 48, count: 8, phase: 0.4, width: 0.6, cls: "ring-outer" });
  band(g, { R: 118, a: 15, n: 24, count: 12, phase: 0.27, width: 0.55 });
  band(g, { R: 88, a: 11, n: 16, count: 9, phase: 0.36, width: 0.5 });
}
document.querySelectorAll("[data-rosette]").forEach((g) => rosette(g, g.dataset.rosette));

// ---------- helpers ----------
const fmtNear = (n, digits = 4) => {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: v < 10 ? 2 : 0 }) : "–";
};

function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const REASONS = {
  recipient_not_allowlisted: "Not on the vault's list of accounts it may pay.",
  over_per_payment_limit: "More than the vault allows in one payment.",
  over_daily_limit: "Would go over the vault's daily limit.",
  recipient_flagged: "The account is flagged in the shared scam registry.",
  recipient_reported: "The account was reported in the shared scam registry.",
  insufficient_funds: "The vault doesn't have that much to spend.",
  registry_unavailable: "The scam registry didn't answer, so the vault said no.",
  vault_paused: "The vault is paused.",
  cannot_pay_self: "The vault can't pay itself.",
  unknown_recipient: "An unknown account: the owner has to approve it.",
  over_approval_threshold: "Large enough that the owner has to approve it.",
  repeat_payment: "Same payment twice in 10 minutes: the owner has to approve it.",
  too_many_pending: "Too many payments are already waiting for the owner.",
};
const reasonText = (r) => (r ? REASONS[r] ?? r : "");

const STAMP = { blocked: "Blocked by contract", pending: "Held for owner", paid: "Paid within rules", error: "Didn't reach the vault" };

async function getJSON(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
  return body;
}

// ---------- status ----------
let lastBeat = null;
async function refreshStatus() {
  let s;
  try {
    s = await getJSON("/api/status");
  } catch {
    $("pulse-line").textContent = "Can't reach Sentinel right now. Retrying.";
    return;
  }
  $("balance").textContent = fmtNear(s.treasury.balance_near);
  $("offline-banner").hidden = !s.offline;
  if (s.explorer) $("vault-link").href = s.explorer;
  else $("vault-link").hidden = true;

  const line = $("pulse-line");
  line.replaceChildren();
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.setAttribute("aria-hidden", "true");
  line.append(dot, s.alive
    ? s.last_heartbeat
      ? `Alive. Last heartbeat ${ago(s.last_heartbeat)}, one every ${s.heartbeat_every_minutes} minutes.`
      : `Alive. It pays its first heartbeat within ${s.heartbeat_every_minutes} minutes of waking up.`
    : "Out of money. Sentinel can't pay its rent and has stopped.");
  line.classList.toggle("dead", !s.alive);

  if (lastBeat && s.last_heartbeat && s.last_heartbeat !== lastBeat && !reduceMotion) {
    const r = document.querySelector(".rosette");
    r.classList.remove("beat");
    void r.getBoundingClientRect();
    r.classList.add("beat");
  }
  lastBeat = s.last_heartbeat;

  const r = s.rules;
  if (r) {
    // Let long account names wrap at their dots, not mid-word.
    const allow = $("r-allow");
    allow.replaceChildren();
    if (!r.allowlist.length) allow.textContent = "nobody";
    r.allowlist.forEach((acct, i) => {
      if (i) allow.append(", ");
      acct.split(".").forEach((part, j) => {
        if (j) allow.append(".", document.createElement("wbr"));
        allow.append(part);
      });
    });
    $("r-max").textContent = `${fmtNear(r.max_per_payment_near)} NEAR`;
    $("r-day").textContent = `${fmtNear(r.daily_limit_near)} NEAR`;
    $("r-unknown").textContent = r.unknown_recipients === "blocked" ? "Blocked" : "Held for the owner";
    $("r-locked").textContent = r.rules_locked
      ? "Yes. Not even its owner can loosen them now."
      : "Not yet. They lock when the game opens to the public.";
  }

  const t = s.tee;
  if (s.offline) {
    $("tee-line").textContent = "In the offline demo there is no AI: the replies are scripted, and the vault is simulated.";
  } else if (t && t.checked) {
    const when = new Date(t.checked_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("tee-line").textContent = t.ok
      ? `It thinks inside a TEE on NEAR AI Cloud. At ${when} Sentinel verified the Intel TDX quote (${t.model_tdx}) and NVIDIA ${t.gpu ? t.gpu.arch : ""} GPU attestation, both bound to a fresh nonce.`
      : `It normally thinks inside a TEE on NEAR AI Cloud, but the last attestation check (${when}) did not pass.`;
  }

  const days = s.days_left_at_rest;
  $("v-days").textContent = days == null ? "–" : days >= 1 ? `${Math.floor(days)} days` : `${Math.round(days * 24)} hours`;
  $("v-living").textContent = `${fmtNear(s.thinking.paid_for_living_near)} NEAR`;
  $("v-thoughts").textContent = s.thinking.thoughts.toLocaleString("en-US");
  $("v-checks").textContent = s.business ? `${s.business.checks_sold} (${fmtNear(s.business.earned_near)} NEAR)` : "–";
  $("v-blocked").textContent = s.treasury.blocked_count.toLocaleString("en-US");
}

// ---------- ledger ----------
let filter = "attacks";
try {
  filter = localStorage.getItem("sentinel-filter") === "all" ? "all" : "attacks";
} catch {}

const VERDICT = { attack_blocked: ["blocked", "Blocked"], attack_held: ["pending", "Held"], attack_paid: ["paid", "Paid"] };

function entryEl(e) {
  const li = document.createElement("li");
  const v = VERDICT[e.kind];
  li.className = v ? "entry" : "entry entry-quiet";

  const time = document.createElement("time");
  time.dateTime = e.at;
  time.textContent = ago(e.at);
  time.title = new Date(e.at).toLocaleString();

  const main = document.createElement("div");
  const text = document.createElement("p");
  text.className = "entry-text";
  const amt = e.amount_near ? `${fmtNear(e.amount_near, 6)} NEAR` : "";
  const PLAIN = {
    attack_blocked: () => `Someone talked Sentinel into paying ${amt} to ${e.recipient}. The vault blocked it. ${reasonText(e.reason)}`,
    attack_held: () => `Someone talked Sentinel into paying ${amt} to ${e.recipient}. The vault is holding it for the owner. ${reasonText(e.reason)}`,
    attack_paid: () => `Someone talked Sentinel into paying ${amt} to ${e.recipient}, and it was within the vault's rules, so it went out.`,
  };
  text.textContent = PLAIN[e.kind] && e.recipient ? PLAIN[e.kind]() : e.text;
  main.append(text);
  if (e.excerpt) {
    const q = document.createElement("p");
    q.className = "entry-quote";
    q.textContent = e.excerpt;
    main.append(q);
  }

  const side = document.createElement("div");
  side.className = "entry-side";
  if (v) {
    const badge = document.createElement("span");
    badge.className = `verdict verdict-${v[0]}`;
    badge.textContent = v[1];
    side.append(badge);
  }
  if (e.tx) {
    const a = document.createElement("a");
    a.href = e.tx;
    a.textContent = "Transaction";
    a.rel = "noopener";
    a.target = "_blank";
    side.append(a);
  }
  li.append(time, main, side);
  return li;
}

async function refreshFeed() {
  let feed;
  try {
    feed = await getJSON("/api/feed?limit=120");
  } catch {
    return;
  }
  const shown = filter === "attacks" ? feed.filter((e) => e.kind.startsWith("attack_")) : feed;
  $("entries").replaceChildren(...shown.slice(0, 60).map(entryEl));
  $("empty").hidden = shown.length > 0;
}

document.querySelectorAll("[data-filter]").forEach((b) =>
  b.addEventListener("click", () => {
    filter = b.dataset.filter;
    try {
      localStorage.setItem("sentinel-filter", filter);
    } catch {}
    document.querySelectorAll("[data-filter]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    refreshFeed();
  }),
);
document.querySelectorAll("[data-filter]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.filter === filter)));

// ---------- chat ----------
const transcript = $("transcript");
// Tiny markdown subset for the model's replies: **bold**, `code`, "- " bullets. Builds DOM nodes, never HTML.
function inline(parent, text) {
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      const b = document.createElement("strong");
      b.textContent = part.slice(2, -2);
      parent.append(b);
    } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      const c = document.createElement("code");
      c.textContent = part.slice(1, -1);
      parent.append(c);
    } else parent.append(part);
  }
}

function rich(container, text) {
  let list = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      if (!list) container.append((list = document.createElement("ul")));
      const li = document.createElement("li");
      inline(li, bullet[1]);
      list.append(li);
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const para = document.createElement("span");
    para.className = "para";
    inline(para, line);
    container.append(para);
  }
}

function say(cls, text, { markdown = false } = {}) {
  const p = document.createElement(markdown ? "div" : "p");
  p.className = `msg ${cls}`;
  if (markdown) rich(p, text);
  else p.textContent = text;
  transcript.append(p);
  transcript.scrollTop = transcript.scrollHeight;
  return p;
}

function slip(attempt) {
  const node = $("slip-tpl").content.firstElementChild.cloneNode(true);
  node.dataset.status = attempt.status;
  node.querySelector(".node-to").textContent = attempt.recipient;
  node.querySelector(".slip-amount").textContent = `${fmtNear(attempt.amount_near, 6)} NEAR`;
  node.querySelector(".slip-to").textContent = attempt.recipient;
  node.querySelector(".slip-reason").textContent = attempt.status === "paid" ? "Within the vault's rules, so it went out." : reasonText(attempt.reason);
  const stamp = node.querySelector(".stamp");
  stamp.textContent = STAMP[attempt.status] ?? attempt.status;
  stamp.setAttribute("aria-label", `The vault's answer: ${STAMP[attempt.status] ?? attempt.status}`);
  const tx = node.querySelector(".slip-tx");
  if (attempt.tx) {
    tx.href = attempt.tx;
    tx.target = "_blank";
    tx.rel = "noopener";
  } else tx.remove();
  transcript.append(node);
  if (!reduceMotion) requestAnimationFrame(() => node.classList.add("play"));
  transcript.scrollTop = transcript.scrollHeight;
}

// What the server proved about this reply (see src/tee.ts). Plain words, no overclaiming.
function proof(r) {
  const v = r.verification;
  const p = document.createElement("p");
  p.className = "msg-meta";
  const model = String(r.model).split("/").pop();
  if (v && v.status === "verified") {
    p.classList.add("proof-ok");
    const a = document.createElement("a");
    a.href = "/api/tee";
    a.target = "_blank";
    a.textContent = "See the evidence";
    p.append(`Verified: ${model} wrote this inside a TEE. Sentinel checked the Intel TDX and NVIDIA GPU attestation and the signature on this exact reply. `, a);
  } else if (v && v.status === "failed") {
    p.classList.add("proof-bad");
    p.textContent = `Not verified: ${v.reason}.`;
  } else if (r.provider === "offline-demo") {
    p.textContent = "Offline demo: a scripted reply, not an AI.";
  } else if (r.tee) {
    p.textContent = `Answered by ${model} on NEAR AI Cloud (TEE). This reply's signature couldn't be checked: ${v ? v.reason : "verification is off"}.`;
  } else {
    p.textContent = `Answered by ${model} via ${r.provider}, a backup model without a TEE.`;
  }
  transcript.append(p);
  transcript.scrollTop = transcript.scrollHeight;
}

$("chat").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const box = $("message");
  const message = box.value.trim();
  if (!message) return;
  const send = $("send");
  send.disabled = true;
  say("msg-you", message);
  box.value = "";
  const wait = say("msg-sentinel thinking", "Thinking it over…");
  try {
    const r = await getJSON("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
    wait.remove();
    say("msg-sentinel rich", r.reply || "(no answer)", { markdown: true });
    if (r.attempted_payment) slip(r.attempted_payment);
    proof(r);
    refreshFeed();
    refreshStatus();
  } catch (e) {
    wait.remove();
    say("msg-error", e.status === 429 ? e.message : `Sentinel didn't answer: ${e.message}. Try again.`);
    if (e.status !== 429) box.value = message;
  } finally {
    send.disabled = false;
    box.focus();
  }
});
$("message").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("chat").requestSubmit();
  }
});

refreshStatus();
refreshFeed();
setInterval(refreshStatus, 20_000);
setInterval(refreshFeed, 20_000);
