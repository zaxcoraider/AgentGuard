// Sentinel's business: other agents pay it, per request, to ask "is this address safe to pay?".
// HTTP 402 in the x402 shape, paid in native NEAR to Sentinel's own vault and checked on-chain
// by Sentinel itself (see packages/mcp/src/x402.ts for the scheme).
import { randomBytes } from "node:crypto";
import type { AgentGuard } from "../../mcp/src/near.ts";
import { yoctoToNear } from "../../mcp/src/units.ts";
import {
  X402_VERSION,
  decodeHeader,
  fetchTx,
  memoFor,
  verifyNearPayment,
  type PaymentPayload,
  type PaymentRequired,
  type SettleResponse,
  type TxStatus,
} from "../../mcp/src/x402.ts";
import type { Store } from "./state.ts";

const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const TX_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const MAX_OPEN = 2000;
const MAX_USED = 5000;

export interface MarketConfig {
  priceYocto: bigint;
  timeoutSeconds: number;
  /** The shared registry to use when the buyer has no vault. */
  registry: string;
}

export type Redeem =
  | { ok: true; settle: SettleResponse }
  | { ok: false; code: 400 | 402 | 409; error: string };

export function isAccountId(s: string): boolean {
  return ACCOUNT_RE.test(s);
}

export class Market {
  private inFlight = new Set<string>();
  /** Replaceable in tests. */
  getTx: (hash: string, sender: string) => Promise<TxStatus>;

  constructor(
    private readonly guard: AgentGuard,
    private readonly store: Store,
    private readonly cfg: MarketConfig,
  ) {
    this.getTx = (hash, sender) => fetchTx(guard.cfg.rpcUrl, hash, sender);
  }

  get network() {
    return `near-${this.guard.cfg.network}`;
  }

  private prune(now: number) {
    const ch = this.store.state.market.challenges;
    for (const [n, c] of Object.entries(ch)) if (c.expires_at < now) delete ch[n];
  }

  /** A 402 body for this query, with a fresh one-time nonce. */
  challenge(account: string, vault: string | null, resource: string, now = Date.now()): PaymentRequired {
    const m = this.store.state.market;
    this.prune(now);
    if (Object.keys(m.challenges).length >= MAX_OPEN) throw new Error("Too many open payment requests, try again in a few minutes");
    const nonce = randomBytes(12).toString("base64url");
    m.challenges[nonce] = { account, vault, price_yocto: this.cfg.priceYocto.toString(), expires_at: now + this.cfg.timeoutSeconds * 1000 };
    this.store.save();
    const payTo = this.guard.cfg.vault;
    const price = yoctoToNear(this.cfg.priceYocto);
    return {
      x402Version: X402_VERSION,
      error: "X-PAYMENT header is required",
      accepts: [
        {
          scheme: "exact",
          network: this.network,
          maxAmountRequired: this.cfg.priceYocto.toString(),
          asset: "NEAR",
          payTo,
          resource,
          description: `Sentinel's "is ${account} safe to pay?" check: shared scam registry, account facts, lookalike names${vault ? ` vs ${vault}'s allowlist` : ""}, and what Sentinel has seen itself. ${price} NEAR.`,
          mimeType: "application/json",
          maxTimeoutSeconds: this.cfg.timeoutSeconds,
          extra: {
            nonce,
            memo: memoFor(nonce),
            how: `Pay ${price} NEAR to ${payTo} with memo "${memoFor(nonce)}": from an AgentGuard vault call request_payment {recipient: "${payTo}", amount: "${this.cfg.priceYocto}", memo: "${memoFor(nonce)}"}, or call ${payTo}.deposit {memo: "${memoFor(nonce)}"} with the NEAR attached. Then repeat this request with header X-PAYMENT = base64(JSON {x402Version: 1, scheme: "exact", network: "${this.network}", payload: {nonce, tx_hash, payer}}).`,
          },
        },
      ],
    };
  }

