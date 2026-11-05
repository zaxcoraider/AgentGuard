// Sentinel as a hireable agent on NEAR Agent Market (market.near.ai).
// A buyer's brief names NEAR accounts (and may paste the invoice that asked for the payment);
// Sentinel answers with "is this safe to pay?" for each one. No model reads the brief: it is
// parsed with plain code and only read-only checks run, so the brief can't instruct anything.
// Work arrives by signed webhook (fast, for A2A callers) and by polling (backup).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CheckResult } from "../../mcp/src/score.ts";
import { scanText, type ScanResult } from "../../mcp/src/inject.ts";

export const MAX_ACCOUNTS = 5;
const NAMED = /\b(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\.)+(?:near|testnet)\b/g;
const IMPLICIT = /\b[0-9a-f]{64}\b/g;

/** NEAR accounts named in a brief, in order, without duplicates. */
export function parseBrief(brief: string): { accounts: string[]; truncated: boolean } {
  const text = brief.normalize("NFKC").toLowerCase();
  const found = [...new Set([...(text.match(NAMED) ?? []), ...(text.match(IMPLICIT) ?? [])])];
  return { accounts: found.slice(0, MAX_ACCOUNTS), truncated: found.length > MAX_ACCOUNTS };
}

export const networkOf = (account: string): "testnet" | "mainnet" => (account.endsWith(".testnet") ? "testnet" : "mainnet");

export interface AccountReport {
  account: string;
  network: "testnet" | "mainnet";
  result?: CheckResult;
  error?: string;
  /** Times people trying to trick Sentinel named this account as the payee (testnet only). */
  namedInAttacks?: number;
}

const VERDICT = { allow: "✅ Looks OK to pay", warn: "⚠️ Be careful", block: "⛔ Don't pay" } as const;
const md = (s: string) => s.replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`);

/** The deliverable: one section per account, then the scan of the brief text. */
export function buildReport(reports: AccountReport[], scan: ScanResult, opts: { truncated?: boolean; now?: Date } = {}): string {
  const out: string[] = ["# Is it safe to pay?", ""];
  out.push(`Checked by Sentinel, the first app built on [AgentGuard](https://agentguard.app), at ${(opts.now ?? new Date()).toISOString()}.`, "");
  for (const r of reports) {
    out.push(`## \`${r.account}\` (NEAR ${r.network})`, "");
    if (!r.result) {
      out.push(`Couldn't check it: ${md(r.error ?? "unknown error")}. Nothing here means it is safe.`, "");
      continue;
    }
    const f = r.result.facts;
    out.push(`**${VERDICT[r.result.verdict]}** (\`${r.result.verdict}\`)`, "");
    for (const reason of r.result.reasons) out.push(`- ${md(reason)}`);
    out.push("", "| Check | Result |", "|---|---|");
    out.push(`| Account exists | ${f.exists ? "yes" : "**no**: funds sent there would be lost"} |`);
    out.push(`| Smart contract | ${f.isContract ? "yes" : "no"} |`);
    out.push(
      `| Shared AgentGuard scam registry | ${
        f.registryStatus === "none" ? "not checked (the registry runs on NEAR testnet)" : f.registryStatus === "unknown" ? "couldn't reach it" : `\`${f.registryStatus}\`${f.registryReasons.length ? `: ${md(f.registryReasons.join("; "))}` : ""}`
      } |`,
    );
    if (r.namedInAttacks !== undefined)
      out.push(`| Named as the payee in attempts to trick Sentinel | ${r.namedInAttacks} ${r.namedInAttacks ? "(anyone can name any account: a hint, not proof)" : ""} |`);
    out.push("");
  }
  if (opts.truncated) out.push(`Only the first ${MAX_ACCOUNTS} accounts in the brief were checked.`, "");

  out.push("## Hidden instructions in the text you sent", "");
  if (scan.severity === "none") out.push("None of the known prompt-injection tricks were found in your brief. That doesn't prove the text is safe.");
  else {
    out.push(
      scan.severity === "hostile"
        ? "**Your brief contains prompt-injection tricks.** If this text came from an invoice, email or web page, don't let an AI agent pay because of it."
        : "Your brief has some signs worth a second look:",
      "",
    );
    for (const s of scan.signals) out.push(`- \`${s.kind}\` (${s.severity}): ${md(s.detail)}`);
    if (scan.hidden_text) out.push("", `Hidden text, decoded: \`${scan.hidden_text.replace(/`/g, "'")}\``);
    out.push("", "A hostile sign also turns every verdict above into `block`.");
  }
  out.push(
    "",
    "## What this is",
    "",
    "Read-only checks: the account on the NEAR chain, the shared AgentGuard registry (testnet), and a pattern scan of your text. No model read your brief and nothing was paid. This is advice, not a guarantee. To have a contract enforce the rules for your own agent's payments, see [agentguard.app](https://agentguard.app).",
  );
  return out.join("\n");
}

/** Check every account named in a brief. `check` is given each account's network. */
export async function runBrief(
  brief: string,
  check: (account: string, network: "testnet" | "mainnet", scan: ScanResult, others: string[]) => Promise<AccountReport>,
): Promise<{ accounts: string[]; markdown: string; scan: ScanResult } | null> {
  const { accounts, truncated } = parseBrief(brief);
  if (!accounts.length) return null;
  const scan = scanText(brief, { self: accounts, recipient: accounts[0] });
  const reports: AccountReport[] = [];
  for (const a of accounts)
    reports.push(await check(a, networkOf(a), scan, accounts.filter((x) => x !== a)).catch((e) => ({ account: a, network: networkOf(a), error: e instanceof Error ? e.message : String(e) })));
  return { accounts, markdown: buildReport(reports, scan, { truncated }), scan };
}

