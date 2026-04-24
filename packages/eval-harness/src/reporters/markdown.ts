import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  MultiTrialResult,
  MatrixResult,
  MatrixCell,
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

function multiTrialMarkdown(result: MultiTrialResult): string {
  const lines: string[] = [];
  const { taskId, trials, summary, samples } = result;
  lines.push(`## Multi-Trial: ${taskId}`);
  lines.push("");
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
  const { taskId, taskVersion, gitSha, models, configs, cells, summary } = result;
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
      const cell = cells.find((c) => c.model === m && c.configId === cfg.id);
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
  const best = findCell(cells, summary.bestPassRate.model, summary.bestPassRate.configId);
  const worst = findCell(cells, summary.worstPassRate.model, summary.worstPassRate.configId);
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

  lines.push(`### Per-Sample Breakdown`);
  lines.push("");
  for (const cell of cells) {
    const cellRate = pct(cell.result.summary.meanPassRate);
    lines.push("<details>");
    lines.push(`<summary>${cell.model} × ${cell.configLabel} (${cellRate}%)</summary>`);
    lines.push("");
    const ks = collectKs(cell.result.samples);
    const subHeader = ["Sample", "Pass Rate", ...ks.map((k) => `pass@${k}`)];
    lines.push(`| ${subHeader.join(" | ")} |`);
    lines.push(`|${subHeader.map(() => "---").join("|")}|`);
    if (cell.result.samples.length === 0) {
      lines.push(`| — | — |`);
    }
    for (const s of cell.result.samples) {
      const rateCell = `${pct(s.passRate)}% (${s.passCount}/${s.trials})`;
      const kCells = ks.map((k) => formatPassAtKCell(s, k));
      lines.push(`| ${s.sampleId} | ${rateCell} | ${kCells.join(" | ")} |`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}

function findCell(cells: MatrixCell[], model: string, configId: string): MatrixCell | undefined {
  return cells.find((c) => c.model === model && c.configId === configId);
}

export class MarkdownReporter implements AggregateReporter {
  constructor(private outputPath: string) {}

  onMultiTrialComplete(result: MultiTrialResult): void {
    mkdirSync(dirname(this.outputPath), { recursive: true });
    writeFileSync(this.outputPath, multiTrialMarkdown(result), "utf8");
  }

  onMatrixComplete(result: MatrixResult): void {
    mkdirSync(dirname(this.outputPath), { recursive: true });
    writeFileSync(this.outputPath, matrixMarkdown(result), "utf8");
  }
}
