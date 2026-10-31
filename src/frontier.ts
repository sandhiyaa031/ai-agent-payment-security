import type { Rate } from "./analysis";

/**
 * The security and utility frontier as a self-contained SVG: money-losing
 * attack trials against honest orders paid in full, one point per defense,
 * with 95% intervals on both axes. It carries no script, so it can sit in a
 * README, and it follows the viewer's light or dark setting.
 */
export interface FrontierPoint {
  id: string;
  /** Which legend group the point belongs to. Three groups at most, so the colors stay distinguishable. */
  group: "baseline" | "prompt or input" | "tool boundary" | "combined";
  loss: Rate;
  honest: Rate;
}

const WIDTH = 760;
const HEIGHT = 500;
const PLOT = { left: 72, right: 28, top: 58, bottom: 62 };

/** Colors checked for colour-blind separation in light and dark, by group. */
const GROUP_CLASS: Record<FrontierPoint["group"], string> = { baseline: "s0", "prompt or input": "s1", "tool boundary": "s2", combined: "s3" };

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const percent = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** A round step that gives about five gridlines over the range. */
function tickStep(span: number): number {
  const rough = span / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const leading = rough / power;
  return (leading <= 1 ? 1 : leading <= 2 ? 2 : leading <= 5 ? 5 : 10) * power;
}

