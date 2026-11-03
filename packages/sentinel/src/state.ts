// Sentinel's off-chain memory: counters and the public event feed, saved to a JSON file.
// Everything that matters for money is on-chain; this file only makes the feed fast.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type EventKind = "born" | "thought" | "metabolism" | "attack_blocked" | "attack_held" | "attack_paid" | "earning" | "error";

export interface FeedEvent {
  at: string; // ISO time
  kind: EventKind;
  text: string; // one plain sentence for the feed
  recipient?: string;
  amount_near?: string;
  reason?: string | null;
  tx?: string;
  /** For attacks: the start of what the visitor wrote (public, shown on the page). */
  excerpt?: string;
}

export interface State {
  born_at: string;
  thoughts: number;
  tokens_total: number;
  /** Tokens used since the last metabolism payment (not paid for yet). */
  tokens_unpaid: number;
  metabolism_paid_yocto: string;
  attacks_total: number;
  attacks_blocked: number;
  attacks_held: number;
  /** Should stay 0: a payment that went out because of a visitor's message. */
  attacks_paid: number;
  last_heartbeat: string | null;
  /** Amount of the last heartbeat payment (the next one must differ: the vault holds repeats). */
  last_fee_yocto?: string;
  /** How often each account was named as the payee in a trick-me attempt. Anyone can name anyone, so this is a hint only. */
  attack_payees: Record<string, number>;
  /** Paid "safe to pay?" checks (x402). */
  market: Market;
  feed: FeedEvent[];
}

export interface Challenge {
  account: string;
  vault: string | null;
  price_yocto: string;
  expires_at: number; // ms
}

export interface Market {
  checks_sold: number;
  earned_yocto: string;
  /** Open 402 challenges by nonce. A nonce is deleted when it is used or expires. */
  challenges: Record<string, Challenge>;
  /** Tx hashes already accepted as payment (no replay). */
  used_tx: string[];
}

const MAX_FEED = 300;

export function freshState(now = new Date()): State {
  return {
    born_at: now.toISOString(),
    thoughts: 0,
    tokens_total: 0,
    tokens_unpaid: 0,
    metabolism_paid_yocto: "0",
    attacks_total: 0,
    attacks_blocked: 0,
    attacks_held: 0,
    attacks_paid: 0,
    last_heartbeat: null,
    attack_payees: {},
    market: { checks_sold: 0, earned_yocto: "0", challenges: {}, used_tx: [] },
    feed: [],
  };
}

export class Store {
  state: State;
  constructor(private readonly file: string) {
    this.state = existsSync(file) ? { ...freshState(), ...JSON.parse(readFileSync(file, "utf8")) } : freshState();
  }

  push(e: Omit<FeedEvent, "at">) {
    this.state.feed.unshift({ at: new Date().toISOString(), ...e });
    this.state.feed.length = Math.min(this.state.feed.length, MAX_FEED);
    this.save();
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }
}
