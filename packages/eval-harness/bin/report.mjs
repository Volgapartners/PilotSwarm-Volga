#!/usr/bin/env node
// packages/eval-harness/bin/report.mjs
//
// Aggregate a `.eval-results/<ts>/` directory into a single Markdown
// report. Works on partial runs (some tasks may still be writing) so
// it's safe to invoke mid-flight or after vitest completes.
//
// Usage
// -----
//   bin/report.mjs                          # latest dir under .eval-results/
//   bin/report.mjs <reports-dir>            # specific dir
//   bin/report.mjs --out <path>             # explicit output path
//   bin/report.mjs --stdout                 # write Markdown to stdout
//
// Output: REPORT-<ts>.md in the reports dir (or --out path).

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, basename, join } from "node:path";

function parseArgs(argv) {
  const opts = { dir: "", out: "", stdout: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      opts.out = argv[++i] ?? "";
    } else if (a === "--out=" || a.startsWith("--out=")) {
      opts.out = a.slice("--out=".length);
    } else if (a === "--stdout") {
      opts.stdout = true;
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if (!opts.dir) {
      opts.dir = a;
    } else {
      console.error(`unexpected arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelp() {
  console.log(
    "Usage: report.mjs [<reports-dir>] [--out <path>] [--stdout]\n" +
      "Defaults to the most recent dir under packages/eval-harness/.eval-results/.",
  );
}

function findLatestReportsDir() {
  const root = resolve(
    new URL(import.meta.url).pathname,
    "../../.eval-results",
  );
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (dirs.length === 0) return null;
  // Prefer timestamped suffixes; fall back to mtime
  const sorted = dirs
    .map((name) => {
      const full = join(root, name);
      let mtime;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { name, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return sorted[0]?.full ?? null;
}

function readJsonl(path) {
  const lines = [];
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return lines;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      lines.push(JSON.parse(t));
    } catch {
      // skip malformed line — happens when the writer crashed mid-line
    }
  }
  return lines;
}

function classifyFailure(sample) {
  // Heuristic. Order matters.
  // 1. infraError === true on any score → infra
  // 2. observed undefined → infra
  // 3. score reasons mentioning specific patterns → SDK / model / judge
  if (sample.errored) return "infra";
  for (const s of sample.scores ?? []) {
    if (s.infraError === true) return "infra";
  }
  // Heuristic: judge-named scores → model-quality fail
  for (const s of sample.scores ?? []) {
    if (typeof s.name === "string" && s.name.startsWith("judge/")) {
      return "model-quality (judge-graded)";
    }
  }
  // Heuristic: budget-named violations → SDK perf signal
  for (const s of sample.scores ?? []) {
    if (
      typeof s.reason === "string" &&
      /observed\s+\d+\s*>\s*budget|over budget|peakConnections|dbQueries/.test(
        s.reason,
      )
    ) {
      return "sdk-perf";
    }
  }
  return "model-quality (deterministic grader)";
}

function fmtDur(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function pct(n, d) {
  if (!d) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function escapeCell(s) {
  if (s == null) return "";
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function aggregate(dir) {
  const entries = readdirSync(dir);
  const jsonl = entries.filter((n) => n.endsWith(".jsonl"));

  const byTask = new Map();
  const allFails = [];
  const judgeScores = [];
  const summaries = [];
  let earliestRun = null;
  let latestSummary = null;

  for (const name of jsonl) {
    const lines = readJsonl(join(dir, name));
    const runLine = lines.find((l) => l.type === "run");
    const summaryLine = lines.find((l) => l.type === "summary");
    const samples = lines.filter((l) => l.type === "sample");

    const taskId =
      summaryLine?.taskId ??
      runLine?.task ??
      basename(name, ".jsonl").slice(0, 8);

    if (runLine?.startedAt) {
      const t = new Date(runLine.startedAt).getTime();
      if (!earliestRun || t < earliestRun) earliestRun = t;
    }
    if (summaryLine?.finishedAt) {
      const t = new Date(summaryLine.finishedAt).getTime();
      if (!latestSummary || t > latestSummary) latestSummary = t;
    }
    if (summaryLine) summaries.push(summaryLine);

    if (!byTask.has(taskId)) {
      byTask.set(taskId, {
        taskId,
        runs: 0,
        total: 0,
        passed: 0,
        failed: 0,
        errored: 0,
        latencies: [],
      });
    }
    const t = byTask.get(taskId);
    t.runs += 1;
    if (summaryLine) {
      t.total += summaryLine.total ?? 0;
      t.passed += summaryLine.passed ?? 0;
      t.failed += summaryLine.failed ?? 0;
      t.errored += summaryLine.errored ?? 0;
    }

    for (const s of samples) {
      if (typeof s.observed?.latencyMs === "number") {
        t.latencies.push(s.observed.latencyMs);
      }
      // Capture judge scores
      for (const sc of s.scores ?? []) {
        if (typeof sc.name === "string" && sc.name.startsWith("judge/")) {
          judgeScores.push({
            taskId,
            caseId: s.caseId,
            criterion: sc.name.replace(/^judge\//, ""),
            value: sc.value,
            pass: sc.pass,
            infraError: sc.infraError === true,
            reason: sc.reason ?? "",
          });
        }
      }
      if (s.pass === false || s.errored === true) {
        const failingScores = (s.scores ?? []).filter((sc) => sc.pass === false);
        allFails.push({
          taskId,
          caseId: s.caseId,
          category: classifyFailure(s),
          durationMs: s.durationMs,
          reasons: failingScores.map((sc) => `**${sc.name}**: ${sc.reason}`),
          observedResponse:
            typeof s.observed?.finalResponse === "string"
              ? s.observed.finalResponse.slice(0, 240)
              : "",
        });
      }
    }
  }

  // Aggregate latency p50/p95
  for (const t of byTask.values()) {
    if (t.latencies.length === 0) {
      t.p50 = null;
      t.p95 = null;
      continue;
    }
    const sorted = [...t.latencies].sort((a, b) => a - b);
    t.p50 = sorted[Math.floor(sorted.length * 0.5)];
    t.p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
  }

  return {
    dir,
    earliestRun,
    latestSummary,
    summaries,
    byTask: [...byTask.values()].sort((a, b) =>
      a.taskId.localeCompare(b.taskId),
    ),
    allFails,
    judgeScores,
  };
}

function renderMarkdown(agg) {
  const totals = agg.byTask.reduce(
    (acc, t) => {
      acc.total += t.total;
      acc.passed += t.passed;
      acc.failed += t.failed;
      acc.errored += t.errored;
      return acc;
    },
    { total: 0, passed: 0, failed: 0, errored: 0 },
  );
  const wall =
    agg.earliestRun && agg.latestSummary
      ? fmtDur(agg.latestSummary - agg.earliestRun)
      : "in progress / unknown";
  const reportTs = new Date().toISOString();

  const out = [];
  out.push(`# Eval Harness Report — ${basename(agg.dir)}`);
  out.push("");
  out.push(`Generated at \`${reportTs}\` by \`bin/report.mjs\`.`);
  out.push("");
  out.push(`Source: \`${agg.dir}\``);
  out.push("");

  out.push("## Top-line totals");
  out.push("");
  out.push("| metric | value |");
  out.push("|---|---:|");
  out.push(`| Tasks (jsonl files) | ${agg.summaries.length} |`);
  out.push(`| Total cases | ${totals.total} |`);
  out.push(`| Passed | ${totals.passed} |`);
  out.push(`| Failed (quality) | ${totals.failed} |`);
  out.push(`| Errored (infra) | ${totals.errored} |`);
  out.push(`| Pass rate | ${pct(totals.passed, totals.total)} |`);
  out.push(`| Infra error rate | ${pct(totals.errored, totals.total)} |`);
  out.push(`| Wall clock (run window) | ${wall} |`);
  if (agg.earliestRun) {
    out.push(
      `| Earliest run start | \`${new Date(agg.earliestRun).toISOString()}\` |`,
    );
  }
  if (agg.latestSummary) {
    out.push(
      `| Latest summary write | \`${new Date(agg.latestSummary).toISOString()}\` |`,
    );
  }
  out.push("");

  out.push("## Per-task aggregate");
  out.push("");
  out.push(
    "| Task | Runs | Total | Pass | Fail | Errored | Pass rate | Latency p50 | Latency p95 |",
  );
  out.push(
    "|------|-----:|------:|-----:|-----:|--------:|----------:|------------:|------------:|",
  );
  for (const t of agg.byTask) {
    out.push(
      `| ${escapeCell(t.taskId)} | ${t.runs} | ${t.total} | ${t.passed} | ${t.failed} | ${t.errored} | ${pct(t.passed, t.total)} | ${fmtDur(t.p50)} | ${fmtDur(t.p95)} |`,
    );
  }
  out.push("");

  // Failures
  out.push("## Failures");
  out.push("");
  if (agg.allFails.length === 0) {
    out.push("_No failures recorded._");
    out.push("");
  } else {
    const byCat = new Map();
    for (const f of agg.allFails) {
      if (!byCat.has(f.category)) byCat.set(f.category, []);
      byCat.get(f.category).push(f);
    }
    for (const [cat, items] of [...byCat.entries()].sort()) {
      out.push(`### ${cat} (${items.length})`);
      out.push("");
      for (const f of items) {
        out.push(
          `- **${escapeCell(f.taskId)} / ${escapeCell(f.caseId)}** (${fmtDur(f.durationMs)})`,
        );
        for (const r of f.reasons) {
          out.push(`  - ${escapeCell(r)}`);
        }
        if (f.observedResponse) {
          out.push(
            `  - _observed response (truncated):_ \`${escapeCell(f.observedResponse)}\``,
          );
        }
      }
      out.push("");
    }
  }

  // Judge details
  if (agg.judgeScores.length > 0) {
    out.push("## LLM-judge scores");
    out.push("");
    out.push(
      `${agg.judgeScores.length} judge score(s) recorded across ${
        new Set(agg.judgeScores.map((j) => j.criterion)).size
      } criterion(a).`,
    );
    out.push("");
    // Per-criterion aggregate
    const byCrit = new Map();
    for (const j of agg.judgeScores) {
      if (!byCrit.has(j.criterion))
        byCrit.set(j.criterion, { total: 0, pass: 0, infra: 0, sumValue: 0, n: 0 });
      const c = byCrit.get(j.criterion);
      c.total += 1;
      if (j.pass) c.pass += 1;
      if (j.infraError) c.infra += 1;
      if (typeof j.value === "number" && Number.isFinite(j.value)) {
        c.sumValue += j.value;
        c.n += 1;
      }
    }
    out.push("| Criterion | Calls | Pass | Infra err | Mean value | Pass rate |");
    out.push("|---|---:|---:|---:|---:|---:|");
    for (const [crit, c] of [...byCrit.entries()].sort()) {
      const mean = c.n > 0 ? (c.sumValue / c.n).toFixed(3) : "—";
      out.push(
        `| ${escapeCell(crit)} | ${c.total} | ${c.pass} | ${c.infra} | ${mean} | ${pct(c.pass, c.total)} |`,
      );
    }
    out.push("");

    // Show non-pass / infra judge cases for inspection
    const interesting = agg.judgeScores.filter(
      (j) => !j.pass || j.infraError,
    );
    if (interesting.length > 0) {
      out.push("### Non-pass / infra judge calls");
      out.push("");
      for (const j of interesting) {
        const tag = j.infraError ? "infra-error" : "fail";
        out.push(
          `- _[${tag}]_ **${escapeCell(j.taskId)} / ${escapeCell(j.caseId)} / ${escapeCell(j.criterion)}** (value=${typeof j.value === "number" ? j.value.toFixed(3) : "—"}): ${escapeCell(j.reason).slice(0, 280)}`,
        );
      }
      out.push("");
    }
  }

  out.push("## How to read this");
  out.push("");
  out.push(
    "- **infra** failures = harness / driver / transport problem; usually a harness bug to fix before chasing model behavior.",
  );
  out.push(
    "- **sdk-perf** failures = budget overrun on a perf assertion; usually real PilotSwarm SDK signal worth profiling.",
  );
  out.push(
    "- **model-quality (deterministic grader)** = the model called the wrong tool / produced disallowed output / missed a required string.",
  );
  out.push(
    "- **model-quality (judge-graded)** = a rubric criterion failed; check the judge reason for whether the verdict is calibrated.",
  );
  out.push("");
  out.push(
    "Raw artifacts live alongside this report: one `<runId>.jsonl` per task plus `<runId>/<caseId>.json` for any failing case. Re-run `bin/report.mjs` against the same dir to refresh after additional jsonl writes.",
  );
  out.push("");

  return out.join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let dir = opts.dir
    ? resolve(opts.dir)
    : findLatestReportsDir();
  if (!dir) {
    console.error(
      "no reports dir found — pass an explicit path or run vitest with EVAL_REPORTS_DIR set.",
    );
    process.exit(1);
  }
  let s;
  try {
    s = statSync(dir);
  } catch (err) {
    console.error(`cannot stat ${dir}: ${err.message}`);
    process.exit(1);
  }
  if (!s.isDirectory()) {
    console.error(`not a directory: ${dir}`);
    process.exit(1);
  }
  const agg = aggregate(dir);
  const md = renderMarkdown(agg);
  if (opts.stdout) {
    process.stdout.write(md);
    return;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const outPath = opts.out
    ? resolve(opts.out)
    : join(dir, `REPORT-${ts}.md`);
  writeFileSync(outPath, md, "utf8");
  console.log(outPath);
}

main();
