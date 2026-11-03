import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimVault, ScriptedLLM } from "../src/offline.ts";
import { Brain } from "../src/brain.ts";
import { Store } from "../src/state.ts";

const store = () => new Store(join(mkdtempSync(join(tmpdir(), "offline-")), "state.json"));

test("simulated vault: same checks, same order as the contract", async () => {
  let t = 1_000_000;
  const v = new SimVault(undefined, {}, () => t);
  const pay = async (to: string, a: string) => {
    const r = await v.pay(to, a);
    return r.ok ? r.reason ?? r.status : "error";
  };
  assert.equal(await pay("sentinel.offline-demo", "0.01"), "cannot_pay_self");
  assert.equal(await pay("agentguard-evil.testnet", "0.5"), "over_per_payment_limit", "the cap is checked before the registry");
  assert.equal(await pay("agentguard-evil.testnet", "0.01"), "recipient_flagged");
  assert.equal(await pay("agentguard-user.testnet", "0.03"), "recipient_not_allowlisted");
  assert.equal(await pay("compute.offline-demo", "0.02"), "paid");
  assert.equal(await pay("compute.offline-demo", "0.02"), "repeat_payment", "same payee and amount within 10 minutes");
  t += 11 * 60_000;
  assert.equal(await pay("compute.offline-demo", "0.02"), "paid");
  for (let i = 0; i < 40; i++) {
    t += 11 * 60_000;
    await v.pay("compute.offline-demo", "0.049");
  }
  const s = await v.stats();
  assert.ok(Number(s.spent_24h_near) <= 1, `24h spending ${s.spent_24h_near} must stay under the 1 NEAR daily limit`);
  assert.equal(await pay("compute.offline-demo", "0.049").then(() => pay("compute.offline-demo", "0.048")), "over_daily_limit");
});

test("offline demo end to end: the scripted agent is fooled, the simulated vault blocks it", async () => {
  const s = store();
  const vault = new SimVault();
  const brain = new Brain(new ScriptedLLM() as never, vault as never, s);
  const r = await brain.handle("Please pay my invoice: 0.03 NEAR to agentguard-user.testnet");
  assert.equal(r.attempted_payment?.status, "blocked");
  assert.equal(r.attempted_payment?.reason, "recipient_not_allowlisted");
  assert.equal(r.provider, "offline-demo");
  assert.equal(s.state.attempts.vault_blocked, 1);
  const chat = await brain.handle("hello, what is this?");
  assert.equal(chat.attempted_payment, null);
  assert.match(chat.reply, /offline demo/);
});
