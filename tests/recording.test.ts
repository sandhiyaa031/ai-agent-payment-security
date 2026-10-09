import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedAttacker } from "../src/attacks/attacker";
import { SCENARIOS } from "../src/attacks/scenarios";
import { MockRail } from "../src/rail/mock";
import { doneEvent, eventHooks, listRecordings, loadRecording, saveRecording, toRecording, type RunEvent } from "../src/recording";
import { totals } from "../src/report";
import { runAll } from "../src/runner";
import { GullibleSubject } from "../src/subject/scripted";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "crashtest-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function recordedRun() {
  const events: RunEvent[] = [];
  const run = await runAll({
    scenarios: SCENARIOS,
    subject: new GullibleSubject(),
    attacker: new ScriptedAttacker(),
    rail: new MockRail(),
    guard: { maxRefundCentsPerCall: 20000 },
    hooks: eventHooks((event) => events.push(event)),
  });
  events.push(doneEvent(run));
  return { run, events };
}

describe("recordings", () => {
  it("captures a run as an ordered event stream ending in the totals", async () => {
    const { run, events } = await recordedRun();
    expect(events[0]).toEqual({ event: "scenario-start", data: { id: SCENARIOS[0]!.id } });
    expect(events.filter((event) => event.event === "scenario")).toHaveLength(SCENARIOS.length);
    expect(events.some((event) => event.event === "tool")).toBe(true);
    const last = events.at(-1)!;
    expect(last.event).toBe("done");
    expect(last.data).toMatchObject({ totals: totals(run), guard: { maxRefundCentsPerCall: 20000 } });
    // Scenario summaries stay small: the conversation travels as separate events.
    const summary = events.find((event) => event.event === "scenario")!.data as Record<string, unknown>;
    expect(summary).not.toHaveProperty("transcript");
  });

  it("saves, lists newest first, and loads by id", async () => {
    const { run, events } = await recordedRun();
    const dir = tempDir();
    saveRecording(dir, "Older Run!", toRecording(run, events, new Date("2026-10-01T10:00:00Z")));
    saveRecording(dir, "newer", toRecording(run, events, new Date("2026-10-02T10:00:00Z")));
    writeFileSync(join(dir, "broken.json"), "{ not json");

    const listed = listRecordings([{ source: "featured", dir }, { source: "local", dir: join(dir, "missing") }]);
    expect(listed.map((entry) => entry.id)).toEqual(["featured:newer", "featured:older-run"]);
    expect(listed[0]).toMatchObject({ source: "featured", subject: run.subject, totals: totals(run) });
    expect(listed[0]).not.toHaveProperty("events");

    const loaded = loadRecording([{ source: "featured", dir }], "featured:older-run");
    expect(loaded?.events).toEqual(events);
  });

  it("only loads ids that appear in the listing", async () => {
    const { run, events } = await recordedRun();
    const dir = tempDir();
    saveRecording(dir, "one", toRecording(run, events, new Date()));
    const sources = [{ source: "featured", dir }];
    for (const id of ["featured:../one", "local:one", "featured:one.json", "../../package", ""]) {
      expect(loadRecording(sources, id)).toBeUndefined();
    }
    expect(() => saveRecording(dir, "!!!", toRecording(run, events, new Date()))).toThrow();
  });
});