function ticks(lo: number, hi: number): number[] {
  const step = tickStep(hi - lo);
  const out: number[] = [];
  for (let value = Math.ceil(lo / step - 1e-9) * step; value <= hi + 1e-9; value += step) out.push(Math.round(value * 1e6) / 1e6);
  return out;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export function frontierSvg(points: FrontierPoint[], title: string): string {
  // Defenses that land on exactly the same spot share one mark and one label.
  const merged = new Map<string, { ids: string[]; point: FrontierPoint }>();
  for (const point of points) {
    const key = `${point.honest.rate.toFixed(4)}|${point.loss.rate.toFixed(4)}|${point.group}`;
    const entry = merged.get(key);
    if (entry) entry.ids.push(point.id);
    else merged.set(key, { ids: [point.id], point });
  }
  const marks = [...merged.values()];

  const lowestHonest = Math.min(...points.map((p) => p.honest.ci.lo));
  // The axis starts just below the lowest interval: the differences that matter are close to 100%.
  const xMin = Math.min(0.9, Math.floor(lowestHonest * 20) / 20);
  const highestLoss = Math.max(0.05, ...points.map((p) => p.loss.ci.hi));
  const yMax = Math.ceil(highestLoss * 40) / 40;
  const plotWidth = WIDTH - PLOT.left - PLOT.right;
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
  const px = (honest: number) => PLOT.left + ((honest - xMin) / (1 - xMin)) * plotWidth;
  const py = (loss: number) => PLOT.top + (1 - loss / yMax) * plotHeight;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="t d" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">`);
  out.push(`<title id="t">${escapeXml(title)}</title>`);
  out.push(`<desc id="d">${escapeXml(points.map((p) => `${p.id}: loss ${percent(p.loss.rate)}, honest orders paid in full ${percent(p.honest.rate)}`).join("; "))}</desc>`);
  out.push(`<style>
  .bg { fill: #fcfcfb; } .ink { fill: #0b0b0b; } .soft { fill: #52514e; } .grid { stroke: #e7e6e2; } .axis { stroke: #a8a79f; } .bar { stroke-width: 1.5; stroke-opacity: .55; }
  .ring { stroke: #fcfcfb; stroke-width: 2; }
  .s0 { fill: #52514e; stroke: #52514e; } .s1 { fill: #2a78d6; stroke: #2a78d6; } .s2 { fill: #eb6834; stroke: #eb6834; } .s3 { fill: #1baf7a; stroke: #1baf7a; }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #1a1a19; } .ink { fill: #f0efec; } .soft { fill: #c3c2b7; } .grid { stroke: #33332f; } .axis { stroke: #6e6d66; } .ring { stroke: #1a1a19; }
    .s0 { fill: #c3c2b7; stroke: #c3c2b7; } .s1 { fill: #3987e5; stroke: #3987e5; } .s2 { fill: #d95926; stroke: #d95926; } .s3 { fill: #199e70; stroke: #199e70; }
  }
</style>`);
  out.push(`<rect class="bg" width="${WIDTH}" height="${HEIGHT}"/>`);
  out.push(`<text class="ink" x="${PLOT.left}" y="24" font-size="16" font-weight="600">${escapeXml(title)}</text>`);

  // Legend, one row, so identity never rests on the color of a point alone.
  const groups = [...new Set(points.map((p) => p.group))];
  let legendX = PLOT.left;
  for (const group of groups) {
    out.push(`<circle class="${GROUP_CLASS[group]}" cx="${legendX + 5}" cy="42" r="5"/>`);
    out.push(`<text class="soft" x="${legendX + 15}" y="46" font-size="12">${escapeXml(group)}</text>`);
    legendX += 15 + group.length * 7 + 18;
  }

  for (const value of ticks(0, yMax)) {
    out.push(`<line class="grid" x1="${PLOT.left}" x2="${WIDTH - PLOT.right}" y1="${py(value)}" y2="${py(value)}"/>`);
    out.push(`<text class="soft" x="${PLOT.left - 8}" y="${py(value) + 4}" font-size="12" text-anchor="end">${percent(value)}</text>`);
  }
  for (const value of ticks(xMin, 1)) {
    out.push(`<line class="grid" x1="${px(value)}" x2="${px(value)}" y1="${PLOT.top}" y2="${HEIGHT - PLOT.bottom}"/>`);
    out.push(`<text class="soft" x="${px(value)}" y="${HEIGHT - PLOT.bottom + 18}" font-size="12" text-anchor="middle">${percent(value)}</text>`);
  }
  out.push(`<line class="axis" x1="${PLOT.left}" x2="${WIDTH - PLOT.right}" y1="${py(0)}" y2="${py(0)}"/>`);
  out.push(`<text class="soft" x="${PLOT.left + plotWidth / 2}" y="${HEIGHT - 16}" font-size="12" text-anchor="middle">Honest orders paid in full (better to the right)</text>`);
  out.push(`<text class="soft" transform="translate(18 ${PLOT.top + plotHeight / 2}) rotate(-90)" font-size="12" text-anchor="middle">Attack trials that lost money (better lower)</text>`);

  for (const { point } of marks) {
    const cls = GROUP_CLASS[point.group];
    const x = px(point.honest.rate);
    const y = py(point.loss.rate);
    out.push(`<line class="${cls} bar" x1="${px(point.honest.ci.lo)}" x2="${px(point.honest.ci.hi)}" y1="${y}" y2="${y}"/>`);
    out.push(`<line class="${cls} bar" x1="${x}" x2="${x}" y1="${py(point.loss.ci.lo)}" y2="${py(point.loss.ci.hi)}"/>`);
  }
  for (const { point } of marks) {
    out.push(`<circle class="${GROUP_CLASS[point.group]} ring" cx="${px(point.honest.rate)}" cy="${py(point.loss.rate)}" r="6"/>`);
  }

  // Each label takes the first nearby spot that is free of other labels and of the marks.
  const taken: Box[] = marks.map(({ point }) => ({ x: px(point.honest.rate) - 8, y: py(point.loss.rate) - 8, width: 16, height: 16 }));
  const order = [...marks].sort((a, b) => px(b.point.honest.rate) - px(a.point.honest.rate) || py(a.point.loss.rate) - py(b.point.loss.rate));
  for (const { ids, point } of order) {
    const text = ids.join(", ");
    const width = text.length * 6.6;
    const height = 14;
    const x = px(point.honest.rate);
    const y = py(point.loss.rate);
    const spots: Box[] = [];
    for (const lift of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      const dy = lift * 16;
      spots.push({ x: x - width - 10, y: y - height / 2 - dy, width, height });
      spots.push({ x: x + 10, y: y - height / 2 - dy, width, height });
      spots.push({ x: x - width - 10, y: y - height / 2 + dy, width, height });
      spots.push({ x: x - width / 2, y: y - height - 10 - dy, width, height });
    }
    const inside = (box: Box) => box.x >= PLOT.left + 2 && box.x + box.width <= WIDTH - PLOT.right && box.y >= PLOT.top && box.y + box.height <= HEIGHT - PLOT.bottom - 2;
    const spot = spots.find((box) => inside(box) && !taken.some((other) => overlaps(box, other))) ?? spots[0]!;
    taken.push(spot);
    // A label pushed away from its mark gets a thin line back to it, so it cannot be read as another point's.
    const labelY = spot.y + height / 2;
    if (Math.abs(labelY - y) > 2) {
      const labelX = spot.x + width / 2 < x ? spot.x + width + 2 : spot.x - 2;
      out.push(`<line class="axis" x1="${x}" y1="${y}" x2="${labelX}" y2="${labelY}"/>`);
    }
    out.push(`<text class="ink" x="${spot.x}" y="${spot.y + 11}" font-size="12">${escapeXml(text)}</text>`);
  }
  out.push("</svg>");
  return `${out.join("\n")}\n`;
}
