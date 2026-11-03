// Off-chain "is this address safe to pay?" check. It advises the agent before it
// asks the vault; the vault still enforces its own rules on-chain either way.

export type Verdict = "allow" | "warn" | "block";

export interface AddressFacts {
  account: string;
  exists: boolean;
  isContract: boolean;
  registryStatus: "clear" | "reported" | "flagged" | "dismissed" | "unknown";
  registryReasons: string[];
  allowlisted: boolean;
  allowlist: string[];
}

export interface CheckResult {
  account: string;
  verdict: Verdict;
  reasons: string[];
  facts: AddressFacts;
}

// Characters attackers swap to make a name look like a trusted one.
const CONFUSABLE: [RegExp, string][] = [
  [/rn/g, "m"],
  [/vv/g, "w"],
  [/0/g, "o"],
  [/1/g, "l"],
  [/i/g, "l"],
  [/5/g, "s"],
  [/3/g, "e"],
];

function skeleton(name: string): string {
  let s = name.toLowerCase();
  for (const [re, to] of CONFUSABLE) s = s.replace(re, to);
  return s;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Trusted names this account imitates (looks alike but is not the same account). */
export function lookalikes(account: string, trusted: string[]): string[] {
  const a = account.toLowerCase();
  return trusted.filter((t) => {
    const b = t.toLowerCase();
    if (a === b) return false;
    if (skeleton(a) === skeleton(b)) return true;
    return Math.max(a.length, b.length) >= 8 && editDistance(a, b) <= 2;
  });
}

export function score(f: AddressFacts): CheckResult {
  const block: string[] = [];
  const warn: string[] = [];

  if (f.registryStatus === "flagged") block.push(`flagged in the shared AgentGuard registry: ${f.registryReasons.join("; ") || "no reason given"}`);
  if (f.registryStatus === "reported") warn.push(`reported in the shared registry: ${f.registryReasons.join("; ")}`);
  if (f.registryStatus === "unknown") warn.push("could not reach the shared registry");
  if (!f.exists) block.push("account does not exist on NEAR (funds sent there would be lost)");

  const alike = lookalikes(f.account, f.allowlist);
  if (alike.length) block.push(`looks like trusted account ${alike.join(", ")} but is a different account`);

  if (f.exists && !f.allowlisted) warn.push("not on this vault's allowlist (the vault will hold the payment for the owner, or block it)");
  if (f.isContract && !f.allowlisted) warn.push("is a smart contract, not a person or shop account");

  const verdict: Verdict = block.length ? "block" : warn.length ? "warn" : "allow";
  const reasons = block.length ? [...block, ...warn] : warn.length ? warn : ["allowlisted and clear in the shared registry"];
  return { account: f.account, verdict, reasons, facts: f };
}
