import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CIGate } from "../src/ci-gate.js";
import { RegressionDetector } from "../src/regression.js";
import { saveBaseline, loadBaseline } from "../src/baseline.js";
import { PRCommentReporter } from "../src/reporters/pr-comment.js";
import type {
  MultiTrialResult,
  SampleTrialResult,
  RegressionResult,
  Baseline,
  MatrixResult,
} from "../src/types.js";
import { CIGateResultSchema } from "../src/types.js";

type WilsonCI = { lower: number; upper: number; point: number; z: number };

function makeCI(point: number): WilsonCI {
  return {
    lower: Math.max(0, point - 0.1),
    upper: Math.min(1, point + 0.1),
    point,
    z: 1.96,
  };
}

function makeSample(
  sampleId: string,
  passCount: number,
  trials: number,
): SampleTrialResult {
  const passRate = trials === 0 ? 0 : passCount / trials;
  return {
    sampleId,
    trials,
    passCount,
    failCount: trials - passCount,
    errorCount: 0,
    passRate,
    passAtK: {},
    scores: {},
    wilsonCI: makeCI(passRate),
  };
}

function makeMultiTrial(
  taskId: string,
  trials: number,
  samples: SampleTrialResult[],
): MultiTrialResult {
  const meanPassRate =
    samples.length === 0
      ? 0
      : samples.reduce((a, s) => a + s.passRate, 0) / samples.length;
  return {
    schemaVersion: 1,
    runId: `${taskId}-run`,
    taskId,
    taskVersion: "1.0.0",
    trials,
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:01:00.000Z",
    summary: {
      total: samples.length,
      trials,
      meanPassRate,
      stddevPassRate: 0,
      passRateCI: makeCI(meanPassRate),
    },
    samples,
    rawRuns: [],
  };
}

describe("CIGate", () => {
  it("passes when all gates met", () => {
    const gate = new CIGate({ passRateFloor: 0.8 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 9, 10)]);
    const r = gate.evaluate(result);
    expect(r.pass).toBe(true);
    expect(r.reasons).toContain("All gates passed");
    expect(r.passRate).toBeCloseTo(0.9, 5);
  });

  it("fails on pass rate below floor", () => {
    const gate = new CIGate({ passRateFloor: 0.9 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 5, 10)]);
    const r = gate.evaluate(result);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => s.includes("below floor"))).toBe(true);
  });

  it("fails on too many regressions", () => {
    const gate = new CIGate({ maxRegressions: 0 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    const regressions: RegressionResult[] = [
      {
        sampleId: "s1",
        baselinePassRate: 1.0,
        currentPassRate: 0.5,
        pValue: 0.01,
        significant: true,
        direction: "regressed",
      },
    ];
    const r = gate.evaluate(result, regressions);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => s.includes("regression"))).toBe(true);
    expect(r.regressionCount).toBe(1);
  });

  it("returns exit code 0 on pass, 1 on fail", () => {
    const gate = new CIGate({ passRateFloor: 0.5 });
    const pass = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    const fail = makeMultiTrial("t1", 10, [makeSample("s1", 0, 10)]);
    expect(gate.exitCode(gate.evaluate(pass))).toBe(0);
    expect(gate.exitCode(gate.evaluate(fail))).toBe(1);
  });

  it("validates config in constructor", () => {
    expect(() => new CIGate({ passRateFloor: 1.5 } as never)).toThrow();
    expect(() => new CIGate({ maxRegressions: -1 } as never)).toThrow();
  });

  it("handles missing optional config fields", () => {
    const gate = new CIGate({});
    const result = makeMultiTrial("t1", 5, [makeSample("s1", 3, 5)]);
    const r = gate.evaluate(result);
    expect(r.pass).toBe(true);
  });

  it("includes all failure reasons when multiple gates fail", () => {
    const gate = new CIGate({
      passRateFloor: 0.9,
      maxRegressions: 0,
    });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 3, 10)]);
    const regressions: RegressionResult[] = [
      {
        sampleId: "s1",
        baselinePassRate: 0.9,
        currentPassRate: 0.3,
        pValue: 0.001,
        significant: true,
        direction: "regressed",
      },
    ];
    const r = gate.evaluate(result, regressions);
    expect(r.pass).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("fails when maxRegressions configured but regressions arg not provided", () => {
    const gate = new CIGate({ maxRegressions: 0 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    const r = gate.evaluate(result);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => /regression/i.test(s))).toBe(true);
  });

  it("fails when maxCostUsd configured but totalCostUsd not provided", () => {
    const gate = new CIGate({ maxCostUsd: 10 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    const r = gate.evaluate(result);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => /cost/i.test(s))).toBe(true);
  });

  it("fails when totalCostUsd is NaN", () => {
    const gate = new CIGate({ maxCostUsd: 10 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    const r = gate.evaluate(result, undefined, NaN);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => /invalid|non-finite/i.test(s))).toBe(true);
    expect(r.totalCostUsd).toBeUndefined();
    expect(CIGateResultSchema.safeParse(r).success).toBe(true);
  });

  it("fails when totalCostUsd is negative", () => {
    const gate = new CIGate({ maxCostUsd: 10 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    const r = gate.evaluate(result, undefined, -1);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((s) => /invalid|negative/i.test(s))).toBe(true);
    expect(r.totalCostUsd).toBeUndefined();
    expect(CIGateResultSchema.safeParse(r).success).toBe(true);
  });

  it("does not count non-significant or improved regressions", () => {
    const gate = new CIGate({ maxRegressions: 0 });
    const result = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    const regressions: RegressionResult[] = [
      {
        sampleId: "s1",
        baselinePassRate: 0.5,
        currentPassRate: 0.9,
        pValue: 0.01,
        significant: true,
        direction: "improved",
      },
      {
        sampleId: "s2",
        baselinePassRate: 0.9,
        currentPassRate: 0.8,
        pValue: 0.5,
        significant: false,
        direction: "unchanged",
      },
    ];
    const r = gate.evaluate(result, regressions);
    expect(r.pass).toBe(true);
    expect(r.regressionCount).toBe(0);
  });
});

