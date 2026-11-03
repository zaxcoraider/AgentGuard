// OpenAI-compatible chat client with provider fallback.
// Primary: NEAR AI Cloud (TEE). Backups: Nebius, DGrid. Keys come from the environment.

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Runs inside attested TEE hardware (NEAR AI Cloud private models). */
  tee: boolean;
}

export interface ChatResult {
  message: ChatMessage;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  provider: string;
  model: string;
  tee: boolean;
  /** For TEE providers: the exact bytes sent and received, so the reply's signature can be checked. */
  evidence?: { id: string; request: string; response: string };
}

export function providersFromEnv(env = process.env): Provider[] {
  const list: Provider[] = [];
  if (env.NEAR_AI_API_KEY)
    list.push({
      name: "near-ai",
      baseUrl: env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai/v1",
      apiKey: env.NEAR_AI_API_KEY,
      model: env.NEAR_AI_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      tee: true,
    });
  if (env.NEBIUS_API_KEY)
    list.push({ name: "nebius", baseUrl: env.NEBIUS_BASE_URL || "https://api.tokenfactory.nebius.com/v1", apiKey: env.NEBIUS_API_KEY, model: env.NEBIUS_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017", tee: false });
  if (env.DGRID_API_KEY)
    list.push({ name: "dgrid", baseUrl: env.DGRID_BASE_URL || "https://api.dgrid.ai/v1", apiKey: env.DGRID_API_KEY, model: env.DGRID_MODEL ?? "openai/gpt-5-nano", tee: false });
  return list;
}

export class LLM {
  constructor(private readonly providers: Provider[], private readonly timeoutMs = 60_000) {}

  /** False when no model key is set: the server still runs (page, status, feed, paid checks), chat is off. */
  get configured() {
    return this.providers.length > 0;
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[] = [], maxTokens = 600): Promise<ChatResult> {
    if (!this.configured) throw new Error("No LLM provider configured: set NEAR_AI_API_KEY (or NEBIUS_API_KEY / DGRID_API_KEY)");
    const errors: string[] = [];
    for (const p of this.providers) {
      try {
        // Build the body once and keep the exact bytes: a TEE reply's signature covers them.
        const body = JSON.stringify({ model: p.model, messages, tools: tools.length ? tools : undefined, max_tokens: maxTokens, temperature: 0.7 });
        const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` };
        if (p.tee) Object.assign(headers, { "x-no-aliasing": "true", "accept-encoding": "identity" });
        const res = await fetch(`${p.baseUrl}/chat/completions`, { method: "POST", headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
        const raw = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
        const d = JSON.parse(raw) as { id?: string; choices?: { message: ChatMessage }[]; usage?: ChatResult["usage"] };
        const message = d.choices?.[0]?.message;
        if (!message) throw new Error("no message in response");
        const usage = d.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        const evidence = p.tee && d.id ? { id: d.id, request: body, response: raw } : undefined;
        return { message, usage, provider: p.name, model: p.model, tee: p.tee, evidence };
      } catch (e) {
        errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw new Error(`All LLM providers failed: ${errors.join(" | ")}`);
  }
}
