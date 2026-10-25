/**
 * The statistics used to report results. No dependencies: each method is
 * short, standard, and checked in tests against published values.
 */

/** z for a two-sided 95% interval. */
const Z95 = 1.959963984540054;

export interface Interval {
  lo: number;
  hi: number;
}

/**
 * Wilson score interval for k successes in n trials. Unlike the textbook
 * "p plus or minus 1.96 standard errors", it stays inside 0 to 1 and gives a
 * sensible upper bound when nothing was observed (0 of 150 is not "exactly 0").
 */
export function wilson(k: number, n: number, z = Z95): Interval {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { lo: k === 0 ? 0 : Math.max(0, centre - half), hi: k === n ? 1 : Math.min(1, centre + half) };
}

/**
 * Newcombe's hybrid score interval for a difference of two proportions,
 * k1/n1 minus k2/n2 (method 10 in Newcombe, Statistics in Medicine, 1998).
 * Built from the two Wilson intervals, so it behaves at 0 and 1 as they do.
 */
export function newcombe(k1: number, n1: number, k2: number, n2: number): Interval & { diff: number } {
  const p1 = n1 === 0 ? 0 : k1 / n1;
  const p2 = n2 === 0 ? 0 : k2 / n2;
  const a = wilson(k1, n1);
  const b = wilson(k2, n2);
  const diff = p1 - p2;
  return {
    diff,
    lo: diff - Math.sqrt((p1 - a.lo) ** 2 + (b.hi - p2) ** 2),
    hi: diff + Math.sqrt((a.hi - p1) ** 2 + (p2 - b.lo) ** 2),
  };
}

const logFactorials: number[] = [0];
function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i += 1) logFactorials.push(logFactorials[i - 1]! + Math.log(i));
  return logFactorials[n]!;
}

/**
 * Fisher's exact test, two-sided, for the 2x2 table
 *
 *            event   no event
 *   group 1    a        b
 *   group 2    c        d
 *
 * The p-value sums the probabilities of every table with the same margins
 * that is no more likely than the one observed.
 */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const row1 = a + b;
  const col1 = a + c;
  const n = a + b + c + d;
  const logP = (x: number) =>
    logFactorial(row1) + logFactorial(n - row1) + logFactorial(col1) + logFactorial(n - col1) -
    logFactorial(n) - logFactorial(x) - logFactorial(row1 - x) - logFactorial(col1 - x) - logFactorial(n - row1 - col1 + x);
  const observed = logP(a);
  let p = 0;
  for (let x = Math.max(0, row1 + col1 - n); x <= Math.min(row1, col1); x += 1) {
    const lp = logP(x);
    // The small tolerance keeps tables exactly as likely as the observed one from being dropped by rounding.
    if (lp <= observed + 1e-7) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

/** A small, fast, seeded random number generator (mulberry32), so every resampling result can be reproduced. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Outcomes of the two groups being compared within one stratum (one scenario): 1 for the event, 0 for none. */
export interface Stratum {
  a: number[];
  b: number[];
}

const pooledDifference = (strata: Stratum[]) => {
  let sumA = 0;
  let nA = 0;
  let sumB = 0;
  let nB = 0;
  for (const { a, b } of strata) {
    for (const x of a) sumA += x;
    for (const x of b) sumB += x;
    nA += a.length;
    nB += b.length;
  }
  return (nA === 0 ? 0 : sumA / nA) - (nB === 0 ? 0 : sumB / nB);
};

/**
 * Permutation test of "group a and group b have the same rate", respecting
 * strata. If the groups did not differ, which trials within a scenario carry
 * which label would be arbitrary, so the labels are shuffled within each
 * scenario many times and the observed difference is compared with the
 * shuffled ones. Shuffling only within scenarios keeps an easy scenario from
 * masquerading as an effect.
 *
 * `alternative`: "less" tests whether a is lower than b, "greater" whether it
 * is higher, "two-sided" either. The p-value counts the observed labelling as
 * one of the permutations, so it is never exactly 0.
 */
export function stratifiedPermutationTest(
  strata: Stratum[],
  options: { iterations?: number; seed?: number; alternative?: "two-sided" | "less" | "greater" } = {},
): { difference: number; p: number } {
  const iterations = options.iterations ?? 10_000;
  const alternative = options.alternative ?? "two-sided";
  const random = seededRandom(options.seed ?? 1);
  const observed = pooledDifference(strata);
  const pools = strata.map(({ a, b }) => ({ values: [...a, ...b], split: a.length }));
  const tolerance = 1e-12;

  let extreme = 0;
  const shuffled: Stratum[] = pools.map(() => ({ a: [], b: [] }));
  for (let i = 0; i < iterations; i += 1) {
    pools.forEach((pool, index) => {
      const values = pool.values;
      for (let j = values.length - 1; j > 0; j -= 1) {
        const k = Math.floor(random() * (j + 1));
        [values[j], values[k]] = [values[k]!, values[j]!];
      }
      shuffled[index] = { a: values.slice(0, pool.split), b: values.slice(pool.split) };
    });
    const difference = pooledDifference(shuffled);
    if (alternative === "less" ? difference <= observed + tolerance : alternative === "greater" ? difference >= observed - tolerance : Math.abs(difference) >= Math.abs(observed) - tolerance) {
      extreme += 1;
    }
  }
  return { difference: observed, p: (extreme + 1) / (iterations + 1) };
}

/**
 * 95% percentile bootstrap interval for the overall mean of values grouped in
 * strata. Each resample draws, within every stratum, as many values as it has,
 * with replacement; so every scenario keeps its weight.
 */
export function stratifiedBootstrapMean(strata: number[][], options: { iterations?: number; seed?: number } = {}): Interval & { mean: number } {
  const iterations = options.iterations ?? 10_000;
  const random = seededRandom(options.seed ?? 1);
  const total = strata.reduce((n, values) => n + values.length, 0);
  const sum = (values: number[]) => values.reduce((s, x) => s + x, 0);
  const mean = total === 0 ? 0 : strata.reduce((s, values) => s + sum(values), 0) / total;
  if (total === 0) return { mean, lo: 0, hi: 0 };

  const means: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let s = 0;
    for (const values of strata) {
      for (let j = 0; j < values.length; j += 1) s += values[Math.floor(random() * values.length)]!;
    }
    means.push(s / total);
  }
  means.sort((x, y) => x - y);
  const at = (q: number) => means[Math.min(means.length - 1, Math.max(0, Math.round(q * (means.length - 1))))]!;
  return { mean, lo: at(0.025), hi: at(0.975) };
}

/** Holm's step-down adjustment of p-values for several tests at once. Returned in the original order. */
export function holm(pValues: number[]): number[] {
  const order = pValues.map((p, index) => ({ p, index })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  order.forEach(({ p, index }, rank) => {
    running = Math.max(running, Math.min(1, (pValues.length - rank) * p));
    adjusted[index] = running;
  });
  return adjusted;
}
