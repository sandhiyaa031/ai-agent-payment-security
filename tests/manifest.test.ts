import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AdaptiveAttacker, ScriptedAttacker } from "../src/attacks/attacker";
import { CORE_SCENARIO_IDS, SCENARIO_SET_VERSION, SCENARIOS as ALL_SCENARIOS } from "../src/attacks/scenarios";
import { openProgress, specs, type RunIdentity } from "../src/checkpoint";
import { createModel, temperature } from "../src/llm";
import type { ChatModel, Turn } from "../src/llm/model";
import { OpenAiCompatibleModel } from "../src/llm/openai-compatible";
import { conversationSeed, fixedPart, sha256 } from "../src/manifest";
import { MockRail } from "../src/rail/mock";
import type { Recording } from "../src/recording";
import { runAll } from "../src/runner";
import { POLICY_VERSION } from "../src/store/policy";
import { ModelSubject, promptTemplate } from "../src/subject/agent";
import { NO_DEFENSE } from "./helpers";

const SCENARIOS = ALL_SCENARIOS.filter((s) => CORE_SCENARIO_IDS.includes(s.id));

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "crashtest-manifest-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in model that answers every message with plain text, counts requests and remembers the seed of each conversation. */
function meteredModel(label: string, reply: () => Partial<Turn> = () => ({ text: "Let me look into that." })) {
  const seeds: (number | undefined)[] = [];
  let requests = 0;
  const answer = async (): Promise<Turn> => {
    requests += 1;
    return { text: "", toolCalls: [], refused: false, ...reply() };
  };
  const model: ChatModel = {
    label,
    start(_system, _tools, options) {
      seeds.push(options?.seed);
      return { say: answer, answerTools: answer };
    },
    usage: () => ({ requests, promptTokens: requests * 100, completionTokens: requests * 10, cachedTokens: requests * 50, latencyMs: requests * 7 }),
    manifest: () => ({ provider: "fake", model: label, temperature: 1, served: [`${label}-build`], fingerprints: [] }),
  };
  return { model, seeds };
}

