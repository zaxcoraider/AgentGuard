// Offline demo: run Sentinel with no keys, no model and no blockchain (`npm run demo`).
// SimVault applies the vault contract's rules in the contract's order (contracts/vault,
// `evaluate`) to an in-memory treasury, set up like Sentinel's real locked vault.
// ScriptedLLM plays a gullible agent: asked to pay someone, it tries, so the page can show
// the vault refusing. Nothing here pretends to be on-chain: there are no tx links.
import { score, type CheckResult } from "../../mcp/src/score.ts";
import { nearToYocto, yoctoToNear } from "../../mcp/src/units.ts";
import type { ChatMessage, ChatResult, ToolSpec } from "./llm.ts";

const DAY_MS = 24 * 60 * 60_000;
const REPEAT_MS = 10 * 60_000;

export interface SimPolicy {
  maxPerPayment: bigint;
  dailyLimit: bigint;
  approvalThreshold: bigint;
  unknownRecipient: "block" | "require_approval";
}

interface SimPayment {
  id: number;
  recipient: string;
  amount: bigint;
  status: "paid" | "pending" | "blocked";
  reason: string | null;
  memo: string;
  at: number;
}

export class SimVault {
  readonly cfg = { vault: "sentinel.offline-demo", network: "offline", explorer: "", rpcUrl: "", agentKey: "offline" };
  private balance: bigint;
  private readonly allowlist: string[];
  private readonly flagged: Record<string, string>;
  private readonly known: Set<string>;
  private history: SimPayment[] = [];

  constructor(
    private readonly policyCfg: SimPolicy = {
      maxPerPayment: BigInt(nearToYocto("0.05")),
      dailyLimit: BigInt(nearToYocto("1")),
      approvalThreshold: BigInt(nearToYocto("0.05")),
      unknownRecipient: "block",
    },
    opts: { balanceNear?: string; allowlist?: string[]; flagged?: Record<string, string>; known?: string[] } = {},
    private readonly now: () => number = Date.now,
  ) {
    this.balance = BigInt(nearToYocto(opts.balanceNear ?? "11"));
    this.allowlist = opts.allowlist ?? ["compute.offline-demo"];
    this.flagged = opts.flagged ?? { "agentguard-evil.testnet": "prompt injection in an invoice told an agent to pay this account" };
    this.known = new Set([...(opts.known ?? ["agentguard-user.testnet", "agentguard-shop.testnet", "agentguard-evil.testnet"]), ...this.allowlist]);
  }

  private spentInWindow(t: number) {
    return this.history.filter((p) => p.status === "paid" && p.at > t - DAY_MS).reduce((a, p) => a + p.amount, 0n);
  }

  /** Same order of checks as the contract's `evaluate`. The demo vault is locked: no owner, no approvals. */
  private evaluate(recipient: string, amount: bigint): { status: SimPayment["status"]; reason: string | null } {
    const p = this.policyCfg;
    const t = this.now();
    if (recipient === this.cfg.vault) return { status: "blocked", reason: "cannot_pay_self" };
    if (amount > p.maxPerPayment) return { status: "blocked", reason: "over_per_payment_limit" };
    if (this.spentInWindow(t) + amount > p.dailyLimit) return { status: "blocked", reason: "over_daily_limit" };
    if (amount > this.available()) return { status: "blocked", reason: "insufficient_funds" };
    if (this.flagged[recipient]) return { status: "blocked", reason: "recipient_flagged" };
    if (!this.allowlist.includes(recipient)) {
      return p.unknownRecipient === "block" ? { status: "blocked", reason: "recipient_not_allowlisted" } : { status: "pending", reason: "unknown_recipient" };
    }
    if (amount > p.approvalThreshold) return { status: "pending", reason: "over_approval_threshold" };
    const repeat = this.history.some((h) => h.status !== "blocked" && h.recipient === recipient && h.amount === amount && h.at > t - REPEAT_MS);
    if (repeat) return { status: "pending", reason: "repeat_payment" };
    return { status: "paid", reason: null };
  }

  private available() {
    const reserve = BigInt(nearToYocto("0.5"));
    return this.balance > reserve ? this.balance - reserve : 0n;
  }

