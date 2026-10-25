import Anthropic from "@anthropic-ai/sdk";
import { emptyUsage, type ModelManifest, type Usage } from "../manifest";
import type { ChatModel, Conversation, ToolOutput, ToolSpec, Turn } from "./model";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** Claude through the Anthropic API. This provider is paid. */
export class AnthropicModel implements ChatModel {
  readonly label: string;
  private readonly client: Anthropic;
  private readonly totals: Usage = emptyUsage();
  private readonly served = new Set<string>();

  constructor(private readonly model: string = DEFAULT_ANTHROPIC_MODEL, client?: Anthropic) {
    this.label = `anthropic ${model}`;
    this.client = client ?? new Anthropic();
  }

  usage(): Usage {
    return { ...this.totals };
  }

  /** Temperature is left at the provider default here, and recorded as unpinned. */
  manifest(): ModelManifest {
    return { provider: "anthropic", model: this.model, served: [...this.served], fingerprints: [] };
  }

  start(system: string, tools: ToolSpec[]): Conversation {
    const messages: Anthropic.MessageParam[] = [];
    const toolParams: Anthropic.Tool[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
      ...(tool.strict ? { strict: true } : {}),
    }));

    const send = async (): Promise<Turn> => {
      // No server-side fallback here on purpose: a silent switch to another
      // model would corrupt a per-model score. A refusal is reported as-is.
      const sentAt = Date.now();
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
        system,
        ...(toolParams.length > 0 ? { tools: toolParams } : {}),
        output_config: { effort: "medium" },
        messages,
      });
      this.totals.requests += 1;
      this.totals.promptTokens += response.usage?.input_tokens ?? 0;
      this.totals.completionTokens += response.usage?.output_tokens ?? 0;
      this.totals.cachedTokens += response.usage?.cache_read_input_tokens ?? 0;
      this.totals.latencyMs += Date.now() - sentAt;
      if (response.model) this.served.add(response.model);
      messages.push({ role: "assistant", content: response.content });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      const toolCalls =
        response.stop_reason === "tool_use"
          ? response.content
              .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
              .map((block) => ({ id: block.id, name: block.name, input: block.input as Record<string, unknown> }))
          : [];
      return { text, toolCalls, refused: response.stop_reason === "refusal" };
    };

    return {
      say(text) {
        messages.push({ role: "user", content: text });
        return send();
      },
      answerTools(outputs: ToolOutput[]) {
        messages.push({
          role: "user",
          content: outputs.map((output) => ({
            type: "tool_result" as const,
            tool_use_id: output.id,
            is_error: output.isError,
            content: output.content,
          })),
        });
        return send();
      },
    };
  }
}
