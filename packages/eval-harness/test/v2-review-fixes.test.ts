import { describe, it, expect } from "vitest";
import { MultiTrialRunner } from "../src/multi-trial.js";
import { MatrixRunner } from "../src/matrix.js";
import { FakeDriver } from "../src/drivers/fake-driver.js";
import { mannWhitneyU, bootstrapCI } from "../src/stats.js";
import { MultiTrialResultSchema } from "../src/types.js";
import type { Driver, DriverOptions } from "../src/drivers/types.js";
import type { EvalSample, EvalTask, ObservedResult } from "../src/types.js";
import type { Reporter } from "../src/reporters/types.js";

function makeTask(sampleIds: string[]): EvalTask {
  return {
    schemaVersion: 1,
    id: "test-task",
    name: "Test Task",
    description: "test",
    version: "1.0",
    samples: sampleIds.map((id) => ({
      id,
      description: `Sample ${id}`,
      input: { prompt: `Do ${id}` },
      expected: {
        toolCalls: [{ name: "add", args: { a: 1, b: 2 }, match: "subset" }],
        toolSequence: "unordered",
      },
      timeoutMs: 5000,
    })) as EvalSample[],
  };
}

function makeObserved(pass: boolean): ObservedResult {
  return {
    toolCalls: pass ? [{ name: "add", args: { a: 1, b: 2 }, order: 0 }] : [],
    finalResponse: pass ? "result" : "no tools",
    sessionId: "s1",
    latencyMs: 10,
  };
}

class SequentialFakeDriver implements Driver {
  private callIndex = 0;
  constructor(private responses: Array<ObservedResult | Error>) {}
  async run(_sample: EvalSample, _options?: DriverOptions): Promise<ObservedResult> {
    const r = this.responses[this.callIndex++ % this.responses.length]!;
    if (r instanceof Error) throw r;
    return structuredClone(r);
  }
}

