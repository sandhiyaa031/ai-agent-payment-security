import { describe, expect, it } from "vitest";
import { ScriptedAttacker } from "../src/attacks/attacker";
import { SCENARIOS } from "../src/attacks/scenarios";
import { MockRail } from "../src/rail/mock";
import { doneEvent, eventHooks, toRecording, type Recording, type RunEvent } from "../src/recording";
import { experimentSection, pilotSection, resultsMarkdown, type TwoArmExperiment } from "../src/results-report";
import { runAll } from "../src/runner";
import { GullibleSubject, StrictSubject } from "../src/subject/scripted";
import type { Subject } from "../src/subject/subject";
import { NO_DEFENSE } from "./helpers";

const PROTOCOL = "experiments/test/protocol.md";

async function recorded(subject: Subject, repeats: number, protocol?: string): Promise<Recording> {
  const events: RunEvent[] = [];
  const run = await runAll({ profile: "baseline", scenarios: SCENARIOS, subject, attacker: new ScriptedAttacker(), rail: new MockRail(), defense: NO_DEFENSE, repeats, seed: 1, hooks: eventHooks((e) => events.push(e)) });
  events.push(doneEvent(run));
  return toRecording(run, events, new Date(), "test", protocol ? { protocol: { path: protocol, sha256: "0".repeat(64) } } : {});
}

/** The rule-based agents stand in for two prompt variants of one model. */
const spec = (targetTrials: number, cutoff = new Date("2999-01-01")): TwoArmExperiment => ({
  title: "Test experiment",
  protocol: PROTOCOL,
  registered: "today",
  cutoff,
  targetTrials,
  control: { label: "control", matches: (r) => r.subject.startsWith("gullible") },
  treatment: { label: "treatment", matches: (r) => r.subject.startsWith("strict") },
  models: ["test-model"],
  primaryModels: ["test-model"],
  margin: 0.05,
  model: () => "test-model",
});

describe("experiment results", () => {
  it("show only progress until every configuration reaches the pre-registered number of trials", async () => {
    const recordings = [await recorded(new GullibleSubject(), 2, PROTOCOL), await recorded(new StrictSubject(), 1, PROTOCOL)];
    const text = experimentSection(spec(2), recordings, new Date()).join("\n");
    expect(text).toContain("**In progress.**");
    expect(text).toContain("| test-model | control | 2 of 2 |");
    expect(text).toContain("| test-model | treatment | 1 of 2 |");
    expect(text).not.toContain("### Rates");
    expect(text).not.toContain("### H1");
  });

  it("report rates, both hypotheses, the A/A check and notable scenarios once complete", async () => {
    const recordings = [await recorded(new GullibleSubject(), 2, PROTOCOL), await recorded(new StrictSubject(), 2, PROTOCOL)];
    const text = experimentSection(spec(2), recordings, new Date()).join("\n");
    for (const heading of ["### Rates", "### H1", "### H2", "### A/A check", "### Scenarios with anything to report", "### Deviations from the protocol"]) {
      expect(text).toContain(heading);
    }
    // The policy-perfect agent attempts nothing, so attack success is clearly lower for the treatment.
    const h1 = text.split("\n").find((line) => line.startsWith("| test-model | confirmatory |"))!;
    expect(h1).toMatch(/\| yes \|$/);
    expect(h1).toContain("0 of 30 (0.0%; 0.0% to 11.4%)");
    // Identical rule-based trials: the A/A check must find exactly nothing.
    const aa = text.split("\n").filter((line) => line.includes("| attack success |") || line.includes("| honest orders paid in full |"));
    expect(aa.length).toBeGreaterThan(0);
    for (const line of aa) expect(line).toMatch(/\+0\.0 points .*\| 1\.000 \|$/);
    expect(text).toContain("None recorded.");
  });

  it("analyse whatever was completed once the cutoff has passed, and say so", async () => {
    const recordings = [await recorded(new GullibleSubject(), 2, PROTOCOL), await recorded(new StrictSubject(), 1, PROTOCOL)];
    const text = experimentSection(spec(2, new Date("2000-01-01")), recordings, new Date()).join("\n");
    expect(text).toContain("before every configuration reached 2 trials");
    expect(text).toContain("### Rates");
  });

  it("keep runs without a protocol out of the experiment and list them as pilot runs", async () => {
    const pilot = await recorded(new GullibleSubject(), 1);
    const registered = [await recorded(new GullibleSubject(), 2, PROTOCOL), await recorded(new StrictSubject(), 2, PROTOCOL)];
    const section = pilotSection([pilot, ...registered]).join("\n");
    expect(section).toContain("## Pilot runs (not pre-registered)");
    expect(section.split("\n").filter((line) => line.startsWith("| gullible"))).toHaveLength(1);

    const page = resultsMarkdown([spec(2)], [pilot, ...registered], new Date());
    const rates = page.slice(page.indexOf("### Rates"), page.indexOf("### H1"));
    expect(rates).toContain("| test-model | control | 2 |");
  });
});
