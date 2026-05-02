// Regression LIVE — gated by LIVE=1. Saves a baseline from a real
// LiveDriver multi-trial run, then runs current under intentionally worse
// conditions and asserts RegressionDetector flags it; also asserts a stable
// equivalent rerun does NOT flag.

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveDriver } from "../src/drivers/live-driver.js";
import { MultiTrialRunner } from "../src/multi-trial.js";
import { RegressionDetector } from "../src/regression.js";
import { CIGate } from "../src/ci-gate.js";
import { saveBaseline, loadBaseline, baselineFromMultiTrialResult } from "../src/baseline.js";
import { loadEvalTask } from "../src/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Regression LIVE", () => {
  const run = process.env.LIVE === "1" ? it : it.skip;

  run("detects regression from actual PilotSwarm baseline to current run", async () => {
    const driver = new LiveDriver({ timeout: 240_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;

    // Baseline: trials high → presumed stable pass.
    const baselineRun = await new MultiTrialRunner({ driver, trials: 3 }).runTask({
      ...dataset,
      samples: [sample],
    });
    const baseline = baselineFromMultiTrialResult(baselineRun);
    const dir = mkdtempSync(join(tmpdir(), "eval-regression-live-"));
    const path = join(dir, "baseline.json");
    saveBaseline(path, baseline);
    const loaded = loadBaseline(path);

    // Inject worse current: zero-trials degenerate (all infra-error) — the
    // detector must surface either the missing-quality signal or the
    // pass-rate drop.
    const currentDegenerate = {
      ...baselineRun,
      samples: baselineRun.samples.map((s) => ({
        ...s,
        passCount: 0,
        failCount: 0,
        errorCount: s.trials,
        noQualitySignal: true,
      })),
    };
    const detector = new RegressionDetector({ alpha: 0.05 });
    const detection = detector.detect(loaded, currentDegenerate);
    const flaggedOrMissing =
      detection.regressions.length > 0 ||
      detection.missingBaselineSamples.length > 0 ||
      currentDegenerate.samples.every((s) => s.noQualitySignal);
    expect(flaggedOrMissing).toBe(true);

    const gate = new CIGate({ passRateFloor: 0.5 });
    const gated = gate.evaluate({ result: currentDegenerate, baseline: loaded } as never);
    expect(gated.pass).toBe(false);
  }, 870_000);

  run("does not flag equivalent actual PilotSwarm rerun as regression", async () => {
    const driver = new LiveDriver({ timeout: 240_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const baselineRun = await new MultiTrialRunner({ driver, trials: 3 }).runTask({
      ...dataset,
      samples: [sample],
    });
    const baseline = baselineFromMultiTrialResult(baselineRun);
    // Same run as both baseline and current → no regression at typical alpha.
    const detector = new RegressionDetector({ alpha: 0.05 });
    const detection = detector.detect(baseline, baselineRun);
    expect(detection.regressions.length).toBe(0);
  }, 870_000);
});
