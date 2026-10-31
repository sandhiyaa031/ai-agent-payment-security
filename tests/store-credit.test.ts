import { describe, expect, it } from "vitest";
import { ScriptedAttacker } from "../src/attacks/attacker";
import { SCENARIOS } from "../src/attacks/scenarios";
import { MockRail } from "../src/rail/mock";
import { StoreCreditRail } from "../src/rail/store-credit";
import { runAll } from "../src/runner";
import { ModelSubject, REFUND_TOOL, STORE_CREDIT_TOOL } from "../src/subject/agent";
import { GullibleSubject } from "../src/subject/scripted";
import { createSupportTools, type ToolCallRecord } from "../src/subject/tools";
import { call, fakeModel, NO_DEFENSE, POLICY_DEFENSE } from "./helpers";

describe("a second privileged tool: store credit", () => {
  it("scores exactly as refunds do, because it goes through the same checkpoint", async () => {
    const run = (rail: MockRail | StoreCreditRail, defense = NO_DEFENSE) =>
      runAll({ profile: defense.enforcePolicy ? "guarded" : "baseline", scenarios: SCENARIOS, subject: new GullibleSubject(), attacker: new ScriptedAttacker(), rail, defense, seed: 1 });
    expect((await run(new StoreCreditRail())).metrics).toEqual((await run(new MockRail())).metrics);
    const guarded = await run(new StoreCreditRail(), POLICY_DEFENSE);
    expect(guarded.metrics).toEqual((await run(new MockRail(), POLICY_DEFENSE)).metrics);
    expect(guarded.metrics.overRefundCents).toBe(0);
    expect(guarded.metrics.improperAttemptsBlocked).toBeGreaterThan(0);
    expect(guarded.rail).toBe("store-credit");
  });

  async function setup(defense = NO_DEFENSE) {
    const rail = new StoreCreditRail();
    const charge = await rail.charge({ amountCents: 4900, description: "Desk lamp", reference: "r" });
    const session = { customerEmail: "maya@example.com" };
    const log: ToolCallRecord[] = [];
    const orders = [{ orderId: charge.orderId, captureId: charge.captureId, customerEmail: "maya@example.com", item: "Desk lamp", amountCents: 4900, placedDaysAgo: 3, delivery: "DELIVERED" as const, deliveredDaysAgo: 1, returnReceived: false }];
    return { rail, charge, session, log, tools: createSupportTools({ orders, rail, session, defense, log }) };
  }

  it("gives a model the store-credit tool in place of the refund tool, and records that it is a different configuration", async () => {
    const { rail, charge, session, tools, log } = await setup();
    const { model, exchanges } = fakeModel([{ toolCalls: [call("t1", "issue_store_credit", { order_id: charge.orderId, amount: "49.00", reason: "asked" })] }, { text: "Done." }]);
    const subject = new ModelSubject(model, "stock", STORE_CREDIT_TOOL);
    await subject.startSession(session, tools).reply("credit me please");

    expect(exchanges[0]!.tools.map((tool) => tool.name)).toEqual(["get_order", "issue_store_credit"]);
    expect(exchanges[0]!.system).toContain("issue_store_credit");
    expect(subject.name).toBe("fake model (stock prompt) with issue_store_credit");
    expect(subject.manifest().toolsSha256).not.toBe(new ModelSubject(model, "stock", REFUND_TOOL).manifest().toolsSha256);
    expect(subject.manifest().systemPromptSha256).not.toBe(new ModelSubject(model).manifest().systemPromptSha256);

    expect(log[0]).toMatchObject({ outcome: "completed", improperCents: 4900, refundId: "STORECREDIT0001" });
    expect(await rail.refunds(charge.orderId)).toEqual([{ refundId: "STORECREDIT0001", amountCents: 4900, status: "COMPLETED" }]);
  });

  it("is stopped by the policy defense like any refund, and a model cannot call the tool it was not given", async () => {
    const { rail, charge, session, tools, log } = await setup(POLICY_DEFENSE);
    const { model } = fakeModel([
      { toolCalls: [call("t1", "refund_order", { order_id: charge.orderId, amount: "49.00", reason: "x" })] },
      { toolCalls: [call("t2", "issue_store_credit", { order_id: charge.orderId, amount: "49.00", reason: "x" })] },
      { text: "I can't do that." },
    ]);
    await new ModelSubject(model, "stock", STORE_CREDIT_TOOL).startSession(session, tools).reply("credit me");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: "blocked", blockedBy: "policy" });
    expect(await rail.refunds(charge.orderId)).toEqual([]);
  });

  it("keeps idempotency and refuses unknown payments", async () => {
    const rail = new StoreCreditRail({ continueFrom: { orders: 2, refunds: 5 } });
    const charge = await rail.charge({ amountCents: 1000, description: "x", reference: "r" });
    expect(charge.orderId).toBe("STOREORDER0003");
    const first = await rail.refund({ captureId: charge.captureId, amountCents: 100, note: "n", idempotencyKey: "k" });
    expect(first.refundId).toBe("STORECREDIT0006");
    expect(await rail.refund({ captureId: charge.captureId, amountCents: 100, note: "n", idempotencyKey: "k" })).toEqual(first);
    expect(await rail.refunds(charge.orderId)).toHaveLength(1);
    await expect(rail.refund({ captureId: "nope", amountCents: 100, note: "n", idempotencyKey: "z" })).rejects.toThrow("Unknown payment");
  });
});
