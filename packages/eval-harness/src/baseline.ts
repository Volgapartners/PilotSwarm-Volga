import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  BaselineSchema,
  type Baseline,
  type MultiTrialResult,
} from "./types.js";

export function saveBaseline(
  result: MultiTrialResult,
  filePath: string,
): void {
  const baseline: Baseline = {
    schemaVersion: 1,
    taskId: result.taskId,
    taskVersion: result.taskVersion,
    ...(result.model !== undefined ? { model: result.model } : {}),
    createdAt: new Date().toISOString(),
    samples: result.samples.map((s) => ({
      sampleId: s.sampleId,
      passRate: s.passRate,
      trials: s.trials,
      passCount: s.passCount,
    })),
  };
  BaselineSchema.parse(baseline);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(baseline, null, 2), "utf8");
}

export function loadBaseline(filePath: string): Baseline {
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `loadBaseline: file at ${filePath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  return BaselineSchema.parse(parsed);
}
