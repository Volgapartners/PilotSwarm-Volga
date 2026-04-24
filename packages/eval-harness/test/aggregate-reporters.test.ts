import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConsoleAggregateReporter } from "../src/reporters/console-aggregate.js";
import { MarkdownReporter } from "../src/reporters/markdown.js";
import type {
  MultiTrialResult,
  MatrixResult,
  MatrixCell,
  SampleTrialResult,
  WilsonCISchema,
} from "../src/types.js";
import type { z } from "zod";

type WilsonCI = {
  lower: number;
  upper: number;
  point: number;
  z: number;
};

function makeCI(point: number, lower = Math.max(0, point - 0.1), upper = Math.min(1, point + 0.1)): WilsonCI {
  return { lower, upper, point, z: 1.96 };
}

function makeSample(
  sampleId: string,
  passCount: number,
  trials: number,
  passAtK: Record<number, number> = {},
): SampleTrialResult {
  const passRate = trials === 0 ? 0 : passCount / trials;
  return {
    sampleId,
    trials,
    passCount,
    failCount: trials - passCount,
    errorCount: 0,
    passRate,
    passAtK,
    scores: {},
    wilsonCI: makeCI(passRate),
  };
}

function makeMultiTrial(
  taskId: string,
  trials: number,
  samples: SampleTrialResult[],
  opts: { gitSha?: string; model?: string; taskVersion?: string } = {},
): MultiTrialResult {
  const meanPassRate =
    samples.length === 0 ? 0 : samples.reduce((a, s) => a + s.passRate, 0) / samples.length;
  return {
    schemaVersion: 1,
    runId: "run-1",
    taskId,
    taskVersion: opts.taskVersion ?? "1.0.0",
    gitSha: opts.gitSha,
    model: opts.model,
    trials,
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:00:05.000Z",
    summary: {
      total: samples.length,
      trials,
      meanPassRate,
      stddevPassRate: 0.05,
      passRateCI: makeCI(meanPassRate),
    },
    samples,
    rawRuns: [],
  };
}

function makeCell(model: string, configId: string, configLabel: string, passRate: number, trials = 100): MatrixCell {
  const passCount = Math.round(passRate * trials);
  const sample = makeSample("sample-1", passCount, trials, { 1: passRate });
  return {
    model,
    configId,
    configLabel,
    result: makeMultiTrial("task-1", trials, [sample], { model }),
  };
}

function makeMatrix(cells: MatrixCell[]): MatrixResult {
  const byRate = [...cells].sort((a, b) => a.result.summary.meanPassRate - b.result.summary.meanPassRate);
  const worst = byRate[0]!;
  const best = byRate[byRate.length - 1]!;
  const models = Array.from(new Set(cells.map((c) => c.model)));
  const configIds = Array.from(new Set(cells.map((c) => c.configId)));
  const configs = configIds.map((id) => {
    const c = cells.find((x) => x.configId === id)!;
    return { id, label: c.configLabel, overrides: {} };
  });
  return {
    schemaVersion: 1,
    runId: "run-matrix-1",
    taskId: "task-1",
    taskVersion: "1.0.0",
    gitSha: "abc123",
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:00:10.000Z",
    models,
    configs,
    cells,
    summary: {
      totalCells: cells.length,
      bestPassRate: {
        model: best.model,
        configId: best.configId,
        passRate: best.result.summary.meanPassRate,
      },
      worstPassRate: {
        model: worst.model,
        configId: worst.configId,
        passRate: worst.result.summary.meanPassRate,
      },
    },
  };
}

describe("ConsoleAggregateReporter", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function output(): string {
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  it("renders multi-trial summary with icons", async () => {
    const reporter = new ConsoleAggregateReporter();
    const result = makeMultiTrial("task-1", 10, [
      makeSample("sample-1", 10, 10, { 1: 1.0, 5: 1.0 }),
      makeSample("sample-2", 7, 10, { 1: 0.7, 5: 0.99 }),
      makeSample("sample-3", 0, 10, { 1: 0.0, 5: 0.0 }),
    ]);
    await reporter.onMultiTrialComplete(result);
    const out = output();
    expect(out).toContain("Multi-Trial: task-1");
    expect(out).toContain("10 trials");
    expect(out).toContain("✅");
    expect(out).toContain("⚠️");
    expect(out).toContain("❌");
    expect(out).toContain("sample-1");
    expect(out).toContain("100");
    expect(out).toContain("pass@1=1.00");
    expect(out).toContain("pass@5=0.99");
    expect(out).toContain("2/3 samples");
    expect(out).toContain("Duration:");
  });

  it("renders matrix table", async () => {
    const reporter = new ConsoleAggregateReporter();
    const matrix = makeMatrix([
      makeCell("gpt-4o", "default", "default", 0.85),
      makeCell("gpt-4o", "strict-prompt", "strict-prompt", 0.92),
      makeCell("claude-sonnet", "default", "default", 0.78),
      makeCell("claude-sonnet", "strict-prompt", "strict-prompt", 0.88),
    ]);
    await reporter.onMatrixComplete(matrix);
    const out = output();
    expect(out).toContain("Matrix: task-1");
    expect(out).toContain("2×2");
    expect(out).toContain("gpt-4o");
    expect(out).toContain("claude-sonnet");
    expect(out).toContain("default");
    expect(out).toContain("strict-prompt");
    expect(out).toContain("85.0%");
    expect(out).toContain("92.0%");
    expect(out).toContain("Best:");
    expect(out).toContain("Worst:");
  });

  it("handles single-cell matrix", async () => {
    const reporter = new ConsoleAggregateReporter();
    const matrix = makeMatrix([makeCell("gpt-4o", "default", "default", 0.7)]);
    await reporter.onMatrixComplete(matrix);
    const out = output();
    expect(out).toContain("1×1");
    expect(out).toContain("gpt-4o");
    expect(out).toContain("70.0%");
  });

  it("uses correct icons for pass rate thresholds", async () => {
    const reporter = new ConsoleAggregateReporter();
    const result = makeMultiTrial("task-x", 10, [
      makeSample("high", 9, 10),
      makeSample("mid", 5, 10),
      makeSample("low", 4, 10),
    ]);
    await reporter.onMultiTrialComplete(result);
    const lines = output().split("\n");
    const highLine = lines.find((l) => l.includes("high"))!;
    const midLine = lines.find((l) => l.includes("mid"))!;
    const lowLine = lines.find((l) => l.includes("low"))!;
    expect(highLine).toContain("✅");
    expect(midLine).toContain("⚠️");
    expect(lowLine).toContain("❌");
  });
});

