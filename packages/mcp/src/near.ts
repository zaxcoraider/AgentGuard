import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider } from "near-api-js";
import { score, type AddressFacts, type CheckResult } from "./score.js";
import { scanText } from "./inject.js";
import { nearToYocto, yoctoToNear } from "./units.js";

export interface Config {
  network: "testnet" | "mainnet";
  rpcUrl: string;
  vault: string;
  /** ed25519:... secret key of the agent's function-call key on the vault. */
  agentKey?: string;
  explorer: string;
}

const RPC: Record<string, string> = {
  testnet: "https://rpc.testnet.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};
const EXPLORER: Record<string, string> = {
  testnet: "https://testnet.nearblocks.io",
  mainnet: "https://nearblocks.io",
};

/** Read config from env. The agent key comes from AGENTGUARD_AGENT_KEY or the near CLI key file. */
export function loadConfig(env = process.env): Config {
  const network = (env.NEAR_NETWORK ?? "testnet") as Config["network"];
  if (network !== "testnet" && network !== "mainnet") throw new Error("NEAR_NETWORK must be testnet or mainnet");
  const vault = env.AGENTGUARD_VAULT;
  if (!vault) throw new Error("Set AGENTGUARD_VAULT to your vault account, e.g. demo2.agentguard.testnet");
  let agentKey = env.AGENTGUARD_AGENT_KEY;
  const keyFile = env.AGENTGUARD_KEY_FILE ?? join(homedir(), ".near-credentials", network, `${vault}.json`);
  if (!agentKey && existsSync(keyFile)) agentKey = JSON.parse(readFileSync(keyFile, "utf8")).private_key;
  return { network, rpcUrl: env.NEAR_RPC_URL ?? RPC[network], vault, agentKey, explorer: EXPLORER[network] };
}

export interface PaymentResult {
  id: string;
  status: "paid" | "pending" | "blocked";
  reason: string | null;
}

const EMPTY_CODE_HASH = "11111111111111111111111111111111";

export class AgentGuard {
  readonly provider: JsonRpcProvider;
  constructor(readonly cfg: Config) {
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  }

  view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.provider.callFunction({ contractId, method, args }) as Promise<T>;
  }

  /** Ask the vault to pay. Signed with the agent's function-call key; the vault decides. */
  /** Ask the vault to pay. forceReview = the vault holds it for the owner whatever the other rules say. */
  async pay(recipient: string, amountNear: string, memo?: string, opts: { forceReview?: boolean } = {}) {
    if (!this.cfg.agentKey)
      throw new Error(`No agent key. Set AGENTGUARD_AGENT_KEY or create ~/.near-credentials/${this.cfg.network}/${this.cfg.vault}.json`);
    const amount = nearToYocto(amountNear);
    const account = new Account(this.cfg.vault, this.provider, this.cfg.agentKey as `ed25519:${string}`);
    const res = await account.callFunctionRaw({
      contractId: this.cfg.vault,
      methodName: "request_payment",
      args: { recipient, amount, memo: memo ?? "", ...(opts.forceReview ? { force_review: true } : {}) },
      gas: 100_000_000_000_000n,
      deposit: 0n,
    });
    const txHash = res.transaction.hash;
    const status = res.status as { SuccessValue?: string; Failure?: unknown };
    if (status.Failure !== undefined) {
      return { ok: false as const, error: JSON.stringify(status.Failure), tx: this.txUrl(txHash) };
    }
    const result = JSON.parse(Buffer.from(status.SuccessValue ?? "", "base64").toString() || "null") as PaymentResult;
    return { ok: true as const, ...result, amount_near: amountNear, recipient, tx: this.txUrl(txHash) };
  }

  async stats() {
    const s = await this.view<Record<string, unknown>>(this.cfg.vault, "get_stats");
    const near = (k: string) => yoctoToNear(String(s[k]));
    return {
      vault: this.cfg.vault,
      balance_near: near("balance"),
      available_near: near("available"),
      spent_24h_near: near("spent_24h"),
      total_paid_near: near("total_paid"),
      paid_count: Number(s.paid_count),
      blocked_count: Number(s.blocked_count),
      blocked_near: near("blocked_amount"),
      pending_count: s.pending_count,
      paused: s.paused,
      locked: s.locked ?? false,
    };
  }

  async policy() {
    const [p, allowlist, registry, locked] = await Promise.all([
      this.view<Record<string, string>>(this.cfg.vault, "get_policy"),
      this.view<string[]>(this.cfg.vault, "get_allowlist"),
      this.view<string | null>(this.cfg.vault, "get_registry").catch(() => null),
      this.view<boolean>(this.cfg.vault, "is_locked").catch(() => false),
    ]);
    return {
      vault: this.cfg.vault,
      max_per_payment_near: yoctoToNear(p.max_per_payment),
      daily_limit_near: yoctoToNear(p.daily_limit),
      needs_owner_approval_above_near: yoctoToNear(p.approval_threshold),
      unknown_recipients: p.unknown_recipient === "block" ? "blocked" : "held for owner approval",
      pending_expires_after_hours: Number(BigInt(p.pending_ttl_ns) / 3_600_000_000_000n),
      allowlist,
      shared_registry: registry,
      rules_locked: locked,
    };
  }

  async payment(id: string) {
    const p = await this.view<Record<string, unknown> | null>(this.cfg.vault, "get_payment", { id });
    if (!p) return null;
    return { ...p, amount_near: yoctoToNear(String(p.amount)) };
  }

  async history(limit = 10) {
    const h = await this.view<Record<string, unknown>[]>(this.cfg.vault, "get_history", { limit });
    return h.map((p) => ({ id: p.id, status: p.status, reason: p.reason, recipient: p.recipient, amount_near: yoctoToNear(String(p.amount)), memo: p.memo }));
  }

  /** Gather facts about a recipient and score them. */
  async checkAddress(account: string, opts: { vault?: string | null; registry?: string; context?: string } = {}): Promise<CheckResult> {
    // By default judge against our own vault. vault: null = no vault (no allowlist), registry given explicitly.
    const vault = opts.vault === undefined ? this.cfg.vault : opts.vault;
    const allowlist = vault ? await this.view<string[]>(vault, "get_allowlist").catch(() => [] as string[]) : [];
    const registry = opts.registry ?? (vault ? await this.view<string | null>(vault, "get_registry").catch(() => null) : null);

    let exists = false;
    let isContract = false;
    try {
      const a = (await this.provider.viewAccount({ accountId: account })) as unknown as Record<string, unknown>;
      exists = true;
      const code = String(a.code_hash ?? EMPTY_CODE_HASH);
      isContract = code !== EMPTY_CODE_HASH || Boolean(a.global_contract_hash) || Boolean(a.global_contract_account_id);
    } catch {
      exists = false;
    }

    let registryStatus: AddressFacts["registryStatus"] = registry ? "unknown" : "none";
    let registryReasons: string[] = [];
    if (registry) {
      try {
        const st = await this.view<{ status: AddressFacts["registryStatus"] }>(registry, "get_status", { account });
        registryStatus = st.status;
        if (st.status !== "clear") {
          const e = await this.view<{ reports: { reason: string }[] } | null>(registry, "get_entry", { account });
          registryReasons = (e?.reports ?? []).map((r) => r.reason);
        }
      } catch {
        registryStatus = "unknown";
      }
    }
    const injection = opts.context ? scanText(opts.context, { recipient: account, self: vault ? [vault] : [] }) : undefined;
    return score({ account, exists, isContract, registryStatus, registryReasons, allowlisted: allowlist.includes(account), allowlist, hasAllowlist: Boolean(vault) }, injection);
  }

  txUrl(hash: string) {
    return `${this.cfg.explorer}/txns/${hash}`;
  }
}
