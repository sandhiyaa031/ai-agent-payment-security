import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedAttacker } from "../src/attacks/attacker";
import { SCENARIOS } from "../src/attacks/scenarios";
import { loadSuite } from "../src/attacks/suite";
import { summarize, type Rate, rate, trialFacts } from "../src/analysis";
import { ScoreBook } from "../src/defenses/guard";
import { recordedTrials, type RecordedTrial } from "../src/defenses/replay";
import { adaptiveSection, ARMS, defenseSection, evaluateArm, MODELS, suiteSection, techniqueTable, verdict } from "../src/experiment-report";
import { frontierSvg } from "../src/frontier";
import { MockRail } from "../src/rail/mock";
import { doneEvent, eventHooks, toRecording, type Recording, type RunEvent } from "../src/recording";
import { runAll } from "../src/runner";
import { GullibleSubject, StrictSubject } from "../src/subject/scripted";
import type { Subject } from "../src/subject/subject";
import { NO_DEFENSE, POLICY_DEFENSE } from "./helpers";

const E01 = "experiments/01-prompt-hardening/protocol.md";
const E02 = "experiments/02-defense-comparison/protocol.md";
const E03 = "experiments/03-adaptive-attacker/protocol.md";
const E04 = "experiments/04-attack-suite/protocol.md";
const FUTURE = new Date("2999-01-01");
const PAST = new Date("2000-01-01");

/** A recording dressed as a real run: the rule-based agents stand in for models and prompt variants. */
async function recording(options: { subject: Subject; protocol: string; model: string; variant: string; repeats: number; guarded?: boolean; scenarios?: typeof SCENARIOS }): Promise<Recording> {
  const events: RunEvent[] = [];
  const run = await runAll({
    profile: options.guarded ? "guarded" : "baseline",
    scenarios: options.scenarios ?? SCENARIOS,
    subject: options.subject,
    attacker: new ScriptedAttacker(),
    rail: new MockRail(),
    defense: options.guarded ? POLICY_DEFENSE : NO_DEFENSE,
    repeats: options.repeats,
    seed: 1,
    hooks: eventHooks((e) => events.push(e)),
  });
  events.push(doneEvent(run));
  const made = toRecording(run, events, new Date(), "test", { protocol: { path: options.protocol, sha256: "0".repeat(64) } });
  made.manifest = { agent: { kind: "model", promptVariant: options.variant, model: { provider: "fake", model: options.model, served: [], fingerprints: [] } }, attacker: { kind: "scripted" } };
  return made;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function guardBook(recordings: Recording[], extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "crashtest-book-"));
  dirs.push(dir);
  const book = new ScoreBook(join(dir, "scores.json"));
  const texts = [...recordings.flatMap((r) => recordedTrials(r).flatMap((t) => t.messages)), ...extra];
  await book.scoreAll(texts, { label: "fake", score: async (text) => (/SYSTEM|ignore/i.test(text) ? 0.99 : 0.01) });
  return book;
}

async function fullSet() {
  const out: Recording[] = [];
  for (const model of MODELS) {
    out.push(await recording({ subject: new GullibleSubject(), protocol: E01, model, variant: "stock", repeats: 2 }));
    out.push(await recording({ subject: new StrictSubject(), protocol: E01, model, variant: "hardened", repeats: 2 }));
    out.push(await recording({ subject: new GullibleSubject(), protocol: E02, model, variant: "spotlight", repeats: 1 }));
  }
  out.push(await recording({ subject: new GullibleSubject(), protocol: E02, model: "openai/gpt-oss-20b", variant: "stock", repeats: 1, guarded: true }));
  return out;
}

