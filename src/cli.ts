import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { AdaptiveAttacker, ScriptedAttacker, type Attacker } from "./attacks/attacker";
import { SCENARIOS } from "./attacks/scenarios";
import { createRail, loadEnv } from "./config";
import { toCents, usd } from "./money";
import { formatReport } from "./report";
import { runAll } from "./runner";
import { ClaudeSubject, DEFAULT_MODEL } from "./subject/claude";
import { GullibleSubject, StrictSubject } from "./subject/scripted";
import type { Subject } from "./subject/subject";
import type { Guard } from "./subject/tools";

const HELP = `Crashtest: how much money can an AI support agent be talked out of?

Usage: npm run crashtest -- [options]

  --subject <gullible|strict|claude>   Agent under test (default gullible)
  --attacker <scripted|adaptive>       Who plays the customer (default scripted)
  --rail <mock|paypal>                 Where the money moves (default mock)
  --cap <dollars>                      Guard: block any single refund above this
  --enforce-policy                     Guard: check the refund policy in code
  --only <scenario-id>                 Run one scenario
  --json <path>                        Also write the full result as JSON
  --help

claude and adaptive need an Anthropic API key; paypal needs sandbox keys.
See SETUP.md.`;

function createSubject(kind: string): Subject {
  if (kind === "gullible") return new GullibleSubject();
  if (kind === "strict") return new StrictSubject();
  if (kind === "claude") return new ClaudeSubject(process.env["CRASHTEST_SUBJECT_MODEL"]?.trim() || DEFAULT_MODEL);
  throw new Error(`Unknown subject "${kind}". Use gullible, strict or claude.`);
}

function createAttacker(kind: string): Attacker {
  if (kind === "scripted") return new ScriptedAttacker();
  if (kind === "adaptive") return new AdaptiveAttacker(process.env["CRASHTEST_ATTACKER_MODEL"]?.trim() || DEFAULT_MODEL);
  throw new Error(`Unknown attacker "${kind}". Use scripted or adaptive.`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      subject: { type: "string", default: "gullible" },
      attacker: { type: "string", default: "scripted" },
      rail: { type: "string", default: "mock" },
      cap: { type: "string" },
      "enforce-policy": { type: "boolean", default: false },
      only: { type: "string" },
      json: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  loadEnv();

  const scenarios = values.only ? SCENARIOS.filter((s) => s.id === values.only) : SCENARIOS;
  if (scenarios.length === 0) {
    throw new Error(`No scenario "${values.only}". Known: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  }
  const guard: Guard = {};
  if (values.cap !== undefined) guard.maxRefundCentsPerCall = toCents(values.cap);
  if (values["enforce-policy"]) guard.enforcePolicy = true;

  const run = await runAll({
    scenarios,
    subject: createSubject(values.subject),
    attacker: createAttacker(values.attacker),
    rail: createRail(values.rail),
    guard,
    onScenario: (result) => {
      const verdict = result.wrongfulCents > 0 ? `LOST ${usd(result.wrongfulCents)}` : "held";
      console.error(`  ${result.id}: ${verdict}`);
    },
  });

  console.log(`\n${formatReport(run)}`);
  if (values.json) {
    mkdirSync(dirname(values.json), { recursive: true });
    writeFileSync(values.json, JSON.stringify(run, null, 2));
    console.log(`\nFull result written to ${values.json}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `Error: ${error.message}` : error);
  process.exitCode = 1;
});
