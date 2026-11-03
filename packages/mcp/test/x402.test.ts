import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyNearPayment, encodeHeader, decodeHeader, type TxStatus } from "../src/x402.ts";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const PRICE = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
const want = { payTo: "sentinel.testnet", minYocto: PRICE, memo: "x402:abc", payer: "buyer-vault.testnet" };

/** Shaped like a real testnet request_payment tx (see docs/TESTNET-RESULTS.md), incl. the gas refund from "system". */
function vaultTx(o: { memo?: string; recipient?: string; paid?: bigint; transferFails?: boolean; signer?: string } = {}): TxStatus {
  const recipient = o.recipient ?? "sentinel.testnet";
  const paid = o.paid ?? PRICE;
  return {
    status: { SuccessValue: b64({ id: "3", status: "paid", reason: null }) },
    transaction: {
      hash: "H",
      signer_id: o.signer ?? "buyer-vault.testnet",
      receiver_id: "buyer-vault.testnet",
      actions: [{ FunctionCall: { method_name: "request_payment", args: b64({ recipient, amount: paid.toString(), memo: o.memo ?? "x402:abc" }), deposit: "0" } }],
    },
    receipts: [
      { receipt_id: "r1", predecessor_id: "buyer-vault.testnet", receiver_id: "registry.testnet", receipt: { Action: { actions: [{ FunctionCall: { method_name: "get_status", args: "", deposit: "0" } }] } } },
      { receipt_id: "r2", predecessor_id: "buyer-vault.testnet", receiver_id: recipient, receipt: { Action: { actions: [{ Transfer: { deposit: paid.toString() } }] } } },
      { receipt_id: "r3", predecessor_id: "system", receiver_id: "sentinel.testnet", receipt: { Action: { actions: [{ Transfer: { deposit: "92488601961342300000000" } }] } } },
    ],
    receipts_outcome: [
      { id: "r1", outcome: { executor_id: "registry.testnet", status: { SuccessValue: "" } } },
      { id: "r2", outcome: { executor_id: recipient, status: o.transferFails ? { Failure: {} } : { SuccessValue: "" } } },
      { id: "r3", outcome: { executor_id: "sentinel.testnet", status: { SuccessValue: "" } } },
    ],
  };
}

test("a vault payment with the right memo, payee and amount is accepted", () => {
  const v = verifyNearPayment(vaultTx(), want);
  assert.deepEqual(v, { ok: true, payer: "buyer-vault.testnet", amount: PRICE });
});

test("gas refunds from 'system' never count as payment", () => {
  // Blocked/held vault payment: no transfer, but a big refund lands at payTo. Must be refused.
  const tx = vaultTx();
  tx.receipts.splice(1, 1);
  tx.receipts_outcome.splice(1, 1);
  const v = verifyNearPayment(tx, want);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /no NEAR reached/);
});

test("wrong memo, wrong payee, wrong signer, too little, failed transfer: all refused", () => {
  assert.equal(verifyNearPayment(vaultTx({ memo: "x402:other" }), want).ok, false);
  assert.equal(verifyNearPayment(vaultTx({ recipient: "evil.testnet" }), want).ok, false);
  assert.equal(verifyNearPayment(vaultTx({ signer: "someone-else.testnet" }), want).ok, false);
  assert.equal(verifyNearPayment(vaultTx({ paid: PRICE - 1n }), want).ok, false);
  assert.equal(verifyNearPayment(vaultTx({ transferFails: true }), want).ok, false);
  const failed = vaultTx();
  failed.status = { Failure: { ActionError: {} } };
  assert.equal(verifyNearPayment(failed, want).ok, false);
});

test("a direct deposit call with the memo is accepted", () => {
  const tx: TxStatus = {
    status: { SuccessValue: "" },
    transaction: { hash: "H", signer_id: "alice.testnet", receiver_id: "sentinel.testnet", actions: [{ FunctionCall: { method_name: "deposit", args: b64({ memo: "x402:abc" }), deposit: PRICE.toString() } }] },
    receipts: [{ receipt_id: "r1", predecessor_id: "alice.testnet", receiver_id: "sentinel.testnet", receipt: { Action: { actions: [{ FunctionCall: { method_name: "deposit", args: "", deposit: PRICE.toString() } }] } } }],
    receipts_outcome: [{ id: "r1", outcome: { executor_id: "sentinel.testnet", status: { SuccessValue: "" } } }],
  };
  assert.equal(verifyNearPayment(tx, { ...want, payer: "alice.testnet" }).ok, true);
  tx.transaction.receiver_id = "elsewhere.testnet";
  assert.equal(verifyNearPayment(tx, { ...want, payer: "alice.testnet" }).ok, false);
});

test("headers round-trip as base64 JSON", () => {
  const v = { x402Version: 1, payload: { nonce: "n" } };
  assert.deepEqual(decodeHeader(encodeHeader(v)), v);
});

// ---- buyer ----
import { fetchWithVaultPayment } from "../src/x402.ts";
import { yoctoToNear } from "../src/units.ts";

function fakeServer(price: bigint) {
  const seen: (string | null)[] = [];
  const f = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    const pay = init?.headers?.["x-payment"] ?? null;
    seen.push(pay);
    if (!pay) {
      const body = { x402Version: 1, error: "pay", accepts: [{ scheme: "exact", network: "near-testnet", asset: "NEAR", maxAmountRequired: price.toString(), payTo: "sentinel.testnet", extra: { nonce: "n1", memo: "x402:n1" } }] };
      return new Response(JSON.stringify(body), { status: 402 });
    }
    return new Response(JSON.stringify({ verdict: "allow" }), { status: 200, headers: { "x-payment-response": encodeHeader({ success: true }) } });
  }) as unknown as typeof fetch;
  return { f, seen };
}

function fakeVault() {
  const calls: unknown[] = [];
  return {
    calls,
    cfg: { vault: "buyer.testnet", network: "testnet" },
    async pay(recipient: string, amountNear: string, memo?: string) {
      calls.push({ recipient, amountNear, memo });
      return { ok: true as const, status: "paid", reason: null, tx: "https://explorer/txns/7jna1nTKB2dBVTs3bSphirCkVVbV2HhW11QRfi5Vf7wc" };
    },
  };
}

test("buyer pays through its vault with the server's memo, then retries with X-PAYMENT", async () => {
  const { f, seen } = fakeServer(PRICE);
  const v = fakeVault();
  const r = await fetchWithVaultPayment("http://s/api/check", v, { maxYocto: PRICE * 2n, fetchImpl: f, toNear: yoctoToNear });
  assert.equal(r.status, 200);
  assert.deepEqual(v.calls, [{ recipient: "sentinel.testnet", amountNear: "0.01", memo: "x402:n1" }]);
  const sent = decodeHeader<{ payload: { tx_hash: string; payer: string } }>(seen[1]!);
  assert.equal(sent.payload.payer, "buyer.testnet");
  assert.equal(sent.payload.tx_hash, "7jna1nTKB2dBVTs3bSphirCkVVbV2HhW11QRfi5Vf7wc");
});

test("buyer refuses a price above its limit and pays nothing", async () => {
  const { f } = fakeServer(PRICE * 10n);
  const v = fakeVault();
  await assert.rejects(fetchWithVaultPayment("http://s", v, { maxYocto: PRICE, fetchImpl: f, toNear: yoctoToNear }), /above your limit/);
  assert.equal(v.calls.length, 0);
});
