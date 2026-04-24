import { standardNormalCdf } from "./stats.js";
import type {
  Baseline,
  MultiTrialResult,
  RegressionResult,
} from "./types.js";

function proportionZTest(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
): { pValue: number; z: number } {
  if (n1 <= 0 || n2 <= 0) return { pValue: 1, z: 0 };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pPooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / n1 + 1 / n2));
  if (se === 0 || !Number.isFinite(se)) return { pValue: 1, z: 0 };
  const z = (p1 - p2) / se;
  const pValue = 2 * (1 - standardNormalCdf(Math.abs(z)));
  return { pValue, z };
}

export class RegressionDetector {
  constructor(private readonly alpha: number = 0.05) {
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      throw new Error(
        `RegressionDetector: alpha must be in [0, 1] (got ${alpha})`,
      );
    }
  }

  detect(baseline: Baseline, current: MultiTrialResult): RegressionResult[] {
    if (baseline.taskId !== current.taskId) {
      throw new Error(
        `RegressionDetector: baseline taskId "${baseline.taskId}" does not match current taskId "${current.taskId}"`,
      );
    }
    const results: RegressionResult[] = [];

    for (const currentSample of current.samples) {
      const baselineSample = baseline.samples.find(
        (b) => b.sampleId === currentSample.sampleId,
      );
      if (!baselineSample) continue;

      const basePassRate = baselineSample.passRate;
      const currPassRate = currentSample.passRate;

      // Always use two-proportion z-test. The baseline format stores
      // aggregate passCount/trials only — not per-trial outcomes — so
      // McNemar's test (which requires real paired data) cannot be applied
      // without fabricating a pairing, which produces false positives.
      const zResult = proportionZTest(
        baselineSample.passCount,
        baselineSample.trials,
        currentSample.passCount,
        currentSample.trials,
      );
      const pValue = zResult.pValue;

      const significant = pValue < this.alpha;
      const rawDirection: "improved" | "regressed" | "unchanged" =
        currPassRate > basePassRate
          ? "improved"
          : currPassRate < basePassRate
            ? "regressed"
            : "unchanged";
      const direction = significant ? rawDirection : "unchanged";

      results.push({
        sampleId: currentSample.sampleId,
        baselinePassRate: basePassRate,
        currentPassRate: currPassRate,
        pValue,
        significant,
        direction,
      });
    }

    return results;
  }
}
