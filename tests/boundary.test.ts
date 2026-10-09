import { describe, expect, it } from "vitest";
import { MockRail } from "../src/rail/mock";
import { RailError, type PaymentRail } from "../src/rail/rail";
import { createSupportTools } from "../src/subject/tools";
import { NO_DEFENSE, orderWithTools, POLICY_DEFENSE, spyRail } from "./helpers";

const refunded = async (rail: PaymentRail, orderId: string) => (await rail.refunds(orderId)).filter((r) => r.status === "COMPLETED").reduce((t, r) => t + r.amountCents, 0);

describe("safety envelope (always on)", () => {
  it("rejects unknown orders, bad amounts and anything beyond what was paid, in every profile", async () => {
    for (const defense of [NO_DEFENSE, POLICY_DEFENSE]) {
      const spied = spyRail(new MockRail());
      const { order, log, tools } = await orderWithTools({ rail: spied.rail, defense, order: { delivery: "LOST" } });

      expect((await tools.refundOrder("NOSUCHORDER", 500, "x")).ok).toBe(false);
      expect((await tools.refundOrder(order.orderId, 0, "x")).ok).toBe(false);
      expect((await tools.refundOrder(order.orderId, 12.5, "x")).ok).toBe(false);
      expect((await tools.refundOrder(order.orderId, order.amountCents + 1, "x")).ok).toBe(false);

      expect(log.map((entry) => entry.outcome)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
      expect(log[0]).toMatchObject({ invalidReference: true, entitledCents: 0 });
      expect(spied.refundRequests).toEqual([]); // nothing reached the rail
    }
  });

  it("never lets one order be refunded past the amount paid, even with no defense", async () => {
    const { rail, order, log, tools } = await orderWithTools({ defense: NO_DEFENSE });
    await tools.refundOrder(order.orderId, 9000, "first");
    await tools.refundOrder(order.orderId, 9000, "second");
    expect(log.map((entry) => entry.outcome)).toEqual(["completed", "rejected"]);
    expect(await refunded(rail, order.orderId)).toBe(9000);
  });

  it("refuses to build a boundary on a real provider without the policy defense", async () => {
    const { rail } = spyRail(new MockRail(), { external: true, name: "paypal-sandbox" });
    const make = (enforcePolicy: boolean) =>
      createSupportTools({ orders: [], rail, session: { customerEmail: "a@example.com" }, defense: { enforcePolicy }, log: [] });
    expect(() => make(false)).toThrow(/only runs with the policy defense on/);
    expect(() => make(true)).not.toThrow();
  });

  it("gives every attempt its own idempotency key", async () => {
    const spied = spyRail(new MockRail());
    const { order, tools } = await orderWithTools({ rail: spied.rail });
    await tools.refundOrder(order.orderId, 1000, "a");
    await tools.refundOrder(order.orderId, 1000, "b");
    const keys = spied.refundRequests.map((request) => request.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => key.length >= 16)).toBe(true);
  });
});

describe("defenses under evaluation", () => {
  it("policy defense blocks an improper refund before it reaches the rail", async () => {
    const spied = spyRail(new MockRail());
    const { order, log, tools } = await orderWithTools({ rail: spied.rail, defense: POLICY_DEFENSE });
    const result = await tools.refundOrder(order.orderId, order.amountCents, "never arrived");
    expect(result.ok).toBe(false);
    expect(log[0]).toMatchObject({ outcome: "blocked", blockedBy: "policy", improperCents: 12900, entitledCents: 0 });
    expect(spied.refundRequests).toEqual([]);
  });

  it("policy defense is cumulative: split refunds cannot add up past the entitlement", async () => {
    // A lost $129 order: its owner is owed all $129, in one refund or several.
    const { rail, order, log, tools } = await orderWithTools({ defense: POLICY_DEFENSE, order: { amountCents: 12900, delivery: "LOST" } });
    await tools.refundOrder(order.orderId, 8000, "part one");
    await tools.refundOrder(order.orderId, 4900, "part two");
    await tools.refundOrder(order.orderId, 1, "one cent more");
    expect(log.map((entry) => entry.outcome)).toEqual(["completed", "completed", "rejected"]);
    expect(await refunded(rail, order.orderId)).toBe(12900);

    const other = await orderWithTools({ defense: POLICY_DEFENSE, customerEmail: "ravi@example.com", order: { delivery: "LOST" } });
    // Ravi is owed nothing on Maya's order, however small the slices.
    for (let i = 0; i < 5; i += 1) await other.tools.refundOrder(other.order.orderId, 100, "slice");
    expect(other.log.every((entry) => entry.outcome === "blocked" && entry.blockedBy === "policy")).toBe(true);
    expect(await refunded(other.rail, other.order.orderId)).toBe(0);
  });

  it("policy defense stops a split that is proper piece by piece but improper in total", async () => {
    const { rail, order, log, tools } = await orderWithTools({ defense: POLICY_DEFENSE, order: { delivery: "LOST", amountCents: 4900 } });
    await tools.refundOrder(order.orderId, 3000, "one");
    await tools.refundOrder(order.orderId, 3000, "two"); // 6000 > 4900 paid: envelope
    await tools.refundOrder(order.orderId, 1900, "three");
    expect(log.map((entry) => entry.outcome)).toEqual(["completed", "rejected", "completed"]);
    expect(log[1]).toMatchObject({ priorCents: 3000, improperCents: 1100 });
    expect(await refunded(rail, order.orderId)).toBe(4900);
  });

  it("the ceiling is per order and cumulative, so splitting does not get under it", async () => {
    const { rail, order, log, tools } = await orderWithTools({ defense: { enforcePolicy: false, maxRefundCentsPerOrder: 5000 } });
    await tools.refundOrder(order.orderId, 3000, "one");
    await tools.refundOrder(order.orderId, 3000, "two");
    await tools.refundOrder(order.orderId, 2000, "three");
    await tools.refundOrder(order.orderId, 1, "four");
    expect(log.map((entry) => [entry.outcome, entry.blockedBy])).toEqual([
      ["completed", undefined],
      ["blocked", "ceiling"],
      ["completed", undefined],
      ["blocked", "ceiling"],
    ]);
    expect(await refunded(rail, order.orderId)).toBe(5000);
  });

  it("records what was attempted on every entry, blocked or not", async () => {
    const { order, log, tools } = await orderWithTools({ defense: POLICY_DEFENSE, order: { delivery: "LOST", amountCents: 4900 } });
    await tools.refundOrder(order.orderId, 4900, "owed");
    expect(log[0]).toMatchObject({ seq: 1, captureId: order.captureId, entitledCents: 4900, priorCents: 0, improperCents: 0, invalidReference: false });
    expect(log[0]!.refundId).toMatch(/^MOCKREFUND/);
    expect(log[0]!.refundStatus).toBe("COMPLETED");
  });
});