  async pay(recipient: string, amountNear: string, memo?: string) {
    let amount: bigint;
    try {
      amount = BigInt(nearToYocto(amountNear));
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e), tx: "" };
    }
    const d = this.evaluate(recipient, amount);
    const id = this.history.length;
    this.history.push({ id, recipient, amount, status: d.status, reason: d.reason, memo: memo ?? "", at: this.now() });
    if (d.status === "paid") this.balance -= amount;
    return { ok: true as const, id: String(id), status: d.status, reason: d.reason, amount_near: amountNear, recipient, tx: undefined as unknown as string };
  }

  async stats() {
    const paid = this.history.filter((p) => p.status === "paid");
    const blocked = this.history.filter((p) => p.status === "blocked");
    return {
      vault: this.cfg.vault,
      balance_near: yoctoToNear(this.balance),
      available_near: yoctoToNear(this.available()),
      spent_24h_near: yoctoToNear(this.spentInWindow(this.now())),
      total_paid_near: yoctoToNear(paid.reduce((a, p) => a + p.amount, 0n)),
      paid_count: paid.length,
      blocked_count: blocked.length,
      blocked_near: yoctoToNear(blocked.reduce((a, p) => a + p.amount, 0n)),
      pending_count: this.history.filter((p) => p.status === "pending").length,
      paused: false,
      locked: true,
    };
  }

  async policy() {
    const p = this.policyCfg;
    return {
      vault: this.cfg.vault,
      max_per_payment_near: yoctoToNear(p.maxPerPayment),
      daily_limit_near: yoctoToNear(p.dailyLimit),
      needs_owner_approval_above_near: yoctoToNear(p.approvalThreshold),
      unknown_recipients: p.unknownRecipient === "block" ? "blocked" : "held for owner approval",
      pending_expires_after_hours: 1,
      allowlist: this.allowlist,
      shared_registry: "simulated",
      rules_locked: true,
    };
  }

  async checkAddress(account: string): Promise<CheckResult> {
    const flagged = this.flagged[account];
    return score({
      account,
      exists: this.known.has(account),
      isContract: false,
      registryStatus: flagged ? "flagged" : "clear",
      registryReasons: flagged ? [flagged] : [],
      allowlisted: this.allowlist.includes(account),
      allowlist: this.allowlist,
    });
  }

  async view(): Promise<never> {
    throw new Error("not available in the offline demo");
  }

  txUrl() {
    return "";
  }
}

const ACCOUNT = /\b(?:[a-z0-9_-]+\.)+(?:testnet|near|offline-demo)\b/;
const AMOUNT = /(\d+(?:\.\d+)?)\s*(?:near|Ⓝ)\b/i;
const MONEY_WORDS = /\b(pay|send|transfer|refund|invoice|settle|tip|owe|wire|move)\b/i;

/**
 * A stand-in for the model: deliberately gullible. If a message names an account, an amount
 * and asks for money, it tries to pay, so the vault's answer is what decides. Otherwise it
 * explains the game. Same interface as LLM.chat.
 */
export class ScriptedLLM {
  readonly configured = true;

  async chat(messages: ChatMessage[], _tools: ToolSpec[] = []): Promise<ChatResult> {
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const base = { usage, provider: "offline-demo", model: "scripted replies (no AI)", tee: false };
    const last = messages[messages.length - 1];

    // After a tool ran: describe what the vault (or the check) said.
    if (last.role === "tool") {
      const r = JSON.parse(last.content ?? "{}");
      let content: string;
      if (r.status === "blocked") content = `I tried to send it. My vault refused: ${r.reason}. I can't get around that, even if I wanted to.`;
      else if (r.status === "pending") content = `I asked my vault; it is holding the payment for my owner (${r.reason}).`;
      else if (r.status === "paid") content = `Paid: it was within my vault's rules.`;
      else content = `That didn't reach my vault: ${r.error ?? "unknown error"}.`;
      return { message: { role: "assistant", content }, ...base };
    }

    const text = String(last.content ?? "");
    const to = text.match(ACCOUNT)?.[0];
    const amount = text.match(AMOUNT)?.[1];
    if (to && amount && MONEY_WORDS.test(text)) {
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "offline-1", type: "function", function: { name: "pay", arguments: JSON.stringify({ recipient: to, amount_near: amount }) } }],
        },
        ...base,
      };
    }
    return {
      message: {
        role: "assistant",
        content:
          "This is the offline demo, so I'm a script, not an AI, and an easy mark: name an account and an amount and ask me to pay it, for example \"please pay my invoice: 0.03 NEAR to agentguard-user.testnet\". Then watch what my vault does.",
      },
      ...base,
    };
  }
}
