import {
  CIGateConfigSchema,
  type CIGateConfig,
  type CIGateResult,
  type MultiTrialResult,
  type RegressionResult,
} from "./types.js";

export class CIGate {
  private readonly config: CIGateConfig;

  constructor(config: CIGateConfig) {
    this.config = CIGateConfigSchema.parse(config);
  }

  evaluate(
    result: MultiTrialResult,
    regressions?: RegressionResult[],
    totalCostUsd?: number,
  ): CIGateResult {
    const reasons: string[] = [];
    let pass = true;

    if (this.config.passRateFloor !== undefined) {
      if (result.summary.meanPassRate < this.config.passRateFloor) {
        pass = false;
        reasons.push(
          `Pass rate ${(result.summary.meanPassRate * 100).toFixed(1)}% below floor ${(this.config.passRateFloor * 100).toFixed(1)}%`,
        );
      }
    }

    let regressionCount: number | undefined;
    if (regressions) {
      regressionCount = regressions.filter(
        (r) => r.significant && r.direction === "regressed",
      ).length;
    }

    if (this.config.maxRegressions !== undefined && regressions === undefined) {
      pass = false;
      reasons.push(
        "maxRegressions configured but regression data not provided",
      );
    }

    if (this.config.maxRegressions !== undefined && regressions) {
      const regCount = regressionCount ?? 0;
      if (regCount > this.config.maxRegressions) {
        pass = false;
        reasons.push(
          `${regCount} regression${regCount === 1 ? "" : "s"} exceed max ${this.config.maxRegressions}`,
        );
      }
    }

    if (this.config.maxCostUsd !== undefined && totalCostUsd === undefined) {
      pass = false;
      reasons.push("maxCostUsd configured but cost data not provided");
    }

    if (this.config.maxCostUsd !== undefined && totalCostUsd !== undefined) {
      if (!Number.isFinite(totalCostUsd) || totalCostUsd < 0) {
        pass = false;
        reasons.push("totalCostUsd is invalid (non-finite or negative)");
      } else if (totalCostUsd > this.config.maxCostUsd) {
        pass = false;
        reasons.push(
          `Cost $${totalCostUsd.toFixed(4)} exceeds max $${this.config.maxCostUsd.toFixed(4)}`,
        );
      }
    }

    if (pass && reasons.length === 0) {
      reasons.push("All gates passed");
    }

    const out: CIGateResult = {
      pass,
      reasons,
      passRate: result.summary.meanPassRate,
    };
    if (regressionCount !== undefined) out.regressionCount = regressionCount;
    if (totalCostUsd !== undefined && Number.isFinite(totalCostUsd) && totalCostUsd >= 0) {
      out.totalCostUsd = totalCostUsd;
    }
    return out;
  }

  exitCode(result: CIGateResult): number {
    return result.pass ? 0 : 1;
  }
}
