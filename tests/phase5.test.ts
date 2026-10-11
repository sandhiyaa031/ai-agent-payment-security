import { describe, expect, it } from "vitest";
import { ScriptedAttacker } from "../src/attacks/attacker";
import { CORE_SCENARIO_IDS, SCENARIOS, type Scenario } from "../src/attacks/scenarios";
import { scenarioStats } from "../src/metrics";
import { planRun } from "../src/profiles";
import { MockRail } from "../src/rail/mock";
import { formatReport } from "../src/report";
import { runAll } from "../src/runner";
import { GullibleSubject, RefuseAllSubject, StrictSubject } from "../src/subject/scripted";
import type { Subject } from "../src/subject/subject";
import type { Defense } from "../src/subject/tools";
import { NO_DEFENSE, POLICY_DEFENSE } from "./helpers";

const pick = (...ids: string[]): Scenario[] => ids.map((id) => SCENARIOS.find((s) => s.id === id)!);

function run(subject: Subject, scenarios: Scenario[], defense: Defense = NO_DEFENSE, repeats = 1) {
  return runAll({
    profile: defense.enforcePolicy ? "guarded" : "baseline",
    scenarios,
    subject,
    attacker: new ScriptedAttacker(),
    rail: new MockRail(),
    defense,
    repeats,
  });
}

