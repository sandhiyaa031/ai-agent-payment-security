import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedAttacker } from "../src/attacks/attacker";
import { CORE_SCENARIO_IDS, SCENARIO_SET_VERSION, SCENARIOS as ALL_SCENARIOS } from "../src/attacks/scenarios";
import { identityOf, openProgress, resultsFromEvents, type RunIdentity } from "../src/checkpoint";
import { MockRail } from "../src/rail/mock";
import { doneEvent, eventHooks, toRecording, type Recording, type RunEvent } from "../src/recording";
import { runAll, type RunResult } from "../src/runner";
import { POLICY_VERSION } from "../src/store/policy";
import { GullibleSubject, StrictSubject } from "../src/subject/scripted";
import type { Subject } from "../src/subject/subject";
import type { Defense } from "../src/subject/tools";
import { NO_DEFENSE, POLICY_DEFENSE } from "./helpers";

const SCENARIOS = ALL_SCENARIOS.filter((s) => CORE_SCENARIO_IDS.includes(s.id));

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "crashtest-progress-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const identity = (subject: Subject, defense: Defense): RunIdentity => ({
  profile: defense.enforcePolicy ? "guarded" : "baseline",
  subject: subject.name,
  attacker: new ScriptedAttacker().name,
  defense,
  policyVersion: POLICY_VERSION,
  scenarioSetVersion: SCENARIO_SET_VERSION,
  harnessVersion: "test",
  scenarioIds: SCENARIOS.map((s) => s.id),
});

/** A run with nothing saved along the way: what every continued run must come out equal to. */
async function straight(repeats: number, subject: Subject = new GullibleSubject(), defense: Defense = NO_DEFENSE) {
  return runAll({ profile: identity(subject, defense).profile, scenarios: SCENARIOS, subject, attacker: new ScriptedAttacker(), rail: new MockRail(), defense, repeats });
}

/**
 * One sitting of a recorded run, wired the way the command line wires it.
 * `stopAfter` cuts the sitting short once that many scenario runs have finished in it.
 */
async function sit(options: { path: string; repeats: number; stopAfter?: number; startFrom?: Recording; subject?: Subject; defense?: Defense }) {
  const subject = options.subject ?? new GullibleSubject();
  const defense = options.defense ?? NO_DEFENSE;
  const progress = openProgress(options.path, identity(subject, defense), options.startFrom);
  const earlier = progress.results;
  const events: RunEvent[] = progress.events;
  const recorder = eventHooks((event) => events.push(event));
  let finishedNow = 0;
  const run = await runAll({
    profile: identity(subject, defense).profile,
    scenarios: SCENARIOS,
    subject,
    attacker: new ScriptedAttacker(),
    rail: new MockRail({
      continueFrom: {
        orders: earlier.reduce((total, result) => total + result.orders.length, 0),
        refunds: earlier.reduce((total, result) => total + result.orders.reduce((sum, order) => sum + order.refunds.length, 0), 0),
      },
    }),
    defense,
    repeats: options.repeats,
    resume: { startedAt: progress.startedAt, results: earlier },
    hooks: {
      ...recorder,
      onScenario: (result) => {
        recorder.onScenario?.(result);
        progress.save();
        finishedNow += 1;
        if (finishedNow === options.stopAfter) throw new Error("power cut");
      },
    },
  });
  events.push(doneEvent(run));
  const recording = toRecording(run, events, new Date(), "test", progress.sittings());
  progress.clear();
  return { run, recording, finishedNow };
}

/** What two runs must agree on to count as the same result: everything except when they ran and their random id. */
const outcome = (run: RunResult) => ({ ...run, runId: "", startedAt: "", finishedAt: "" });
const starts = (events: RunEvent[]) => events.filter((entry) => entry.event === "scenario-start").map((entry) => entry.data);

