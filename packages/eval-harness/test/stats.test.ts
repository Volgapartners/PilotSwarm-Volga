import { describe, it, expect } from "vitest";
import {
  passAtK,
  meanStddev,
  wilsonInterval,
  bootstrapCI,
  mcNemarTest,
  mannWhitneyU,
} from "../src/stats.js";

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("passAtK", () => {
  it("all pass returns 1.0 for k=1", () => {
    expect(passAtK([true, true, true], 1)).toBe(1.0);
  });

  it("all fail returns 0.0 for k=1", () => {
    expect(passAtK([false, false, false], 1)).toBe(0.0);
  });

  it("one of five passes, k=1 -> 0.2", () => {
    expect(passAtK([true, false, false, false, false], 1)).toBeCloseTo(0.2, 10);
  });

  it("two of ten pass, k=3 -> 1 - C(8,3)/C(10,3) ≈ 0.5333", () => {
    const results = [
      true, true, false, false, false, false, false, false, false, false,
    ];
    expect(passAtK(results, 3)).toBeCloseTo(1 - 56 / 120, 10);
  });

  it("returns 1.0 when n-c < k (not enough fails to ever fail)", () => {
    // n=5, c=4, k=3 → n-c=1 < 3 → 1.0
    expect(passAtK([true, true, true, true, false], 3)).toBe(1.0);
  });

  it("all pass any k returns 1.0", () => {
    expect(passAtK([true, true, true, true, true], 3)).toBe(1.0);
  });

  it("all fail any k returns 0.0", () => {
    expect(passAtK([false, false, false, false, false], 3)).toBe(0.0);
  });

  it("throws on empty input", () => {
    expect(() => passAtK([], 1)).toThrow();
  });

  it("throws on k=0", () => {
    expect(() => passAtK([true], 0)).toThrow();
  });

  it("throws on k>n", () => {
    expect(() => passAtK([true, false], 3)).toThrow();
  });

  it("throws on non-integer k", () => {
    expect(() => passAtK([true, false, true], 1.5)).toThrow();
  });

  it("throws on negative k", () => {
    expect(() => passAtK([true], -1)).toThrow();
  });

  it("single true result with k=1", () => {
    expect(passAtK([true], 1)).toBe(1.0);
  });

  it("single false result with k=1", () => {
    expect(passAtK([false], 1)).toBe(0.0);
  });
});

describe("meanStddev", () => {
  it("computes mean and sample stddev for [1..5]", () => {
    const r = meanStddev([1, 2, 3, 4, 5]);
    expect(r.mean).toBeCloseTo(3, 10);
    expect(r.stddev).toBeCloseTo(Math.sqrt(2.5), 10);
    expect(r.n).toBe(5);
  });

  it("single value returns stddev 0", () => {
    const r = meanStddev([10]);
    expect(r.mean).toBe(10);
    expect(r.stddev).toBe(0);
    expect(r.n).toBe(1);
  });

  it("empty returns NaN", () => {
    const r = meanStddev([]);
    expect(Number.isNaN(r.mean)).toBe(true);
    expect(Number.isNaN(r.stddev)).toBe(true);
    expect(r.n).toBe(0);
  });

  it("identical values give stddev 0", () => {
    const r = meanStddev([1, 1, 1, 1]);
    expect(r.mean).toBe(1);
    expect(r.stddev).toBe(0);
    expect(r.n).toBe(4);
  });

  it("handles negative values", () => {
    const r = meanStddev([-2, -1, 0, 1, 2]);
    expect(r.mean).toBeCloseTo(0, 10);
    expect(r.stddev).toBeCloseTo(Math.sqrt(2.5), 10);
  });

  it("throws on NaN", () => {
    expect(() => meanStddev([1, NaN, 3])).toThrow();
  });

  it("throws on Infinity", () => {
    expect(() => meanStddev([1, Infinity, 3])).toThrow();
  });
});

describe("wilsonInterval", () => {
  it("50 of 100 at z=1.96 gives point=0.5 and known bounds", () => {
    const r = wilsonInterval(50, 100, 1.96);
    expect(r.point).toBeCloseTo(0.5, 10);
    expect(r.lower).toBeCloseTo(0.4038, 3);
    expect(r.upper).toBeCloseTo(0.5962, 3);
    expect(r.z).toBe(1.96);
  });

  it("defaults z to ~1.959964 for 95% CI", () => {
    const r = wilsonInterval(50, 100);
    expect(r.z).toBeCloseTo(1.959964, 5);
  });

  it("0 of 10 has lower=0 and upper>0", () => {
    const r = wilsonInterval(0, 10);
    expect(r.lower).toBe(0);
    expect(r.upper).toBeGreaterThan(0);
    expect(r.point).toBe(0);
  });

  it("10 of 10 has upper=1 and lower<1", () => {
    const r = wilsonInterval(10, 10);
    expect(r.upper).toBe(1);
    expect(r.lower).toBeLessThan(1);
    expect(r.point).toBe(1);
  });

  it("0 of 0 returns full interval with NaN point", () => {
    const r = wilsonInterval(0, 0);
    expect(r.lower).toBe(0);
    expect(r.upper).toBe(1);
    expect(Number.isNaN(r.point)).toBe(true);
  });

  it("clamps bounds within [0,1]", () => {
    const r = wilsonInterval(1, 2);
    expect(r.lower).toBeGreaterThanOrEqual(0);
    expect(r.upper).toBeLessThanOrEqual(1);
  });

  it("throws on negative passes", () => {
    expect(() => wilsonInterval(-1, 10)).toThrow();
  });

  it("throws on negative total", () => {
    expect(() => wilsonInterval(1, -1)).toThrow();
  });

  it("throws when passes > total", () => {
    expect(() => wilsonInterval(11, 10)).toThrow();
  });
});

