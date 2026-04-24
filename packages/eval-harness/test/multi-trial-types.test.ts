import { describe, it, expect } from "vitest";
import {
  SampleTrialResultSchema,
  MultiTrialSummarySchema,
  MultiTrialResultSchema,
  MatrixConfigOverridesSchema,
  MatrixConfigSchema,
  MatrixCellSchema,
  MatrixResultSchema,
  MissingScorePolicySchema,
  type SampleTrialResult,
  type MultiTrialResult,
  type MatrixConfig,
  type MatrixCell,
  type MatrixResult,
  type MissingScorePolicy,
} from "../src/types.js";

function makeObservedResult() {
  return {
    toolCalls: [],
    finalResponse: "ok",
    sessionId: "sess-1",
    latencyMs: 10,
  };
}

function makeCaseResult(id = "c1", pass = true) {
  return {
    caseId: id,
    pass,
    scores: [],
    observed: makeObservedResult(),
    durationMs: 5,
  };
}

function makeRunResult(runId = "run-1"): unknown {
  return {
    schemaVersion: 1,
    runId,
    taskId: "task-x",
    taskVersion: "1.0.0",
    startedAt: "2025-01-01T00:00:00Z",
    finishedAt: "2025-01-01T00:00:05Z",
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      passRate: 1,
    },
    cases: [makeCaseResult()],
  };
}

function makeSampleTrialResult(overrides: Partial<SampleTrialResult> = {}): unknown {
  return {
    sampleId: "s1",
    trials: 5,
    passCount: 4,
    failCount: 1,
    errorCount: 0,
    passRate: 0.8,
    passAtK: { 1: 0.8, 5: 1.0 },
    scores: {
      toolMatch: {
        mean: 0.9,
        stddev: 0.1,
        n: 5,
        values: [1, 1, 1, 1, 0.5],
      },
    },
    wilsonCI: { lower: 0.3, upper: 0.98, point: 0.8, z: 1.959964 },
    ...overrides,
  };
}

function makeMultiTrialResult(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    runId: "mt-1",
    taskId: "task-x",
    taskVersion: "1.0.0",
    trials: 5,
    startedAt: "2025-01-01T00:00:00Z",
    finishedAt: "2025-01-01T00:00:10Z",
    summary: {
      total: 1,
      trials: 5,
      meanPassRate: 0.8,
      stddevPassRate: 0,
      passRateCI: { lower: 0.3, upper: 0.98, point: 0.8, z: 1.959964 },
    },
    samples: [makeSampleTrialResult()],
    rawRuns: [makeRunResult()],
    ...overrides,
  };
}

describe("SampleTrialResult", () => {
  it("validates a well-formed sample trial result", () => {
    const parsed = SampleTrialResultSchema.parse(makeSampleTrialResult());
    expect(parsed.sampleId).toBe("s1");
    expect(parsed.passAtK[1]).toBe(0.8);
    expect(parsed.scores.toolMatch!.values).toHaveLength(5);
  });

  it("rejects missing sampleId", () => {
    const bad = makeSampleTrialResult();
    delete (bad as Record<string, unknown>).sampleId;
    expect(() => SampleTrialResultSchema.parse(bad)).toThrow();
  });

  it("accepts empty scores record", () => {
    const parsed = SampleTrialResultSchema.parse(
      makeSampleTrialResult({ scores: {} }),
    );
    expect(parsed.scores).toEqual({});
  });

  it("accepts empty passAtK record", () => {
    const parsed = SampleTrialResultSchema.parse(
      makeSampleTrialResult({ passAtK: {} }),
    );
    expect(parsed.passAtK).toEqual({});
  });

  it("validates passAtK as Record<number, number>", () => {
    const parsed = SampleTrialResultSchema.parse(
      makeSampleTrialResult({ passAtK: { 1: 0.5, 3: 0.75, 10: 0.99 } }),
    );
    expect(parsed.passAtK[10]).toBe(0.99);
  });

  it("rejects invalid score structure (missing values array)", () => {
    const bad = makeSampleTrialResult({
      scores: {
        broken: { mean: 1, stddev: 0, n: 1 } as unknown as SampleTrialResult["scores"][string],
      },
    });
    expect(() => SampleTrialResultSchema.parse(bad)).toThrow();
  });
});

describe("MultiTrialSummary", () => {
  it("validates summary fields", () => {
    const parsed = MultiTrialSummarySchema.parse({
      total: 10,
      trials: 5,
      meanPassRate: 0.7,
      stddevPassRate: 0.1,
      passRateCI: { lower: 0.5, upper: 0.85, point: 0.7, z: 1.959964 },
    });
    expect(parsed.trials).toBe(5);
  });
});

