import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import type {
  CIGateResult,
  MatrixCell,
  MatrixResult,
  MultiTrialResult,
  RegressionResult,
  SampleTrialResult,
} from "../types.js";
import type { AggregateReporter } from "./aggregate-types.js";

function pct(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  return (rate * 100).toFixed(1);
}

function collectKs(samples: SampleTrialResult[]): number[] {
  const set = new Set<number>();
  for (const s of samples) {
    for (const k of Object.keys(s.passAtK)) set.add(Number(k));
  }
  return [...set].filter((k) => Number.isFinite(k)).sort((a, b) => a - b);
}

function formatPassAtKCell(s: SampleTrialResult, k: number): string {
  if (k > s.trials) return "—";
  const v = s.passAtK[k];
  if (v === undefined) return "—";
  return v.toFixed(2);
}

function findCell(
  cells: MatrixCell[],
  model: string,
  configId: string,
): MatrixCell | undefined {
  return cells.find((c) => c.model === model && c.configId === configId);
}

function multiTrialMarkdown(result: MultiTrialResult): string {
  const lines: string[] = [];
  const { taskId, trials, summary, samples, model } = result;
  lines.push(`## Eval Results: ${taskId}`);
  lines.push("");
  lines.push(`**Task Version:** ${result.taskVersion}  `);
  if (model) lines.push(`**Model:** ${model}  `);
  lines.push(`**Trials:** ${trials}  `);
  lines.push(
    `**Mean Pass Rate:** ${pct(summary.meanPassRate)}% (CI: ${pct(summary.passRateCI.lower)}-${pct(summary.passRateCI.upper)}%)  `,
  );
  lines.push("");

  const ks = collectKs(samples);
  const header = ["Sample", "Pass Rate", ...ks.map((k) => `pass@${k}`)];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const s of samples) {
    const rateCell = `${pct(s.passRate)}% (${s.passCount}/${s.trials})`;
    const kCells = ks.map((k) => formatPassAtKCell(s, k));
    lines.push(`| ${s.sampleId} | ${rateCell} | ${kCells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function matrixMarkdown(result: MatrixResult): string {
  const lines: string[] = [];
  const { taskId, taskVersion, gitSha, models, configs, cells, summary } =
    result;
  const trials = cells[0]?.result.trials ?? 0;

  lines.push(`## Eval Matrix: ${taskId}`);
  lines.push("");
  lines.push(`**Task:** ${taskId} v${taskVersion}  `);
  lines.push(`**Trials per cell:** ${trials}  `);
  if (gitSha) lines.push(`**Git SHA:** ${gitSha}  `);
  lines.push("");

  lines.push(`### Pass Rates`);
  lines.push("");
  const header = ["Model", ...configs.map((c) => c.label)];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const m of models) {
    const row: string[] = [m];
    for (const cfg of configs) {
      const cell = findCell(cells, m, cfg.id);
      if (!cell) {
        row.push("—");
        continue;
      }
      const r = cell.result.summary.meanPassRate;
      const ci = cell.result.summary.passRateCI;
      row.push(`${pct(r)}% (CI: ${pct(ci.lower)}-${pct(ci.upper)}%)`);
    }
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");

  lines.push(`### Best / Worst`);
  lines.push("");
  const best = findCell(
    cells,
    summary.bestPassRate.model,
    summary.bestPassRate.configId,
  );
  const worst = findCell(
    cells,
    summary.worstPassRate.model,
    summary.worstPassRate.configId,
  );
  if (best) {
    lines.push(
      `- **Best:** ${best.model} × ${best.configLabel} — ${pct(summary.bestPassRate.passRate)}%`,
    );
  }
  if (worst) {
    lines.push(
      `- **Worst:** ${worst.model} × ${worst.configLabel} — ${pct(summary.worstPassRate.passRate)}%`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function gateResultMarkdown(
  gate: CIGateResult,
  regressions?: RegressionResult[],
): string {
  const lines: string[] = [];
  const badge = gate.pass ? "✅ **PASS**" : "❌ **FAIL**";
  lines.push(`## CI Gate: ${badge}`);
  lines.push("");

  if (gate.passRate !== undefined) {
    lines.push(`**Pass Rate:** ${pct(gate.passRate)}%  `);
  }
  if (gate.regressionCount !== undefined) {
    lines.push(`**Regressions:** ${gate.regressionCount}  `);
  }
  if (gate.totalCostUsd !== undefined) {
    lines.push(`**Total Cost:** $${gate.totalCostUsd.toFixed(4)}  `);
  }
  lines.push("");

  lines.push(`### Reasons`);
  lines.push("");
  for (const r of gate.reasons) {
    lines.push(`- ${r}`);
  }
  lines.push("");

  if (regressions && regressions.length > 0) {
    lines.push(`### Sample Comparison vs Baseline`);
    lines.push("");
    lines.push(
      `| Sample | Baseline | Current | Δ | p-value | Direction |`,
    );
    lines.push(`|---|---|---|---|---|---|`);
    for (const r of regressions) {
      const delta = (r.currentPassRate - r.baselinePassRate) * 100;
      const sign = delta >= 0 ? "+" : "";
      const dirLabel = r.significant
        ? r.direction
        : `${r.direction} (n.s.)`;
      lines.push(
        `| ${r.sampleId} | ${pct(r.baselinePassRate)}% | ${pct(r.currentPassRate)}% | ${sign}${delta.toFixed(1)}pp | ${r.pValue.toFixed(4)} | ${dirLabel} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export class PRCommentReporter implements AggregateReporter {
  private readonly outputPath: string;
  private wroteMainSection = false;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  private ensureDir(): void {
    mkdirSync(dirname(this.outputPath), { recursive: true });
  }

  private writeOrAppend(content: string): void {
    this.ensureDir();
    if (!existsSync(this.outputPath) || !this.wroteMainSection) {
      writeFileSync(this.outputPath, content, "utf8");
      this.wroteMainSection = true;
    } else {
      appendFileSync(this.outputPath, `\n${content}`, "utf8");
    }
  }

  onMultiTrialComplete(result: MultiTrialResult): void {
    this.writeOrAppend(multiTrialMarkdown(result));
  }

  onMatrixComplete(result: MatrixResult): void {
    this.writeOrAppend(matrixMarkdown(result));
  }

  writeGateResult(
    gate: CIGateResult,
    regressions?: RegressionResult[],
  ): void {
    this.ensureDir();
    const content = gateResultMarkdown(gate, regressions);
    if (!existsSync(this.outputPath)) {
      writeFileSync(this.outputPath, content, "utf8");
    } else {
      appendFileSync(this.outputPath, `\n${content}`, "utf8");
    }
    this.wroteMainSection = true;
  }
}