describe("pinning the model", () => {
  function server() {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      call += 1;
      return new Response(
        JSON.stringify({
          model: call === 1 ? "some-model-0925" : "some-model-1001",
          system_fingerprint: "fp_abc",
          choices: [{ finish_reason: "stop", message: { content: "hi" } }],
          usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } },
        }),
      );
    }) as typeof fetch;
    return { bodies, fetchImpl };
  }

  it("sends the pinned temperature and the conversation's seed, and counts what the provider reports", async () => {
    const { bodies, fetchImpl } = server();
    const model = new OpenAiCompatibleModel({ provider: "groq", baseUrl: "https://llm.test/v1", model: "some-model", temperature: 1, fetchImpl });
    const chat = model.start("s", [], { seed: 1234 });
    await chat.say("one");
    await chat.say("two");

    expect(bodies.map((body) => [body["temperature"], body["seed"]])).toEqual([
      [1, 1234],
      [1, 1234],
    ]);
    expect(model.usage()).toMatchObject({ requests: 2, promptTokens: 240, completionTokens: 60, cachedTokens: 200 });
    expect(model.usage().latencyMs).toBeGreaterThanOrEqual(0);
    // A provider that quietly swaps the model behind a name is visible in the record.
    expect(model.manifest()).toEqual({
      provider: "groq",
      model: "some-model",
      temperature: 1,
      served: ["some-model-0925", "some-model-1001"],
      fingerprints: ["fp_abc"],
    });
  });

  it("sends no temperature or seed when none is set, and says the temperature was not pinned", async () => {
    const { bodies, fetchImpl } = server();
    const model = new OpenAiCompatibleModel({ provider: "custom", baseUrl: "https://llm.test/v1", model: "m", fetchImpl });
    await model.start("s", []).say("hello");
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(bodies[0]).not.toHaveProperty("seed");
    expect(model.manifest()).not.toHaveProperty("temperature");
  });

  it("pins temperature 1 by default and takes LLM_TEMPERATURE when it is a usable number", () => {
    const saved = { provider: process.env["LLM_PROVIDER"], key: process.env["LLM_API_KEY"], temperature: process.env["LLM_TEMPERATURE"] };
    try {
      process.env["LLM_PROVIDER"] = "groq";
      process.env["LLM_API_KEY"] = "k";
      delete process.env["LLM_TEMPERATURE"];
      expect(temperature()).toBe(1);
      expect(createModel("subject").manifest?.()).toMatchObject({ provider: "groq", temperature: 1 });
      process.env["LLM_TEMPERATURE"] = "0.2";
      expect(temperature()).toBe(0.2);
      for (const bad of ["warm", "-1", "3"]) {
        process.env["LLM_TEMPERATURE"] = bad;
        expect(() => temperature()).toThrow(/LLM_TEMPERATURE/);
      }
    } finally {
      for (const [name, value] of [["LLM_PROVIDER", saved.provider], ["LLM_API_KEY", saved.key], ["LLM_TEMPERATURE", saved.temperature]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("manifests", () => {
  it("fingerprint each prompt variant and the tools, so a changed prompt is a different configuration", () => {
    const { model } = meteredModel("m");
    const stock = new ModelSubject(model).manifest();
    const hardened = new ModelSubject(model, "hardened").manifest();
    expect(stock).toMatchObject({ kind: "model", promptVariant: "stock", systemPromptSha256: sha256(promptTemplate("stock")) });
    expect(hardened.systemPromptSha256).not.toBe(stock.systemPromptSha256);
    expect(hardened.toolsSha256).toBe(stock.toolsSha256);
    expect(new ModelSubject(meteredModel("other").model).manifest().systemPromptSha256).toBe(stock.systemPromptSha256);
    expect(stock.model).toMatchObject({ provider: "fake", model: "m", temperature: 1 });
    expect(new AdaptiveAttacker(model, 4).manifest()).toMatchObject({ kind: "adaptive", maxTurns: 4, model: { model: "m" } });
  });

  it("leave out what the provider reported serving when deciding whether two runs match", () => {
    const { model } = meteredModel("m");
    const manifest = new ModelSubject(model).manifest();
    expect(fixedPart(manifest)!.model).toEqual({ provider: "fake", model: "m", temperature: 1, served: [], fingerprints: [] });
    expect(fixedPart({ kind: "scripted" })).toEqual({ kind: "scripted" });
  });
});

describe("seeds and per-conversation usage", () => {
  const run = (seed: number, agent = meteredModel("agent")) =>
    runAll({ profile: "baseline", scenarios: SCENARIOS, subject: new ModelSubject(agent.model), attacker: new ScriptedAttacker(), rail: new MockRail(), defense: NO_DEFENSE, repeats: 2, seed }).then((result) => ({ result, seeds: agent.seeds }));

  it("give every conversation its own seed, derived from the run's, and record the run seed and manifest", async () => {
    const first = await run(42);
    const again = await run(42);
    const other = await run(43);
    expect(first.seeds).toHaveLength(SCENARIOS.length * 2);
    expect(new Set(first.seeds).size).toBe(first.seeds.length);
    expect(again.seeds).toEqual(first.seeds);
    expect(other.seeds).not.toEqual(first.seeds);
    expect(first.seeds[0]).toBe(conversationSeed(42, SCENARIOS[0]!.id, 1, "agent"));

    expect(first.result.seed).toBe(42);
    expect(first.result.manifest.agent).toMatchObject({ kind: "model", promptVariant: "stock", model: { served: ["agent-build"] } });
    expect(first.result.manifest.attacker).toEqual({ kind: "scripted" });
  });

  it("record each conversation's tokens and model time", async () => {
    const { result } = await run(7);
    for (const scenario of result.scenarios) {
      // One plain-text answer per customer message.
      const turns = scenario.transcript.length;
      expect(scenario.usage?.agent).toEqual({ requests: turns, promptTokens: turns * 100, completionTokens: turns * 10, cachedTokens: turns * 50, latencyMs: turns * 7 });
      expect(scenario.usage?.attacker).toBeUndefined();
    }
  });

  it("seed the adaptive attacker separately for each turn", async () => {
    let turn = 0;
    const attacker = meteredModel("attacker", () => {
      turn += 1;
      return { text: turn % 3 === 0 ? "STOP" : "I want my money back." };
    });
    const result = await runAll({
      profile: "baseline",
      scenarios: SCENARIOS.slice(0, 2),
      subject: new ModelSubject(meteredModel("agent").model),
      attacker: new AdaptiveAttacker(attacker.model),
      rail: new MockRail(),
      defense: NO_DEFENSE,
      seed: 5,
    });
    expect(attacker.seeds.slice(0, 3)).toEqual([0, 1, 2].map((t) => conversationSeed(5, SCENARIOS[0]!.id, 1, `attacker-${t}`)));
    expect(result.scenarios[0]!.usage?.attacker?.requests).toBe(3);
  });

  it("continuing a run is refused under a different temperature or seed", () => {
    const path = join(tempDir(), "x.partial.json");
    const at = (value: number): RunIdentity => {
      const { model } = meteredModel("m");
      const subject = new ModelSubject({ ...model, manifest: () => ({ ...model.manifest!(), temperature: value }) });
      return {
        profile: "baseline",
        subject: subject.name,
        attacker: "scripted",
        defense: NO_DEFENSE,
        policyVersion: POLICY_VERSION,
        scenarioSetVersion: SCENARIO_SET_VERSION,
        harnessVersion: "test",
        scenarioIds: ["never-arrived"],
        ...specs(subject.manifest(), new ScriptedAttacker().manifest()),
      };
    };
    openProgress(path, at(1), { seed: 9 }).save();
    expect(() => openProgress(path, at(0.2))).toThrow(/different settings \(agentSpec\)/);
    expect(() => openProgress(path, at(1), { seed: 10 })).toThrow(/started with seed 9/);
    expect(openProgress(path, at(1)).seed).toBe(9);
  });
});

describe("the command line", () => {
  it("records the seed, the manifest and the pre-registered protocol a run follows", () => {
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
    const dir = tempDir();
    const protocol = join(dir, "protocol.md");
    writeFileSync(protocol, "# Protocol\r\n\r\nHypothesis: none.\r\n");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href,
        join(ROOT, "src", "cli.ts"),
        "--subject",
        "gullible",
        "--only",
        "never-arrived",
        "--seed",
        "77",
        "--protocol",
        "protocol.md",
        "--record",
        "pinned",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const recording = JSON.parse(readFileSync(join(dir, "recordings", "pinned.json"), "utf8")) as Recording;
    expect(recording.seed).toBe(77);
    expect(recording.harnessVersion).toBe("0.2.0");
    expect(recording.manifest).toEqual({ agent: { kind: "scripted" }, attacker: { kind: "scripted" } });
    // Line endings are normalised, so the same protocol hashes the same on Windows and elsewhere.
    expect(recording.protocol).toEqual({ path: "protocol.md", sha256: sha256("# Protocol\n\nHypothesis: none.\n") });

    const badSeed = spawnSync(process.execPath, ["--import", pathToFileURL(join(ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href, join(ROOT, "src", "cli.ts"), "--seed", "x"], { cwd: dir, encoding: "utf8" });
    expect(badSeed.stderr).toContain("--seed must be a whole number");
  }, 60_000);
});
