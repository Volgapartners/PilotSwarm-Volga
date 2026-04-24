import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  TrajectoryTaskSchema,
  TrajectorySampleSchema,
  ObservedTurnSchema,
  ObservedTrajectorySchema,
  TrajectoryCaseResultSchema,
  type TrajectorySample,
  type TrajectoryTask,
  type ObservedTrajectory,
} from "../src/types.js";
import { FakeMultiTurnDriver } from "../src/drivers/fake-multi-turn-driver.js";
import { gradeTrajectory } from "../src/graders/trajectory.js";
import { TrajectoryRunner, type TrajectoryReporter } from "../src/trajectory-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function sample(overrides: Partial<TrajectorySample> = {}): TrajectorySample {
  return TrajectorySampleSchema.parse({
    id: "s1",
    description: "test",
    turns: [
      {
        input: { prompt: "add 1+2" },
        expected: {
          toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, match: "subset" }],
        },
      },
      {
        input: { prompt: "multiply 3*4" },
        expected: {
          toolCalls: [{ name: "test_multiply", args: { a: 3, b: 4 }, match: "subset" }],
        },
      },
    ],
    timeoutMs: 1000,
    ...overrides,
  });
}

function observed(overrides: Partial<ObservedTrajectory> = {}): ObservedTrajectory {
  return {
    turns: [
      {
        toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }],
        response: "3",
        latencyMs: 10,
      },
      {
        toolCalls: [{ name: "test_multiply", args: { a: 3, b: 4 }, order: 0 }],
        response: "12",
        latencyMs: 10,
      },
    ],
    sessionId: "sess-1",
    totalLatencyMs: 20,
    ...overrides,
  };
}

describe("TrajectoryTask types", () => {
  it("validates a well-formed trajectory task", () => {
    const task: TrajectoryTask = {
      schemaVersion: 1,
      id: "t",
      name: "t",
      description: "d",
      version: "1.0.0",
      samples: [sample()],
    };
    expect(() => TrajectoryTaskSchema.parse(task)).not.toThrow();
  });

  it("rejects empty turns", () => {
    expect(() =>
      TrajectorySampleSchema.parse({
        id: "s",
        description: "d",
        turns: [],
      }),
    ).toThrow();
  });

  it("accepts optional expected / tools / tags", () => {
    const s = TrajectorySampleSchema.parse({
      id: "s",
      description: "d",
      turns: [{ input: { prompt: "p" }, expected: {} }],
    });
    expect(s.timeoutMs).toBe(120000);
    expect(s.expected).toBeUndefined();
  });
});

describe("FakeMultiTurnDriver", () => {
  it("returns scripted trajectory for known sample", async () => {
    const traj = observed({ sessionId: "abc" });
    const driver = new FakeMultiTurnDriver([{ sampleId: "s1", trajectory: traj }]);
    const result = await driver.runTrajectory(sample());
    expect(result.sessionId).toBe("abc");
    expect(result.turns).toHaveLength(2);
  });

  it("throws for unknown sample", async () => {
    const driver = new FakeMultiTurnDriver([]);
    await expect(driver.runTrajectory(sample())).rejects.toThrow(/unknown/i);
  });

  it("respects abort signal", async () => {
    const driver = new FakeMultiTurnDriver([
      { sampleId: "s1", trajectory: observed() },
    ]);
    const ac = new AbortController();
    ac.abort();
    await expect(
      driver.runTrajectory(sample(), { signal: ac.signal }),
    ).rejects.toThrow(/aborted/i);
  });
});