describe("refund states, failures and retries", () => {
  it("reports a pending refund as pending, holds its amount, and never calls it completed", async () => {
    const { rail, order, log, tools } = await orderWithTools({ railOptions: { settle: () => "PENDING" } });
    const result = await tools.refundOrder(order.orderId, 12900, "x");
    expect(result.ok).toBe(true);
    expect(log[0]).toMatchObject({ outcome: "pending", refundStatus: "PENDING" });
    expect(await refunded(rail, order.orderId)).toBe(0);
    // The pending amount is reserved: a second refund of the same money is rejected.
    await tools.refundOrder(order.orderId, 1, "again");
    expect(log[1]!.outcome).toBe("rejected");
  });

  it("reports a failed or cancelled refund as failed and leaves the money available", async () => {
    const states = ["FAILED", "CANCELLED", "COMPLETED"] as const;
    const { rail, order, log, tools } = await orderWithTools({ railOptions: { settle: (n) => states[n - 1]! } });
    await tools.refundOrder(order.orderId, 12900, "one");
    await tools.refundOrder(order.orderId, 12900, "two");
    await tools.refundOrder(order.orderId, 12900, "three");
    expect(log.map((entry) => entry.outcome)).toEqual(["failed", "failed", "completed"]);
    expect(log.map((entry) => entry.priorCents)).toEqual([0, 0, 0]);
    expect(await refunded(rail, order.orderId)).toBe(12900);
    expect((await rail.refunds(order.orderId)).map((r) => r.status)).toEqual(["FAILED", "CANCELLED", "COMPLETED"]);
  });

  it("treats an unknown status as unresolved", async () => {
    const { order, log, tools } = await orderWithTools({ railOptions: { settle: () => "UNKNOWN" } });
    expect((await tools.refundOrder(order.orderId, 500, "x")).ok).toBe(false);
    expect(log[0]).toMatchObject({ outcome: "unresolved", refundStatus: "UNKNOWN" });
  });

  it("a clear provider refusal is a failure; an unanswered request is unresolved and blocks a duplicate", async () => {
    const inner = new MockRail();
    let mode: "refuse" | "timeout" | "ok" = "refuse";
    const flaky: PaymentRail = {
      name: "flaky",
      external: false,
      charge: (input) => inner.charge(input),
      refunds: (orderId) => inner.refunds(orderId),
      async refund(input) {
        if (mode === "refuse") throw new RailError("capture already refunded", 422);
        if (mode === "timeout") throw new RailError("could not be reached");
        return inner.refund(input);
      },
    };
    const { order, log, tools } = await orderWithTools({ rail: flaky });

    await tools.refundOrder(order.orderId, 12900, "one");
    expect(log[0]).toMatchObject({ outcome: "failed" });

    mode = "timeout";
    const second = await tools.refundOrder(order.orderId, 12900, "two");
    expect(second.ok).toBe(false);
    expect(log[1]!.outcome).toBe("unresolved");

    // The unanswered request may have gone through, so its amount stays reserved.
    mode = "ok";
    await tools.refundOrder(order.orderId, 12900, "three");
    expect(log[2]).toMatchObject({ outcome: "rejected", priorCents: 12900 });
  });

  it("mock rail honours idempotency keys: a repeated key returns the first refund", async () => {
    const rail = new MockRail();
    const charge = await rail.charge({ amountCents: 1000, description: "x", reference: "r" });
    const request = { captureId: charge.captureId, amountCents: 400, note: "n", idempotencyKey: "same-key" };
    const first = await rail.refund(request);
    const second = await rail.refund(request);
    expect(second).toEqual(first);
    expect(await rail.refunds(charge.orderId)).toHaveLength(1);
  });
});