describe("MarkdownReporter", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "md-reporter-"));
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("writes multi-trial markdown", async () => {
    const outPath = join(tmp, "multi.md");
    const reporter = new MarkdownReporter(outPath);
    const result = makeMultiTrial("task-1", 10, [
      makeSample("sample-1", 10, 10, { 1: 1.0, 5: 1.0, 10: 1.0 }),
      makeSample("sample-2", 7, 10, { 1: 0.7, 5: 0.99 }),
    ]);
    await reporter.onMultiTrialComplete(result);
    const md = readFileSync(outPath, "utf8");
    expect(md).toContain("## Multi-Trial: task-1");
    expect(md).toContain("**Trials:** 10");
    expect(md).toContain("Mean Pass Rate");
    expect(md).toContain("| Sample |");
    expect(md).toContain("sample-1");
    expect(md).toContain("100");
    expect(md).toContain("1.00");
    expect(md).toContain("sample-2");
  });

  it("writes matrix markdown with CI", async () => {
    const outPath = join(tmp, "matrix.md");
    const reporter = new MarkdownReporter(outPath);
    const matrix = makeMatrix([
      makeCell("gpt-4o", "default", "default", 0.85),
      makeCell("gpt-4o", "strict-prompt", "strict-prompt", 0.92),
      makeCell("claude-sonnet", "default", "default", 0.78),
      makeCell("claude-sonnet", "strict-prompt", "strict-prompt", 0.88),
    ]);
    await reporter.onMatrixComplete(matrix);
    const md = readFileSync(outPath, "utf8");
    expect(md).toContain("## Eval Matrix: task-1");
    expect(md).toContain("**Task:** task-1 v1.0.0");
    expect(md).toContain("**Trials per cell:** 10");
    expect(md).toContain("**Git SHA:** abc123");
    expect(md).toContain("| Model | default | strict-prompt |");
    expect(md).toContain("gpt-4o");
    expect(md).toContain("85.0%");
    expect(md).toContain("CI:");
    expect(md).toContain("### Best / Worst");
    expect(md).toContain("**Best:**");
    expect(md).toContain("**Worst:**");
  });

  it("includes per-sample details in collapsible sections", async () => {
    const outPath = join(tmp, "details.md");
    const reporter = new MarkdownReporter(outPath);
    const matrix = makeMatrix([
      makeCell("gpt-4o", "default", "default", 0.85),
      makeCell("gpt-4o", "strict-prompt", "strict-prompt", 0.92),
    ]);
    await reporter.onMatrixComplete(matrix);
    const md = readFileSync(outPath, "utf8");
    expect(md).toContain("<details>");
    expect(md).toContain("<summary>");
    expect(md).toContain("</details>");
    expect(md).toContain("gpt-4o × default");
    expect(md).toContain("| Sample | Pass Rate |");
  });

  it("uses dash for passAtK where k > trials", async () => {
    const outPath = join(tmp, "dash.md");
    const reporter = new MarkdownReporter(outPath);
    const result = makeMultiTrial("task-small", 3, [
      makeSample("s1", 2, 3, { 1: 0.67, 5: 0 }),
    ]);
    await reporter.onMultiTrialComplete(result);
    const md = readFileSync(outPath, "utf8");
    expect(md).toContain("—");
  });

  it("handles empty samples gracefully", async () => {
    const outPath = join(tmp, "empty.md");
    const reporter = new MarkdownReporter(outPath);
    const cell: MatrixCell = {
      model: "gpt-4o",
      configId: "default",
      configLabel: "default",
      result: makeMultiTrial("task-1", 0, [], { model: "gpt-4o" }),
    };
    const matrix = makeMatrix([cell]);
    await reporter.onMatrixComplete(matrix);
    const md = readFileSync(outPath, "utf8");
    expect(md).toContain("## Eval Matrix: task-1");
    // Should not throw and should contain the cell label
    expect(md).toContain("gpt-4o");
  });

  it("creates output directory if needed", async () => {
    const outPath = join(tmp, "nested", "deep", "output.md");
    const reporter = new MarkdownReporter(outPath);
    const result = makeMultiTrial("task-1", 1, [makeSample("s1", 1, 1, { 1: 1.0 })]);
    await reporter.onMultiTrialComplete(result);
    expect(existsSync(outPath)).toBe(true);
  });
});
