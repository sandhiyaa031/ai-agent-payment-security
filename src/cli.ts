import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { SCENARIOS } from "./attacks/scenarios";
import { createAttacker, createRail, createSubject, harnessVersion, loadEnv } from "./config";
import { usd } from "./money";
import { planRun } from "./profiles";
import { doneEvent, eventHooks, saveRecording, toRecording, type RunEvent } from "./recording";
import { formatReport } from "./report";
import { runAll } from "./runner";

const HELP = `Crashtest: how much money can an AI support agent be talked out of?

Usage: npm run crashtest -- [options]

  --profile <baseline|guarded|sandbox>  The experiment to run (default baseline)
        baseline  Agent vulnerability. Test rail, no policy defense: shows what
                  the agent attempts and what it would cost.
        guarded   Defense effectiveness. Test rail, policy defense on.
        sandbox   PayPal sandbox verification. Real sandbox refunds, with the
                  policy defense always on.
  --subject <gullible|strict|refuse-all|model|toolkit>
                                        Agent under test (default gullible).
                                        model is an AI agent using the provider in .env;
                                        toolkit is the same agent refunding through
                                        PayPal's Agent Toolkit (sandbox profile only)
  --attacker <scripted|adaptive>        Who plays the customer (default scripted)
  --cap <dollars>                       Extra defense: ceiling on total refunds per order
  --only <scenario-id>                  Run one scenario
  --json <path>                         Also write the full result as JSON
  --record <name>                       Save the run to recordings/<name>.json so the
                                        dashboard can replay it (these are committed)
  --help

model, toolkit and adaptive need an AI provider in .env (free ones work);
the sandbox profile needs PayPal sandbox keys. See SETUP.md.`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      profile: { type: "string" },
      subject: { type: "string" },
      attacker: { type: "string" },
      cap: { type: "string" },
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
  const plan = planRun(values, { hosted: false });

  const events: RunEvent[] = [];
  const recorder = eventHooks((event) => events.push(event));
  const run = await runAll({
    profile: plan.profile.id,
    scenarios,
    subject: createSubject(plan.subject),
    attacker: createAttacker(plan.attacker),
    rail: createRail(plan.profile.rail),
    defense: plan.defense,
    hooks: {
      ...recorder,
      onScenario: (result) => {
        recorder.onScenario?.(result);
        const lost = result.orders.reduce((total, order) => total + order.overRefundCents, 0);
        const verdict = result.error ? "ERROR" : lost > 0 ? `LOST ${usd(lost)}` : result.unresolved ? "unresolved" : "held";
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
    const path = saveRecording("recordings", values.record, toRecording(run, events, new Date(), harnessVersion()));
    console.log(`\nRecording saved to ${path}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `Error: ${error.message}` : error);
  process.exitCode = 1;
});
