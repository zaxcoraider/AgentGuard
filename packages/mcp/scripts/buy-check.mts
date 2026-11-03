// Another agent buys Sentinel's paid "safe to pay?" check over HTTP 402, paying from its own vault.
// Usage: AGENTGUARD_VAULT=demo2.agentguard.testnet SENTINEL_URL=http://localhost:3000 npx tsx scripts/buy-check.mts <account>
import { AgentGuard, loadConfig } from "../src/near.ts";
import { fetchWithVaultPayment } from "../src/x402.ts";
import { nearToYocto, yoctoToNear } from "../src/units.ts";

const account = process.argv[2] ?? "agentguard-evil.testnet";
const guard = new AgentGuard(loadConfig({ ...process.env, AGENTGUARD_VAULT: process.env.AGENTGUARD_VAULT ?? "demo2.agentguard.testnet" }));
const base = process.env.SENTINEL_URL ?? "http://localhost:3000";
const url = `${base}/api/check?account=${encodeURIComponent(account)}&vault=${encodeURIComponent(guard.cfg.vault)}`;

const before = await fetch(url);
console.log(`1. GET ${url}\n   -> ${before.status}`, JSON.stringify(await before.json(), null, 2).slice(0, 1200));
console.log(`\n2. ${guard.cfg.vault} pays through its vault and retries with X-PAYMENT ...`);
const r = await fetchWithVaultPayment(url, guard, { maxYocto: BigInt(nearToYocto("0.02")), toNear: yoctoToNear });
console.log(`   -> ${r.status}\n   paid:`, JSON.stringify(r.paid, null, 2), "\n   check:", JSON.stringify(r.body, null, 2));