describe("bootstrapCI", () => {
  it("degenerate all-equal gives lower=upper=value", () => {
    const r = bootstrapCI([5, 5, 5, 5], 0.05, 500, mulberry32(1));
    expect(r.lower).toBe(5);
    expect(r.upper).toBe(5);
    expect(r.point).toBe(5);
    expect(r.reps).toBe(500);
    expect(r.alpha).toBe(0.05);
  });

  it("seeded run is deterministic and contains mean", () => {
    const rngA = mulberry32(42);
    const rngB = mulberry32(42);
    const ra = bootstrapCI([1, 2, 3, 4, 5], 0.05, 1000, rngA);
    const rb = bootstrapCI([1, 2, 3, 4, 5], 0.05, 1000, rngB);
    expect(ra.lower).toBe(rb.lower);
    expect(ra.upper).toBe(rb.upper);
    expect(ra.lower).toBeLessThan(ra.point);
    expect(ra.upper).toBeGreaterThan(ra.point);
    expect(ra.point).toBeCloseTo(3, 10);
  });

  it("empty returns NaN fields", () => {
    const r = bootstrapCI([], 0.05, 100, mulberry32(1));
    expect(Number.isNaN(r.lower)).toBe(true);
    expect(Number.isNaN(r.upper)).toBe(true);
    expect(Number.isNaN(r.point)).toBe(true);
  });

  it("single value is degenerate", () => {
    const r = bootstrapCI([7], 0.05, 100, mulberry32(1));
    expect(r.lower).toBe(7);
    expect(r.upper).toBe(7);
    expect(r.point).toBe(7);
  });

  it("throws on alpha<=0", () => {
    expect(() => bootstrapCI([1, 2, 3], 0, 100, mulberry32(1))).toThrow();
  });

  it("throws on alpha>=1", () => {
    expect(() => bootstrapCI([1, 2, 3], 1, 100, mulberry32(1))).toThrow();
  });

  it("throws on non-finite values", () => {
    expect(() => bootstrapCI([1, NaN, 3], 0.05, 100, mulberry32(1))).toThrow();
  });

  it("throws on reps <= 0", () => {
    expect(() => bootstrapCI([1, 2, 3], 0.05, 0)).toThrow();
    expect(() => bootstrapCI([1, 2, 3], 0.05, -1)).toThrow();
  });

  it("throws on non-integer reps", () => {
    expect(() => bootstrapCI([1, 2, 3], 0.05, 2.5)).toThrow();
  });

  it("uses default alpha and reps when omitted", () => {
    const r = bootstrapCI([1, 2, 3, 4, 5], undefined, undefined, mulberry32(1));
    expect(r.alpha).toBe(0.05);
    expect(r.reps).toBe(10_000);
  });
});

