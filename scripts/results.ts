import { join } from "node:path";
import { listRecordings, loadRecording, type Recording } from "../src/recording";
import { EXPERIMENTS, resultsMarkdown } from "../src/results-report";

/** Prints RESULTS.md from the recordings in recordings/. Nothing is re-run. */
const dirs = [{ source: "featured", dir: join(process.cwd(), "recordings") }];
const recordings = listRecordings(dirs)
  .map((summary) => loadRecording(dirs, summary.id))
  .filter((recording): recording is Recording => recording !== undefined);

console.log(recordings.length === 0 ? "No recordings found in recordings/." : resultsMarkdown(EXPERIMENTS, recordings, new Date()));