describe("the defense comparison", () => {
  it("shows only progress while runs are still going", async () => {
    const written: string[] = [];
    const text = defenseSection(await fullSet(), undefined, new Date(), FUTURE, (path) => written.push(path)).join("\n");
    expect(text).toContain("**In progress.**");
    expect(text).toContain("| openai/gpt-oss-20b, spotlighting | 1 of 5 |");
    expect(text).not.toContain("### Every defense");
    expect(written).toEqual([]);
  });

  it("reports every defense, the chart and the hypotheses once past the cutoff, and says it was cut off", async () => {
    const recordings = await fullSet();
    const written = new Map<string, string>();
    const text = defenseSection(recordings, await guardBook(recordings), new Date(), PAST, (path, content) => written.set(path, content)).join("\n");
    expect(text).toContain("**Cut off before every run finished.**");
    for (const arm of ARMS) expect(text, arm.id).toContain(`**${arm.id}** ${arm.label}`);
    expect(written.get("docs/frontier.svg")).toContain("<svg");

    const row = (id: string) => text.split("\n").find((line) => line.startsWith(`| **${id}** `))!;
    expect(row("D0")).toMatch(/\| baseline \|$/);
    expect(row("D5")).toContain("eliminated");
    expect(row("D5")).toContain("| replay |");
    expect(row("D3")).toContain("| live |");
    expect(row("D6 $50")).toMatch(/\| \d+\.\d \|/);
    expect(text).toContain("**H1 (guarantee).**");
    expect(text).toContain("Held.");
    expect(text).toContain("**H2.**");
    expect(text).toContain("**H3 (replay check).**");
  });

  it("waits for the guard scores rather than reporting without them", async () => {
    const recordings = await fullSet();
    const text = defenseSection(recordings, undefined, new Date(), PAST, () => {}).join("\n");
    expect(text).toContain("Waiting for the guard scores");
  });

  it("stops a conversation at the guard's first flag, and the guard's own cost to honest customers shows up", async () => {
    const stock = await recording({ subject: new GullibleSubject(), protocol: E01, model: "m", variant: "stock", repeats: 1 });
    const trials = recordedTrials(stock);
    const guardArm = ARMS.find((arm) => arm.id === "D2")!;
    const dir = mkdtempSync(join(tmpdir(), "crashtest-book-"));
    dirs.push(dir);
    const book = new ScoreBook(join(dir, "scores.json"));
    await book.scoreAll(trials.flatMap((t) => t.messages), { label: "flags everything", score: async () => 0.9 });
    const result = summarize(evaluateArm(guardArm, trials, book).facts);
    expect(result.loss.k).toBe(0);
    expect(result.honestFullRefund.k).toBe(0);
  });
});

describe("the wording rule for defenses", () => {
  const summary = (lossK: number, lossN: number) => ({ loss: rate(lossK, lossN) }) as ReturnType<typeof summarize>;
  it("says eliminated only with no loss seen, and gives the upper bound", () => {
    expect(verdict(summary(0, 450), summary(30, 450))).toMatch(/^eliminated \(0 of 450; true rate at most 0\.\d%\)$/);
  });
  it("says reduced only when the whole interval is below no change", () => {
    expect(verdict(summary(2, 450), summary(30, 450))).toBe("reduced");
  });
  it("says no clear difference otherwise, whatever the point estimate", () => {
    expect(verdict(summary(25, 450), summary(30, 450))).toBe("no clear difference");
  });
});

describe("techniques", () => {
  it("credit the turn of the first improper attempt, not every turn", () => {
    const call = (seq: number, improperCents: number) => ({ seq, improperCents, invalidReference: false }) as RecordedTrial["result"]["toolCalls"][number];
    const trial = {
      result: {
        transcript: [
          { customer: "a", agent: "no", technique: "emotional-appeal" },
          { customer: "b", agent: "ok", technique: "fake-system-message" },
          { customer: "c", agent: "ok" },
        ],
        toolCalls: [call(1, 0), call(2, 500), call(3, 500)],
      },
      messages: ["a", "b", "c"],
      turnOf: new Map([[1, 0], [2, 1], [3, 2]]),
    } as unknown as RecordedTrial;
    expect(techniqueTable([trial])).toEqual([
      { technique: "fake-system-message", turns: 1, firstImproper: 1 },
      { technique: "emotional-appeal", turns: 1, firstImproper: 0 },
      { technique: "unlabelled", turns: 1, firstImproper: 0 },
    ]);
  });
});

