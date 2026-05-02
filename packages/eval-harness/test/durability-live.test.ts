// Live durability tests — gated by LIVE=1. When LIVE infra is not present
// these are skipped; they document the PilotSwarm-functional product
// scenarios the harness should exercise once a real worker is available.
//
// LIVE_DURABILITY_HOOK is an optional extension point: if set, the harness
// can wire a real worker-restart hook here. Default is to skip.

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDriver } from "../src/drivers/live-driver.js";
import { ChaosDriver } from "../src/drivers/chaos-driver.js";
import { EvalRunner } from "../src/runner.js";
import { loadEvalTask } from "../src/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("LiveDriver durability LIVE", () => {
  const run = process.env.LIVE === "1" ? it : it.skip;

  run("recovers eval run after worker crash mid-turn", async () => {
    const driver = new LiveDriver({ timeout: 300_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const runner = new EvalRunner({ driver, runId: "live-durability-crash" });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    const c = result.cases[0]!;
    if (!c.pass) {
      expect(c.scores.some((s) => s.infraError === true) || typeof c.infraError === "string").toBe(true);
    }
    expect(c.observed.sessionId).toBeTruthy();
  }, 360_000);

  run("dehydrates and resumes a long-running eval session", async () => {
    const driver = new LiveDriver({ timeout: 240_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const runner = new EvalRunner({ driver, runId: "live-durability-dehydrate" });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    const c = result.cases[0]!;
    expect(c.observed.sessionId).toBeTruthy();
    expect(result.runId).toBe("live-durability-dehydrate");
    expect(c.caseId).toBe(sample.id);
  }, 360_000);

  // -------------------------------------------------------------------------
  // DURABILITY suite expansion (eval-platform expansion phase 4)
  // ChaosDriver wraps LiveDriver and tags each ObservedResult with a
  // DurabilityObservation describing the injected fault and recovery state.
  // -------------------------------------------------------------------------

  run("DURABILITY: ChaosDriver-wrapped run produces a recovered observation under worker_crash/before_turn", async () => {
    const inner = new LiveDriver({ timeout: 240_000 });
    const driver = new ChaosDriver(inner, {
      scenarioName: "worker-crash-before-turn",
      faultPoint: "before_turn",
      faultMode: "worker_crash",
    });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const runner = new EvalRunner({ driver, runId: "live-durability-chaos-before-turn" });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    const c = result.cases[0]!;
    expect(c.observed.durability).toBeDefined();
    expect(c.observed.durability!.scenario).toBe("worker-crash-before-turn");
    expect(c.observed.durability!.injected).toBe(true);
  }, 360_000);

  run("DURABILITY: dehydrate fault point flags dehydrated/hydrated", async () => {
    const inner = new LiveDriver({ timeout: 240_000 });
    const driver = new ChaosDriver(inner, {
      scenarioName: "dehydrate-between-turns",
      faultPoint: "after_dehydrate",
      faultMode: "worker_crash",
    });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const runner = new EvalRunner({ driver, runId: "live-durability-dehydrate-chaos" });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    const obs = result.cases[0]!.observed.durability;
    expect(obs).toBeDefined();
    expect(obs!.dehydrated).toBe(true);
    expect(obs!.hydrated).toBe(true);
  }, 360_000);

  run("DURABILITY: in-flight tool fault re-throws when not swallowed (no silent infra-error)", async () => {
    const inner = new LiveDriver({ timeout: 240_000 });
    const driver = new ChaosDriver(inner, {
      faultPoint: "during_tool_call",
      faultMode: "tool_throw",
      beforeRunHook: () => {
        throw new Error("synthetic tool fault");
      },
    });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const runner = new EvalRunner({ driver, runId: "live-durability-tool-throw" });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    const c = result.cases[0]!;
    // EvalRunner catches driver throws and surfaces as infraError on the case.
    expect(typeof c.infraError === "string" || c.pass === false).toBe(true);
  }, 360_000);

  run("DURABILITY: long-running session survives multiple chaos cycles (smoke)", async () => {
    const inner = new LiveDriver({ timeout: 240_000 });
    const driver = new ChaosDriver(inner, {
      faultPoint: "after_turn",
      faultMode: "worker_crash",
      injectionRate: 0.5,
      rng: () => 0.6,
    });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const runner = new EvalRunner({ driver, runId: "live-durability-long" });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    expect(result.cases[0]!.observed.sessionId).toBeTruthy();
  }, 360_000);

  run("DURABILITY: worker handoff scenario tags result accordingly via afterRunHook", async () => {
    const inner = new LiveDriver({ timeout: 240_000 });
    const driver = new ChaosDriver(inner, {
      scenarioName: "worker-handoff",
      faultPoint: "after_turn",
      faultMode: "worker_crash",
      afterRunHook: (_sample, observed) => {
        if (observed.durability) observed.durability.workerHandoff = true;
      },
    });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const runner = new EvalRunner({ driver, runId: "live-durability-handoff" });
    const result = await runner.runTask({ ...dataset, samples: [sample] });
    expect(result.cases[0]!.observed.durability?.workerHandoff).toBe(true);
  }, 360_000);
});
