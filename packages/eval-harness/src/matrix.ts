import { randomUUID } from "node:crypto";
import { MultiTrialRunner } from "./multi-trial.js";
import type { Driver } from "./drivers/types.js";
import type {
  EvalTask,
  MatrixCell,
  MatrixConfig,
  MatrixConfigOverrides,
  MatrixPassRateRefSchema,
  MatrixResult,
  MatrixSummary,
} from "./types.js";
import type { z } from "zod";

type MatrixPassRateRef = z.infer<typeof MatrixPassRateRefSchema>;

export interface MatrixRunnerOptions {
  driverFactory: () => Driver;
  models: string[];
  configs: MatrixConfig[];
  trials: number;
  passAtKValues?: number[];
  // V2: scores always use exclude policy. Zero-fill deferred to V3.
  gitSha?: string;
}

export class MatrixRunner {
  private driverFactory: () => Driver;
  private models: string[];
  private configs: MatrixConfig[];
  private trials: number;
  private passAtKValues?: number[];
  private gitSha?: string;

  constructor(options: MatrixRunnerOptions) {
    if (!Array.isArray(options.models) || options.models.length === 0) {
      throw new Error("MatrixRunner: models must be a non-empty array");
    }
    if (!Array.isArray(options.configs) || options.configs.length === 0) {
      throw new Error("MatrixRunner: configs must be a non-empty array");
    }
    const uniqueModels = new Set(options.models);
    if (uniqueModels.size !== options.models.length) {
      throw new Error("MatrixRunner: duplicate model names");
    }
    const uniqueConfigIds = new Set(options.configs.map((c) => c.id));
    if (uniqueConfigIds.size !== options.configs.length) {
      throw new Error("MatrixRunner: duplicate config IDs");
    }
    if (!Number.isInteger(options.trials) || options.trials < 1) {
      throw new Error(
        `MatrixRunner: trials must be an integer >= 1 (got ${options.trials})`,
      );
    }
    this.driverFactory = options.driverFactory;
    this.models = options.models;
    this.configs = options.configs;
    this.trials = options.trials;
    this.passAtKValues = options.passAtKValues;
    this.gitSha = options.gitSha;
  }

  async runTask(task: EvalTask): Promise<MatrixResult> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();

    const cells: MatrixCell[] = [];
    for (const model of this.models) {
      for (const config of this.configs) {
        const overriddenTask = applyOverrides(task, config.overrides);
        const inner = new MultiTrialRunner({
          driverFactory: this.driverFactory,
          trials: this.trials,
          passAtKValues: this.passAtKValues,
          gitSha: this.gitSha,
          model,
        });
        const result = await inner.runTask(overriddenTask);
        cells.push({
          model,
          configId: config.id,
          configLabel: config.label,
          result,
        });
      }
    }

    const summary = computeSummary(cells);
    const finishedAt = new Date().toISOString();

    return {
      schemaVersion: 1,
      runId,
      taskId: task.id,
      taskVersion: task.version,
      gitSha: this.gitSha,
      startedAt,
      finishedAt,
      models: [...this.models],
      configs: this.configs.map((c) => ({ ...c, overrides: { ...c.overrides } })),
      cells,
      summary,
    };
  }
}

function applyOverrides(
  task: EvalTask,
  overrides: MatrixConfigOverrides,
): EvalTask {
  const cloned = structuredClone(task);
  for (const sample of cloned.samples) {
    if (overrides.systemMessage !== undefined) {
      sample.input.systemMessage = overrides.systemMessage;
    }
    if (overrides.timeoutMs !== undefined) {
      sample.timeoutMs = overrides.timeoutMs;
    }
  }
  return cloned;
}

function computeSummary(cells: MatrixCell[]): MatrixSummary {
  if (cells.length === 0) {
    throw new Error("MatrixRunner: cannot compute summary with zero cells");
  }

  let best: MatrixPassRateRef = {
    model: cells[0]!.model,
    configId: cells[0]!.configId,
    passRate: cells[0]!.result.summary.meanPassRate,
  };
  let worst: MatrixPassRateRef = { ...best };

  for (let i = 1; i < cells.length; i++) {
    const cell = cells[i]!;
    const rate = cell.result.summary.meanPassRate;
    if (rate > best.passRate) {
      best = { model: cell.model, configId: cell.configId, passRate: rate };
    }
    if (rate < worst.passRate) {
      worst = { model: cell.model, configId: cell.configId, passRate: rate };
    }
  }

  return {
    totalCells: cells.length,
    bestPassRate: best,
    worstPassRate: worst,
  };
}
