// x402-style "pay per request" over HTTP 402, settled in native NEAR on-chain.
//
// x402 (https://x402.org) defines the shape: the server answers 402 with what it accepts,
// the client pays and retries with an X-PAYMENT header, the server checks the payment and
// answers with an X-PAYMENT-RESPONSE header. x402 has no official NEAR scheme, so this is
// our own "exact" scheme on network "near-testnet" / "near-mainnet":
//   - the 402 names a one-time nonce; the buyer pays `payTo` with memo "x402:<nonce>"
//     (either through its AgentGuard vault's request_payment, or a direct deposit call),
//   - X-PAYMENT carries {nonce, tx_hash, payer},
//   - the server reads that tx from a NEAR RPC node and checks the memo, the payer and
//     that at least the price really arrived at payTo. Each nonce and tx is used once.
// No facilitator: the seller verifies against the chain itself.

export const X402_VERSION = 1;

export interface PaymentRequirements {
  scheme: "exact";
  network: string; // "near-testnet" | "near-mainnet"
  maxAmountRequired: string; // yoctoNEAR
  asset: "NEAR";
  payTo: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: { nonce: string; memo: string; how: string };
}

export interface PaymentRequired {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
}

export interface PaymentPayload {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: { nonce: string; tx_hash: string; payer: string };
}

export interface SettleResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
  amount: string; // yoctoNEAR that arrived
}

export const memoFor = (nonce: string) => `x402:${nonce}`;

export function encodeHeader(v: unknown): string {
  return Buffer.from(JSON.stringify(v), "utf8").toString("base64");
}

export function decodeHeader<T>(h: string): T {
  if (h.length > 4096) throw new Error("X-PAYMENT header too large");
  return JSON.parse(Buffer.from(h, "base64").toString("utf8")) as T;
}

// ---- verifying a NEAR transaction (pure, so it can be unit tested on recorded txs) ----

type Action = { FunctionCall?: { method_name: string; args: string; deposit: string }; Transfer?: { deposit: string } } | string;

/** The parts of an EXPERIMENTAL_tx_status result we read. */
export interface TxStatus {
  status: { SuccessValue?: string; Failure?: unknown };
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: Action[] };
  receipts: { receipt_id: string; predecessor_id: string; receiver_id: string; receipt: { Action?: { actions: Action[] } } }[];
  receipts_outcome: { id: string; outcome: { executor_id: string; status: { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown } } }[];
}

export type Verified = { ok: true; payer: string; amount: bigint } | { ok: false; reason: string };

function actionDeposit(a: Action): bigint {
  if (typeof a === "string") return 0n;
  return BigInt(a.Transfer?.deposit ?? a.FunctionCall?.deposit ?? "0");
}

