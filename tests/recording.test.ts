import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedAttacker } from "../src/attacks/attacker";
import { SCENARIOS } from "../src/attacks/scenarios";
import { MockRail } from "../src/rail/mock";
import { doneEvent, eventHooks, listRecordings, loadRecording, RECORDING_SCHEMA, saveRecording, toRecording, type RunEvent } from "../src/recording";
import { runAll } from "../src/runner";
import { GullibleSubject } from "../src/subject/scripted";
import type { ToolCallRecord } from "../src/subject/tools";

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
    profile: "baseline",
    scenarios: SCENARIOS,
    subject: new GullibleSubject(),
    attacker: new ScriptedAttacker(),
    rail: new MockRail(),
    defense: { enforcePolicy: false, maxRefundCentsPerOrder: 20000 },
    hooks: eventHooks((event) => events.push(event)),
  });
  events.push(doneEvent(run));
  return { run, events };
}

describe("recordings", () => {
  it("captures a run as an ordered event stream ending in the settings and metrics", async () => {
    const { run, events } = await recordedRun();
    expect(events[0]).toEqual({ event: "scenario-start", data: { id: SCENARIOS[0]!.id } });
    expect(events.filter((event) => event.event === "scenario")).toHaveLength(SCENARIOS.length);
    const last = events.at(-1)!;
    expect(last.event).toBe("done");
    expect(last.data).toMatchObject({
      runId: run.runId,
      profile: "baseline",
      subject: run.subject,
      attacker: "scripted",
      rail: "mock",
      defense: { enforcePolicy: false, maxRefundCentsPerOrder: 20000 },
      policyVersion: "1",
      scenarioSetVersion: "1",
      metrics: run.metrics,
    });
  });

  it("keeps the evidence behind each number: attempts, refund ids, statuses and rail totals", async () => {
    const { events } = await recordedRun();
    const attempt = events.find((event) => event.event === "tool")!.data as { id: string; call: ToolCallRecord };
    expect(attempt.call).toMatchObject({ seq: 1, outcome: "completed", refundStatus: "COMPLETED", amountCents: 12900, entitledCents: 0, improperCents: 12900 });
    expect(attempt.call.refundId).toMatch(/^MOCKREFUND/);

    const summary = events.find((event) => event.event === "scenario")!.data as Record<string, unknown>;
    expect(summary).toMatchObject({ id: "never-arrived", version: 1, unresolved: false });
    expect(summary["orders"]).toMatchObject([
      { amountCents: 12900, entitledCents: 0, completedCents: 12900, overRefundCents: 12900, refunds: [{ status: "COMPLETED", amountCents: 12900 }] },
    ]);
    // The conversation travels as its own events, not inside the summary.
    expect(summary).not.toHaveProperty("transcript");
    expect(summary).not.toHaveProperty("toolCalls");
  });

  it("holds nothing from the environment", async () => {
    const names = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_TEST_CARD_NUMBER", "PAYPAL_TEST_CARD_CVV", "LLM_API_KEY", "ANTHROPIC_API_KEY"];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) process.env[name] = `SENTINEL-${name}`;
      const { run, events } = await recordedRun();
      const text = JSON.stringify(toRecording(run, events, new Date(), "0.1.0"));
      expect(text).not.toContain("SENTINEL");
      expect(text).not.toMatch(/security_code|access_token|client_secret|authorization/i);
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  it("saves, lists newest first, and loads by id with the same events and metrics", async () => {
    const { run, events } = await recordedRun();
    const dir = tempDir();
    saveRecording(dir, "Older Run!", toRecording(run, events, new Date("2026-10-01T10:00:00Z"), "0.1.0"));
    saveRecording(dir, "newer", toRecording(run, events, new Date("2026-10-02T10:00:00Z"), "0.1.0"));
    writeFileSync(join(dir, "broken.json"), "{ not json");
    writeFileSync(join(dir, "old-format.json"), JSON.stringify({ subject: "x", totals: {}, events: [] }));

    const listed = listRecordings([{ source: "featured", dir }, { source: "local", dir: join(dir, "missing") }]);
    expect(listed.map((entry) => entry.id)).toEqual(["featured:newer", "featured:older-run"]);
    expect(listed[0]).toMatchObject({ source: "featured", schema: RECORDING_SCHEMA, runId: run.runId, harnessVersion: "0.1.0", metrics: run.metrics });
    expect(listed[0]).not.toHaveProperty("events");

    const loaded = loadRecording([{ source: "featured", dir }], "featured:older-run");
    expect(loaded?.events).toEqual(events);
    expect(loaded?.metrics).toEqual(run.metrics);
  });

  it("only loads ids that appear in the listing", async () => {
    const { run, events } = await recordedRun();
    const dir = tempDir();
    saveRecording(dir, "one", toRecording(run, events, new Date(), "0.1.0"));
    const sources = [{ source: "featured", dir }];
    for (const id of ["featured:../one", "local:one", "featured:one.json", "../../package", ""]) {
      expect(loadRecording(sources, id)).toBeUndefined();
    }
    expect(() => saveRecording(dir, "!!!", toRecording(run, events, new Date(), "0.1.0"))).toThrow();
  });
});
