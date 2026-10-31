import { emptyUsage, type ModelManifest, type Usage } from "../manifest";
import type { ChatModel, Conversation, ToolCall, ToolOutput, ToolSpec, Turn } from "./model";

export interface OpenAiCompatibleOptions {
  /** Provider name for reports and error messages. */
  provider: string;
  baseUrl: string;
  model: string;
  /** Omitted for local servers that need no key. */
  apiKey?: string;
  /** Sent with every request when set, so the run does not depend on a provider default that can change. */
  temperature?: number;
  /** The longest one request may spend waiting out rate limits in total. Defaults to an hour. */
  patienceMs?: number;
  /** Called before every wait, so a long pause is not mistaken for a hang. */
  onWait?: (ms: number) => void;
  /** Tests inject these. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: RawToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface RawToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface CompletionResponse {
  model?: string;
  system_fingerprint?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: RawToolCall[] } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

/** Free tiers rate-limit hard, so a run waits and retries instead of failing. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Failures that give no advice on when to come back (server errors, dropped connections) get this many tries. */
const MAX_BLIND_ATTEMPTS = 7;
const MAX_BLIND_WAIT_MS = 90_000;
/**
 * A rate limit that names its own wait is obeyed until one request has waited
 * this long in total. A used-up daily allowance refills slowly and can ask for
 * many minutes at a time; giving up early would record the scenario as an error.
 */
const DEFAULT_PATIENCE_MS = 60 * 60_000;
/** A single wait is capped here, and then the provider is asked again. */
const MAX_ADVISED_WAIT_MS = 15 * 60_000;

/**
 * Groq puts the account's organization id in its rate-limit messages. Error
 * text ends up in recordings, which are public, so the id is left out.
 */
const withoutAccountId = (message: string) => message.replace(/\borg_\w+/g, "org_(hidden)");

/**
 * Any service that speaks the OpenAI chat-completions format: Groq,
 * OpenRouter, Google's Gemini endpoint, a local Ollama server, and others.
 */
export class OpenAiCompatibleModel implements ChatModel {
  readonly label: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly totals: Usage = emptyUsage();
  private readonly served = new Set<string>();
  private readonly fingerprints = new Set<string>();

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.label = `${options.provider} ${options.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  usage(): Usage {
    return { ...this.totals };
  }

  manifest(): ModelManifest {
    return {
      provider: this.options.provider,
      model: this.options.model,
      ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
      served: [...this.served],
      fingerprints: [...this.fingerprints],
    };
  }

  start(system: string, tools: ToolSpec[], options: { seed?: number } = {}): Conversation {
    const messages: Message[] = [{ role: "system", content: system }];
    const toolParams = tools.map((tool) => ({
      type: "function" as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

    const send = async (): Promise<Turn> => {
      const body = await this.request({
        model: this.options.model,
        messages,
        ...(toolParams.length > 0 ? { tools: toolParams, tool_choice: "auto" } : {}),
        ...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
        ...(options.seed === undefined ? {} : { seed: options.seed }),
      });
      const choice = body.choices?.[0];
      const rawCalls = choice?.message?.tool_calls ?? [];
      const text = (choice?.message?.content ?? "").trim();
      messages.push({ role: "assistant", content: text || null, ...(rawCalls.length > 0 ? { tool_calls: rawCalls } : {}) });

      const toolCalls: ToolCall[] = rawCalls.map((call) => {
        let input: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(call.function.arguments || "{}");
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          // left as null; the agent loop tells the model its arguments were invalid
        }
        return { id: call.id, name: call.function.name, input };
      });
      return { text, toolCalls, refused: choice?.finish_reason === "content_filter" };
    };

    return {
      say(text) {
        messages.push({ role: "user", content: text });
        return send();
      },
      answerTools(outputs: ToolOutput[]) {
        for (const output of outputs) {
          messages.push({
            role: "tool",
            tool_call_id: output.id,
            content: output.isError ? `ERROR: ${output.content}` : output.content,
          });
        }
        return send();
      },
    };
  }

  private async request(payload: unknown): Promise<CompletionResponse> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.options.apiKey) headers["Authorization"] = `Bearer ${this.options.apiKey}`;
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    const patienceMs = this.options.patienceMs ?? DEFAULT_PATIENCE_MS;
    let waitedMs = 0;
    let blindFailures = 0;
    const backOff = (attempt: number) => this.pause(Math.min(2 ** attempt * 1000, MAX_BLIND_WAIT_MS));

    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      let text: string;
      const sentAt = Date.now();
      try {
        response = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(payload) });
        text = await response.text();
      } catch (error) {
        // No answer arrived, for example because the connection dropped. Asking again is safe.
        blindFailures += 1;
        if (blindFailures >= MAX_BLIND_ATTEMPTS) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`${this.options.provider} could not be reached: ${reason}`);
        }
        await backOff(attempt);
        continue;
      }
      let body: CompletionResponse = {};
      try {
        body = text ? (JSON.parse(text) as CompletionResponse) : {};
      } catch {
        // non-JSON error page; reported below by status
      }
      if (response.ok) {
        this.count(body, Date.now() - sentAt);
        return body;
      }

      if (RETRY_STATUSES.has(response.status)) {
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          const wait = Math.min(retryAfter * 1000, MAX_ADVISED_WAIT_MS);
          if (waitedMs + wait <= patienceMs) {
            waitedMs += wait;
            await this.pause(wait);
            continue;
          }
        } else {
          blindFailures += 1;
          if (blindFailures < MAX_BLIND_ATTEMPTS) {
            await backOff(attempt);
            continue;
          }
        }
      }
      const detail = withoutAccountId(body.error?.message ?? (text.slice(0, 200) || response.statusText));
      throw new Error(`${this.options.provider} request failed (${response.status}): ${detail}`);
    }
  }

  private count(body: CompletionResponse, latencyMs: number): void {
    this.totals.requests += 1;
    this.totals.promptTokens += body.usage?.prompt_tokens ?? 0;
    this.totals.completionTokens += body.usage?.completion_tokens ?? 0;
    this.totals.cachedTokens += body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    this.totals.latencyMs += latencyMs;
    if (body.model) this.served.add(body.model);
    if (body.system_fingerprint) this.fingerprints.add(body.system_fingerprint);
  }

  private async pause(ms: number): Promise<void> {
    this.options.onWait?.(ms);
    await this.sleep(ms);
  }
}