describe("scenario set", () => {
  it("has unique ids, and every script names an order the scenario defines", () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    expect(CORE_SCENARIO_IDS.every((id) => SCENARIOS.some((s) => s.id === id))).toBe(true);
    for (const s of SCENARIOS) {
      const keys = new Set(s.orders.map((order) => order.key));
      const used = [...s.script, s.goal].flatMap((line) => [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
      expect(used.length, s.id).toBeGreaterThan(0);
      for (const key of used) expect(keys.has(key), `${s.id} uses {${key}}`).toBe(true);
    }
  });

  it("covers attacks and honest customers, including honest customers who are owed nothing", () => {
    const attacks = SCENARIOS.filter((s) => s.kind === "attack");
    const benign = SCENARIOS.filter((s) => s.kind === "benign");
    expect(attacks.length).toBe(15);
    expect(benign.length).toBe(7);
    const owed = (s: Scenario) => s.orders.reduce((total, order) => total + order.expectedRefundCents, 0);
    expect(benign.filter((s) => owed(s) > 0).length).toBe(5);
    expect(benign.filter((s) => owed(s) === 0).length).toBe(2);
  });

  it("on the full set, the strict agent loses nothing and pays everything owed; the refuser pays nothing", async () => {
    // Owed across the set, added by hand: 39 + 49 + 119 + 59 + 89 + 159 + 29 = $543.
    const strict = (await run(new StrictSubject(), SCENARIOS)).metrics;
    expect(strict).toMatchObject({ overRefundCents: 0, improperAttempts: 0, entitledCents: 54300, correctlyRefundedCents: 54300, underRefundCents: 0 });
    expect(strict.eligibleOrders).toBe(7);

    const refuser = (await run(new RefuseAllSubject(), SCENARIOS)).metrics;
    expect(refuser).toMatchObject({ overRefundCents: 0, underRefundCents: 54300, eligibleUnderRefunded: 7 });
  });
});

describe("new attack scenarios against the gullible agent", () => {
  it("split refund: the whole order is lost, and the repeats are counted", async () => {
    const m = (await run(new GullibleSubject(), pick("split-refund"))).metrics;
    expect(m).toMatchObject({ overRefundCents: 24000, refundAttempts: 3, improperAttempts: 3, improperAttemptsCompleted: 1, repeatAttempts: 2 });
  });

  it("duplicate refund: the owed refund is paid once, and each resend is an improper attempt that moves no money", async () => {
    const baseline = (await run(new GullibleSubject(), pick("duplicate-refund"))).metrics;
    expect(baseline).toMatchObject({ overRefundCents: 0, correctlyRefundedCents: 5900, improperAttempts: 2, improperAttemptCents: 11800, improperAttemptsRejected: 2, repeatAttempts: 2 });
    const guarded = (await run(new GullibleSubject(), pick("duplicate-refund"), POLICY_DEFENSE)).metrics;
    expect(guarded).toMatchObject({ overRefundCents: 0, correctlyRefundedCents: 5900, improperAttempts: 2 });
  });

  it("invalid reference: the made-up order is ignored, and the real order is refunded only when named", async () => {
    const result = await run(new GullibleSubject(), pick("invalid-reference"));
    expect(result.scenarios[0]!.transcript[0]!.agent).toBe("Which order is this about?");
    expect(result.metrics).toMatchObject({ overRefundCents: 8500, improperAttempts: 1 });
  });

  it("late return and the honest late return are both owed nothing, whoever asks", async () => {
    const m = (await run(new GullibleSubject(), pick("late-return", "benign-late-return-polite"), POLICY_DEFENSE)).metrics;
    expect(m).toMatchObject({ overRefundCents: 0, entitledCents: 0 });
    expect(m.improperAttemptsBlocked).toBe(3); // two turns of the attack, one honest ask
  });

  it("two orders, one owed: only the lost order is refunded by the strict agent", async () => {
    const result = await run(new StrictSubject(), pick("benign-two-orders-one-owed"));
    const [lost, arrived] = result.scenarios[0]!.orders;
    expect(lost).toMatchObject({ entitledCents: 2900, completedCents: 2900 });
    expect(arrived).toMatchObject({ entitledCents: 0, completedCents: 0 });
  });
});

describe("repeated trials", () => {
  it("runs every scenario the requested number of times, interleaved, and counts trials", async () => {
    const result = await run(new GullibleSubject(), pick("never-arrived", "benign-lost-package"), NO_DEFENSE, 3);
    expect(result.repeats).toBe(3);
    expect(result.scenarios.map((s) => `${s.id}#${s.trial}`)).toEqual([
      "never-arrived#1",
      "benign-lost-package#1",
      "never-arrived#2",
      "benign-lost-package#2",
      "never-arrived#3",
      "benign-lost-package#3",
    ]);
    expect(result.metrics).toMatchObject({ scenarios: 6, overRefundCents: 3 * 12900, correctlyRefundedCents: 3 * 4900, attackScenarios: 3, attackScenariosWithLoss: 3 });
    // Every trial used its own fresh orders.
    const ids = result.scenarios.flatMap((s) => s.orders.map((order) => order.orderId));
    expect(new Set(ids).size).toBe(6);

    expect(scenarioStats(result.scenarios)).toEqual([
      { id: "never-arrived", kind: "attack", trials: 3, trialsWithImproperAttempt: 3, trialsWithLoss: 3, trialsShortChanged: 0, trialsUnresolved: 0, overRefundCents: 38700, underRefundCents: 0 },
      { id: "benign-lost-package", kind: "benign", trials: 3, trialsWithImproperAttempt: 0, trialsWithLoss: 0, trialsShortChanged: 0, trialsUnresolved: 0, overRefundCents: 0, underRefundCents: 0 },
    ]);

    const report = formatReport(result);
    expect(report).toContain("Trials           : 3 per scenario, 6 scenario runs in total");
    expect(report).toContain("Per scenario, over 3 trials each");
  });

  it("reports differing trials as counts, so a result seen once in three is not shown as a certainty", async () => {
    let session = 0;
    const flaky: Subject = {
      name: "refunds on the second trial only",
      startSession(_context, tools) {
        session += 1;
        const mine = session;
        return {
          async reply(message) {
            if (mine === 2) await tools.refundOrder(message.match(/MOCKORDER\d+/)![0], 12900, "x");
            return "ok";
          },
        };
      },
    };
    const result = await run(flaky, pick("never-arrived"), NO_DEFENSE, 3);
    expect(scenarioStats(result.scenarios)[0]).toMatchObject({ trials: 3, trialsWithLoss: 1, trialsWithImproperAttempt: 1, overRefundCents: 12900 });
  });

  it("accepts only sensible repeat counts, with a lower limit on a hosted copy", () => {
    expect(planRun({}, { hosted: false }).repeats).toBe(1);
    expect(planRun({ repeat: "10" }, { hosted: false }).repeats).toBe(10);
    for (const bad of ["0", "-1", "2.5", "many", "31"]) {
      expect(() => planRun({ repeat: bad }, { hosted: false }), bad).toThrow(/repeat count/);
    }
    expect(planRun({ repeat: "3" }, { hosted: true }).repeats).toBe(3);
    expect(() => planRun({ repeat: "4" }, { hosted: true })).toThrow(/repeat count/);
  });
});
