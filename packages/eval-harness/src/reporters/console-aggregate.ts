import type { MultiTrialResult, MatrixResult, MatrixCell } from "../types.js";
import type { AggregateReporter } from "./aggregate-types.js";

function pct(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  return (rate * 100).toFixed(1);
}

function iconFor(rate: number): string {
  if (rate >= 0.9) return "✅";
  if (rate >= 0.5) return "⚠️";
  return "❌";
}

function formatPassAtK(passAtK: Record<number, number>): string {
  const keys = Object.keys(passAtK)
    .map((k) => Number(k))
    .filter((k) => Number.isFinite(k))
    .sort((a, b) => a - b);
  return keys.map((k) => `pass@${k}=${passAtK[k]!.toFixed(2)}`).join("  ");
}

function durationMs(startedAt: string, finishedAt: string): number | null {
  const s = Date.parse(startedAt);
  const f = Date.parse(finishedAt);
  if (Number.isNaN(s) || Number.isNaN(f)) return null;
  return f - s;
}

export class ConsoleAggregateReporter implements AggregateReporter {
  onMultiTrialComplete(result: MultiTrialResult): void {
    const { taskId, trials, summary, samples } = result;
    const meanPct = pct(summary.meanPassRate);
    const stdPct = pct(summary.stddevPassRate);
    const loPct = pct(summary.passRateCI.lower);
    const hiPct = pct(summary.passRateCI.upper);

    console.log(`━━━ Multi-Trial: ${taskId} (${trials} trials) ━━━`);
    console.log(
      `  Mean pass rate: ${meanPct}% (±${stdPct}%) CI: [${loPct}%, ${hiPct}%]`,
    );
    console.log(`  Samples:`);

    const maxIdLen = samples.reduce((m, s) => Math.max(m, s.sampleId.length), 0);
    let aboveHalf = 0;
    for (const s of samples) {
      if (s.passRate > 0.5) aboveHalf++;
      const icon = iconFor(s.passRate);
      const idPad = s.sampleId.padEnd(maxIdLen);
      const ratePct = pct(s.passRate).padStart(5);
      const counts = `(${s.passCount}/${s.trials})`;
      const kStr = formatPassAtK(s.passAtK);
      console.log(
        `    ${icon} ${idPad}: ${ratePct}% ${counts}  ${kStr}`.trimEnd(),
      );
    }

    console.log(
      `━━━ Results: ${aboveHalf}/${samples.length} samples >50% pass rate ━━━`,
    );
    const dur = durationMs(result.startedAt, result.finishedAt);
    if (dur !== null) console.log(`Duration: ${dur}ms`);
  }

  onMatrixComplete(result: MatrixResult): void {
    const { taskId, models, configs, cells, summary } = result;
    const trials = cells[0]?.result.trials ?? 0;

    console.log(
      `━━━ Matrix: ${taskId} (${models.length}×${configs.length}, ${trials} trials) ━━━`,
    );
    console.log("");

    const headerCols = ["Model / Config", ...configs.map((c) => c.label)];
    const rows: string[][] = [];
    for (const m of models) {
      const row: string[] = [m];
      for (const cfg of configs) {
        const cell = cells.find((c) => c.model === m && c.configId === cfg.id);
        row.push(cell ? `${pct(cell.result.summary.meanPassRate)}%` : "—");
      }
      rows.push(row);
    }

    const widths = headerCols.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
    );
    const pad = (val: string, i: number): string => val.padEnd(widths[i]!);
    const sep = widths.map((w) => "-".repeat(w)).map((s, i) => (i === 0 ? s : s));

    console.log(`| ${headerCols.map((h, i) => pad(h, i)).join(" | ")} |`);
    console.log(`|${sep.map((s) => `-${s}-`).join("|")}|`);
    for (const row of rows) {
      console.log(`| ${row.map((v, i) => pad(v, i)).join(" | ")} |`);
    }
    console.log("");

    const bestCell = findCell(cells, summary.bestPassRate.model, summary.bestPassRate.configId);
    const worstCell = findCell(cells, summary.worstPassRate.model, summary.worstPassRate.configId);
    if (bestCell) {
      console.log(
        `Best:  ${bestCell.model} × ${bestCell.configLabel} (${pct(summary.bestPassRate.passRate)}%)`,
      );
    }
    if (worstCell) {
      console.log(
        `Worst: ${worstCell.model} × ${worstCell.configLabel} (${pct(summary.worstPassRate.passRate)}%)`,
      );
    }

    const dur = durationMs(result.startedAt, result.finishedAt);
    if (dur !== null) console.log(`━━━ Duration: ${dur}ms ━━━`);
  }
}

function findCell(cells: MatrixCell[], model: string, configId: string): MatrixCell | undefined {
  return cells.find((c) => c.model === model && c.configId === configId);
}
