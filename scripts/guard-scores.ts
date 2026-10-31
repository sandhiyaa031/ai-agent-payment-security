import { join } from "node:path";
import { loadSuite } from "../src/attacks/suite";
import { loadEnv } from "../src/config";
import { ChatClassifierGuard, PROMPT_GUARD_MODEL, ScoreBook } from "../src/defenses/guard";
import { GUARD_SCORES } from "../src/experiment-report";
import { recordedTrials } from "../src/defenses/replay";
import { listRecordings, loadRecording, type Recording } from "../src/recording";

/**
 * Scores every customer message in the recordings, and the free-text order
 * fields of scenario set 3, with the guard model. Reads messages only, never
 * outcomes. Scores are saved next to the experiment, so the analysis can be
 * repeated with no key and no calls. Safe to re-run: only new texts are scored.
 */
loadEnv();
const dirs = [{ source: "featured", dir: join(process.cwd(), "recordings") }];
const recordings = listRecordings(dirs)
  .filter((summary) => summary.protocol)
  .map((summary) => loadRecording(dirs, summary.id))
  .filter((recording): recording is Recording => recording !== undefined);

const set3 = loadSuite(join(process.cwd(), "scenarios", "set-3.json"));
const texts = [
  ...recordings.flatMap((recording) => recordedTrials(recording).flatMap((trial) => trial.messages)),
  ...set3.scenarios.flatMap((s) => s.orders.flatMap((order) => Object.values(order.thirdPartyText ?? {}))),
];

const apiKey = process.env["LLM_API_KEY"]?.trim();
if (!apiKey) throw new Error("LLM_API_KEY is not set. The guard runs on Groq; see SETUP.md.");
const guard = new ChatClassifierGuard({ baseUrl: "https://api.groq.com/openai/v1", model: PROMPT_GUARD_MODEL, apiKey });
const book = new ScoreBook(join(process.cwd(), GUARD_SCORES));
await book.scoreAll(texts, guard, (done, total) => {
  if (done % 50 === 0 || done === total) console.error(`  scored ${done} of ${total} new texts`);
});
console.log(`Guard scores saved to ${GUARD_SCORES}.`);
