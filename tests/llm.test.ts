import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createModel, modelConfigured, modelSettings } from "../src/llm";
import { AnthropicModel } from "../src/llm/anthropic";
import type { ToolSpec } from "../src/llm/model";
import { OpenAiCompatibleModel, type OpenAiCompatibleOptions } from "../src/llm/openai-compatible";

const LOOKUP: ToolSpec = {
  name: "get_order",
  description: "Look up an order.",
  strict: true,
  parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"], additionalProperties: false },
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { model: string; messages: Record<string, unknown>[]; tools?: unknown[]; tool_choice?: string };
}

/** Stands in for an OpenAI-format server: replies from a script and records each request. */
function fakeServer(replies: { status?: number; headers?: Record<string, string>; body: unknown }[]) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(init?.body as string) });
    const next = replies.shift();
    if (!next) throw new Error("Unexpected request");
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: next.headers });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const message = (content: string | null, tool_calls?: unknown[], finish_reason = "stop") => ({
  body: { choices: [{ finish_reason, message: { content, ...(tool_calls ? { tool_calls } : {}) } }] },
});
const rawCall = (id: string, name: string, args: string) => ({ id, type: "function", function: { name, arguments: args } });

function openAiModel(fetchImpl: typeof fetch, waits: number[] = [], extra: Partial<OpenAiCompatibleOptions> = {}) {
  return new OpenAiCompatibleModel({
    provider: "groq",
    baseUrl: "https://llm.test/v1/",
    model: "some-model",
    apiKey: "key",
    fetchImpl,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...extra,
  });
}

const dailyLimit = (retryAfter: string) => ({
  status: 429,
  headers: { "retry-after": retryAfter },
  body: { error: { message: "Rate limit reached in organization `org_01abcXYZ` on tokens per day (TPD)." } },
});