describe("rebuilding results from a recording's events", () => {
  it("gives back every scenario run exactly, including one that ended in an error", async () => {
    const failing: Subject = {
      name: "fails on the second customer",
      startSession: (() => {
        let sessions = 0;
        const inner = new GullibleSubject();
        return (context, tools) => {
          sessions += 1;
          if (sessions === 2) return { reply: async () => Promise.reject(new Error("provider is down")) };
          return inner.startSession(context, tools);
        };
      })(),
    };
    const events: RunEvent[] = [];
    const run = await runAll({
      profile: "baseline",
      scenarios: SCENARIOS,
      subject: failing,
      attacker: new ScriptedAttacker(),
      rail: new MockRail(),
      defense: NO_DEFENSE,
      repeats: 2,
      hooks: eventHooks((event) => events.push(event)),
    });
    events.push(doneEvent(run));
    expect(run.scenarios[1]!.error).toBe("provider is down");

    const rebuilt = resultsFromEvents(events);
    expect(rebuilt.results).toEqual(run.scenarios);
    expect(rebuilt.events).toEqual(events.slice(0, -1));
  });

  it("drops the events of a scenario that never finished", async () => {
    const events: RunEvent[] = [];
    const run = await runAll({ profile: "baseline", scenarios: SCENARIOS, subject: new GullibleSubject(), attacker: new ScriptedAttacker(), rail: new MockRail(), defense: NO_DEFENSE, hooks: eventHooks((event) => events.push(event)) });
    const lastStart = events.map((entry) => entry.event).lastIndexOf("scenario-start");
    const cutMidScenario = events.slice(0, lastStart + 2);
    const rebuilt = resultsFromEvents(cutMidScenario);
    expect(rebuilt.results).toEqual(run.scenarios.slice(0, -1));
    expect(rebuilt.events).toEqual(events.slice(0, lastStart));
  });
});

