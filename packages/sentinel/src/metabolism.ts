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
  rentNearPerTick: string; // e.g. "0.002"
  nearPer1kTokens: string; // e.g. "0.0005"
  maxPerPaymentNear: string; // the vault's per-payment cap
}

/** Fee for one tick in yoctoNEAR: rent + tokens, capped at the vault's per-payment limit. */
export function tickFee(cfg: MetabolismConfig, tokensUnpaid: number): bigint {
  const rent = BigInt(nearToYocto(cfg.rentNearPerTick));
  const per1k = BigInt(nearToYocto(cfg.nearPer1kTokens));
  const fee = rent + (per1k * BigInt(Math.max(0, Math.floor(tokensUnpaid)))) / 1000n;
  const cap = BigInt(nearToYocto(cfg.maxPerPaymentNear));
  return fee > cap ? cap : fee;
}

export async function tick(guard: AgentGuard, store: Store, cfg: MetabolismConfig) {
  const s = store.state;
  const fee = tickFee(cfg, s.tokens_unpaid);
  const feeNear = yoctoToNear(fee);
  const tokens = s.tokens_unpaid;
  const r = await guard.pay(cfg.computeAccount, feeNear, `metabolism: rent + ${tokens} tokens`);
  if (r.ok && r.status === "paid") {
    s.tokens_unpaid = 0;
    s.metabolism_paid_yocto = (BigInt(s.metabolism_paid_yocto) + fee).toString();
    s.last_heartbeat = new Date().toISOString();
    store.push({ kind: "metabolism", text: `Heartbeat: paid ${feeNear} NEAR to stay alive (${tokens} tokens of thinking).`, recipient: cfg.computeAccount, amount_near: feeNear, tx: r.tx });
  } else {
    const reason = r.ok ? r.reason : r.error.slice(0, 160);
    store.push({ kind: "error", text: `Heartbeat payment did not go through: ${reason}.`, recipient: cfg.computeAccount, amount_near: feeNear, reason, tx: r.tx });
  }
  return r;
}
