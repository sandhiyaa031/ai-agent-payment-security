import type { ChatModel, ToolOutput, ToolSpec, Turn } from "../src/llm/model";

export interface Exchange {
  system: string;
  tools: ToolSpec[];
  /** What the model was sent, in order: user text or tool outputs. */
  sent: (string | ToolOutput[])[];
}

/** A scripted model: replies with the given turns in order and records what it was sent. */
export function fakeModel(turns: Partial<Turn>[]) {
  const exchanges: Exchange[] = [];
  const next = (): Turn => {
    const turn = turns.shift();
    if (!turn) throw new Error("Unexpected model request");
    return { text: "", toolCalls: [], refused: false, ...turn };
  };
  const model: ChatModel = {
    label: "fake model",
    start(system, tools) {
      const exchange: Exchange = { system, tools, sent: [] };
      exchanges.push(exchange);
      return {
        async say(text) {
          exchange.sent.push(text);
          return next();
        },
        async answerTools(outputs) {
          exchange.sent.push(outputs);
          return next();
        },
      };
    },
  };
  return { model, exchanges };
}

export const call = (id: string, name: string, input: Record<string, unknown> | null) => ({ id, name, input });
