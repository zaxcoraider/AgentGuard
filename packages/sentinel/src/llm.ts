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
  if (env.NEBIUS_API_KEY && env.NEBIUS_BASE_URL)
    list.push({ name: "nebius", baseUrl: env.NEBIUS_BASE_URL, apiKey: env.NEBIUS_API_KEY, model: env.NEBIUS_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash-1017", tee: false });
  if (env.DGRID_API_KEY && env.DGRID_BASE_URL)
    list.push({ name: "dgrid", baseUrl: env.DGRID_BASE_URL, apiKey: env.DGRID_API_KEY, model: env.DGRID_MODEL ?? "openai/gpt-5-nano", tee: false });
  return list;
}

export class LLM {
  constructor(private readonly providers: Provider[], private readonly timeoutMs = 60_000) {
    if (!providers.length) throw new Error("No LLM provider configured: set NEAR_AI_API_KEY (or NEBIUS_*/DGRID_*) in .env");
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[] = [], maxTokens = 600): Promise<ChatResult> {
    const errors: string[] = [];
    for (const p of this.providers) {
      try {
        const res = await fetch(`${p.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
          body: JSON.stringify({ model: p.model, messages, tools: tools.length ? tools : undefined, max_tokens: maxTokens, temperature: 0.7 }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const d = (await res.json()) as { choices?: { message: ChatMessage }[]; usage?: ChatResult["usage"] };
        const message = d.choices?.[0]?.message;
        if (!message) throw new Error("no message in response");
        const usage = d.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        return { message, usage, provider: p.name, model: p.model, tee: p.tee };
      } catch (e) {
        errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw new Error(`All LLM providers failed: ${errors.join(" | ")}`);
  }
}
