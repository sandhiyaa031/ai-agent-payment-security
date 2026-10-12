import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { SCENARIO_SET_VERSION, SCENARIOS } from "./attacks/scenarios";
import { openProgress, type Progress } from "./checkpoint";
import { createAttacker, createRail, createSubject, harnessVersion, loadEnv } from "./config";
import { usd } from "./money";
import { planRun } from "./profiles";
import { doneEvent, eventHooks, readRecording, recordingSlug, saveRecording, toRecording, type RunEvent } from "./recording";
import { formatReport } from "./report";
import { runAll } from "./runner";
import { POLICY_VERSION } from "./store/policy";

const HELP = `Crashtest: how much money can an AI support agent be talked out of?

Usage: npm run crashtest -- [options]

  --profile <baseline|guarded|sandbox>  The experiment to run (default baseline)
        baseline  Agent vulnerability. Test rail, no policy defense: shows what
                  the agent attempts and what it would cost.
        guarded   Defense effectiveness. Test rail, policy defense on.
        sandbox   PayPal sandbox verification. Real sandbox refunds, with the
                  policy defense always on.
  --subject <gullible|strict|refuse-all|model|model-hardened|toolkit>
                                        Agent under test (default gullible).
                                        model is an AI agent using the provider in .env;
                                        model-hardened is the same with a prompt that
                                        tells it customer text is untrusted;
                                        toolkit is the same agent refunding through
                                        PayPal's Agent Toolkit (sandbox profile only)
  --attacker <scripted|adaptive>        Who plays the customer (default scripted)
  --cap <dollars>                       Extra defense: ceiling on total refunds per order
  --repeat <n>                          Run each scenario n times (default 1). Models vary
                                        between runs; the report gives counts per scenario
  --only <scenario-id>                  Run only this scenario (can be given more than once)
  --json <path>                         Also write the full result as JSON
  --record <name>                       Save the run to recordings/<name>.json so the
                                        dashboard can replay it (these are committed).
                                        Progress is kept in runs/<name>.partial.json as it
                                        goes; if the run is stopped, the same command
                                        carries on from there
  --extend                              With --record: keep the trials already in
                                        recordings/<name>.json and run only the ones
                                        --repeat adds
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
      repeat: { type: "string" },
      only: { type: "string", multiple: true },
      json: { type: "string" },
      record: { type: "string" },
      extend: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  loadEnv();

  const wanted = values.only ?? [];
  const unknown = wanted.filter((id) => !SCENARIOS.some((s) => s.id === id));
  if (unknown.length > 0) {
    throw new Error(`No scenario "${unknown.join(", ")}". Known: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  }
  const scenarios = wanted.length > 0 ? SCENARIOS.filter((s) => wanted.includes(s.id)) : SCENARIOS;
  const plan = planRun(values, { hosted: false });

  const subject = createSubject(plan.subject);
  const attacker = createAttacker(plan.attacker);
  const version = harnessVersion();

  // A recorded run keeps its progress on disk, so being stopped costs nothing already finished.
  let progress: Progress | undefined;
  if (values.record) {
    const slug = recordingSlug(values.record);
    const partial = join("runs", `${slug}.partial.json`);
    const finished = values.extend ? readRecording(join("recordings", `${slug}.json`)) : undefined;
    if (values.extend && !finished && !existsSync(partial)) {
      throw new Error(`--extend found no recordings/${slug}.json to add trials to.`);
    }
    progress = openProgress(
      partial,
      {
        profile: plan.profile.id,
        subject: subject.name,
        attacker: attacker.name,
        defense: plan.defense,
        policyVersion: POLICY_VERSION,
        scenarioSetVersion: SCENARIO_SET_VERSION,
        harnessVersion: version,
        scenarioIds: scenarios.map((scenario) => scenario.id),
      },
      finished,
    );
    const beyond = progress.results.filter((result) => result.trial > plan.repeats).length;
    if (beyond > 0) {
      throw new Error(`${slug} already has trials beyond --repeat ${plan.repeats}. Ask for at least as many trials as it holds.`);
    }
    const wanted = scenarios.length * plan.repeats;
    if (finished && !existsSync(partial) && progress.results.length === wanted) {
      // Saving again would only change the run id and times of a recording that is already complete.
      console.log(`recordings/${slug}.json already has ${plan.repeats} trials of every scenario. Nothing to do.`);
      return;
    }
    if (progress.results.length > 0) {
      console.error(`Continuing ${slug}: ${progress.results.length} of ${wanted} scenario runs are already done.`);
    }
  } else if (values.extend) {
    throw new Error("--extend needs --record <name>.");
  }
  const earlier = progress?.results ?? [];

  const events: RunEvent[] = progress?.events ?? [];
  const recorder = eventHooks((event) => events.push(event));
  const run = await runAll({
    profile: plan.profile.id,
    scenarios,
    subject,
    attacker,
    rail: createRail(plan.profile.rail, {
      orders: earlier.reduce((total, result) => total + result.orders.length, 0),
      refunds: earlier.reduce((total, result) => total + result.orders.reduce((sum, order) => sum + order.refunds.length, 0), 0),
    }),
    defense: plan.defense,
    repeats: plan.repeats,
    resume: progress && { startedAt: progress.startedAt, results: earlier },
    hooks: {
      ...recorder,
      onScenario: (result) => {
        recorder.onScenario?.(result);
        progress?.save();
        const lost = result.orders.reduce((total, order) => total + order.overRefundCents, 0);
        const verdict = result.error ? "ERROR" : lost > 0 ? `LOST ${usd(lost)}` : result.unresolved ? "unresolved" : "held";
        const trial = plan.repeats > 1 ? ` [${result.trial}/${plan.repeats}]` : "";
        console.error(`  ${result.id}${trial}: ${verdict}`);
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
    const path = saveRecording("recordings", values.record, toRecording(run, events, new Date(), version, progress?.sittings()));
    progress?.clear();
    console.log(`\nRecording saved to ${path}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `Error: ${error.message}` : error);
  process.exitCode = 1;
});
