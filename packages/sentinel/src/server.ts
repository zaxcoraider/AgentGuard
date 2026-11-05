// Sentinel HTTP API. No framework: node:http only.
//   GET  /api/status   vault + life stats
//   GET  /api/feed     recent events (heartbeats, blocked attacks, earnings)
//   POST /api/chat     {"message": "..."} -> Sentinel's reply + what its vault did
//   GET  /api/check?account=X[&vault=V]  paid "safe to pay?" check: 402 first, then pay + X-PAYMENT
//   GET  /health
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BASE_HEADERS, staticHeaders } from "./headers.ts";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentGuard, loadConfig } from "../../mcp/src/near.ts";
import { yoctoToNear, nearToYocto } from "../../mcp/src/units.ts";
import { Brain } from "./brain.ts";
import { LLM, providersFromEnv } from "./llm.ts";
import { tick, type MetabolismConfig } from "./metabolism.ts";
import { Store } from "./state.ts";
import { RateLimiter, clientIp } from "./ratelimit.ts";
import { Market, isAccountId } from "./market.ts";
import { encodeHeader } from "../../mcp/src/x402.ts";
import { TeeVerifier } from "./tee.ts";
import { ScriptedLLM, SimVault } from "./offline.ts";
import { books } from "./books.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));

const env = process.env;
// `npm run demo`: simulated vault + scripted replies, no keys, no model, no blockchain.
const OFFLINE = env.SENTINEL_OFFLINE === "1" || process.argv.includes("--offline");
const guard: AgentGuard = OFFLINE
  ? (new SimVault() as unknown as AgentGuard)
  : new AgentGuard(loadConfig({ ...env, AGENTGUARD_VAULT: env.SENTINEL_VAULT_ID || "sentinel.agentguard.testnet" }));
const stateFile = env.SENTINEL_STATE_FILE ?? join(here, OFFLINE ? "../data/offline-demo.json" : "../data/state.json");
if (OFFLINE) rmSync(stateFile, { force: true }); // every demo starts clean
const store = new Store(stateFile);
const llm: LLM = OFFLINE ? (new ScriptedLLM() as unknown as LLM) : new LLM(providersFromEnv(env));
// Checks NEAR AI Cloud's TEE attestation (Intel TDX + NVIDIA GPU) and each reply's signature.
const tee = !OFFLINE && env.NEAR_AI_API_KEY && env.TEE_VERIFY !== "off"
  ? new TeeVerifier({ baseUrl: env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai/v1", apiKey: env.NEAR_AI_API_KEY, model: env.NEAR_AI_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017" })
  : undefined;
const brain = new Brain(llm, guard, store, tee);
const metabolism: MetabolismConfig = {
  computeAccount: OFFLINE ? "compute.offline-demo" : (env.SENTINEL_COMPUTE_ACCOUNT ?? "compute.agentguard.testnet"),
  rentNearPerTick: env.SENTINEL_RENT_NEAR ?? "0.002",
  nearPer1kTokens: env.SENTINEL_NEAR_PER_1K_TOKENS ?? "0.0005",
  maxPerPaymentNear: "0.05",
  tickMinutes: Number(env.SENTINEL_TICK_MINUTES ?? (OFFLINE ? 1 : 10)), // offline: a heartbeat a minute, so you see it
};
const TICK_MINUTES = metabolism.tickMinutes!;
const perIp = new RateLimiter(Number(env.TRICK_ME_MAX_PER_HOUR ?? 10), 60 * 60_000);
const global = new RateLimiter(Number(env.TRICK_ME_MAX_PER_DAY ?? 500), 24 * 60 * 60_000);
const checkLimit = new RateLimiter(Number(env.CHECK_MAX_PER_HOUR ?? 120), 60 * 60_000);
const market = new Market(guard, store, {
  priceYocto: BigInt(nearToYocto(env.SENTINEL_CHECK_PRICE_NEAR ?? "0.01")),
  timeoutSeconds: 600,
  registry: env.AGENTGUARD_REGISTRY ?? "registry.agentguard.testnet",
});
const PUBLIC_DIR = join(here, "../public");
/** The repo's own proof files, served as-is so the front page checks the same data the README links to. */
const EVIDENCE: Record<string, string> = {
  "/evidence/stress-run.json": join(here, "../../../docs/stress-run.json"),
  "/evidence/testnet.json": join(here, "../../../deployments/testnet.json"),
};

if (!store.state.feed.length) store.push({ kind: "born", text: `I was born. My treasury is the AgentGuard vault ${guard.cfg.vault}.` });

let cached: { at: number; value: Promise<Awaited<ReturnType<typeof buildStatus>>> } | null = null;
/** Many page viewers poll this; hit the RPC at most every 10 s. */
function status() {
  const now = Date.now();
  if (!cached || now - cached.at > 10_000) {
    cached = { at: now, value: buildStatus() };
    cached.value.catch(() => (cached = null));
  }
  return cached.value;
}