describe("a run that is stopped and continued", () => {
  it("comes out identical to one that was never stopped, and runs nothing twice", async () => {
    const path = join(tempDir(), "runs", "x.partial.json");
    const whole = await straight(2);

    await expect(sit({ path, repeats: 2, stopAfter: 7 })).rejects.toThrow("power cut");
    expect(existsSync(path)).toBe(true);
    await expect(sit({ path, repeats: 2, stopAfter: 9 })).rejects.toThrow("power cut");
    const last = await sit({ path, repeats: 2 });

    expect(last.finishedNow).toBe(SCENARIOS.length * 2 - 16);
    expect(outcome(last.run)).toEqual(outcome(whole));
    expect(starts(last.recording.events)).toEqual(whole.scenarios.map((result) => ({ id: result.id, trial: result.trial })));
    expect(last.recording.events.at(-1)).toMatchObject({ event: "done", data: { metrics: whole.metrics } });
    expect(last.recording.sittings!.map((sitting) => sitting.scenarioRuns)).toEqual([7, 9, 6]);
    // Finished and saved: nothing is left behind to continue from.
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("keeps order and refund ids unique across sittings", async () => {
    const path = join(tempDir(), "x.partial.json");
    await expect(sit({ path, repeats: 2, stopAfter: 5 })).rejects.toThrow("power cut");
    const { run } = await sit({ path, repeats: 2 });
    const orderIds = run.scenarios.flatMap((result) => result.orders.map((order) => order.orderId));
    const refundIds = run.scenarios.flatMap((result) => result.orders.flatMap((order) => order.refunds.map((refund) => refund.refundId)));
    expect(new Set(orderIds).size).toBe(orderIds.length);
    expect(new Set(refundIds).size).toBe(refundIds.length);
    expect(refundIds.length).toBeGreaterThan(0);
  });

  it("refuses to continue under different settings, so two configurations never mix", async () => {
    const path = join(tempDir(), "x.partial.json");
    await expect(sit({ path, repeats: 1, stopAfter: 3 })).rejects.toThrow("power cut");

    expect(() => openProgress(path, identity(new StrictSubject(), NO_DEFENSE))).toThrow(/different settings \(subject\)/);
    expect(() => openProgress(path, identity(new GullibleSubject(), POLICY_DEFENSE))).toThrow(/different settings \(profile, defense\)/);
    expect(() => openProgress(path, { ...identity(new GullibleSubject(), NO_DEFENSE), harnessVersion: "other" })).toThrow(/harnessVersion/);
    expect(() => openProgress(path, { ...identity(new GullibleSubject(), NO_DEFENSE), scenarioIds: ["never-arrived"] })).toThrow(/scenarioIds/);
    // The matching settings still open it, with the three finished runs intact.
    expect(openProgress(path, identity(new GullibleSubject(), NO_DEFENSE)).results).toHaveLength(3);
  });

  it("refuses a progress file it cannot read as one", () => {
    const path = join(tempDir(), "x.partial.json");
    writeFileSync(path, JSON.stringify({ schema: 1, events: [] }));
    expect(() => openProgress(path, identity(new GullibleSubject(), NO_DEFENSE))).toThrow(/Delete it to start again/);
  });

  it("starts from nothing when there is no progress on disk", () => {
    const progress = openProgress(join(tempDir(), "none.partial.json"), identity(new GullibleSubject(), NO_DEFENSE));
    expect(progress.results).toEqual([]);
    expect(progress.events).toEqual([]);
    expect(progress.sittings()).toEqual([]);
  });
});

describe("adding trials to a finished recording", () => {
  it("keeps the trials it has and comes out identical to running them all at once", async () => {
    const path = join(tempDir(), "x.partial.json");
    const first = await sit({ path, repeats: 1, subject: new StrictSubject(), defense: POLICY_DEFENSE });
    expect(identityOf(first.recording)).toEqual(identity(new StrictSubject(), POLICY_DEFENSE));

    const extended = await sit({ path, repeats: 3, startFrom: first.recording, subject: new StrictSubject(), defense: POLICY_DEFENSE });
    expect(extended.finishedNow).toBe(SCENARIOS.length * 2);
    expect(outcome(extended.run)).toEqual(outcome(await straight(3, new StrictSubject(), POLICY_DEFENSE)));
    expect(extended.recording.repeats).toBe(3);
    expect(extended.recording.sittings!.map((sitting) => sitting.scenarioRuns)).toEqual([SCENARIOS.length, SCENARIOS.length * 2]);
    expect(extended.recording.startedAt).toBe(first.recording.startedAt);
  });

  it("refuses a recording made under other settings", async () => {
    const dir = tempDir();
    const first = await sit({ path: join(dir, "a.partial.json"), repeats: 1 });
    expect(() => openProgress(join(dir, "b.partial.json"), identity(new StrictSubject(), NO_DEFENSE), first.recording)).toThrow(
      /different settings \(subject\), so trials cannot be added/,
    );
  });
});

describe("the test rail", () => {
  it("carries on numbering where an earlier sitting stopped", async () => {
    const rail = new MockRail({ continueFrom: { orders: 5, refunds: 3 } });
    const charge = await rail.charge({ amountCents: 1000, description: "x", reference: "r" });
    expect(charge).toMatchObject({ orderId: "MOCKORDER0006", captureId: "MOCKCAPTURE0006" });
    const refund = await rail.refund({ captureId: charge.captureId, amountCents: 400, note: "n", idempotencyKey: "k" });
    expect(refund.refundId).toBe("MOCKREFUND0004");
  });
});

describe("the command line", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsx = pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const cli = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, ["--import", tsx, join(ROOT, "src", "cli.ts"), "--subject", "gullible", ...args], { cwd, encoding: "utf8" });
  const result = (path: string) => JSON.parse(readFileSync(path, "utf8")) as RunResult;

  it("adds trials to a saved recording with --extend, and refuses to add them under other settings", () => {
    const dir = tempDir();
    execFileSync(process.execPath, ["--import", tsx, join(ROOT, "src", "cli.ts"), "--subject", "gullible", "--repeat", "2", "--json", "whole.json"], { cwd: dir, stdio: "pipe" });

    expect(cli(dir, "--repeat", "1", "--record", "Demo Run").status).toBe(0);
    expect(existsSync(join(dir, "runs", "demo-run.partial.json"))).toBe(false);

    const extended = cli(dir, "--repeat", "2", "--record", "Demo Run", "--extend", "--json", "extended.json");
    expect(extended.status).toBe(0);
    expect(extended.stderr).toContain(`Continuing demo-run: ${ALL_SCENARIOS.length} of ${ALL_SCENARIOS.length * 2} scenario runs are already done.`);
    expect(outcome(result(join(dir, "extended.json")))).toEqual(outcome(result(join(dir, "whole.json"))));

    const recording = JSON.parse(readFileSync(join(dir, "recordings", "demo-run.json"), "utf8")) as Recording;
    expect(recording.repeats).toBe(2);
    expect(recording.sittings!.map((sitting) => sitting.scenarioRuns)).toEqual([ALL_SCENARIOS.length, ALL_SCENARIOS.length]);
    expect(existsSync(join(dir, "runs", "demo-run.partial.json"))).toBe(false);

    const mixed = cli(dir, "--profile", "guarded", "--repeat", "3", "--record", "Demo Run", "--extend");
    expect(mixed.status).toBe(1);
    expect(mixed.stderr).toContain("different settings (profile, defense), so trials cannot be added");

    const fewer = cli(dir, "--repeat", "1", "--record", "Demo Run", "--extend");
    expect(fewer.status).toBe(1);
    expect(fewer.stderr).toContain("already has trials beyond --repeat 1");

    const nothing = cli(dir, "--repeat", "2", "--record", "never-made", "--extend");
    expect(nothing.status).toBe(1);
    expect(nothing.stderr).toContain("--extend found no recordings/never-made.json");
  }, 120_000);
});