describe("gradeTrajectory", () => {
  it("scores each turn independently and prefixes with turn index", () => {
    const score = gradeTrajectory(observed(), sample());
    expect(score.turnScores).toHaveLength(2);
    for (const ts of score.turnScores) {
      for (const s of ts) {
        expect(s.name.startsWith("t")).toBe(true);
        expect(s.name).toMatch(/^t\d+\//);
      }
    }
    expect(score.turnScores.every((ts) => ts.every((s) => s.pass))).toBe(true);
  });

  it("scores context retention across turns (found)", () => {
    const s = sample({
      turns: [
        { input: { prompt: "context" }, expected: {} },
        { input: { prompt: "reference" }, expected: {} },
      ],
      expected: {
        contextRetention: [{ term: "Osaka", mustAppearAfterTurn: 0 }],
      },
    });
    const obs: ObservedTrajectory = {
      turns: [
        { toolCalls: [], response: "ok Osaka", latencyMs: 1 },
        { toolCalls: [], response: "still Osaka", latencyMs: 1 },
      ],
      sessionId: "x",
      totalLatencyMs: 2,
    };
    const score = gradeTrajectory(obs, s);
    expect(score.crossTurnScores).toHaveLength(1);
    expect(score.crossTurnScores[0].pass).toBe(true);
    expect(score.crossTurnScores[0].name).toBe("context-retention/Osaka");
  });

  it("fails context retention when term missing", () => {
    const s = sample({
      turns: [
        { input: { prompt: "p1" }, expected: {} },
        { input: { prompt: "p2" }, expected: {} },
      ],
      expected: {
        contextRetention: [{ term: "Osaka", mustAppearAfterTurn: 0 }],
      },
    });
    const obs: ObservedTrajectory = {
      turns: [
        { toolCalls: [], response: "hello", latencyMs: 1 },
        { toolCalls: [], response: "world", latencyMs: 1 },
      ],
      sessionId: "x",
      totalLatencyMs: 2,
    };
    const score = gradeTrajectory(obs, s);
    expect(score.crossTurnScores[0].pass).toBe(false);
  });

  it("scores goal completion", () => {
    const s = sample({ expected: { goalCompleted: true } });
    const score = gradeTrajectory(observed(), s);
    const goal = score.holisticScores.find((x) => x.name === "goal-completed");
    expect(goal).toBeDefined();
    expect(goal!.pass).toBe(true);
  });

  it("scores call budget within limit", () => {
    const s = sample({ expected: { maxTotalToolCalls: 5 } });
    const score = gradeTrajectory(observed(), s);
    const budget = score.holisticScores.find((x) => x.name === "call-budget");
    expect(budget).toBeDefined();
    expect(budget!.pass).toBe(true);
  });

  it("scores call budget exceeding limit", () => {
    const s = sample({ expected: { maxTotalToolCalls: 1 } });
    const score = gradeTrajectory(observed(), s);
    const budget = score.holisticScores.find((x) => x.name === "call-budget");
    expect(budget!.pass).toBe(false);
  });

  it("handles missing observed turns", () => {
    const obs: ObservedTrajectory = {
      turns: [
        { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }], response: "3", latencyMs: 1 },
      ],
      sessionId: "x",
      totalLatencyMs: 1,
    };
    const score = gradeTrajectory(obs, sample());
    expect(score.turnScores).toHaveLength(2);
    expect(score.turnScores[1].some((s) => s.name === "t2/missing")).toBe(true);
    expect(score.turnScores[1].every((s) => !s.pass)).toBe(true);
  });

  it("handles more observed turns than expected (extras fail turn-count)", () => {
    const obs = observed({
      turns: [
        ...observed().turns,
        { toolCalls: [], response: "extra", latencyMs: 1 },
      ],
      totalLatencyMs: 21,
    });
    const score = gradeTrajectory(obs, sample());
    expect(score.turnScores).toHaveLength(2);
    const turnCountScore = score.holisticScores.find((s) => s.name === "turn-count");
    expect(turnCountScore).toBeDefined();
    expect(turnCountScore!.pass).toBe(false);
  });

  it("fails when observed has extra turns beyond expected", () => {
    const observed: ObservedTrajectory = {
      turns: [
        { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }], response: "3", latencyMs: 50 },
        { toolCalls: [], response: "extra turn 1", latencyMs: 50 },
        { toolCalls: [], response: "extra turn 2", latencyMs: 50 },
      ],
      sessionId: "s1",
      totalLatencyMs: 150,
    };
    const sample = {
      id: "extra-turns-fail",
      description: "test",
      turns: [
        { input: { prompt: "add" }, expected: { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 } }] } },
      ],
      timeoutMs: 5000,
    };
    const score = gradeTrajectory(observed, sample as any);
    const turnCountScore = score.holisticScores.find((s) => s.name === "turn-count");
    expect(turnCountScore).toBeDefined();
    expect(turnCountScore!.pass).toBe(false);
    expect(turnCountScore!.reason).toContain("3");
    expect(turnCountScore!.reason).toContain("1");
  });

  it("passes turn-count when observed matches expected turn count", () => {
    const observed: ObservedTrajectory = {
      turns: [
        { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }], response: "3", latencyMs: 50 },
      ],
      sessionId: "s1",
      totalLatencyMs: 50,
    };
    const sample = {
      id: "exact-turns",
      description: "test",
      turns: [
        { input: { prompt: "add" }, expected: { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 } }] } },
      ],
      timeoutMs: 5000,
    };
    const score = gradeTrajectory(observed, sample as any);
    const turnCountScore = score.holisticScores.find((s) => s.name === "turn-count");
    expect(turnCountScore).toBeDefined();
    expect(turnCountScore!.pass).toBe(true);
  });
});