describe("OpenAI-compatible model", () => {
  it("runs a tool-calling exchange and keeps the history in the provider's format", async () => {
    const { sent, fetchImpl } = fakeServer([
      message(null, [rawCall("c1", "get_order", '{"order_id":"A1"}')], "tool_calls"),
      message("It is in transit."),
    ]);
    const model = openAiModel(fetchImpl);
    expect(model.label).toBe("groq some-model");

    const chat = model.start("Be helpful.", [LOOKUP]);
    const first = await chat.say("Where is A1?");
    expect(first).toEqual({ text: "", toolCalls: [{ id: "c1", name: "get_order", input: { order_id: "A1" } }], refused: false });

    const second = await chat.answerTools([{ id: "c1", content: '{"status":"IN_TRANSIT"}', isError: false }]);
    expect(second.text).toBe("It is in transit.");

    expect(sent[0]!.url).toBe("https://llm.test/v1/chat/completions");
    expect(sent[0]!.headers["Authorization"]).toBe("Bearer key");
    expect(sent[0]!.body).toMatchObject({ model: "some-model", tool_choice: "auto" });
    expect(sent[0]!.body.tools).toEqual([
      { type: "function", function: { name: "get_order", description: "Look up an order.", parameters: LOOKUP.parameters } },
    ]);
    expect(sent[1]!.body.messages).toEqual([
      { role: "system", content: "Be helpful." },
      { role: "user", content: "Where is A1?" },
      { role: "assistant", content: null, tool_calls: [rawCall("c1", "get_order", '{"order_id":"A1"}')] },
      { role: "tool", tool_call_id: "c1", content: '{"status":"IN_TRANSIT"}' },
    ]);
  });

  it("omits tools when there are none, flags tool errors, and marks unparseable arguments", async () => {
    const { sent, fetchImpl } = fakeServer([
      message("hi"),
      message(null, [rawCall("c1", "get_order", "{not json"), rawCall("c2", "get_order", "[1]")]),
      message("ok"),
    ]);
    const plain = await openAiModel(fetchImpl).start("s", []).say("hello");
    expect(plain.text).toBe("hi");
    expect(sent[0]!.body.tools).toBeUndefined();
    expect(sent[0]!.body.tool_choice).toBeUndefined();

    const chat = openAiModel(fetchImpl).start("s", [LOOKUP]);
    const turn = await chat.say("x");
    expect(turn.toolCalls.map((entry) => entry.input)).toEqual([null, null]);
    await chat.answerTools([{ id: "c1", content: "bad arguments", isError: true }]);
    expect(sent[2]!.body.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "ERROR: bad arguments" });
  });

  it("waits and retries when the free tier rate-limits it", async () => {
    const waits: number[] = [];
    const { sent, fetchImpl } = fakeServer([
      { status: 429, headers: { "retry-after": "3" }, body: { error: { message: "slow down" } } },
      { status: 503, body: {} },
      message("done"),
    ]);
    const turn = await openAiModel(fetchImpl, waits).start("s", []).say("x");
    expect(turn.text).toBe("done");
    expect(sent).toHaveLength(3);
    expect(waits).toEqual([3000, 4000]);
  });

  it("sits out a used-up daily allowance for as long as the provider asks, one capped wait at a time", async () => {
    const waits: number[] = [];
    const announced: number[] = [];
    // 701 s is what Groq asked for on a real run; the old limit of 7 tries of 90 s gave up before that.
    const { sent, fetchImpl } = fakeServer([dailyLimit("701"), dailyLimit("1200"), dailyLimit("5"), message("done")]);
    const model = openAiModel(fetchImpl, waits, { onWait: (ms) => announced.push(ms) });
    expect((await model.start("s", []).say("x")).text).toBe("done");
    expect(sent).toHaveLength(4);
    expect(waits).toEqual([701_000, 900_000, 5_000]);
    expect(announced).toEqual(waits);
  });

  it("stops waiting once one request has used up its patience, and keeps the account id out of the error", async () => {
    const waits: number[] = [];
    const { sent, fetchImpl } = fakeServer([dailyLimit("400"), dailyLimit("400"), message("never reached")]);
    const model = openAiModel(fetchImpl, waits, { patienceMs: 10 * 60_000 });
    const failure = await model.start("s", []).say("x").then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(failure).toBe("groq request failed (429): Rate limit reached in organization `org_(hidden)` on tokens per day (TPD).");
    expect(sent).toHaveLength(2);
    expect(waits).toEqual([400_000]);
  });

  it("asks again when the connection drops, and gives up after seven failures in a row", async () => {
    const waits: number[] = [];
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify(message("back").body));
    }) as typeof fetch;
    expect((await openAiModel(flaky, waits).start("s", []).say("x")).text).toBe("back");
    expect(waits).toEqual([2000]);

    waits.length = 0;
    calls = 0;
    const down = (async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(openAiModel(down, waits).start("s", []).say("x")).rejects.toThrow("groq could not be reached: fetch failed");
    expect(calls).toBe(7);
    expect(waits).toEqual([2000, 4000, 8000, 16000, 32000, 64000]);
  });

  it("still gives up on a server error that keeps coming back with no advice", async () => {
    const waits: number[] = [];
    const { sent, fetchImpl } = fakeServer(Array.from({ length: 8 }, () => ({ status: 503, body: { error: { message: "overloaded" } } })));
    await expect(openAiModel(fetchImpl, waits).start("s", []).say("x")).rejects.toThrow("groq request failed (503): overloaded");
    expect(sent).toHaveLength(7);
    expect(waits).toHaveLength(6);
  });

  it("gives up with the provider's message on an error that will not go away", async () => {
    const { fetchImpl } = fakeServer([{ status: 401, body: { error: { message: "Invalid API Key" } } }]);
    await expect(openAiModel(fetchImpl).start("s", []).say("x")).rejects.toThrow("groq request failed (401): Invalid API Key");
  });

  it("reports a content-filter stop as a refusal", async () => {
    const { fetchImpl } = fakeServer([message(null, undefined, "content_filter")]);
    expect((await openAiModel(fetchImpl).start("s", []).say("x")).refused).toBe(true);
  });
});

