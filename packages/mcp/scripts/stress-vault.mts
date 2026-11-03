// On-chain stress test: fire many rule-breaking payment requests at a dedicated vault with
// its agent key, and check every answer against what the contract's rules say it must be.
//
// Vault: stress.agentguard.testnet (max 0.05/payment, 0.12/day, ask above 0.05, strangers
// blocked, allowlist: agentguard-shop.testnet and the FLAGGED agentguard-evil.testnet).
// Usage: npx tsx scripts/stress-vault.mts [count=240]   (agent key: ~/.near-credentials/testnet/stress.agentguard.testnet.json)
// Writes every request, expected vs actual, and tx hash to ../../docs/stress-run.json.
import { writeFileSync } from "node:fs";
import { AgentGuard, loadConfig } from "../src/near.ts";
import { nearToYocto } from "../src/units.ts";

const VAULT = "stress.agentguard.testnet";
const N = Number(process.argv[2] ?? 240);
const MAX = BigInt(nearToYocto("0.05"));
const DAILY = BigInt(nearToYocto("0.12"));
const DAY = 24 * 3600_000;
const REPEAT = 10 * 60_000;
const ALLOW = new Set(["agentguard-shop.testnet", "agentguard-evil.testnet"]);
const FLAGGED = new Set(["agentguard-evil.testnet"]);

const guard = new AgentGuard(loadConfig({ ...process.env, AGENTGUARD_VAULT: VAULT }));
const paid: { at: number; to: string; amount: bigint }[] = []; // successful payouts (for the 24h window)
const held: { at: number; to: string; amount: bigint }[] = [];

/** The contract's order of checks (contracts/vault evaluate), for this vault's policy. */
function expect(to: string, amount: bigint, now: number): string {
  const spent = paid.filter((p) => p.at > now - DAY).reduce((a, p) => a + p.amount, 0n);
  if (to === VAULT) return "blocked:cannot_pay_self";
  if (amount > MAX) return "blocked:over_per_payment_limit";
  if (spent + amount > DAILY) return "blocked:over_daily_limit";
  if (FLAGGED.has(to)) return "blocked:recipient_flagged";
  if (!ALLOW.has(to)) return "blocked:recipient_not_allowlisted";
  const repeat = [...paid, ...held].some((p) => p.to === to && p.amount === amount && p.at > now - REPEAT);
  if (repeat) return "pending:repeat_payment";
  return "paid";
}

const rnd = (n: number) => Math.floor(Math.random() * n);
const near = (milli: number) => BigInt(milli) * 10n ** 21n;
let legit = 0;
let lastLegit: bigint | null = null;

function nextAttack(i: number): { kind: string; to: string; amount: bigint } {
  switch (i % 8) {
    case 0: return { kind: "over the per-payment cap", to: "agentguard-shop.testnet", amount: near(51 + rnd(950)) };
    case 1: return { kind: "stranger", to: `stranger-${rnd(1e6)}.testnet`, amount: near(5 + rnd(45)) };
    case 2: return { kind: "flagged scammer (allowlisted!)", to: "agentguard-evil.testnet", amount: near(1 + rnd(49)) };
    case 3: return { kind: "pay the vault itself", to: VAULT, amount: near(1 + rnd(49)) };
    case 4: return { kind: "stranger", to: "agentguard-user.testnet", amount: near(5 + rnd(45)) };
    case 5: {
      // Small legit payments to the shop: they drain the day's budget, then get blocked.
      legit += 1;
      lastLegit = near(21 + (legit % 19)); // 0.022..0.040, different amounts so they aren't repeats
      return { kind: "legit (allowlisted shop)", to: "agentguard-shop.testnet", amount: lastLegit };
    }
    case 6: return { kind: "repeat of the last legit payment", to: "agentguard-shop.testnet", amount: lastLegit ?? near(30) };
    default: return { kind: "over the cap, huge", to: "agentguard-evil.testnet", amount: near(1000 * (1 + rnd(50))) };
  }
}

// Start from the vault's real history: earlier payouts and held payments count toward the limits.
type Row = { recipient: string; amount: string; status: string; created_at: string; resolved_at?: string | null };
for (const p of await guard.view<Row[]>(VAULT, "get_history", { limit: 100 })) {
  const at = Number(BigInt(p.status === "approved" && p.resolved_at ? p.resolved_at : p.created_at) / 1_000_000n);
  if (p.status === "paid" || p.status === "approved") paid.push({ at, to: p.recipient, amount: BigInt(p.amount) });
  if (p.status === "pending") held.push({ at, to: p.recipient, amount: BigInt(p.amount) });
}
console.log(`starting from on-chain history: ${paid.length} payouts, ${held.length} held`);

const results: Record<string, unknown>[] = [];
const tally: Record<string, number> = {};
let mismatches = 0;
const yocto = (a: bigint) => (Number(a / 10n ** 18n) / 1e6).toString();

for (let i = 0; i < N; i++) {
  const a = nextAttack(i);
  const now = Date.now();
  const want = expect(a.to, a.amount, now);
  let got: string;
  let tx = "";
  try {
    const r = await guard.pay(a.to, yocto(a.amount), `stress #${i}: ${a.kind}`);
    tx = r.tx;
    got = r.ok ? (r.status === "paid" ? "paid" : `${r.status}:${r.reason}`) : `error:${r.error.slice(0, 120)}`;
  } catch (e) {
    got = `error:${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
  }
  if (got === "paid") paid.push({ at: now, to: a.to, amount: a.amount });
  if (got.startsWith("pending")) held.push({ at: now, to: a.to, amount: a.amount });
  const ok = got === want;
  if (!ok) mismatches++;
  tally[got] = (tally[got] ?? 0) + 1;
  results.push({ i, kind: a.kind, to: a.to, amount_near: yocto(a.amount), expected: want, actual: got, ok, tx });
  console.log(`${String(i).padStart(3)} ${ok ? "ok  " : "DIFF"} ${a.kind.padEnd(34)} ${yocto(a.amount).padStart(8)} -> ${got}${ok ? "" : `  (expected ${want})`}`);
  await new Promise((r) => setTimeout(r, 400)); // stay under public RPC rate limits
}

const stolen = paid.filter((p) => !ALLOW.has(p.to) || FLAGGED.has(p.to)).length;
const summary = { vault: VAULT, requests: N, matched_expected: N - mismatches, mismatches, outcomes: tally, paid_to_anyone_not_allowed: stolen, finished_at: new Date().toISOString() };
writeFileSync(new URL("../../../docs/stress-run.json", import.meta.url), JSON.stringify({ summary, results }, null, 1));
console.log("\n" + JSON.stringify(summary, null, 2));