describe("RegressionDetector", () => {
  function mkBaseline(samples: Array<[string, number, number]>): Baseline {
    return {
      schemaVersion: 1,
      taskId: "t1",
      taskVersion: "1.0.0",
      createdAt: "2025-01-01T00:00:00.000Z",
      samples: samples.map(([id, pc, tr]) => ({
        sampleId: id,
        passRate: tr === 0 ? 0 : pc / tr,
        trials: tr,
        passCount: pc,
      })),
    };
  }

  it("detects regression when pass rate drops significantly", () => {
    const baseline = mkBaseline([["s1", 30, 30]]);
    const current = makeMultiTrial("t1", 30, [makeSample("s1", 10, 30)]);
    const det = new RegressionDetector(0.05);
    const results = det.detect(baseline, current);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.sampleId).toBe("s1");
    expect(r.direction).toBe("regressed");
    expect(r.significant).toBe(true);
    expect(r.pValue).toBeLessThan(0.05);
  });

  it("detects improvement when pass rate rises significantly", () => {
    const baseline = mkBaseline([["s1", 5, 30]]);
    const current = makeMultiTrial("t1", 30, [makeSample("s1", 28, 30)]);
    const det = new RegressionDetector(0.05);
    const results = det.detect(baseline, current);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.direction).toBe("improved");
    expect(r.significant).toBe(true);
  });

  it("reports unchanged for insignificant differences", () => {
    const baseline = mkBaseline([["s1", 15, 30]]);
    const current = makeMultiTrial("t1", 30, [makeSample("s1", 16, 30)]);
    const det = new RegressionDetector(0.05);
    const results = det.detect(baseline, current);
    const r = results[0]!;
    expect(r.significant).toBe(false);
    expect(r.direction).toBe("unchanged");
  });

  it("handles new samples not in baseline (skips them)", () => {
    const baseline = mkBaseline([["s1", 10, 10]]);
    const current = makeMultiTrial("t1", 10, [
      makeSample("s1", 10, 10),
      makeSample("s2_new", 5, 10),
    ]);
    const det = new RegressionDetector(0.05);
    const results = det.detect(baseline, current);
    expect(results).toHaveLength(1);
    expect(results[0]!.sampleId).toBe("s1");
  });

  it("handles baseline samples not in current (omits them)", () => {
    const baseline = mkBaseline([
      ["s1", 10, 10],
      ["s2_removed", 10, 10],
    ]);
    const current = makeMultiTrial("t1", 10, [makeSample("s1", 10, 10)]);
    const det = new RegressionDetector(0.05);
    const results = det.detect(baseline, current);
    expect(results).toHaveLength(1);
    expect(results[0]!.sampleId).toBe("s1");
  });

  it("detects regression with unequal trial counts", () => {
    const baseline: Baseline = {
      schemaVersion: 1,
      taskId: "t1",
      taskVersion: "1.0",
      createdAt: new Date().toISOString(),
      samples: [
        { sampleId: "s1", passRate: 0.9, trials: 10, passCount: 9 },
      ],
    };
    const current = {
      taskId: "t1",
      samples: [
        {
          sampleId: "s1",
          trials: 20,
          passCount: 8,
          failCount: 12,
          errorCount: 0,
          passRate: 0.4,
          passAtK: {},
          scores: {},
          wilsonCI: { lower: 0.2, upper: 0.6, point: 0.4, z: 1.96 },
        },
      ],
      summary: {
        total: 1,
        trials: 20,
        meanPassRate: 0.4,
        stddevPassRate: 0,
        passRateCI: { lower: 0.2, upper: 0.6, point: 0.4, z: 1.96 },
      },
      rawRuns: [],
    } as unknown as MultiTrialResult;

    const detector = new RegressionDetector(0.05);
    const results = detector.detect(baseline, current);
    const r = results.find((x) => x.sampleId === "s1");
    expect(r).toBeDefined();
    expect(r!.direction).toBe("regressed");
    expect(r!.significant).toBe(true);
  });

  it("does not false-positive on aggregate data with equal trials", () => {
    // 18/30 baseline vs 12/30 current = 60% vs 40%
    // Two-proportion z-test p ≈ 0.12 (not significant at 0.05)
    // Old McNemar with fabricated pairing gave p ≈ 0.03 (false positive)
    const baseline: Baseline = {
      schemaVersion: 1,
      taskId: "t1",
      taskVersion: "1.0",
      createdAt: new Date().toISOString(),
      samples: [{ sampleId: "s1", passRate: 0.6, trials: 30, passCount: 18 }],
    };
    const current = {
      taskId: "t1",
      samples: [
        {
          sampleId: "s1",
          trials: 30,
          passCount: 12,
          failCount: 18,
          errorCount: 0,
          passRate: 0.4,
          passAtK: {},
          scores: {},
          wilsonCI: { lower: 0.23, upper: 0.59, point: 0.4, z: 1.96 },
        },
      ],
      summary: {
        total: 1,
        trials: 30,
        meanPassRate: 0.4,
        stddevPassRate: 0,
        passRateCI: { lower: 0.23, upper: 0.59, point: 0.4, z: 1.96 },
      },
      rawRuns: [],
    } as unknown as MultiTrialResult;

    const detector = new RegressionDetector(0.05);
    const results = detector.detect(baseline, current);
    const r = results.find((x) => x.sampleId === "s1");
    expect(r).toBeDefined();
    expect(r!.significant).toBe(false);
    expect(r!.direction).toBe("unchanged");
  });

  it("uses configurable alpha", () => {
    const baseline = mkBaseline([["s1", 20, 20]]);
    // Current 16/20 — borderline
    const current = makeMultiTrial("t1", 20, [makeSample("s1", 16, 20)]);
    const strict = new RegressionDetector(0.01);
    const lax = new RegressionDetector(0.5);
    const rStrict = strict.detect(baseline, current)[0]!;
    const rLax = lax.detect(baseline, current)[0]!;
    // Same p-value, different alpha → different significance
    expect(rStrict.pValue).toBe(rLax.pValue);
    if (rStrict.pValue < 0.5) {
      expect(rLax.significant).toBe(true);
    }
    if (rStrict.pValue > 0.01) {
      expect(rStrict.significant).toBe(false);
    }
  });

  it("throws when baseline taskId does not match current taskId", () => {
    const baseline: Baseline = {
      schemaVersion: 1,
      taskId: "task-a",
      taskVersion: "1.0",
      createdAt: new Date().toISOString(),
      samples: [{ sampleId: "s1", passRate: 1.0, trials: 10, passCount: 10 }],
    };
    const current = makeMultiTrial("task-b", 10, [makeSample("s1", 8, 10)]);
    const detector = new RegressionDetector(0.05);
    expect(() => detector.detect(baseline, current)).toThrow(/taskId/i);
  });
});