// ---------------------------------------------------------------------------
// Fix 1: Reporter concurrency corruption
// ---------------------------------------------------------------------------
describe("Fix 1: reporter isolation under concurrency > 1", () => {
  it("does not corrupt stateful reporters when reporterFactory is provided", async () => {
    // Simulate a JsonlReporter-like stateful reporter that records its bound runId.
    class StatefulReporter implements Reporter {
      public boundRunId = "";
      public seen: string[] = [];
      onRunStart(_t: EvalTask, runId: string): void {
        this.boundRunId = runId;
      }
      onCaseResult(): void {
        this.seen.push(this.boundRunId);
      }
      onRunComplete(): void {}
    }
    const created: StatefulReporter[] = [];
    const factory = (): Reporter[] => {
      const r = new StatefulReporter();
      created.push(r);
      return [r];
    };

    class SlowDriver implements Driver {
      async run(): Promise<ObservedResult> {
        await new Promise((res) => setTimeout(res, 15));
        return makeObserved(true);
      }
    }
    const runner = new MultiTrialRunner({
      driverFactory: () => new SlowDriver(),
      trials: 4,
      concurrency: 4,
      reporterFactory: factory,
    });
    await runner.runTask(makeTask(["s1"]));

    expect(created.length).toBe(4);
    // Each reporter's "seen" entries must all match its own boundRunId.
    for (const r of created) {
      expect(r.seen.length).toBeGreaterThan(0);
      for (const id of r.seen) {
        expect(id).toBe(r.boundRunId);
      }
    }
    // And all bound runIds distinct.
    const ids = new Set(created.map((r) => r.boundRunId));
    expect(ids.size).toBe(4);
  });

  it("drops shared reporters under concurrency > 1 when no factory provided (warn once)", async () => {
    const calls: string[] = [];
    const reporter: Reporter = {
      onRunStart: (_t, id) => calls.push(`start:${id}`),
      onCaseResult: () => calls.push("case"),
      onRunComplete: () => calls.push("complete"),
    };
    const origWarn = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      const runner = new MultiTrialRunner({
        driverFactory: () =>
          new FakeDriver([{ sampleId: "s1", response: makeObserved(true) }]),
        trials: 3,
        concurrency: 2,
        reporters: [reporter],
      });
      await runner.runTask(makeTask(["s1"]));
    } finally {
      console.warn = origWarn;
    }
    // Reporter was NOT called (dropped under concurrency without factory).
    expect(calls.length).toBe(0);
    // Warning logged at least once.
    expect(warns.some((w) => /reporter/i.test(w))).toBe(true);
  });

  it("shares reporters safely when concurrency === 1", async () => {
    const starts: string[] = [];
    const reporter: Reporter = {
      onRunStart: (_t, id) => starts.push(id),
      onCaseResult: () => {},
      onRunComplete: () => {},
    };
    const runner = new MultiTrialRunner({
      driverFactory: () =>
        new FakeDriver([{ sampleId: "s1", response: makeObserved(true) }]),
      trials: 3,
      concurrency: 1,
      reporters: [reporter],
    });
    await runner.runTask(makeTask(["s1"]));
    expect(starts.length).toBe(3);
    expect(new Set(starts).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: passAtK excludes infra errors
// ---------------------------------------------------------------------------
describe("Fix 2: passAtK excludes infra errors", () => {
  it("1 pass + 9 infra errors → passAtK[1] = 1.0, passRate = 1.0", async () => {
    const seq: Array<ObservedResult | Error> = [
      makeObserved(true),
      ...Array.from({ length: 9 }, (_, i) => new Error(`boom-${i}`)),
    ];
    let idx = 0;
    const drivers = seq.map((r) => new SequentialFakeDriver([r]));
    const runner = new MultiTrialRunner({
      driverFactory: () => drivers[idx++]!,
      trials: 10,
    });
    const result = await runner.runTask(makeTask(["s1"]));
    const s1 = result.samples[0]!;
    expect(s1.passCount).toBe(1);
    expect(s1.errorCount).toBe(9);
    expect(s1.passRate).toBeCloseTo(1.0, 10);
    expect(s1.passAtK[1]).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: all-error run produces valid passRateCI (no NaN)
// ---------------------------------------------------------------------------
describe("Fix 3: all-error run has valid passRateCI", () => {
  it("produces non-NaN passRateCI and passes Zod validation", async () => {
    let idx = 0;
    const runner = new MultiTrialRunner({
      driverFactory: () => new SequentialFakeDriver([new Error(`e-${idx++}`)]),
      trials: 4,
    });
    const result = await runner.runTask(makeTask(["s1"]));

    expect(Number.isFinite(result.summary.passRateCI.point)).toBe(true);
    expect(result.summary.passRateCI.point).toBe(0);
    expect(result.summary.passRateCI.lower).toBe(0);
    expect(result.summary.passRateCI.upper).toBe(1);

    // Must pass full Zod validation.
    const parsed = MultiTrialResultSchema.safeParse(result);
    if (!parsed.success) {
      console.error(parsed.error);
    }
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 4: Mann-Whitney avoids exact path for large asymmetric samples
// ---------------------------------------------------------------------------
describe("Fix 4: mannWhitneyU asymmetric sizes use asymptotic path", () => {
  it("returns quickly for n1=5, n2=100 (no OOM from exact enumeration)", () => {
    const a = [1, 2, 3, 4, 5];
    const b = Array.from({ length: 100 }, (_, i) => i + 10);
    const t0 = Date.now();
    const r = mannWhitneyU(a, b);
    const elapsed = Date.now() - t0;

    // Asymptotic path returns a finite z; exact path would return NaN.
    expect(Number.isFinite(r.z)).toBe(true);
    expect(r.pValue).toBeLessThan(0.01);
    // Must be fast — exact enumeration of C(105,5) would be pathological.
    expect(elapsed).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Fix 6: MatrixRunner rejects duplicate IDs
// ---------------------------------------------------------------------------
describe("Fix 6: MatrixRunner validates uniqueness", () => {
  const baseOpts = {
    driverFactory: () =>
      new FakeDriver([{ sampleId: "s1", response: makeObserved(true) }]),
    trials: 1,
  };
  const cfg = { id: "a", label: "A", overrides: {} };

  it("throws on duplicate model names", () => {
    expect(
      () =>
        new MatrixRunner({
          ...baseOpts,
          models: ["gpt-4o", "gpt-4o"],
          configs: [cfg],
        }),
    ).toThrow(/duplicate/i);
  });

  it("throws on duplicate config IDs", () => {
    expect(
      () =>
        new MatrixRunner({
          ...baseOpts,
          models: ["gpt-4o"],
          configs: [
            { id: "a", label: "A", overrides: {} },
            { id: "a", label: "B", overrides: {} },
          ],
        }),
    ).toThrow(/duplicate/i);
  });

  it("accepts distinct IDs", () => {
    expect(
      () =>
        new MatrixRunner({
          ...baseOpts,
          models: ["gpt-4o", "gpt-4o-mini"],
          configs: [
            { id: "a", label: "A", overrides: {} },
            { id: "b", label: "B", overrides: {} },
          ],
        }),
    ).not.toThrow();
  });
});

describe("Fix 5: missingScorePolicy removed from public API", () => {
  it("MultiTrialRunnerOptions does not accept missingScorePolicy", () => {
    // @ts-expect-error — missingScorePolicy was removed from the options type
    const runner = new MultiTrialRunner({
      driverFactory: () => FakeDriver.fromMap({}),
      trials: 1,
      missingScorePolicy: "zero",
    });
    expect(runner).toBeDefined();
  });

  it("MissingScorePolicy is not exported from package index", async () => {
    const exports = await import("../src/index.js");
    expect("MissingScorePolicySchema" in exports).toBe(false);
    expect("MissingScorePolicy" in exports).toBe(false);
  });
});

describe("Fix 7: docs bootstrapCI signature matches implementation", () => {
  it("bootstrapCI accepts (values, alpha, reps, rng) signature", () => {
    const rng = () => 0.5;
    const result = bootstrapCI([1, 2, 3, 4, 5], 0.05, 100, rng);
    expect(result).toHaveProperty("lower");
    expect(result).toHaveProperty("upper");
    expect(result).toHaveProperty("point");
    expect(result).toHaveProperty("reps", 100);
    expect(result).toHaveProperty("alpha", 0.05);
  });
});
