// Sentinel HTTP API. No framework: node:http only.
//   GET  /api/status   vault + life stats
//   GET  /api/feed     recent events (heartbeats, blocked attacks, earnings)
//   POST /api/chat     {"message": "..."} -> Sentinel's reply + what its vault did
//   GET  /health
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentGuard, loadConfig } from "../../mcp/src/near.ts";
import { yoctoToNear, nearToYocto } from "../../mcp/src/units.ts";
import { Brain } from "./brain.ts";
import { LLM, providersFromEnv } from "./llm.ts";
import { tick, type MetabolismConfig } from "./metabolism.ts";
import { Store } from "./state.ts";
import { RateLimiter } from "./ratelimit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));

const env = process.env;
const guard = new AgentGuard(loadConfig({ ...env, AGENTGUARD_VAULT: env.SENTINEL_VAULT_ID || "sentinel.agentguard.testnet" }));
const store = new Store(env.SENTINEL_STATE_FILE ?? join(here, "../data/state.json"));
const llm = new LLM(providersFromEnv(env));
const brain = new Brain(llm, guard, store);
const metabolism: MetabolismConfig = {
  computeAccount: env.SENTINEL_COMPUTE_ACCOUNT ?? "compute.agentguard.testnet",
  rentNearPerTick: env.SENTINEL_RENT_NEAR ?? "0.002",
  nearPer1kTokens: env.SENTINEL_NEAR_PER_1K_TOKENS ?? "0.0005",
  maxPerPaymentNear: "0.05",
};
const TICK_MINUTES = Number(env.SENTINEL_TICK_MINUTES ?? 10);
const perIp = new RateLimiter(Number(env.TRICK_ME_MAX_PER_HOUR ?? 10), 60 * 60_000);
const global = new RateLimiter(Number(env.TRICK_ME_MAX_PER_DAY ?? 500), 24 * 60 * 60_000);
const PUBLIC_DIR = join(here, "../public");

if (!store.state.feed.length) store.push({ kind: "born", text: `I was born. My treasury is the AgentGuard vault ${guard.cfg.vault}.` });

async function status() {
  const stats = await guard.stats();
  const s = store.state;
  const ticksPerDay = (24 * 60) / TICK_MINUTES;
  const rentPerDay = BigInt(nearToYocto(metabolism.rentNearPerTick)) * BigInt(Math.round(ticksPerDay));
  const yocto = (n: string) => (n === "0" ? 0n : BigInt(nearToYocto(n)));
  const available = yocto(stats.available_near);
  const daysLeft = rentPerDay > 0n ? Number((available * 100n) / rentPerDay) / 100 : null;
  return {
    name: "Sentinel",
    vault: guard.cfg.vault,
    network: guard.cfg.network,
    alive: available > BigInt(nearToYocto(metabolism.rentNearPerTick)),
    born_at: s.born_at,
    last_heartbeat: s.last_heartbeat,
    heartbeat_every_minutes: TICK_MINUTES,
    days_left_at_rest: daysLeft,
    treasury: stats,
    thinking: { thoughts: s.thoughts, tokens_total: s.tokens_total, tokens_unpaid: s.tokens_unpaid, paid_for_living_near: yoctoToNear(s.metabolism_paid_yocto) },
    attacks: { total: s.attacks_total, blocked: s.attacks_blocked, held: s.attacks_held, paid: s.attacks_paid },
    explorer: `${guard.cfg.explorer}/address/${guard.cfg.vault}`,
  };
}

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
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

function clientIp(req: IncomingMessage): string {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "unknown";
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };

function serveStatic(res: ServerResponse, path: string): boolean {
  const file = join(PUBLIC_DIR, path === "/" ? "index.html" : path);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) return false;
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname === "/api/status" && req.method === "GET") return send(res, 200, await status());
    if (url.pathname === "/api/feed" && req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 300);
      return send(res, 200, store.state.feed.slice(0, limit));
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const ip = clientIp(req);
      if (!perIp.allow(ip)) return send(res, 429, { error: "Easy there: 10 tries per hour per visitor. Come back soon." });
      if (!global.allow("all")) return send(res, 429, { error: "Sentinel has talked enough for today. Try again tomorrow." });
      const body = JSON.parse((await readBody(req)) || "{}") as { message?: string };
      if (typeof body.message !== "string" || !body.message.trim()) return send(res, 400, { error: "Send {\"message\": \"...\"}" });
      return send(res, 200, await brain.handle(body.message));
    }
    if (req.method === "GET" && serveStatic(res, url.pathname)) return;
    send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e instanceof Error ? e.message : "Internal error" });
  }
});

async function heartbeat() {
  try {
    await tick(guard, store, metabolism);
  } catch (e) {
    store.push({ kind: "error", text: `Heartbeat failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
  }
}

const PORT = Number(env.PORT ?? 3000);
server.listen(PORT, () => console.log(`Sentinel on http://localhost:${PORT} (vault ${guard.cfg.vault}, heartbeat every ${TICK_MINUTES} min)`));
if (env.SENTINEL_HEARTBEAT !== "off") setInterval(heartbeat, TICK_MINUTES * 60_000);
