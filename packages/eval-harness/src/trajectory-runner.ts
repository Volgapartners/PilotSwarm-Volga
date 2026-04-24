import { randomUUID } from "node:crypto";
import type { MultiTurnDriver } from "./drivers/multi-turn-types.js";
import type {
  TrajectoryTask,
  TrajectorySample,
  TrajectoryCaseResult,
  TrajectoryRunResult,
  TrajectoryScore,
  ObservedTrajectory,
} from "./types.js";
import { gradeTrajectory } from "./graders/trajectory.js";

export interface TrajectoryReporter {
  onRunStart?(task: TrajectoryTask, runId: string): void | Promise<void>;
  onCaseResult?(result: TrajectoryCaseResult): void | Promise<void>;
  onRunComplete?(result: TrajectoryRunResult): void | Promise<void>;
}

export interface TrajectoryRunnerOptions {
  driver: MultiTurnDriver;
  reporters?: TrajectoryReporter[];
  runId?: string;
  gitSha?: string;
  model?: string;
}

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function sanitizeId(id: string): string {
  if (!id) return "run";
  if (SAFE_ID_RE.test(id)) return id;
  const cleaned = id.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "run";
}

function allScoresPass(score: TrajectoryScore): boolean {
  const turnOk = score.turnScores.every((ts) => ts.every((s) => s.pass));
  const crossOk = score.crossTurnScores.every((s) => s.pass);
  const holisticOk = score.holisticScores.every((s) => s.pass);
  return turnOk && crossOk && holisticOk;
}

export class TrajectoryRunner {
  private driver: MultiTurnDriver;
  private reporters: TrajectoryReporter[];
  private fixedRunId?: string;
  private runId: string;
  private gitSha?: string;
  private model?: string;

  constructor(options: TrajectoryRunnerOptions) {
    this.driver = options.driver;
    this.reporters = options.reporters ?? [];
    this.fixedRunId = options.runId !== undefined ? sanitizeId(options.runId) : undefined;
    this.runId = this.fixedRunId ?? sanitizeId(randomUUID());
    this.gitSha = options.gitSha;
    this.model = options.model;
  }

  private async safeReporter<K extends keyof TrajectoryReporter>(
    method: K,
    ...args: Parameters<NonNullable<TrajectoryReporter[K]>>
  ): Promise<void> {
    for (const r of this.reporters) {
      const fn = r[method];
      if (typeof fn !== "function") continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ret = (fn as any).apply(r, args);
        if (ret && typeof (ret as Promise<unknown>).then === "function") {
          await ret;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[TrajectoryRunner] reporter ${String(method)} threw: ${msg}`);
      }
    }
  }

  async runTask(task: TrajectoryTask): Promise<TrajectoryRunResult> {
    this.runId = this.fixedRunId ?? sanitizeId(randomUUID());

    const startedAt = new Date().toISOString();
    await this.safeReporter("onRunStart", task, this.runId);

    const cases: TrajectoryCaseResult[] = [];
    for (const sample of task.samples) {
      const caseResult = await this.runCase(sample);
      cases.push(caseResult);
      await this.safeReporter("onCaseResult", caseResult);
    }

    const passed = cases.filter((c) => c.pass).length;
    const errored = cases.filter((c) => !!c.infraError).length;
    const failed = cases.filter((c) => !c.pass && !c.infraError).length;

    const result: TrajectoryRunResult = {
      schemaVersion: 1,
      runId: this.runId,
      taskId: task.id,
      taskVersion: task.version,
      gitSha: this.gitSha,
      model: this.model,
      startedAt,
      finishedAt: new Date().toISOString(),
      summary: {
        total: cases.length,
        passed,
        failed,
        errored,
        passRate: cases.length > 0 ? passed / cases.length : 0,
      },
      cases,
    };

    await this.safeReporter("onRunComplete", result);
    return result;
  }

  private async runCase(sample: TrajectorySample): Promise<TrajectoryCaseResult> {
    const start = Date.now();
    const timeoutMs = sample.timeoutMs;
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(
            new Error(`Driver timeout after ${timeoutMs}ms for sample "${sample.id}"`),
          );
        }, timeoutMs);
      });
      let observed: ObservedTrajectory;
      try {
        observed = await Promise.race([
          this.driver.runTrajectory(sample, {
            timeout: timeoutMs,
            signal: controller.signal,
            model: this.model,
          }),
          timeoutPromise,
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      let trajectoryScore: TrajectoryScore;
      try {
        trajectoryScore = gradeTrajectory(observed, sample);
      } catch (graderErr) {
        const msg = graderErr instanceof Error ? graderErr.message : String(graderErr);
        trajectoryScore = {
          turnScores: [
            [
              {
                name: "grader-error",
                value: 0,
                pass: false,
                reason: `grader threw: ${msg}`,
              },
            ],
          ],
          crossTurnScores: [],
          holisticScores: [],
        };
      }

      return {
        caseId: sample.id,
        pass: allScoresPass(trajectoryScore),
        trajectoryScore,
        observed,
        durationMs: Date.now() - start,
      };
    } catch (error: unknown) {
      if (!controller.signal.aborted) controller.abort();
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error && error.stack ? "\n" + error.stack : "";
      return {
        caseId: sample.id,
        pass: false,
        trajectoryScore: { turnScores: [], crossTurnScores: [], holisticScores: [] },
        observed: {
          turns: [],
          sessionId: "",
          totalLatencyMs: 0,
        },
        infraError: message + stack,
        durationMs: Date.now() - start,
      };
    }
  }

  checkPassRateFloor(result: TrajectoryRunResult, floor: number): boolean {
    return result.summary.passRate >= floor;
  }
}