describe("Baseline management", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-baseline-"));
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("saves and loads baseline round-trip", () => {
    const result = makeMultiTrial("task-a", 10, [
      makeSample("s1", 9, 10),
      makeSample("s2", 7, 10),
    ]);
    result.model = "gpt-4";
    const path = join(dir, "baseline.json");
    saveBaseline(result, path);
    expect(existsSync(path)).toBe(true);
    const loaded = loadBaseline(path);
    expect(loaded.taskId).toBe("task-a");
    expect(loaded.taskVersion).toBe("1.0.0");
    expect(loaded.model).toBe("gpt-4");
    expect(loaded.samples).toHaveLength(2);
    expect(loaded.samples[0]!.passCount).toBe(9);
  });

  it("validates baseline schema on load", () => {
    const path = join(dir, "bad.json");
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, taskId: "x" }),
      "utf8",
    );
    expect(() => loadBaseline(path)).toThrow();
  });

  it("rejects invalid baseline file (non-JSON)", () => {
    const path = join(dir, "nope.json");
    writeFileSync(path, "not json at all", "utf8");
    expect(() => loadBaseline(path)).toThrow();
  });

  it("creates output directory if needed", () => {
    const result = makeMultiTrial("task-a", 3, [makeSample("s1", 3, 3)]);
    const path = join(dir, "nested", "sub", "baseline.json");
    saveBaseline(result, path);
    expect(existsSync(path)).toBe(true);
  });
});

