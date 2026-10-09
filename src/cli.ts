import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { SCENARIOS } from "./attacks/scenarios";
import { checkCombination, createAttacker, createRail, createSubject, loadEnv } from "./config";
import { toCents, usd } from "./money";
import { doneEvent, eventHooks, saveRecording, toRecording, type RunEvent } from "./recording";
import { formatReport } from "./report";
import { runAll } from "./runner";
import type { Guard } from "./subject/tools";

const HELP = `Crashtest: how much money can an AI support agent be talked out of?

Usage: npm run crashtest -- [options]

  --subject <gullible|strict|model|toolkit>
                                       Agent under test (default gullible).
                                       model is an AI agent using the provider in .env;
                                       toolkit is the same agent refunding through
                                       PayPal's Agent Toolkit, and needs --rail paypal
  --attacker <scripted|adaptive>       Who plays the customer (default scripted)
  --rail <mock|paypal>                 Where the money moves (default mock)
  --cap <dollars>                      Guard: block any single refund above this
  --enforce-policy                     Guard: check the refund policy in code
  --only <scenario-id>                 Run one scenario
  --json <path>                        Also write the full result as JSON
  --record <name>                      Save the run to recordings/<name>.json so the
                                       dashboard can replay it (these are committed)
  --help

model, toolkit and adaptive need an AI provider in .env (free ones work);
paypal needs sandbox keys.
See SETUP.md.`;

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
      record: { type: "string" },
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

  checkCombination(values.subject, values.rail);
  const events: RunEvent[] = [];
  const recorder = eventHooks((event) => events.push(event));
  const run = await runAll({
    scenarios,
    subject: createSubject(values.subject),
    attacker: createAttacker(values.attacker),
    rail: createRail(values.rail),
    guard,
    hooks: {
      ...recorder,
      onScenario: (result) => {
        recorder.onScenario?.(result);
        const verdict = result.wrongfulCents > 0 ? `LOST ${usd(result.wrongfulCents)}` : "held";
        console.error(`  ${result.id}: ${verdict}`);
      },
    },
  });
  events.push(doneEvent(run));

  console.log(`\n${formatReport(run)}`);
  if (values.json) {
    mkdirSync(dirname(values.json), { recursive: true });
    writeFileSync(values.json, JSON.stringify(run, null, 2));
    console.log(`\nFull result written to ${values.json}`);
  }
  if (values.record) {
    const path = saveRecording("recordings", values.record, toRecording(run, events, new Date()));
    console.log(`\nRecording saved to ${path}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `Error: ${error.message}` : error);
  process.exitCode = 1;
});
