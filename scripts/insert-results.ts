import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fillBlocks, type BlockSource } from "../src/insert-results";

/**
 * Copies finished results from RESULTS.md into the README and the report, so a
 * number in either one is never typed by hand. A block stays as it is until
 * its experiment has results.
 */
const root = process.cwd();
const results = readFileSync(join(root, "RESULTS.md"), "utf8");

const report: BlockSource[] = [
  { block: "e01", experiment: "## Experiment 01", sections: ["### Rates", "### H1", "### H2", "### A/A check"] },
  { block: "e02", experiment: "## Experiment 02", sections: ["### Every defense, pooled across the models", "### Cost per conversation", "### Hypotheses"], chart: "frontier.svg" },
  { block: "e03", experiment: "## Experiment 03", sections: ["### Scripted and adaptive, side by side", "### Which techniques worked"] },
  { block: "e04", experiment: "## Experiment 04", sections: ["### By attack family"] },
];
const readme: BlockSource[] = [
  { block: "headline", experiment: "## Experiment 02", sections: ["### Every defense, pooled across the models"], chart: "docs/frontier.svg" },
];

for (const [file, blocks] of [["README.md", readme], ["docs/REPORT.md", report]] as const) {
  const path = join(root, file);
  writeFileSync(path, fillBlocks(readFileSync(path, "utf8"), results, blocks));
}