describe("Anthropic model", () => {
  type Params = Anthropic.MessageCreateParamsNonStreaming;

  function fakeClient(responses: { stop_reason: string; content: unknown[] }[]) {
    const requests: Params[] = [];
    const client = {
      messages: {
        create: async (params: Params) => {
          // Snapshot: the conversation keeps appending to the same messages array.
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error("Unexpected model request");
          return next;
        },
      },
    } as unknown as Anthropic;
    return { client, requests };
  }

  it("maps tools, tool calls and tool results to the Messages API", async () => {
    const { client, requests } = fakeClient([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "get_order", input: { order_id: "A1" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: " In transit. " }] },
      { stop_reason: "refusal", content: [] },
    ]);
    const chat = new AnthropicModel("claude-opus-5-5", client).start("Be helpful.", [LOOKUP]);

    const first = await chat.say("Where is A1?");
    expect(first.toolCalls).toEqual([{ id: "t1", name: "get_order", input: { order_id: "A1" } }]);
    const second = await chat.answerTools([{ id: "t1", content: "IN_TRANSIT", isError: false }]);
    expect(second).toEqual({ text: "In transit.", toolCalls: [], refused: false });
    expect((await chat.say("again")).refused).toBe(true);

    expect(requests[0]).toMatchObject({ model: "claude-opus-5-5", system: "Be helpful." });
    expect(requests[0]!.tools).toEqual([
      { name: "get_order", description: "Look up an order.", input_schema: LOOKUP.parameters, strict: true },
    ]);
    expect(requests[1]!.messages.map((entry) => entry.role)).toEqual(["user", "assistant", "user"]);
    expect(requests[1]!.messages[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", is_error: false, content: "IN_TRANSIT" },
    ]);
  });

  it("sends no tools field when there are no tools", async () => {
    const { client, requests } = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] }]);
    await new AnthropicModel("claude-opus-5-5", client).start("s", []).say("x");
    expect(requests[0]).not.toHaveProperty("tools");
  });
});

describe("model settings from .env", () => {
  const NAMES = [
    "LLM_PROVIDER",
    "LLM_API_KEY",
    "LLM_MODEL",
    "LLM_BASE_URL",
    "LLM_MAX_WAIT_MINUTES",
    "ANTHROPIC_API_KEY",
    "CRASHTEST_SUBJECT_MODEL",
    "CRASHTEST_ATTACKER_MODEL",
  ];
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  const set = (values: Record<string, string>) => {
    for (const name of NAMES) delete process.env[name];
    Object.assign(process.env, values);
  };
  afterEach(() => {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("reports nothing configured, with a message that says what to add", () => {
    set({});
    expect(modelConfigured()).toBe(false);
    expect(() => modelSettings("subject")).toThrow(/LLM_PROVIDER/);
  });

  it("uses a free provider's defaults and lets each role override the model", () => {
    set({ LLM_PROVIDER: "Groq", LLM_API_KEY: "k", CRASHTEST_ATTACKER_MODEL: "attack-model" });
    expect(modelConfigured()).toBe(true);
    expect(modelSettings("subject")).toEqual({ provider: "groq", model: "openai/gpt-oss-120b", baseUrl: "https://api.groq.com/openai/v1", apiKey: "k" });
    expect(modelSettings("attacker").model).toBe("attack-model");
    expect(createModel("subject").label).toBe("groq openai/gpt-oss-120b");
  });

  it("takes the rate-limit patience from LLM_MAX_WAIT_MINUTES and rejects a value that is not a number of minutes", () => {
    set({ LLM_PROVIDER: "groq", LLM_API_KEY: "k", LLM_MAX_WAIT_MINUTES: "0" });
    expect(createModel("subject").label).toBe("groq openai/gpt-oss-120b");
    for (const bad of ["soon", "-5"]) {
      set({ LLM_PROVIDER: "groq", LLM_API_KEY: "k", LLM_MAX_WAIT_MINUTES: bad });
      expect(() => createModel("subject")).toThrow(/LLM_MAX_WAIT_MINUTES/);
    }
  });

  it("needs a key for hosted providers but not for a local one", () => {
    set({ LLM_PROVIDER: "openrouter" });
    expect(modelConfigured()).toBe(false);
    expect(() => modelSettings("subject")).toThrow(/LLM_API_KEY/);
    set({ LLM_PROVIDER: "ollama", LLM_MODEL: "qwen3" });
    expect(modelConfigured()).toBe(true);
    expect(modelSettings("subject")).toMatchObject({ baseUrl: "http://localhost:11434/v1", model: "qwen3", apiKey: undefined });
  });

  it("supports a custom endpoint, rejects unknown names, and keeps Anthropic as an option", () => {
    set({ LLM_PROVIDER: "custom", LLM_BASE_URL: "https://x.test/v1", LLM_MODEL: "m" });
    expect(modelSettings("subject")).toMatchObject({ provider: "custom", baseUrl: "https://x.test/v1", model: "m" });
    set({ LLM_PROVIDER: "nope", LLM_API_KEY: "k" });
    expect(modelConfigured()).toBe(false);
    expect(() => modelSettings("subject")).toThrow(/Unknown LLM_PROVIDER/);
    set({ ANTHROPIC_API_KEY: "k" });
    expect(modelSettings("subject")).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
  });
});