describe("MultiTrialResult", () => {
  it("validates a complete multi-trial result", () => {
    const parsed = MultiTrialResultSchema.parse(makeMultiTrialResult());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.samples).toHaveLength(1);
    expect(parsed.rawRuns).toHaveLength(1);
  });

  it("requires rawRuns array", () => {
    const bad = makeMultiTrialResult();
    delete (bad as Record<string, unknown>).rawRuns;
    expect(() => MultiTrialResultSchema.parse(bad)).toThrow();
  });

  it("accepts empty samples array", () => {
    const parsed = MultiTrialResultSchema.parse(
      makeMultiTrialResult({ samples: [] }),
    );
    expect(parsed.samples).toEqual([]);
  });

  it("rejects missing trials field", () => {
    const bad = makeMultiTrialResult();
    delete (bad as Record<string, unknown>).trials;
    expect(() => MultiTrialResultSchema.parse(bad)).toThrow();
  });

  it("accepts optional gitSha and model", () => {
    const parsed = MultiTrialResultSchema.parse(
      makeMultiTrialResult({ gitSha: "abc123", model: "gpt-4" }),
    );
    expect(parsed.gitSha).toBe("abc123");
    expect(parsed.model).toBe("gpt-4");
  });
});

describe("MatrixConfigOverrides", () => {
  it("validates empty overrides", () => {
    expect(MatrixConfigOverridesSchema.parse({})).toEqual({});
  });

  it("validates systemMessage and timeoutMs", () => {
    const parsed = MatrixConfigOverridesSchema.parse({
      systemMessage: "be terse",
      timeoutMs: 30000,
    });
    expect(parsed.timeoutMs).toBe(30000);
  });
});

describe("MatrixConfig", () => {
  it("validates config with overrides", () => {
    const parsed = MatrixConfigSchema.parse({
      id: "c-terse",
      label: "Terse",
      overrides: { systemMessage: "be terse" },
    });
    expect(parsed.id).toBe("c-terse");
  });

  it("validates config with empty overrides", () => {
    const parsed = MatrixConfigSchema.parse({
      id: "default",
      label: "Default",
      overrides: {},
    });
    expect(parsed.overrides).toEqual({});
  });

  it("rejects missing id", () => {
    expect(() =>
      MatrixConfigSchema.parse({ label: "X", overrides: {} }),
    ).toThrow();
  });
});

describe("MatrixCell", () => {
  it("validates a cell with full result", () => {
    const cell: unknown = {
      model: "gpt-4",
      configId: "default",
      configLabel: "Default",
      result: makeMultiTrialResult(),
    };
    const parsed = MatrixCellSchema.parse(cell);
    expect(parsed.model).toBe("gpt-4");
    expect(parsed.result.trials).toBe(5);
  });
});

describe("MatrixResult", () => {
  const baseMatrix: unknown = {
    schemaVersion: 1,
    runId: "matrix-1",
    taskId: "task-x",
    taskVersion: "1.0.0",
    startedAt: "2025-01-01T00:00:00Z",
    finishedAt: "2025-01-01T00:01:00Z",
    models: ["gpt-4", "gpt-4o"],
    configs: [
      { id: "default", label: "Default", overrides: {} },
      { id: "terse", label: "Terse", overrides: { systemMessage: "be terse" } },
    ],
    cells: [
      {
        model: "gpt-4",
        configId: "default",
        configLabel: "Default",
        result: makeMultiTrialResult(),
      },
    ],
    summary: {
      totalCells: 1,
      bestPassRate: { model: "gpt-4", configId: "default", passRate: 0.8 },
      worstPassRate: { model: "gpt-4", configId: "default", passRate: 0.8 },
    },
  };

  it("validates a complete matrix result", () => {
    const parsed = MatrixResultSchema.parse(baseMatrix);
    expect(parsed.cells).toHaveLength(1);
    expect(parsed.models).toEqual(["gpt-4", "gpt-4o"]);
  });

  it("validates matrix with single cell", () => {
    const parsed = MatrixResultSchema.parse(baseMatrix);
    expect(parsed.summary.totalCells).toBe(1);
  });

  it("rejects missing models array", () => {
    const bad = { ...(baseMatrix as object) } as Record<string, unknown>;
    delete bad.models;
    expect(() => MatrixResultSchema.parse(bad)).toThrow();
  });

  it("validates summary bestPassRate/worstPassRate", () => {
    const parsed = MatrixResultSchema.parse(baseMatrix);
    expect(parsed.summary.bestPassRate.passRate).toBe(0.8);
    expect(parsed.summary.worstPassRate.model).toBe("gpt-4");
  });

  it("accepts empty cells array", () => {
    const parsed = MatrixResultSchema.parse({
      ...(baseMatrix as object),
      cells: [],
      summary: {
        totalCells: 0,
        bestPassRate: { model: "", configId: "", passRate: 0 },
        worstPassRate: { model: "", configId: "", passRate: 0 },
      },
    });
    expect(parsed.cells).toEqual([]);
  });
});

describe("MissingScorePolicy", () => {
  it("accepts 'exclude' and 'zero'", () => {
    expect(MissingScorePolicySchema.parse("exclude")).toBe("exclude");
    expect(MissingScorePolicySchema.parse("zero")).toBe("zero");
  });

  it("rejects other values", () => {
    expect(() => MissingScorePolicySchema.parse("other")).toThrow();
  });

  it("type is assignable", () => {
    const p: MissingScorePolicy = "exclude";
    expect(p).toBe("exclude");
  });
});