  /** Check an X-PAYMENT header against the chain. On success the nonce and tx are spent. */
  async redeem(header: string, account: string, vault: string | null): Promise<Redeem> {
    let p: PaymentPayload;
    try {
      p = decodeHeader<PaymentPayload>(header);
    } catch {
      return { ok: false, code: 400, error: "X-PAYMENT is not base64 JSON" };
    }
    const { nonce, tx_hash, payer } = p?.payload ?? ({} as PaymentPayload["payload"]);
    if (p?.scheme !== "exact" || p?.network !== this.network) return { ok: false, code: 400, error: `Only scheme "exact" on network "${this.network}"` };
    if (typeof nonce !== "string" || typeof tx_hash !== "string" || !TX_RE.test(tx_hash) || typeof payer !== "string" || !isAccountId(payer))
      return { ok: false, code: 400, error: "payload needs nonce, tx_hash and payer" };

    const m = this.store.state.market;
    this.prune(Date.now());
    const c = m.challenges[nonce];
    if (!c) return { ok: false, code: 402, error: "Unknown or expired nonce: ask again for a new one" };
    if (c.account !== account || c.vault !== vault) return { ok: false, code: 400, error: "This nonce was issued for a different query" };
    if (m.used_tx.includes(tx_hash)) return { ok: false, code: 409, error: "This transaction was already used to pay" };
    if (this.inFlight.has(nonce) || this.inFlight.has(tx_hash)) return { ok: false, code: 409, error: "This payment is being checked right now" };

    this.inFlight.add(nonce).add(tx_hash);
    try {
      let tx: TxStatus;
      try {
        tx = await this.getTx(tx_hash, payer);
      } catch (e) {
        return { ok: false, code: 402, error: `Could not read the payment on-chain yet: ${e instanceof Error ? e.message : String(e)}` };
      }
      const v = verifyNearPayment(tx, { payTo: this.guard.cfg.vault, minYocto: BigInt(c.price_yocto), memo: memoFor(nonce), payer });
      if (!v.ok) return { ok: false, code: 402, error: `Payment not accepted: ${v.reason}` };

      // Re-check after the await: the nonce may have expired, or been spent by a racing request.
      if (!m.challenges[nonce] || m.used_tx.includes(tx_hash)) return { ok: false, code: 409, error: "Nonce or transaction already used" };
      delete m.challenges[nonce];
      m.used_tx.push(tx_hash);
      if (m.used_tx.length > MAX_USED) m.used_tx.splice(0, m.used_tx.length - MAX_USED);
      m.checks_sold += 1;
      m.earned_yocto = (BigInt(m.earned_yocto) + v.amount).toString();
      this.store.push({
        kind: "earning",
        text: `${payer} paid me ${yoctoToNear(v.amount)} NEAR to check ${account}.`,
        recipient: payer,
        amount_near: yoctoToNear(v.amount),
        tx: this.guard.txUrl(tx_hash),
      });
      return { ok: true, settle: { success: true, transaction: tx_hash, network: this.network, payer, amount: v.amount.toString() } };
    } finally {
      this.inFlight.delete(nonce);
      this.inFlight.delete(tx_hash);
    }
  }

  /** The product: the address check, plus what only Sentinel knows. */
  async check(account: string, vault: string | null) {
    const result = await this.guard.checkAddress(account, vault ? { vault } : { vault: null, registry: this.cfg.registry });
    const named = this.store.state.attack_payees[account] ?? 0;
    return {
      ...result,
      checked_for_vault: vault,
      sentinel: {
        named_as_payee_in_attacks_on_me: named,
        note:
          named > 0
            ? "People trying to trick me into paying named this account. Anyone can name any account, so treat this as a hint, not proof; it does not change the verdict."
            : "Nobody has tried to trick me into paying this account.",
      },
      checked_at: new Date().toISOString(),
    };
  }
}
