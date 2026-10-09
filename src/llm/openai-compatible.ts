import type { ChatModel, Conversation, ToolCall, ToolOutput, ToolSpec, Turn } from "./model";

export interface OpenAiCompatibleOptions {
  /** Provider name for reports and error messages. */
  provider: string;
  baseUrl: string;
  model: string;
  /** Omitted for local servers that need no key. */
  apiKey?: string;
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
  choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: RawToolCall[] } }[];
  error?: { message?: string };
}

/** Free tiers rate-limit hard, so a run waits and retries instead of failing. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 7;
const MAX_WAIT_MS = 90_000;

/**
 * Any service that speaks the OpenAI chat-completions format: Groq,
 * OpenRouter, Google's Gemini endpoint, a local Ollama server, and others.
 */
export class OpenAiCompatibleModel implements ChatModel {
  readonly label: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.label = `${options.provider} ${options.model}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  start(system: string, tools: ToolSpec[]): Conversation {
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

    for (let attempt = 1; ; attempt += 1) {
      const response = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(payload) });
      const text = await response.text();
      let body: CompletionResponse = {};
      try {
        body = text ? (JSON.parse(text) as CompletionResponse) : {};
      } catch {
        // non-JSON error page; reported below by status
      }
      if (response.ok) return body;

      if (RETRY_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
        await this.sleep(Math.min(wait, MAX_WAIT_MS));
        continue;
      }
      const detail = body.error?.message ?? (text.slice(0, 200) || response.statusText);
      throw new Error(`${this.options.provider} request failed (${response.status}): ${detail}`);
    }
  }
}
