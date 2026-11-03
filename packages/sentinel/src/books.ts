// Sentinel's books: what it earned selling checks, what staying alive cost, and what it
// would take to break even. Every input is a real counter; estimates are labeled as such.
import { yoctoToNear } from "../../mcp/src/units.ts";

export interface BooksInput {
  earnedYocto: bigint; // paid checks (verified on-chain when sold)
  costYocto: bigint; // heartbeats paid from its vault (rent + thinking)
  bornAt: string; // ISO
  now: number; // ms
  priceYocto: bigint; // price of one check
  rentPerTickYocto: bigint;
  tickMinutes: number;
}

const signed = (y: bigint) => (y < 0n ? `-${yoctoToNear(-y)}` : yoctoToNear(y));
const HOUR = 3_600_000;

export function books(i: BooksInput) {
  const aliveMs = Math.max(0, i.now - new Date(i.bornAt).getTime());
  // Under a day of history, the per-day cost is the rent alone (a lower bound); after that, measured.
  const measured = aliveMs >= 24 * HOUR;
  const ticksPerDay = BigInt(Math.round((24 * 60) / i.tickMinutes));
  const costPerDay = measured ? (i.costYocto * BigInt(24 * HOUR)) / BigInt(aliveMs) : i.rentPerTickYocto * ticksPerDay;
  const breakEven = i.priceYocto > 0n ? Number((costPerDay + i.priceYocto - 1n) / i.priceYocto) : null;
  return {
    revenue_near: yoctoToNear(i.earnedYocto),
    costs_near: yoctoToNear(i.costYocto),
    net_near: signed(i.earnedYocto - i.costYocto),
    profitable: i.earnedYocto > i.costYocto,
    days_alive: Math.round((aliveMs / (24 * HOUR)) * 100) / 100,
    cost_per_day_near: yoctoToNear(costPerDay),
    cost_per_day_basis: measured ? "measured" : "rent only, less than a day of data",
    break_even_checks_per_day: breakEven,
  };
}
