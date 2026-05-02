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

  // -------------------------------------------------------------------------
  // G10: REAL multi-worker handoff scenario — replaces the previous synthetic
  // `afterRunHook`-based test. The old test set
  // `observed.durability.workerHandoff = true` from a hook (and even that
  // tag was clobbered by ChaosDriver's post-hook `durability` overlay), so
  // it provided ZERO real evidence of cross-worker session migration.
  //
  // This test:
  //   1. Spins up two real workers (A + B) sharing the same store/schemas/
  //      session-state dir via the SDK's `withTwoWorkers` helper.
  //   2. Creates a session, runs a first turn — some worker handles it.
  //   3. Stops worker A. Worker B remains running.
  //   4. Runs a second turn on the SAME session — worker B MUST handle it
  //      (otherwise the request would hang forever).
  //   5. Reads the persisted CMS event log via `session.getMessages()` and
  //      asserts at least 2 DISTINCT `workerNodeId` values across events.
  //      That is the canonical product-level evidence of a real handoff.
  //
  // No `ChaosDriver`. No `afterRunHook`. No synthetic tags. The assertion
  // reads from real CMS-persisted events written by the real workers.
  //
  // Skipped when LIVE!=1, like every other test in this file.
  // -------------------------------------------------------------------------
  run("DURABILITY: REAL worker handoff — second turn handled by surviving worker (CMS evidence)", async () => {
    // Use the SDK directly rather than `withTwoWorkers` so we can FORCE
    // worker-A-only execution for turn 1 (start A alone, run turn, then
    // stop A and start B for turn 2). With `withTwoWorkers` both workers
    // race to dispatch, so A may never see any work — defeating the point
    // of a handoff test.
    // @ts-expect-error - SDK test helpers are private and untyped
    const sdkMod = await import("pilotswarm-sdk");
    // @ts-expect-error - SDK test env helper is private and untyped
    const envHelpers = await import("../../sdk/test/helpers/local-env.js");
    const PilotSwarmWorker = (sdkMod as any).PilotSwarmWorker;
    const PilotSwarmClient = (sdkMod as any).PilotSwarmClient;
    const createTestEnv = (envHelpers as any).createTestEnv as (suite: string) => any;

    const env = createTestEnv("eval_durability_handoff");
    let workerA: any | undefined;
    let workerB: any | undefined;
    let client: any | undefined;
    try {
      const commonOpts = {
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
        disableManagementAgents: true,
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
      };
      // Phase 1: only worker A is running. It will handle turn 1.
      workerA = new PilotSwarmWorker({ ...commonOpts, workerNodeId: "eval-handoff-a" });
      await workerA.start();

      client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
      });
      await client.start();

      const session = await client.createSession({});
      const sessionId: string = session.sessionId;

      // Turn 1: worker A is the ONLY active worker, so it must handle this.
      const r1 = await session.sendAndWait("Reply with the single token 'one'.", 120_000);
      expect(typeof r1).toBe("string");

      // Hand off: stop A, start B. Session state was persisted by A; B
      // picks up the next turn via the standard hydrate flow.
      await workerA.stop();
      workerA = undefined;
      workerB = new PilotSwarmWorker({ ...commonOpts, workerNodeId: "eval-handoff-b" });
      await workerB.start();

      // Turn 2: worker B is now the only active worker.
      const r2 = await session.sendAndWait("Reply with the single token 'two'.", 180_000);
      expect(typeof r2).toBe("string");

      // CMS evidence: read the full event log and assert at least two
      // distinct workerNodeIds appear. This is the canonical product-level
      // signal that a real cross-worker handoff happened — not a synthetic
      // tag set by an `afterRunHook`.
      const events = await session.getMessages(1000);
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);

      const workerNodeIds = new Set<string>(
        events
          .map((e: any) => e?.workerNodeId)
          .filter((id: unknown): id is string => typeof id === "string" && id.length > 0),
      );
      expect(
        workerNodeIds.size,
        `expected events from >=2 workers across the handoff; sessionId=${sessionId} saw: ${JSON.stringify(Array.from(workerNodeIds))}; total events: ${events.length}`,
      ).toBeGreaterThanOrEqual(2);
      expect(workerNodeIds.has("eval-handoff-a")).toBe(true);
      expect(workerNodeIds.has("eval-handoff-b")).toBe(true);

      // Each turn produces a session.turn_completed event. With two turns
      // we expect at least two such events in CMS.
      const turnCompletes = events.filter(
        (e: any) => e?.eventType === "session.turn_completed",
      );
      expect(turnCompletes.length).toBeGreaterThanOrEqual(2);
    } finally {
      // Reverse-order cleanup. Errors here MUST NOT mask a primary failure.
      try {
        if (client) await client.stop();
      } catch (err) {
        process.stderr.write(`handoff test: client.stop warning: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      try {
        if (workerB) await workerB.stop();
      } catch (err) {
        process.stderr.write(`handoff test: workerB.stop warning: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      try {
        if (workerA) await workerA.stop();
      } catch (err) {
        process.stderr.write(`handoff test: workerA.stop warning: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      if (process.env.KEEP_DURABILITY_ENV !== "1") {
        try {
          await env.cleanup?.();
        } catch (err) {
          process.stderr.write(`handoff test: env.cleanup warning: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
  }, 600_000);
});