describe("PRCommentReporter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-prcomment-"));
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("writes multi-trial summary markdown", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    const result = makeMultiTrial("my-task", 10, [
      makeSample("s1", 9, 10),
      makeSample("s2", 6, 10),
    ]);
    reporter.onMultiTrialComplete(result);
    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content).toContain("my-task");
    expect(content).toContain("s1");
    expect(content).toContain("s2");
    expect(content).toContain("90");
  });

  it("writes gate result with pass badge", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    reporter.writeGateResult({
      pass: true,
      reasons: ["All gates passed"],
      passRate: 0.95,
    });
    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content.toLowerCase()).toMatch(/pass|✅/);
    expect(content).toContain("All gates passed");
  });

  it("writes gate result with fail badge", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    reporter.writeGateResult({
      pass: false,
      reasons: ["Pass rate 30.0% below floor 80.0%"],
      passRate: 0.3,
    });
    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content.toLowerCase()).toMatch(/fail|❌/);
    expect(content).toContain("below floor");
  });

  it("includes regression table when regressions present", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    const regressions: RegressionResult[] = [
      {
        sampleId: "s1",
        baselinePassRate: 0.9,
        currentPassRate: 0.5,
        pValue: 0.01,
        significant: true,
        direction: "regressed",
      },
      {
        sampleId: "s2",
        baselinePassRate: 0.5,
        currentPassRate: 0.9,
        pValue: 0.01,
        significant: true,
        direction: "improved",
      },
    ];
    reporter.writeGateResult(
      {
        pass: false,
        reasons: ["1 regressions exceed max 0"],
        passRate: 0.7,
        regressionCount: 1,
      },
      regressions,
    );
    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content).toContain("s1");
    expect(content).toContain("regressed");
    expect(content).toContain("s2");
  });

  it("does not overwrite gate result when onMultiTrialComplete called after", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    reporter.writeGateResult({ pass: true, reasons: ["All passed"] });
    const result = makeMultiTrial("my-task", 10, [makeSample("s1", 9, 10)]);
    reporter.onMultiTrialComplete(result);
    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content).toContain("All passed");
    expect(content).toContain("my-task");
  });

  it("supports matrix result rendering", () => {
    const reporter = new PRCommentReporter(join(dir, "pr.md"));
    const cellResult = makeMultiTrial("m-task", 5, [makeSample("s1", 5, 5)]);
    const matrix: MatrixResult = {
      schemaVersion: 1,
      runId: "m-run",
      taskId: "m-task",
      taskVersion: "1.0.0",
      startedAt: "2025-01-01T00:00:00.000Z",
      finishedAt: "2025-01-01T00:01:00.000Z",
      models: ["gpt-4"],
      configs: [
        { id: "c1", label: "Config 1", overrides: {} },
      ],
      cells: [
        {
          model: "gpt-4",
          configId: "c1",
          configLabel: "Config 1",
          result: cellResult,
        },
      ],
      summary: {
        totalCells: 1,
        bestPassRate: { model: "gpt-4", configId: "c1", passRate: 1.0 },
        worstPassRate: { model: "gpt-4", configId: "c1", passRate: 1.0 },
      },
    };
    reporter.onMatrixComplete(matrix);
    const content = readFileSync(join(dir, "pr.md"), "utf8");
    expect(content).toContain("m-task");
    expect(content).toContain("gpt-4");
  });
});
