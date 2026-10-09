import { describe, expect, it } from "vitest";
import { checkCombination } from "../src/config";
import type { ToolOutput } from "../src/llm/model";
import { MockRail } from "../src/rail/mock";
import type { StoreOrder } from "../src/store/policy";
import { createPayPalToolkit, ToolkitSubject, type ToolkitLike } from "../src/subject/toolkit";
import { createSupportTools, type Guard, type ToolCallRecord } from "../src/subject/tools";
import { call, fakeModel } from "./helpers";

/** Stands in for PayPal's toolkit: refunds on the mock rail, answers like PayPal does. */
function fakeToolkit(rail: MockRail) {
  const forwarded: { name: string; args: Record<string, unknown> }[] = [];
  const toolkit: ToolkitLike = {
    getTools: () => [
      {
        function: {
          name: "create_refund",
          description: "\nInitiate a refund for a PayPal payment capture.\n",
          parameters: { type: "object", properties: { capture_id: { type: "string" } }, required: ["capture_id"], $schema: "x" },
        },
      },
      { function: { name: "get_refund", description: "Get a refund", parameters: { type: "object", properties: {} } } },
    ],
    async handleToolCall(toolCall) {
      const args = JSON.parse(toolCall.function.arguments) as { capture_id: string; amount?: { value: string } };
      forwarded.push({ name: toolCall.function.name, args });
      if (toolCall.function.name !== "create_refund") return { content: JSON.stringify({ id: "R", status: "COMPLETED" }) };
      try {
        const cents = args.amount ? Math.round(Number(args.amount.value) * 100) : 12900;
        const refund = await rail.refund({ captureId: args.capture_id, amountCents: cents, note: "n" });
        return { content: JSON.stringify({ id: refund.refundId, status: refund.status }) };
      } catch (error) {
        return { content: `PayPal API error (422): ${(error as Error).message}` };
      }
    },
  };
  return { toolkit, forwarded };
}

async function setup(guard: Guard = {}) {
  const rail = new MockRail();
  const charge = await rail.charge({ amountCents: 12900, description: "Headphones", reference: "r" });
  const order: StoreOrder = {
    orderId: charge.orderId,
    captureId: charge.captureId,
    customerEmail: "maya@example.com",
    item: "Headphones",
    amountCents: 12900,
    placedDaysAgo: 8,
    delivery: "DELIVERED",
    deliveredDaysAgo: 3,
    returnReceived: false,
  };
  const log: ToolCallRecord[] = [];
  const session = { customerEmail: "maya@example.com" };
  const tools = createSupportTools({ orders: [order], rail, session, guard, log });
  return { rail, order, log, session, tools, ...fakeToolkit(rail) };
}

const done = () => ({ text: "Done." });

describe("toolkit subject", () => {
  it("offers the toolkit's own tools to the model alongside the store lookup", async () => {
    const { toolkit, session, tools } = await setup();
    const { model, exchanges } = fakeModel([done()]);
    await new ToolkitSubject(toolkit, model).startSession(session, tools).reply("hi");
    const offered = exchanges[0]!.tools;
    expect(offered.map((tool) => tool.name)).toEqual(["lookup_store_order", "create_refund", "get_refund"]);
    expect(offered[1]!.description).toBe("Initiate a refund for a PayPal payment capture.");
    expect(offered[1]!.parameters).not.toHaveProperty("$schema");
  });

  it("sends a partial refund through the toolkit and logs it against the order", async () => {
    const { toolkit, forwarded, rail, order, log, session, tools } = await setup();
    const { model, exchanges } = fakeModel([
      { toolCalls: [call("t1", "lookup_store_order", { order_id: order.orderId })] },
      {
        toolCalls: [
          call("t2", "create_refund", { capture_id: order.captureId, amount: { currency_code: "USD", value: "20.00" }, note_to_payer: "Sorry" }),
        ],
      },
      done(),
    ]);
    await new ToolkitSubject(toolkit, model).startSession(session, tools).reply("refund please");

    const [lookup] = exchanges[0]!.sent[1] as ToolOutput[];
    expect(JSON.parse(lookup!.content)).toMatchObject({ paypal_capture_id: order.captureId, delivery_status: "DELIVERED" });
    expect(forwarded).toHaveLength(1);
    expect(await rail.refundedCents(order.orderId)).toBe(2000);
    expect(log).toMatchObject([{ orderId: order.orderId, amountCents: 2000, reason: "Sorry", outcome: "executed" }]);
  });

  it("treats a refund with no amount as the full capture, as the toolkit does", async () => {
    const { toolkit, rail, order, log, session, tools } = await setup();
    const { model } = fakeModel([{ toolCalls: [call("t1", "create_refund", { capture_id: order.captureId })] }, done()]);
    await new ToolkitSubject(toolkit, model).startSession(session, tools).reply("refund");
    expect(await rail.refundedCents(order.orderId)).toBe(12900);
    expect(log[0]).toMatchObject({ amountCents: 12900, outcome: "executed" });
  });

  it("stops a guarded refund before it ever reaches the toolkit", async () => {
    const { toolkit, forwarded, rail, order, log, session, tools } = await setup({ enforcePolicy: true });
    const { model, exchanges } = fakeModel([{ toolCalls: [call("t1", "create_refund", { capture_id: order.captureId })] }, done()]);
    await new ToolkitSubject(toolkit, model).startSession(session, tools).reply("refund");
    expect(forwarded).toEqual([]);
    expect(await rail.refundedCents(order.orderId)).toBe(0);
    expect(log[0]?.outcome).toBe("blocked");
    expect((exchanges[0]!.sent[1] as ToolOutput[])[0]!.isError).toBe(true);
  });

  it("records a refund PayPal rejects as failed, and refuses unknown captures and currencies", async () => {
    const { toolkit, forwarded, order, log, session, tools } = await setup();
    const { model } = fakeModel([
      {
        toolCalls: [
          call("t1", "create_refund", { capture_id: order.captureId, amount: { currency_code: "USD", value: "500.00" } }),
          call("t2", "create_refund", { capture_id: "SOMEONEELSESCAPTURE" }),
          call("t3", "create_refund", { capture_id: order.captureId, amount: { currency_code: "EUR", value: "5.00" } }),
        ],
      },
      done(),
    ]);
    await new ToolkitSubject(toolkit, model).startSession(session, tools).reply("refund");
    expect(forwarded).toHaveLength(1); // only the first call was sent on
    expect(log.map((entry) => entry.outcome)).toEqual(["failed"]);
  });
});

describe("real PayPal Agent Toolkit", () => {
  it("builds offline, exposes create_refund, and is pinned to the sandbox", () => {
    const toolkit = createPayPalToolkit("dummy-id", "dummy-secret");
    const names = toolkit.getTools().map((tool) => tool.function.name);
    expect(names).toContain("create_refund");
    expect(names).not.toContain("create_order");
  });

  it("is only allowed on the PayPal rail", () => {
    expect(() => checkCombination("toolkit", "mock")).toThrow(/PayPal sandbox rail/);
    expect(() => checkCombination("toolkit", "paypal")).not.toThrow();
    expect(() => checkCombination("model", "mock")).not.toThrow();
  });
});