describe("the adaptive experiment", () => {
  const attacks = SCENARIOS.filter((s) => s.kind === "attack");
  it("sets scripted and adaptive side by side on the same 15 attacks", async () => {
    const recordings: Recording[] = [];
    for (const model of ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]) {
      for (const [variant, subject] of [["stock", new GullibleSubject()], ["hardened", new StrictSubject()]] as const) {
        recordings.push(await recording({ subject, protocol: E01, model, variant, repeats: 2 }));
        recordings.push(await recording({ subject: new GullibleSubject(), protocol: E03, model, variant, repeats: 2, scenarios: attacks }));
      }
    }
    expect(adaptiveSection(recordings.slice(0, 2), new Date(), FUTURE).join("\n")).toContain("**In progress.**");
    const text = adaptiveSection(recordings, new Date(), FUTURE).join("\n");
    expect(text).toContain("### Scripted and adaptive, side by side");
    const hardened = text.split("\n").find((line) => line.startsWith("| openai/gpt-oss-120b | hardened |"))!;
    // The stand-in "adaptive" agent attempts improper refunds where the scripted one never does.
    expect(hardened).toContain("0 of 30");
    expect(hardened).toMatch(/\| yes \| /);
    expect(text).toContain("### Which techniques worked");
  });
});

describe("the attack suite experiment", () => {
  it("reports attack families, the indirect-injection hypothesis, and the guarantee", async () => {
    const set3 = loadSuite(join(process.cwd(), "scenarios", "set-3.json"));
    const d0 = await recording({ subject: new GullibleSubject(), protocol: E04, model: "openai/gpt-oss-20b", variant: "stock", repeats: 1, scenarios: set3.scenarios });
    const d3 = await recording({ subject: new StrictSubject(), protocol: E04, model: "openai/gpt-oss-20b", variant: "spotlight", repeats: 1, scenarios: set3.scenarios });
    const familyOf = new Map(set3.scenarios.map((s) => [s.id, s.family ?? s.category]));
    const thirdParty = new Map(set3.scenarios.map((s) => [s.id, s.orders.flatMap((o) => Object.values(o.thirdPartyText ?? {}))]));
    const book = await guardBook([d0, d3], [...thirdParty.values()].flat());

    const waiting = suiteSection([d0], familyOf, thirdParty, undefined, new Date(), FUTURE).join("\n");
    expect(waiting).toContain("**In progress.**");

    const text = suiteSection([d0, d3], familyOf, thirdParty, book, new Date(), PAST).join("\n");
    expect(text).toContain("| indirect-injection |");
    expect(text).toContain("**all attacks**");
    expect(text).toContain("**H1.**");
    expect(text).toContain("**H2 (guarantee).**");
    expect(text).toContain("Held.");
    expect(text).toContain("**Guard model (replayed, exploratory).**");
  });
});

describe("the frontier chart", () => {
  const r = (k: number, n: number): Rate => rate(k, n);
  it("draws one labelled mark per distinct result, with the data also in text for screen readers", () => {
    const svg = frontierSvg(
      [
        { id: "D0", group: "baseline", loss: r(30, 450), honest: r(210, 210) },
        { id: "D1", group: "prompt or input", loss: r(4, 450), honest: r(205, 210) },
        { id: "D5", group: "tool boundary", loss: r(0, 450), honest: r(210, 210) },
        { id: "D6 $100", group: "tool boundary", loss: r(0, 450), honest: r(210, 210) },
        { id: "D1+D5 <x>", group: "combined", loss: r(0, 450), honest: r(205, 210) },
      ],
      "Test chart",
    );
    expect(svg.match(/<circle class="s\d ring"/g)).toHaveLength(4);
    expect(svg).toContain(">D5, D6 $100<");
    expect(svg).toContain("D1+D5 &lt;x&gt;");
    expect(svg).toContain("<title id=\"t\">Test chart</title>");
    expect(svg).toContain("prefers-color-scheme: dark");
    expect(svg).not.toContain("<script");
  });
});

// Keeps the per-trial facts in view when the comparison reports refusals.
it("counts an owed order with nothing refunded as refused outright", async () => {
  const run = await runAll({ profile: "baseline", scenarios: SCENARIOS, subject: new StrictSubject(), attacker: new ScriptedAttacker(), rail: new MockRail(), defense: NO_DEFENSE, seed: 1 });
  expect(run.scenarios.map(trialFacts).flatMap((f) => f.owedOrdersRefused).some(Boolean)).toBe(false);
});