describe("mcNemarTest", () => {
  it("all concordant returns pValue=1", () => {
    const r = mcNemarTest([
      [true, true],
      [false, false],
      [true, true],
    ]);
    expect(r.b).toBe(0);
    expect(r.c).toBe(0);
    expect(r.pValue).toBe(1.0);
    expect(r.statistic).toBe(0);
  });

  it("empty returns pValue=1", () => {
    const r = mcNemarTest([]);
    expect(r.pValue).toBe(1.0);
    expect(r.b).toBe(0);
    expect(r.c).toBe(0);
  });

  it("small discordant (b=1,c=9) uses exact binomial", () => {
    const paired: Array<[boolean, boolean]> = [];
    // 1 regression, 9 improvements
    paired.push([true, false]);
    for (let i = 0; i < 9; i++) paired.push([false, true]);
    const r = mcNemarTest(paired);
    expect(r.method).toBe("exact");
    expect(r.b).toBe(1);
    expect(r.c).toBe(9);
    // p = min(1, 2 * P(X<=1; n=10, p=0.5))
    // P(X<=1; 10, 0.5) = (C(10,0)+C(10,1))/2^10 = 11/1024
    // so p = 22/1024 ≈ 0.02148
    expect(r.pValue).toBeCloseTo(22 / 1024, 6);
  });

  it("large discordant uses chi² with Yates correction", () => {
    const paired: Array<[boolean, boolean]> = [];
    for (let i = 0; i < 15; i++) paired.push([true, false]); // b
    for (let i = 0; i < 35; i++) paired.push([false, true]); // c
    const r = mcNemarTest(paired);
    expect(r.method).toBe("chi2-yates");
    expect(r.b).toBe(15);
    expect(r.c).toBe(35);
    const expectedChi = Math.pow(Math.abs(15 - 35) - 1, 2) / (15 + 35);
    expect(r.statistic).toBeCloseTo(expectedChi, 10);
    expect(r.pValue).toBeGreaterThan(0);
    expect(r.pValue).toBeLessThan(0.01);
  });

  it("all regressions yields highly significant p", () => {
    const paired: Array<[boolean, boolean]> = [];
    for (let i = 0; i < 10; i++) paired.push([true, false]);
    const r = mcNemarTest(paired);
    expect(r.b).toBe(10);
    expect(r.c).toBe(0);
    // exact: 2 * P(X<=0; 10, 0.5) = 2/1024
    expect(r.pValue).toBeCloseTo(2 / 1024, 8);
  });

  it("exact=true forces exact even with large n", () => {
    const paired: Array<[boolean, boolean]> = [];
    for (let i = 0; i < 15; i++) paired.push([true, false]);
    for (let i = 0; i < 35; i++) paired.push([false, true]);
    const r = mcNemarTest(paired, { exact: true });
    expect(r.method).toBe("exact");
  });

  it("exact=false forces chi² even with small n", () => {
    const paired: Array<[boolean, boolean]> = [
      [true, false],
      [false, true],
      [false, true],
    ];
    const r = mcNemarTest(paired, { exact: false });
    expect(r.method).toBe("chi2-yates");
  });

  it("single discordant pair", () => {
    const r = mcNemarTest([[true, false]]);
    expect(r.b).toBe(1);
    expect(r.c).toBe(0);
    expect(r.pValue).toBe(1.0);
    expect(r.method).toBe("exact");
  });

  it("single concordant pair", () => {
    const r = mcNemarTest([[true, true]]);
    expect(r.b).toBe(0);
    expect(r.c).toBe(0);
    expect(r.pValue).toBe(1.0);
  });
});

describe("mannWhitneyU", () => {
  it("complete separation gives U=0", () => {
    const r = mannWhitneyU([1, 2, 3], [4, 5, 6]);
    expect(r.u).toBe(0);
    expect(r.n1).toBe(3);
    expect(r.n2).toBe(3);
    expect(r.pValue).toBeLessThanOrEqual(0.1);
  });

  it("exact p-value for small untied samples matches reference", () => {
    // [1,2,3] vs [4,5,6]: exact two-sided p = 2/C(6,3) = 0.1
    const r = mannWhitneyU([1, 2, 3], [4, 5, 6]);
    expect(r.u).toBe(0);
    expect(r.pValue).toBeCloseTo(0.1, 4);
  });

  it("exact p-value for [1,2] vs [3,4]", () => {
    // n1=2, n2=2: U=0, exact p = 1/3 ≈ 0.3333
    const r = mannWhitneyU([1, 2], [3, 4]);
    expect(r.u).toBe(0);
    expect(r.pValue).toBeCloseTo(1 / 3, 3);
  });

  it("falls back to asymptotic for larger samples", () => {
    // n1=10, n2=10: should use asymptotic
    const a = Array.from({ length: 10 }, (_, i) => i);
    const b = Array.from({ length: 10 }, (_, i) => i + 10);
    const r = mannWhitneyU(a, b);
    expect(r.pValue).toBeLessThan(0.001);
  });

  it("falls back to asymptotic when ties exist even for small n", () => {
    // Small n but ties: [1,1,2] vs [2,3,3] — has ties, use asymptotic
    const r = mannWhitneyU([1, 1, 2], [2, 3, 3]);
    expect(r.pValue).toBeGreaterThan(0);
    expect(r.pValue).toBeLessThan(1);
  });

  it("identical samples give pValue near 1", () => {
    const r = mannWhitneyU([1, 2, 3], [1, 2, 3]);
    expect(r.u).toBeCloseTo(4.5, 10);
    expect(r.pValue).toBeCloseTo(1.0, 5);
  });

  it("single element each side", () => {
    const r = mannWhitneyU([1], [2]);
    expect(r.n1).toBe(1);
    expect(r.n2).toBe(1);
    expect(r.u).toBe(0);
  });

  it("empty input returns NaN fields", () => {
    const r = mannWhitneyU([], [1, 2, 3]);
    expect(Number.isNaN(r.u)).toBe(true);
    expect(Number.isNaN(r.pValue)).toBe(true);
    expect(Number.isNaN(r.z)).toBe(true);
  });

  it("all tied returns pValue=1, z=0", () => {
    const r = mannWhitneyU([5, 5, 5], [5, 5, 5]);
    expect(r.z).toBe(0);
    expect(r.pValue).toBe(1);
  });

  it("u1+u2 equals n1*n2", () => {
    const r = mannWhitneyU([1, 3, 5, 7], [2, 4, 6, 8, 10]);
    expect(r.u1 + r.u2).toBe(4 * 5);
    expect(r.u).toBe(Math.min(r.u1, r.u2));
  });

  it("throws on non-finite input", () => {
    expect(() => mannWhitneyU([1, NaN], [2, 3])).toThrow();
    expect(() => mannWhitneyU([1, 2], [Infinity])).toThrow();
  });
});