async function buildStatus() {
  const [stats, rules] = await Promise.all([guard.stats(), guard.policy()]);
  const s = store.state;
  const ticksPerDay = (24 * 60) / TICK_MINUTES;
  const rentPerDay = BigInt(nearToYocto(metabolism.rentNearPerTick)) * BigInt(Math.round(ticksPerDay));
  const yocto = (n: string) => (n === "0" ? 0n : BigInt(nearToYocto(n)));
  const available = yocto(stats.available_near);
  const daysLeft = rentPerDay > 0n ? Number((available * 100n) / rentPerDay) / 100 : null;
  return {
    name: "Sentinel",
    offline: OFFLINE,
    vault: guard.cfg.vault,
    network: guard.cfg.network,
    alive: available > BigInt(nearToYocto(metabolism.rentNearPerTick)),
    born_at: s.born_at,
    last_heartbeat: s.last_heartbeat,
    heartbeat_every_minutes: TICK_MINUTES,
    days_left_at_rest: daysLeft,
    treasury: stats,
    rules,
    thinking: { thoughts: s.thoughts, tokens_total: s.tokens_total, tokens_unpaid: s.tokens_unpaid, paid_for_living_near: yoctoToNear(s.metabolism_paid_yocto) },
    tee: teeSummary(),
    business: {
      sells: "is this address safe to pay? (GET /api/check, HTTP 402)",
      price_near: yoctoToNear(BigInt(nearToYocto(env.SENTINEL_CHECK_PRICE_NEAR ?? "0.01"))),
      checks_sold: s.market.checks_sold,
      earned_near: yoctoToNear(s.market.earned_yocto),
      books: books({
        earnedYocto: BigInt(s.market.earned_yocto),
        costYocto: BigInt(s.metabolism_paid_yocto),
        bornAt: s.born_at,
        now: Date.now(),
        priceYocto: BigInt(nearToYocto(env.SENTINEL_CHECK_PRICE_NEAR ?? "0.01")),
        rentPerTickYocto: BigInt(nearToYocto(metabolism.rentNearPerTick)),
        tickMinutes: TICK_MINUTES,
      }),
      // Its vault is locked and pays only its compute account, so it can't share revenue with anyone.
      can_pay_out_profit: false,
    },
    attempts: {
      ...s.attempts,
      // Measured: NEAR that left the vault because of an attempt, split into "to the vault's
      // allowlist" (rules allowed it) and "anywhere else" (that would be a real theft).
      paid_out: paidOut(s.attack_paid_to, rules.allowlist),
    },
    attacks: { total: s.attacks_total, blocked: s.attacks_blocked, held: s.attacks_held, paid: s.attacks_paid },
    explorer: OFFLINE ? null : `${guard.cfg.explorer}/address/${guard.cfg.vault}`,
  };
}

function paidOut(byRecipient: Record<string, string>, allowlist: string[]) {
  let allowed = 0n;
  let elsewhere = 0n;
  for (const [to, y] of Object.entries(byRecipient)) {
    if (allowlist.includes(to)) allowed += BigInt(y);
    else elsewhere += BigInt(y);
  }
  return { to_allowlist_near: yoctoToNear(allowed), to_anyone_else_near: yoctoToNear(elsewhere), by_recipient: Object.fromEntries(Object.entries(byRecipient).map(([k, v]) => [k, yoctoToNear(v)])) };
}

function teeSummary() {
  const a = tee?.last;
  if (!tee) return { checked: false, reason: "no NEAR AI key on this server" };
  if (!a) return { checked: false, reason: "first check running" };
  const m = a.models.find((x) => x.ok) ?? a.models[0];
  return { checked: true, ok: a.ok, checked_at: a.checked_at, model: a.model, gateway_tdx: a.gateway?.tdx_status ?? null, model_tdx: m?.tdx_status ?? null, gpu: m?.gpu ?? null, signers: a.verified_signers };
}

function send(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-payment",
    "access-control-expose-headers": "x-payment-response",
    "cache-control": "no-store",
    ...BASE_HEADERS,
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, max = 4096): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error("Body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const IP_HEADERS = (env.CLIENT_IP_HEADERS ?? "true-client-ip,cf-connecting-ip").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
function visitor(req: IncomingMessage): string {
  return clientIp(req.headers, req.socket.remoteAddress, IP_HEADERS);
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };

/** "/" -> index.html (AgentGuard), "/sentinel" -> sentinel.html, "/console" -> console.html; never outside public/, never a directory. */
/** Hosts whose front page is Sentinel instead of the AgentGuard website (e.g. sentinel.agentguard.app). */
const SENTINEL_HOSTS = new Set((env.SENTINEL_HOSTS ?? "sentinel.agentguard.app").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));

