import { describe, expect, it } from "vitest";
import { fisherExact, holm, newcombe, seededRandom, stratifiedBootstrapMean, stratifiedPermutationTest, wilson, type Stratum } from "../src/stats";

const round = (x: number) => Math.round(x * 10_000) / 10_000;

describe("Wilson interval", () => {
  // Newcombe, "Two-sided confidence intervals for the single proportion", Statistics in Medicine 1998, table I.
  it.each([
    [81, 263, 0.2553, 0.3662],
    [15, 148, 0.0624, 0.1605],
    [0, 20, 0, 0.1611],
    [1, 29, 0.0061, 0.1718],
  ])("matches the published interval for %i of %i", (k, n, lo, hi) => {
    const interval = wilson(k, n);
    expect([round(interval.lo), round(interval.hi)]).toEqual([lo, hi]);
  });

  it("stays inside 0 to 1, gives a real upper bound for 0 events, and is uninformative with no trials", () => {
    expect(wilson(0, 150)).toEqual({ lo: 0, hi: expect.closeTo(0.025, 3) });
    expect(wilson(150, 150).hi).toBe(1);
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});

describe("Newcombe interval for a difference of two rates", () => {
  // Newcombe, "Interval estimation for the difference between independent proportions", Statistics in Medicine 1998, method 10.
  it.each([
    [56, 70, 48, 80, 0.0524, 0.3339],
    [9, 10, 3, 10, 0.1705, 0.809],
    [5, 56, 0, 29, -0.0381, 0.1926],
    [0, 10, 0, 20, -0.1611, 0.2775],
  ])("matches the published interval for %i/%i minus %i/%i", (k1, n1, k2, n2, lo, hi) => {
    const interval = newcombe(k1, n1, k2, n2);
    expect([round(interval.lo), round(interval.hi)]).toEqual([lo, hi]);
    expect(interval.diff).toBeCloseTo(k1 / n1 - k2 / n2, 12);
  });
});

describe("Fisher's exact test", () => {
  it.each([
    [1, 9, 11, 3, 0.002759],
    [3, 1, 1, 3, 0.4857],
    [0, 5, 5, 0, 0.007937],
    [2, 8, 2, 8, 1],
  ])("gives the two-sided p-value for [[%i, %i], [%i, %i]]", (a, b, c, d, p) => {
    expect(Number(fisherExact(a, b, c, d).toPrecision(4))).toBe(p);
  });
});

describe("Holm adjustment", () => {
  it("multiplies the smallest p by the number of tests, the next by one fewer, and never lets them decrease", () => {
    expect(holm([0.01, 0.04, 0.03]).map(round)).toEqual([0.03, 0.06, 0.06]);
    expect(holm([0.5])).toEqual([0.5]);
    // 0.8 times 2 tests is capped at 1, and the larger p cannot come out smaller than it.
    expect(holm([0.9, 0.8])).toEqual([1, 1]);
  });
});

/** Fifteen scenarios with very different success rates, like a real attack suite: most never succeed, a few often do. */
const SUITE = [0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0.1, 0.1, 0.2, 0.3, 0.6, 0.9];
const draw = (p: number, n: number, random: () => number) => Array.from({ length: n }, () => (random() < p ? 1 : 0));

describe("stratified permutation test", () => {
  it("finds nothing when both groups are identical, and a clear effect when one group never succeeds", () => {
    const same: Stratum[] = [{ a: [1, 0, 1], b: [1, 0, 1] }, { a: [0, 0], b: [0, 0] }];
    expect(stratifiedPermutationTest(same, { iterations: 2000 })).toEqual({ difference: 0, p: 1 });

    const clear: Stratum[] = Array.from({ length: 15 }, () => ({ a: Array(10).fill(0), b: Array(10).fill(1) }));
    const result = stratifiedPermutationTest(clear, { iterations: 2000, alternative: "less" });
    expect(result.difference).toBe(-1);
    expect(result.p).toBeCloseTo(1 / 2001, 6);
  });

  it("is not fooled by unequal trial counts across scenarios, where pooled counts are", () => {
    // Within each scenario the two groups behave identically. Group a simply ran the easy scenario more often.
    const strata: Stratum[] = [
      { a: Array(10).fill(1), b: Array(2).fill(1) },
      { a: Array(2).fill(0), b: Array(10).fill(0) },
    ];
    expect(stratifiedPermutationTest(strata, { iterations: 2000 }).p).toBe(1);
    expect(fisherExact(10, 2, 2, 10)).toBeLessThan(0.01);
  });

  it("raises a false alarm about 5% of the time or less when there is no real difference, and usually detects a real one", () => {
    const random = seededRandom(99);
    const datasets = 300;
    let falseAlarms = 0;
    let detections = 0;
    for (let i = 0; i < datasets; i += 1) {
      const nullCase = SUITE.map((p) => ({ a: draw(p, 10, random), b: draw(p, 10, random) }));
      if (stratifiedPermutationTest(nullCase, { iterations: 500, seed: i }).p < 0.05) falseAlarms += 1;
      // A defense that removes most of the risk in the scenarios where there is any.
      const realCase = SUITE.map((p) => ({ a: draw(p * 0.2, 10, random), b: draw(p, 10, random) }));
      if (stratifiedPermutationTest(realCase, { iterations: 500, seed: i, alternative: "less" }).p < 0.05) detections += 1;
    }
    expect(falseAlarms / datasets).toBeLessThanOrEqual(0.08);
    expect(detections / datasets).toBeGreaterThan(0.8);
  }, 60_000);

  it("gives the same answer for the same seed", () => {
    const strata = SUITE.map((p, i) => ({ a: draw(p, 10, seededRandom(i)), b: draw(p, 10, seededRandom(i + 100)) }));
    expect(stratifiedPermutationTest(strata, { seed: 5, iterations: 1000 })).toEqual(stratifiedPermutationTest(strata, { seed: 5, iterations: 1000 }));
  });
});

describe("stratified bootstrap of a mean", () => {
  it("returns the plain mean, a zero-width interval when every value is the same, and the same result for the same seed", () => {
    expect(stratifiedBootstrapMean([[3, 3], [3, 3, 3]], { iterations: 500 })).toEqual({ mean: 3, lo: 3, hi: 3 });
    const strata = [[0, 0, 0, 159, 0], [0, 0, 0, 0, 0], [329, 0, 0, 0, 0]];
    const result = stratifiedBootstrapMean(strata, { iterations: 2000, seed: 3 });
    expect(result.mean).toBeCloseTo(488 / 15, 10);
    expect(result.lo).toBeLessThanOrEqual(result.mean);
    expect(result.hi).toBeGreaterThanOrEqual(result.mean);
    expect(stratifiedBootstrapMean(strata, { iterations: 2000, seed: 3 })).toEqual(result);
    expect(stratifiedBootstrapMean([])).toEqual({ mean: 0, lo: 0, hi: 0 });
  });
});
