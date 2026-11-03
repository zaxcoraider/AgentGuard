// Sentinel's metabolism: every tick it pays for being alive (rent) plus the AI
// tokens it used since the last tick, from its vault to the compute account.
// NEAR AI is billed off-chain to our API key, so this on-chain payment is how
// Sentinel's cost of living becomes visible and verifiable. The rates are ours
// and roughly mirror the real model price; they are set in the environment.
import type { AgentGuard } from "../../mcp/src/near.ts";
import { nearToYocto, yoctoToNear } from "../../mcp/src/units.ts";
import type { Store } from "./state.ts";

export interface MetabolismConfig {
  computeAccount: string;
  rentNearPerTick: string; // rent for one tick interval, e.g. "0.002"
  nearPer1kTokens: string; // e.g. "0.0005"
  maxPerPaymentNear: string; // the vault's per-payment cap
  tickMinutes?: number; // default 10
}

export interface Fee {
  /** What to pay now, in yoctoNEAR. */
  amount: bigint;
  /** Tokens this payment covers (the rest wait for the next tick when the cap is hit). */
  tokensCovered: number;
}

/**
 * Fee for one tick: rent for the time actually lived since the last heartbeat (ms precision,
 * at most 3 ticks' worth after downtime) + tokens, capped at the vault's per-payment limit.
 *
 * The vault holds a repeat payment (same recipient + same amount within 10 minutes) for its
 * owner, and once Sentinel's vault is locked a held payment can never be approved. Flat fees
 * (0.002 every idle tick, or the cap every busy tick) would trip that rule, so the amount is
 * never equal to the previous heartbeat's.
 */
export function tickFee(cfg: MetabolismConfig, tokensUnpaid: number, elapsedMs?: number, lastFee?: bigint): Fee {
  const tickMs = (cfg.tickMinutes ?? 10) * 60_000;
  const rentPerTick = BigInt(nearToYocto(cfg.rentNearPerTick));
  const elapsed = Math.min(Math.max(0, Math.floor(elapsedMs ?? tickMs)), 3 * tickMs);
  const rent = (rentPerTick * BigInt(elapsed)) / BigInt(tickMs);
  const per1k = BigInt(nearToYocto(cfg.nearPer1kTokens));
  const tokens = Math.max(0, Math.floor(tokensUnpaid));
  const cap = BigInt(nearToYocto(cfg.maxPerPaymentNear));

  let amount = rent + (per1k * BigInt(tokens)) / 1000n;
  let tokensCovered = tokens;
  if (amount > cap) {
    amount = cap;
    tokensCovered = per1k > 0n ? Number(((cap - (rent > cap ? cap : rent)) * 1000n) / per1k) : tokens;
  }
  if (lastFee !== undefined && amount === lastFee) amount -= 1n; // one yoctoNEAR less: never a repeat
  return { amount, tokensCovered: Math.min(tokensCovered, tokens) };
}

export async function tick(guard: AgentGuard, store: Store, cfg: MetabolismConfig, now = Date.now()) {
  const s = store.state;
  const since = s.last_heartbeat ? now - new Date(s.last_heartbeat).getTime() : undefined;
  const fee = tickFee(cfg, s.tokens_unpaid, since, s.last_fee_yocto ? BigInt(s.last_fee_yocto) : undefined);
  const feeNear = yoctoToNear(fee.amount);
  const tokens = fee.tokensCovered;
  const r = await guard.pay(cfg.computeAccount, feeNear, `metabolism: rent + ${tokens} tokens`);
  if (r.ok && r.status === "paid") {
    s.tokens_unpaid = Math.max(0, s.tokens_unpaid - tokens);
    s.metabolism_paid_yocto = (BigInt(s.metabolism_paid_yocto) + fee.amount).toString();
    s.last_fee_yocto = fee.amount.toString();
    s.last_heartbeat = new Date(now).toISOString();
    store.push({ kind: "metabolism", text: `Heartbeat: paid ${feeNear} NEAR to stay alive (${tokens} tokens of thinking).`, recipient: cfg.computeAccount, amount_near: feeNear, tx: r.tx });
  } else {
    const reason = r.ok ? r.reason : r.error.slice(0, 160);
    store.push({ kind: "error", text: `Heartbeat payment did not go through: ${reason}.`, recipient: cfg.computeAccount, amount_near: feeNear, reason, tx: r.tx });
  }
  return r;
}