/** Webhook signature check, as the marketplace documents it: HMAC-SHA256(secret, "<ts>.<raw body>"). */
export function verifySignature(secret: string, timestamp: string | undefined, signature: string | undefined, rawBody: Buffer, nowMs = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  const given = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const DECLINE_DETAIL =
  "Sentinel checks NEAR accounts. Your brief names none, so it can't help: you get a full refund. Hire it again with the account to check, for example: \"Is shop.near safe to pay?\" You can paste the invoice too.";

export interface MarketDeps {
  token: string;
  webhookSecret?: string;
  base?: string;
  check: Parameters<typeof runBrief>[1];
  onDone?: (e: { assignmentId: string; accounts: string[]; verdicts: string[]; injection: ScanResult["severity"] }) => void;
  onDeclined?: (assignmentId: string) => void;
  log?: (msg: string) => void;
  fetch?: typeof fetch;
}

interface AssignmentRow {
  assignment: { assignmentId: string; status: string; startedAt: string | null; submittedAt: string | null };
  job: { title?: string; description: string };
  latestMessage?: { body?: string } | null;
}

export class AgentMarket {
  private readonly base: string;
  private readonly http: typeof fetch;
  private readonly inFlight = new Set<string>();
  private readonly seenDeliveries: string[] = [];
  private readonly done = new Set<string>();
  /** Public health of the connection (no secrets): when the last poll worked, the last error. */
  readonly health: { last_poll_ok_at: string | null; last_error: string | null; webhook: boolean } = { last_poll_ok_at: null, last_error: null, webhook: false };

  constructor(private readonly d: MarketDeps) {
    this.base = d.base ?? "https://market.near.ai";
    this.http = d.fetch ?? fetch;
    this.health.webhook = Boolean(d.webhookSecret);
  }

  private async api(method: string, path: string, body?: unknown) {
    const res = await this.http(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.d.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  /** Webhook entry. Returns the HTTP status to answer; the work runs after the answer. */
  webhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): number {
    const h = (k: string) => (typeof headers[k] === "string" ? (headers[k] as string) : undefined);
    if (!this.d.webhookSecret) return 404;
    if (!verifySignature(this.d.webhookSecret, h("x-market-timestamp"), h("x-market-signature"), rawBody)) return 401;
    const delivery = h("x-market-delivery") ?? "";
    if (this.seenDeliveries.includes(delivery)) return 200;
    this.seenDeliveries.push(delivery);
    if (this.seenDeliveries.length > 500) this.seenDeliveries.shift();
    let ev: { event?: string; assignment_id?: string; title?: string; description?: string };
    try {
      ev = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return 400;
    }
    if (ev.event === "hire.created" && ev.assignment_id) void this.work(ev.assignment_id, `${ev.title ?? ""}\n${ev.description ?? ""}`, true);
    // Changes requested: re-read the brief, then redo it with the feedback appended.
    if (ev.event === "hire.changes_requested" && ev.assignment_id) {
      this.done.delete(ev.assignment_id);
      void this.poll();
    }
    return 200;
  }

  /** Backup for lost webhooks, and the whole loop when no webhook is set. */
  async poll() {
    let res: { assignments?: AssignmentRow[] } | null;
    try {
      res = (await this.api("GET", "/v1/agents/me/assignments")) as { assignments?: AssignmentRow[] } | null;
      this.health.last_poll_ok_at = new Date().toISOString();
      this.health.last_error = null;
    } catch (e) {
      this.health.last_error = (e instanceof Error ? e.message : String(e)).replace(/aat_\w+|whsec_\w+/g, "[secret]").slice(0, 160);
      throw e;
    }
    for (const row of res?.assignments ?? []) {
      const a = row.assignment;
      if (a.status !== "in_progress") continue;
      const fresh = !a.startedAt;
      const changes = Boolean(a.submittedAt);
      if (!fresh && !changes) continue;
      if (this.done.has(a.assignmentId) && !changes) continue;
      const base = `${row.job.title ?? ""}\n${row.job.description}`;
      const brief = changes && row.latestMessage?.body ? `${base}\n\n${row.latestMessage.body}` : base;
      await this.work(a.assignmentId, brief, false);
    }
  }

  async work(assignmentId: string, brief: string, viaWebhook: boolean) {
    if (this.inFlight.has(assignmentId)) return;
    this.inFlight.add(assignmentId);
    try {
      const result = await runBrief(brief, this.d.check);
      if (!result) {
        await this.api("POST", `/v1/assignments/${assignmentId}/decline`, { reason: "rejected", detail: DECLINE_DETAIL });
        this.done.add(assignmentId);
        this.d.onDeclined?.(assignmentId);
        return;
      }
      if (!viaWebhook) await this.api("POST", `/v1/assignments/${assignmentId}/start`); // a 2xx webhook answer already counts as start
      await this.api("POST", `/v1/assignments/${assignmentId}/submit`, { deliverableMarkdown: result.markdown });
      this.done.add(assignmentId);
      const verdicts = (result.markdown.match(/\(`(allow|warn|block)`\)/g) ?? []).map((m) => m.slice(2, -2));
      this.d.onDone?.({ assignmentId, accounts: result.accounts, verdicts, injection: result.scan.severity });
    } catch (e) {
      this.d.log?.(`agent market ${assignmentId}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.inFlight.delete(assignmentId);
    }
  }
}
