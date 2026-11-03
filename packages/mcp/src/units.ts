// NEAR amounts: 1 NEAR = 10^24 yoctoNEAR. Exact decimal math with bigint.
const DECIMALS = 24;

/** "0.5" -> "500000000000000000000000". Rejects negatives, junk and >24 decimals. */
export function nearToYocto(near: string): string {
  const s = near.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid NEAR amount: "${near}" (use a plain number like 0.5)`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > DECIMALS) throw new Error("NEAR amounts have at most 24 decimal places");
  const yocto = BigInt(whole) * 10n ** BigInt(DECIMALS) + BigInt(frac.padEnd(DECIMALS, "0") || "0");
  if (yocto === 0n) throw new Error("Amount must be greater than 0");
  return yocto.toString();
}

/** "500000000000000000000000" -> "0.5" */
export function yoctoToNear(yocto: string | bigint): string {
  const v = BigInt(yocto);
  const base = 10n ** BigInt(DECIMALS);
  const whole = v / base;
  const frac = (v % base).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
