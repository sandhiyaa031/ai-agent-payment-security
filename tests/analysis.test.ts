import { describe, expect, it } from "vitest";
import { compare, recordingFacts, scenarioRows, summarize, trialFacts } from "../src/analysis";
import { ScriptedAttacker } from "../src/attacks/attacker";
import { SCENARIOS } from "../src/attacks/scenarios";
import { MockRail } from "../src/rail/mock";
import { doneEvent, eventHooks, toRecording, type RunEvent } from "../src/recording";
import { runAll } from "../src/runner";
import { GullibleSubject, RefuseAllSubject, StrictSubject } from "../src/subject/scripted";
import type { Subject } from "../src/subject/subject";
import { NO_DEFENSE } from "./helpers";

const run = (subject: Subject, repeats = 3) =>
  runAll({ profile: "baseline", scenarios: SCENARIOS, subject, attacker: new ScriptedAttacker(), rail: new MockRail(), defense: NO_DEFENSE, repeats, seed: 1 });

describe("summaries", () => {
  it("agree with the run's own metrics, which are computed by separate code", async () => {
    const result = await run(new GullibleSubject());
    const summary = summarize(result.scenarios.map(trialFacts));
    const m = result.metrics;

    expect(summary.trials).toBe(SCENARIOS.length * 3);
    expect(summary.trialsPerScenario).toEqual({ min: 3, max: 3 });
    expect([summary.attackSuccess.k, summary.attackSuccess.n]).toEqual([m.attackScenariosWithAttempt, m.attackScenarios]);
    expect([summary.loss.k, summary.loss.n]).toEqual([m.attackScenariosWithLoss, m.attackScenarios]);
    expect([summary.honestFullRefund.k, summary.honestFullRefund.n]).toEqual([m.eligibleFullyRefunded, m.eligibleOrders]);
    expect(summary.unresolved.k).toBe(m.unresolvedScenarios);

    const attackLoss = result.scenarios.filter((s) => s.kind === "attack").flatMap((s) => s.orders).reduce((t, o) => t + o.overRefundCents, 0);
    expect(summary.dollarsPerAttack.mean).toBeCloseTo(attackLoss / 100 / m.attackScenarios, 10);
    expect(summary.dollarsPerAttack.lo).toBeLessThanOrEqual(summary.dollarsPerAttack.mean);
    expect(summary.dollarsPerAttack.hi).toBeGreaterThanOrEqual(summary.dollarsPerAttack.mean);
    expect(summary.attackSuccess.ci.lo).toBeLessThan(summary.attackSuccess.rate);
    expect(summary.tokensPerConversation).toBeUndefined();
  });

  it("show a policy-perfect agent losing nothing and an agent that refuses everyone failing every honest customer", async () => {
    const strict = summarize((await run(new StrictSubject())).scenarios.map(trialFacts));
    expect(strict.attackSuccess.k).toBe(0);
    expect(strict.attackSuccess.ci.hi).toBeGreaterThan(0);
    expect(strict.loss.k).toBe(0);
    expect(strict.honestFullRefund.rate).toBe(1);
    expect(strict.underRefundShare).toEqual({ share: 0, lo: 0, hi: 0 });

    const refuser = summarize((await run(new RefuseAllSubject())).scenarios.map(trialFacts));
    expect(refuser.attackSuccess.k).toBe(0);
    expect(refuser.honestFullRefund.k).toBe(0);
    expect(refuser.underRefundShare.share).toBe(1);
  });

  it("are the same whether read from a run or from its recording", async () => {
    const events: RunEvent[] = [];
    const result = await runAll({ profile: "baseline", scenarios: SCENARIOS, subject: new GullibleSubject(), attacker: new ScriptedAttacker(), rail: new MockRail(), defense: NO_DEFENSE, repeats: 2, hooks: eventHooks((e) => events.push(e)) });
    events.push(doneEvent(result));
    const recording = toRecording(result, events, new Date(), "test");
    expect(recordingFacts(recording)).toEqual(result.scenarios.map(trialFacts));
  });
});

describe("comparisons", () => {
  it("find a clear difference between an agent that refunds anyone and one that applies the policy", async () => {
    const gullible = (await run(new GullibleSubject())).scenarios.map(trialFacts);
    const strict = (await run(new StrictSubject())).scenarios.map(trialFacts);
    const result = compare(gullible, strict, "attackSuccess", "greater");
    expect(result.a.k).toBeGreaterThan(0);
    expect(result.b.k).toBe(0);
    expect(result.difference.diff).toBeCloseTo(result.a.rate, 12);
    expect(result.difference.lo).toBeGreaterThan(0);
    expect(result.p).toBeLessThan(0.001);
    expect(result.fisherP).toBeLessThan(0.001);
  });

  it("find nothing when a configuration is compared with itself, as an A/A check should", async () => {
    const facts = (await run(new GullibleSubject(), 4)).scenarios.map(trialFacts);
    const first = facts.filter((f) => f.trial <= 2);
    const second = facts.filter((f) => f.trial > 2);
    for (const outcome of ["attackSuccess", "loss", "honestFullRefund"] as const) {
      const result = compare(first, second, outcome);
      expect(result.difference.diff).toBe(0);
      expect(result.p).toBe(1);
    }
  });
});

describe("per-scenario rows", () => {
  it("give every scenario its own counts and interval", async () => {
    const rows = scenarioRows((await run(new GullibleSubject())).scenarios.map(trialFacts));
    expect(rows.map((row) => row.scenario)).toEqual(SCENARIOS.map((s) => s.id));
    for (const row of rows) {
      expect(row.trials).toBe(3);
      expect(row.attempts.ci.lo).toBeLessThanOrEqual(row.attempts.rate);
    }
    const neverArrived = rows.find((row) => row.scenario === "never-arrived")!;
    expect(neverArrived).toMatchObject({ kind: "attack", attempts: { k: 3, n: 3 }, losses: { k: 3, n: 3 }, lostCents: 3 * 12900 });
  });
});
