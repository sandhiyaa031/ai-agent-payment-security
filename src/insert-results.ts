/** Where a block in a document gets its content from RESULTS.md. */
export interface BlockSource {
  block: string;
  /** The experiment's heading in RESULTS.md. */
  experiment: string;
  /** Headings inside that experiment to copy, in order. */
  sections: string[];
  /** Path of the chart to show first, relative to the document. */
  chart?: string;
}

/** The lines of one section: from its heading up to the next heading of the same or a higher level. */
function section(lines: string[], heading: string): string[] | undefined {
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return undefined;
  const level = heading.match(/^#+/)![0].length;
  let end = start + 1;
  while (end < lines.length && !new RegExp(`^#{1,${level}} `).test(lines[end]!)) end += 1;
  return lines.slice(start, end);
}

/** Replaces each block that has results, keeping the rest of the document untouched. */
export function fillBlocks(document: string, results: string, blocks: BlockSource[]): string {
  const lines = results.split(/\r?\n/);
  let out = document.replace(/\r\n/g, "\n");
  for (const { block, experiment, sections, chart } of blocks) {
    const body = section(lines, experiment);
    if (!body) continue;
    const parts = sections.flatMap((heading) => {
      const found = section(body, heading);
      return found ? [found.join("\n").trim()] : [];
    });
    if (parts.length === 0) continue;

    const start = `<!-- results:${block}:start -->`;
    const end = `<!-- results:${block}:end -->`;
    const from = out.indexOf(start);
    const to = out.indexOf(end);
    if (from < 0 || to < from) throw new Error(`The block "${block}" is missing its markers.`);
    const content = [...(chart ? [`![Security and utility by defense](${chart})`] : []), ...parts].join("\n\n");
    out = `${out.slice(0, from + start.length)}\n${content}\n${out.slice(to)}`;
  }
  return out;
}
