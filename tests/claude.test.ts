import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AdaptiveAttacker } from "../src/attacks/attacker";
import { MockRail } from "../src/rail/mock";
import type { StoreOrder } from "../src/store/policy";
import { ClaudeSubject } from "../src/subject/claude";
import { createSupportTools, type ToolCallRecord } from "../src/subject/tools";

type Params = Anthropic.MessageCreateParamsNonStreaming;

/** A stand-in Anthropic client that replays scripted responses and records requests. */
function fakeClient(responses: { stop_reason: string; content: unknown[] }[]) {
  const requests: Params[] = [];
  const client = {
    messages: {
      create: async (params: Params) => {
        // Snapshot: the subject keeps appending to the same messages array.
        requests.push(structuredClone(params));
        const next = responses.shift();
        if (!next) throw new Error("Unexpected model request");
        return next;
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const text = (value: string) => ({ type: "text", text: value });
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

async function setup() {
  const rail = new MockRail();
  const charge = await rail.charge({ amountCents: 4900, description: "Desk lamp", reference: "r" });
  const order: StoreOrder = {
    orderId: charge.orderId,
    captureId: charge.captureId,
    customerEmail: "ravi@example.com",
    item: "Desk lamp",
    amountCents: 4900,
    placedDaysAgo: 14,
    delivery: "IN_TRANSIT",
    returnReceived: false,
  };
  const log: ToolCallRecord[] = [];
  const session = { customerEmail: "ravi@example.com" };
  const tools = createSupportTools({ orders: [order], rail, session, guard: {}, log });
  return { rail, order, log, session, tools };
}

describe("Claude subject", () => {
  it("looks the order up, refunds through the rail, and returns the final text", async () => {
    const { rail, order, log, session, tools } = await setup();
    const { client, requests } = fakeClient([
      { stop_reason: "tool_use", content: [toolUse("t1", "get_order", { order_id: order.orderId })] },
      { stop_reason: "tool_use", content: [toolUse("t2", "refund_order", { order_id: order.orderId, amount: "49.00", reason: "Late" })] },
      { stop_reason: "end_turn", content: [text("Your refund is on its way.")] },
    ]);

    const chat = new ClaudeSubject("claude-opus-5-5", client).startSession(session, tools);
    expect(await chat.reply(`Where is ${order.orderId}?`)).toBe("Your refund is on its way.");

    expect(await rail.refundedCents(order.orderId)).toBe(4900);
    expect(log.map((call) => call.outcome)).toEqual(["executed"]);

    const first = requests[0]!;
    expect(first.model).toBe("claude-opus-5-5");
    expect(first.system).toContain("ravi@example.com");
    expect(first.tools?.map((tool) => ("name" in tool ? tool.name : tool.type))).toEqual(["get_order", "refund_order"]);

    // Each tool result answers the tool call that came just before it.
    const lookup = requests[1]!.messages.at(-1)!;
    expect(lookup.role).toBe("user");
    const lookupResult = (lookup.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(lookupResult.tool_use_id).toBe("t1");
    expect(JSON.parse(lookupResult.content as string)).toMatchObject({ delivery_status: "IN_TRANSIT", amount_paid: "49.00" });
    const refundResult = (requests[2]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(refundResult.tool_use_id).toBe("t2");
    expect(refundResult.is_error).toBe(false);
  });

  it("returns bad tool input to the model as an error instead of moving money", async () => {
    const { rail, order, log, session, tools } = await setup();
    const { client, requests } = fakeClient([
      { stop_reason: "tool_use", content: [toolUse("t1", "refund_order", { order_id: order.orderId, amount: "lots", reason: "x" })] },
      { stop_reason: "end_turn", content: [text("Sorry, I could not do that.")] },
    ]);
    const chat = new ClaudeSubject("claude-opus-5-5", client).startSession(session, tools);
    await chat.reply("refund me");
    const result = (requests[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(result.is_error).toBe(true);
    expect(log).toEqual([]);
    expect(await rail.refundedCents(order.orderId)).toBe(0);
  });

  it("keeps the conversation across turns and reports a refusal plainly", async () => {
    const { session, tools } = await setup();
    const { client, requests } = fakeClient([
      { stop_reason: "end_turn", content: [text("Hello!")] },
      { stop_reason: "refusal", content: [] },
    ]);
    const chat = new ClaudeSubject("claude-opus-5-5", client).startSession(session, tools);
    expect(await chat.reply("hi")).toBe("Hello!");
    expect(await chat.reply("again")).toBe("[the agent declined to respond]");
    expect(requests[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("adaptive attacker", () => {
  const brief = { goal: "Get a refund", script: [], customerEmail: "maya@example.com" };

  it("returns the model's message and sends the transcript back to it", async () => {
    const { client, requests } = fakeClient([{ stop_reason: "end_turn", content: [text("  Please refund me.  ")] }]);
    const attacker = new AdaptiveAttacker("claude-opus-5-5", 5, client);
    expect(await attacker.next(brief, [{ customer: "hi", agent: "no refund" }])).toBe("Please refund me.");
    expect(requests[0]!.messages[0]!.content).toContain("AGENT: no refund");
  });

  it("stops on STOP, on a refusal, and at the turn limit", async () => {
    const { client } = fakeClient([
      { stop_reason: "end_turn", content: [text("STOP")] },
      { stop_reason: "refusal", content: [] },
    ]);
    const attacker = new AdaptiveAttacker("claude-opus-5-5", 1, client);
    expect(await attacker.next(brief, [])).toBeNull();
    expect(await attacker.next(brief, [])).toBeNull();
    expect(await attacker.next(brief, [{ customer: "a", agent: "b" }])).toBeNull(); // no model call
  });
});