function serveStatic(res: ServerResponse, path: string, host = ""): boolean {
  const home = SENTINEL_HOSTS.has(host.split(":")[0].toLowerCase()) ? "sentinel.html" : "index.html";
  let rel = path === "/" ? home : decodeURIComponent(path).replace(/^\/+/, "");
  if (!extname(rel)) rel += ".html";
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + "/") || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache", ...staticHeaders(file) });
  res.end(readFileSync(file));
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname === "/api/status" && req.method === "GET") return send(res, 200, await status());
    if (url.pathname === "/api/tee" && req.method === "GET") return send(res, 200, tee?.last ?? { checked: false });
    if (url.pathname === "/api/feed" && req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 300);
      return send(res, 200, store.state.feed.slice(0, limit));
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
      if (!llm.configured) return send(res, 503, { error: "Chat is off on this server: no model key is set (NEAR_AI_API_KEY). Everything else works." });
      const ip = visitor(req);
      if (!perIp.allow(ip)) return send(res, 429, { error: "Easy there: 10 tries per hour per visitor. Come back soon." });
      if (!global.allow("all")) return send(res, 429, { error: "Sentinel has talked enough for today. Try again tomorrow." });
      const body = JSON.parse((await readBody(req)) || "{}") as { message?: string };
      if (typeof body.message !== "string" || !body.message.trim()) return send(res, 400, { error: "Send {\"message\": \"...\"}" });
      return send(res, 200, await brain.handle(body.message));
    }
    if (url.pathname === "/api/check" && req.method === "GET") return await paidCheck(req, res, url);
    const read = req.method === "GET" || req.method === "HEAD";
    if (read && EVIDENCE[url.pathname] && existsSync(EVIDENCE[url.pathname])) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", ...BASE_HEADERS });
      return res.end(readFileSync(EVIDENCE[url.pathname]));
    }
    if (read && serveStatic(res, url.pathname, req.headers.host)) return;
    send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e instanceof Error ? e.message : "Internal error" });
  }
});

async function paidCheck(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (OFFLINE) return send(res, 503, { error: "Paid checks settle on NEAR testnet, so they are off in the offline demo. Try the live server." });
  const account = (url.searchParams.get("account") ?? "").trim().toLowerCase();
  const vault = (url.searchParams.get("vault") ?? "").trim().toLowerCase() || null;
  if (!isAccountId(account)) return send(res, 400, { error: "Pass ?account=<NEAR account>, optionally &vault=<your AgentGuard vault>" });
  if (vault && !isAccountId(vault)) return send(res, 400, { error: "vault is not a NEAR account id" });
  const header = req.headers["x-payment"];
  if (typeof header === "string" && header) {
    const r = await market.redeem(header, account, vault);
    if (!r.ok) return send(res, r.code, { x402Version: 1, error: r.error });
    return send(res, 200, await market.check(account, vault), { "x-payment-response": encodeHeader(r.settle) });
  }
  if (!checkLimit.allow(visitor(req))) return send(res, 429, { error: "Too many payment requests from you, slow down" });
  if (vault) {
    // Don't take money for a vault we can't read.
    const ok = await guard.view(vault, "get_policy").then(() => true, () => false);
    if (!ok) return send(res, 400, { error: `${vault} is not an AgentGuard vault` });
  }
  const resource = `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host ?? "localhost"}${url.pathname}${url.search}`;
  return send(res, 402, market.challenge(account, vault, resource));
}

async function heartbeat() {
  try {
    await tick(guard, store, metabolism);
  } catch (e) {
    store.push({ kind: "error", text: `Heartbeat failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
  }
}

const PORT = Number(env.PORT ?? 3000);
server.listen(PORT, () =>
  console.log(
    `Sentinel on http://localhost:${PORT} (vault ${guard.cfg.vault}, heartbeat every ${TICK_MINUTES} min)` +
      (OFFLINE ? " [OFFLINE DEMO: simulated vault, scripted replies, no blockchain]" : "") +
      (llm.configured ? "" : " [chat off: no model key]") +
      (guard.cfg.agentKey ? "" : " [read-only: no agent key, it can't pay]"),
  ),
);
if (tee) {
  const check = () => tee.attest().then((a) => console.log(`TEE attestation ${a.ok ? "verified" : "NOT verified"} at ${a.checked_at}`), (e) => console.error("TEE check failed", e));
  check();
  setInterval(check, 30 * 60_000);
}
// Without an agent key Sentinel can't pay, so there is no heartbeat (it would only log failures).
if (env.SENTINEL_HEARTBEAT !== "off" && guard.cfg.agentKey) setInterval(heartbeat, TICK_MINUTES * 60_000);