function argsOf(a: Action): Record<string, unknown> | null {
  if (typeof a === "string" || !a.FunctionCall) return null;
  try {
    return JSON.parse(Buffer.from(a.FunctionCall.args, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Did this tx pay `payTo` at least `minYocto`, with memo `memo`, signed by `payer`?
 * Accepts two ways to pay:
 *   1. vault: tx to the payer's AgentGuard vault, request_payment {recipient: payTo, memo}
 *   2. direct: tx to payTo, deposit {memo} with NEAR attached
 * Money counted = successful receipts into payTo that carry NEAR, not sent by "system"
 * (gas refunds come from "system" and must not count as payment).
 */
export function verifyNearPayment(tx: TxStatus, want: { payTo: string; minYocto: bigint; memo: string; payer: string }): Verified {
  if (tx.status.Failure !== undefined) return { ok: false, reason: "transaction failed" };
  if (tx.transaction.signer_id !== want.payer) return { ok: false, reason: `tx was signed by ${tx.transaction.signer_id}, not ${want.payer}` };

  const call = tx.transaction.actions.map(argsOf).find((a) => a !== null);
  const method = tx.transaction.actions.map((a) => (typeof a === "string" ? undefined : a.FunctionCall?.method_name)).find(Boolean);
  if (!call || call.memo !== want.memo) return { ok: false, reason: `memo is not "${want.memo}"` };
  if (method === "request_payment") {
    if (call.recipient !== want.payTo) return { ok: false, reason: `vault payment went to ${String(call.recipient)}, not ${want.payTo}` };
  } else if (method === "deposit") {
    if (tx.transaction.receiver_id !== want.payTo) return { ok: false, reason: `deposit was sent to ${tx.transaction.receiver_id}, not ${want.payTo}` };
  } else {
    return { ok: false, reason: `unsupported method ${String(method)} (use request_payment or deposit)` };
  }

  const outcome = new Map(tx.receipts_outcome.map((o) => [o.id, o.outcome]));
  let amount = 0n;
  for (const r of tx.receipts) {
    if (r.receiver_id !== want.payTo || r.predecessor_id === "system") continue;
    const o = outcome.get(r.receipt_id);
    if (!o || o.status.Failure !== undefined) continue;
    for (const a of r.receipt.Action?.actions ?? []) amount += actionDeposit(a);
  }
  if (amount < want.minYocto) {
    return { ok: false, reason: amount === 0n ? "no NEAR reached the seller (was the vault payment held or blocked?)" : `only ${amount} yoctoNEAR arrived, price is ${want.minYocto}` };
  }
  return { ok: true, payer: want.payer, amount };
}

/** Fetch a final tx with its receipts from a NEAR RPC node. */
export async function fetchTx(rpcUrl: string, txHash: string, sender: string): Promise<TxStatus> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "x402", method: "EXPERIMENTAL_tx_status", params: { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" } }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as { result?: TxStatus; error?: { cause?: { name?: string }; message?: string } };
  if (!body.result) throw new Error(`RPC could not return tx ${txHash}: ${body.error?.cause?.name ?? body.error?.message ?? res.status}`);
  return body.result;
}

// ---- buyer side ----

/** What an AgentGuard vault can do for us: pay through its rules. */
export interface Payer {
  cfg: { vault: string; network: string };
  pay(recipient: string, amountNear: string, memo?: string): Promise<{ ok: true; status: string; reason: string | null; tx: string } | { ok: false; error: string; tx: string }>;
}

export interface PaidFetchResult {
  status: number;
  body: unknown;
  paid?: { amount_near: string; pay_to: string; tx: string; vault_status: string; settle?: SettleResponse };
}

/**
 * GET a URL; if it answers 402 with a NEAR "exact" offer, pay it through our vault and retry.
 * The 402 comes from a server we don't control, so: refuse prices above maxYocto, only
 * pay on our own network, and let the vault's on-chain rules have the last word.
 */
export async function fetchWithVaultPayment(
  url: string,
  payer: Payer,
  opts: { maxYocto: bigint; retries?: number; retryDelayMs?: number; fetchImpl?: typeof fetch; toNear: (y: bigint) => string },
): Promise<PaidFetchResult> {
  const f = opts.fetchImpl ?? fetch;
  const first = await f(url, { signal: AbortSignal.timeout(30_000) });
  if (first.status !== 402) return { status: first.status, body: await first.json().catch(() => null) };

  const offer = ((await first.json()) as PaymentRequired).accepts?.find((a) => a.scheme === "exact" && a.network === `near-${payer.cfg.network}` && a.asset === "NEAR");
  if (!offer) throw new Error(`The server wants a payment we can't make (no NEAR offer on near-${payer.cfg.network})`);
  const price = BigInt(offer.maxAmountRequired);
  if (price > opts.maxYocto) throw new Error(`The server asks ${opts.toNear(price)} NEAR, above your limit of ${opts.toNear(opts.maxYocto)} NEAR. Not paid.`);
  if (!offer.extra?.nonce || offer.extra.memo !== memoFor(offer.extra.nonce)) throw new Error("Malformed 402 offer (nonce/memo)");

  const amountNear = opts.toNear(price);
  const r = await payer.pay(offer.payTo, amountNear, offer.extra.memo);
  if (!r.ok) throw new Error(`Vault call failed: ${r.error} (${r.tx})`);
  const txHash = r.tx.split("/").pop()!;
  const paid = { amount_near: amountNear, pay_to: offer.payTo, tx: r.tx, vault_status: r.status };
  if (r.status !== "paid") return { status: 402, body: { error: `Your vault did not send the payment: ${r.status} (${r.reason})` }, paid };

  const header = encodeHeader({ x402Version: X402_VERSION, scheme: "exact", network: offer.network, payload: { nonce: offer.extra.nonce, tx_hash: txHash, payer: payer.cfg.vault } } satisfies PaymentPayload);
  let last: Response | undefined;
  for (let i = 0; i <= (opts.retries ?? 4); i++) {
    if (i) await new Promise((ok) => setTimeout(ok, opts.retryDelayMs ?? 2000));
    last = await f(url, { headers: { "x-payment": header }, signal: AbortSignal.timeout(30_000) });
    if (last.status !== 402) break; // 402 here = seller can't see the tx yet; retry
  }
  const settleHeader = last!.headers.get("x-payment-response");
  return {
    status: last!.status,
    body: await last!.json().catch(() => null),
    paid: { ...paid, settle: settleHeader ? decodeHeader<SettleResponse>(settleHeader) : undefined },
  };
}