describe("TrajectoryRunner", () => {
  const task: TrajectoryTask = {
    schemaVersion: 1,
    id: "tt",
    name: "tt",
    description: "d",
    version: "1.0.0",
    samples: [sample()],
  };

  it("runs trajectory task and produces result", async () => {
    const driver = FakeMultiTurnDriver.fromMap({ s1: observed() });
    const runner = new TrajectoryRunner({ driver });
    const result = await runner.runTask(task);
    expect(result.schemaVersion).toBe(1);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].pass).toBe(true);
    expect(result.summary.passRate).toBe(1);
  });

  it("handles infra errors", async () => {
    const driver = new FakeMultiTurnDriver([]);
    const runner = new TrajectoryRunner({ driver });
    const result = await runner.runTask(task);
    expect(result.cases[0].pass).toBe(false);
    expect(result.cases[0].infraError).toMatch(/unknown/i);
    expect(result.summary.errored).toBe(1);
  });

  it("computes pass rate correctly with mixed results", async () => {
    const badObs: ObservedTrajectory = {
      turns: [
        { toolCalls: [{ name: "wrong", args: {}, order: 0 }], response: "no", latencyMs: 1 },
      ],
      sessionId: "x",
      totalLatencyMs: 1,
    };
    const driver = FakeMultiTurnDriver.fromMap({ s1: observed(), s2: badObs });
    const runner = new TrajectoryRunner({ driver });
    const mixedTask: TrajectoryTask = {
      ...task,
      samples: [sample(), sample({ id: "s2" })],
    };
    const result = await runner.runTask(mixedTask);
    expect(result.summary.total).toBe(2);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.passRate).toBe(0.5);
  });

  it("forwards events to reporters", async () => {
    const events: string[] = [];
    const reporter: TrajectoryReporter = {
      onRunStart: () => void events.push("start"),
      onCaseResult: () => void events.push("case"),
      onRunComplete: () => void events.push("complete"),
    };
    const driver = FakeMultiTurnDriver.fromMap({ s1: observed() });
    const runner = new TrajectoryRunner({ driver, reporters: [reporter] });
    await runner.runTask(task);
    expect(events).toEqual(["start", "case", "complete"]);
  });
});

describe("v4 review fixes", () => {
  it("fails context retention when term appears only at boundary turn", () => {
    const observed: ObservedTrajectory = {
      turns: [
        { toolCalls: [], response: "Osaka is great", latencyMs: 50 },
        { toolCalls: [], response: "Sure thing", latencyMs: 50 },
      ],
      sessionId: "s1",
      totalLatencyMs: 100,
    };
    const sampleCase = {
      id: "cr-boundary",
      description: "test",
      turns: [
        { input: { prompt: "Tell me about Osaka" }, expected: {} },
        { input: { prompt: "What did I ask about?" }, expected: {} },
      ],
      expected: {
        contextRetention: [{ term: "Osaka", mustAppearAfterTurn: 0 }],
      },
      timeoutMs: 5000,
    };
    const score = gradeTrajectory(observed, sampleCase as any);
    const crScore = score.crossTurnScores.find((s) => s.name.includes("Osaka"));
    expect(crScore).toBeDefined();
    expect(crScore!.pass).toBe(false);
  });

  it("fails when goalCompleted is false but all turns pass", () => {
    const observed: ObservedTrajectory = {
      turns: [
        {
          toolCalls: [{ name: "test_add", args: { a: 1, b: 2 }, order: 0 }],
          response: "3",
          latencyMs: 50,
        },
      ],
      sessionId: "s1",
      totalLatencyMs: 50,
    };
    const sampleCase = {
      id: "goal-false",
      description: "test",
      turns: [
        {
          input: { prompt: "add" },
          expected: { toolCalls: [{ name: "test_add", args: { a: 1, b: 2 } }] },
        },
      ],
      expected: { goalCompleted: false },
      timeoutMs: 5000,
    };
    const score = gradeTrajectory(observed, sampleCase as any);
    const goalScore = score.holisticScores.find((s) => s.name === "goal-completed");
    expect(goalScore).toBeDefined();
    expect(goalScore!.pass).toBe(false);
  });

  it("rejects Infinity in ObservedTurn latencyMs", () => {
    const result = ObservedTurnSchema.safeParse({
      toolCalls: [],
      response: "ok",
      latencyMs: Infinity,
    });
    expect(result.success).toBe(false);
  });

  it("rejects Infinity in ObservedTrajectory totalLatencyMs", () => {
    const result = ObservedTrajectorySchema.safeParse({
      turns: [],
      sessionId: "s1",
      totalLatencyMs: Infinity,
    });
    expect(result.success).toBe(false);
  });

  it("rejects Infinity in TrajectoryCaseResult durationMs", () => {
    const result = TrajectoryCaseResultSchema.safeParse({
      caseId: "c1",
      pass: true,
      trajectoryScore: { turnScores: [], crossTurnScores: [], holisticScores: [] },
      observed: { turns: [], sessionId: "s1", totalLatencyMs: 0 },
      durationMs: Infinity,
    });
    expect(result.success).toBe(false);
  });
});

describe("multi-turn fixtures", () => {
  const path = resolve(__dirname, "../datasets/multi-turn-scenarios.v1.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));

  it("loads multi-turn-scenarios.v1.json", () => {
    expect(() => TrajectoryTaskSchema.parse(raw)).not.toThrow();
  });

  it("all samples have valid trajectory schema", () => {
    const task = TrajectoryTaskSchema.parse(raw);
    expect(task.samples.length).toBeGreaterThanOrEqual(6);
    for (const s of task.samples) {
      expect(s.turns.length).toBeGreaterThanOrEqual(1);
      expect(s.id.startsWith("multi-turn.")).toBe(true);
    }
  });
});
