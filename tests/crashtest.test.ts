import { describe, expect, it } from "vitest";
import { ScriptedAttacker } from "../src/attacks/attacker";
import { SCENARIOS } from "../src/attacks/scenarios";
import { toCents, toDecimal } from "../src/money";
import { MockRail } from "../src/rail/mock";
import { RailError } from "../src/rail/rail";
import { capAnalysis, formatReport, totals } from "../src/report";
import { runAll } from "../src/runner";
import { entitledCents, type StoreOrder } from "../src/store/policy";
import { GullibleSubject, StrictSubject } from "../src/subject/scripted";
import type { Subject } from "../src/subject/subject";
import type { Guard } from "../src/subject/tools";

function run(subject: Subject, guard: Guard = {}) {
  return runAll({ scenarios: SCENARIOS, subject, attacker: new ScriptedAttacker(), rail: new MockRail(), guard });
}

describe("money", () => {
  it("converts between decimal strings and cents", () => {
    expect(toCents("12")).toBe(1200);
    expect(toCents("12.3")).toBe(1230);
    expect(toCents("0.07")).toBe(7);
    expect(toDecimal(1205)).toBe("12.05");
    expect(toDecimal(40)).toBe("0.40");
  });

  it("rejects anything that is not a plain dollar amount", () => {
    for (const bad of ["", "-5", "1.234", "ten", "1e3", "$5"]) {
      expect(() => toCents(bad)).toThrow();
    }
  });
});

describe("mock rail", () => {
  it("tracks refunds and refuses to refund more than was paid", async () => {
    const rail = new MockRail();
    const charge = await rail.charge({ amountCents: 1000, description: "x", reference: "r" });
    await rail.refund({ captureId: charge.captureId, amountCents: 600, note: "n" });
    await expect(rail.refund({ captureId: charge.captureId, amountCents: 500, note: "n" })).rejects.toBeInstanceOf(RailError);
    expect(await rail.refundedCents(charge.orderId)).toBe(600);
  });
});

describe("refund policy", () => {
  const order: StoreOrder = {
    orderId: "O1",
    captureId: "C1",
    customerEmail: "a@example.com",
    item: "thing",
    amountCents: 5000,
    placedDaysAgo: 5,
    delivery: "DELIVERED",
    deliveredDaysAgo: 2,
    returnReceived: false,
  };

  it("owes nothing for a delivered order that was not returned", () => {
    expect(entitledCents(order, "a@example.com")).toBe(0);
  });
  it("owes a full refund once the return is received inside the window", () => {
    expect(entitledCents({ ...order, returnReceived: true }, "a@example.com")).toBe(5000);
    expect(entitledCents({ ...order, returnReceived: true, deliveredDaysAgo: 31 }, "a@example.com")).toBe(0);
  });
  it("owes a full refund for lost or badly late orders", () => {
    expect(entitledCents({ ...order, delivery: "LOST" }, "a@example.com")).toBe(5000);
    expect(entitledCents({ ...order, delivery: "IN_TRANSIT", placedDaysAgo: 11 }, "a@example.com")).toBe(5000);
    expect(entitledCents({ ...order, delivery: "IN_TRANSIT", placedDaysAgo: 10 }, "a@example.com")).toBe(0);
  });
  it("owes nothing to anyone but the customer who placed the order", () => {
    expect(entitledCents({ ...order, delivery: "LOST" }, "b@example.com")).toBe(0);
    expect(entitledCents({ ...order, delivery: "LOST" }, "A@Example.com")).toBe(5000);
  });
});

describe("crashtest run", () => {
  it("shows the gullible agent losing everything that was at risk", async () => {
    const result = await run(new GullibleSubject());
    const t = totals(result);
    expect(t.atRiskCents).toBeGreaterThan(0);
    expect(t.wrongfulCents).toBe(t.atRiskCents - 6900); // the status question never mentions money
    expect(t.attacksThatPaid).toBe(t.attacksRun);
    expect(t.paidOwedCents).toBe(t.owedCents);
  });

  it("shows the strict agent losing nothing and still paying honest customers", async () => {
    const t = totals(await run(new StrictSubject()));
    expect(t.wrongfulCents).toBe(0);
    expect(t.attacksThatPaid).toBe(0);
    expect(t.paidOwedCents).toBe(t.owedCents);
    expect(t.owedCents).toBe(3900 + 4900 + 11900);
  });

  it("lets the policy guard protect even the gullible agent", async () => {
    const result = await run(new GullibleSubject(), { enforcePolicy: true });
    const t = totals(result);
    expect(t.wrongfulCents).toBe(0);
    expect(t.paidOwedCents).toBe(t.owedCents);
    expect(result.scenarios.flatMap((s) => s.toolCalls).some((call) => call.outcome === "blocked")).toBe(true);
  });

  it("blocks refunds above the ceiling, honest ones included", async () => {
    const t = totals(await run(new GullibleSubject(), { maxRefundCentsPerCall: 5000 }));
    expect(t.wrongfulCents).toBe(0); // every attack order costs more than $50
    expect(t.paidOwedCents).toBe(3900 + 4900); // the $119 honest refund is blocked too
  });

  it("keeps the ceiling replay consistent with what the rail recorded", async () => {
    const result = await run(new GullibleSubject());
    const t = totals(result);
    const [none, fifty] = capAnalysis(result, [null, 5000]);
    expect(none).toEqual({ capCents: null, wrongfulCents: t.wrongfulCents, paidOwedCents: t.paidOwedCents });
    expect(fifty).toEqual({ capCents: 5000, wrongfulCents: 0, paidOwedCents: 3900 + 4900 });
  });

  it("gives each scenario its own orders", async () => {
    const result = await run(new GullibleSubject());
    const ids = result.scenarios.flatMap((s) => s.orders.map((o) => o.orderId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("prints a report with the headline numbers", async () => {
    const report = formatReport(await run(new GullibleSubject()));
    expect(report).toContain("Money lost to attacks");
    expect(report).toContain("never-arrived");
  });
});
