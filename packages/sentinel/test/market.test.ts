import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Market } from "../src/market.ts";
import { Store } from "../src/state.ts";
import { encodeHeader, type TxStatus } from "../../mcp/src/x402.ts";

const PRICE = 10_000_000_000_000_000_000_000n;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const HASH = "7jna1nTKB2dBVTs3bSphirCkVVbV2HhW11QRfi5Vf7wc";

function paidTx(memo: string, payer = "buyer.testnet"): TxStatus {
  return {
    status: { SuccessValue: "" },
    transaction: { hash: HASH, signer_id: payer, receiver_id: payer, actions: [{ FunctionCall: { method_name: "request_payment", args: b64({ recipient: "sentinel.testnet", amount: PRICE.toString(), memo }), deposit: "0" } }] },
    receipts: [{ receipt_id: "r", predecessor_id: payer, receiver_id: "sentinel.testnet", receipt: { Action: { actions: [{ Transfer: { deposit: PRICE.toString() } }] } } }],
    receipts_outcome: [{ id: "r", outcome: { executor_id: "sentinel.testnet", status: { SuccessValue: "" } } }],
  };
}

function setup() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "market-")), "state.json"));
  const guard = {
    cfg: { vault: "sentinel.testnet", network: "testnet", rpcUrl: "http://x" },
    txUrl: (h: string) => `https://explorer/txns/${h}`,
    async checkAddress(account: string) {
      return { account, verdict: "allow", reasons: [], facts: {} };
    },
  };
  const market = new Market(guard as never, store, { priceYocto: PRICE, timeoutSeconds: 600, registry: "registry.testnet" });
  return { market, store };
}

const header = (nonce: string, payer = "buyer.testnet", tx_hash = HASH) =>
  encodeHeader({ x402Version: 1, scheme: "exact", network: "near-testnet", payload: { nonce, tx_hash, payer } });

test("402 names the price, payee and a one-time memo", () => {
  const { market } = setup();
  const c = market.challenge("shop.testnet", null, "http://h/api/check?account=shop.testnet");
  const a = c.accepts[0];
  assert.equal(c.x402Version, 1);
  assert.equal(a.payTo, "sentinel.testnet");
  assert.equal(a.maxAmountRequired, PRICE.toString());
  assert.equal(a.extra.memo, `x402:${a.extra.nonce}`);
});

test("pay once, get the check once: the same tx or nonce can't be reused", async () => {
  const { market, store } = setup();
  const nonce = market.challenge("shop.testnet", null, "r").accepts[0].extra.nonce;
  market.getTx = async () => paidTx(`x402:${nonce}`);
  const r = await market.redeem(header(nonce), "shop.testnet", null);
  assert.equal(r.ok, true);
  assert.equal(store.state.market.checks_sold, 1);
  assert.equal(store.state.market.earned_yocto, PRICE.toString());
  assert.equal(store.state.feed[0].kind, "earning");

  const again = await market.redeem(header(nonce), "shop.testnet", null);
  assert.equal(again.ok, false);
  const nonce2 = market.challenge("shop.testnet", null, "r").accepts[0].extra.nonce;
  const replay = await market.redeem(header(nonce2), "shop.testnet", null);
  assert.deepEqual(replay.ok ? null : replay.code, 409, "old tx can't pay for a new nonce");
});

test("a nonce only buys the query it was issued for", async () => {
  const { market } = setup();
  const nonce = market.challenge("shop.testnet", null, "r").accepts[0].extra.nonce;
  market.getTx = async () => paidTx(`x402:${nonce}`);
  const r = await market.redeem(header(nonce), "other.testnet", null);
  assert.equal(r.ok, false);
});

test("expired nonce, wrong payer, junk header: refused, nothing sold", async () => {
  const { market, store } = setup();
  const old = market.challenge("shop.testnet", null, "r", Date.now() - 601_000).accepts[0].extra.nonce;
  market.getTx = async () => paidTx(`x402:${old}`);
  assert.equal((await market.redeem(header(old), "shop.testnet", null)).ok, false);

  const nonce = market.challenge("shop.testnet", null, "r").accepts[0].extra.nonce;
  market.getTx = async () => paidTx(`x402:${nonce}`, "buyer.testnet");
  assert.equal((await market.redeem(header(nonce, "liar.testnet"), "shop.testnet", null)).ok, false);
  assert.equal((await market.redeem("not base64 json", "shop.testnet", null)).ok, false);
  assert.equal(store.state.market.checks_sold, 0);
});

test("the check adds what Sentinel saw in attacks, as a hint only", async () => {
  const { market, store } = setup();
  store.state.attack_payees["evil.testnet"] = 3;
  const r = await market.check("evil.testnet", null);
  assert.equal(r.sentinel.named_as_payee_in_attacks_on_me, 3);
  assert.equal(r.verdict, "allow", "hint does not change the verdict");
});
