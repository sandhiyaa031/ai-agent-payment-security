import { join } from "node:path";
import { usd } from "../src/money";
import { listRecordings, loadRecording, type DoneData } from "../src/recording";
import { describeDefense } from "../src/report";

/**
 * Prints the recordings in recordings/ as Markdown tables: one row per run,
 * then a per-scenario breakdown. Everything comes from the recorded metrics;
 * nothing is re-run.
 */
const dirs = [{ source: "featured", dir: join(process.cwd(), "recordings") }];
const runs = listRecordings(dirs).sort((a, b) => a.subject.localeCompare(b.subject) || a.profile.localeCompare(b.profile));

if (runs.length === 0) {
  console.log("No recordings found in recordings/.");
} else {
  console.log("| Agent | Profile | Attacker | Defenses | Trials | Attack trials with an improper attempt | Attack trials with a loss | Money lost | Honest orders refunded in full | Under-refunded | Unresolved trials |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const run of runs) {
    const m = run.metrics;
    console.log(
      `| ${run.subject} | ${run.profile} | ${run.attacker} | ${describeDefense(run.defense)} | ${run.repeats} | ` +
        `${m.attackScenariosWithAttempt} of ${m.attackScenarios} | ${m.attackScenariosWithLoss} of ${m.attackScenarios} | ` +
        `${usd(m.overRefundCents)} of ${usd(m.atRiskCents)} | ${m.eligibleFullyRefunded} of ${m.eligibleOrders} | ${usd(m.underRefundCents)} | ${m.unresolvedScenarios} of ${m.scenarios} |`,
    );
  }

  for (const run of runs) {
    const done = loadRecording(dirs, run.id)?.events.find((event) => event.event === "done")?.data as DoneData | undefined;
    if (!done) continue;
    const notable = done.byScenario.filter((s) => s.trialsWithImproperAttempt > 0 || s.trialsWithLoss > 0 || s.trialsShortChanged > 0 || s.trialsUnresolved > 0);
    console.log(`\n**${run.subject}, ${run.profile}** (scenarios with anything to report; all others were handled correctly in every trial)\n`);
    if (notable.length === 0) {
      console.log("None.");
      continue;
    }
    console.log("| Scenario | Trials | Improper attempt in | Money lost in | Short-changed in | Unresolved in | Total lost |");
    console.log("|---|---|---|---|---|---|---|");
    for (const s of notable) {
      console.log(`| ${s.id} | ${s.trials} | ${s.trialsWithImproperAttempt} | ${s.trialsWithLoss} | ${s.trialsShortChanged} | ${s.trialsUnresolved} | ${usd(s.overRefundCents)} |`);
    }
  }
}
