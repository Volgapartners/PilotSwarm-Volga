# Eval Harness V3 — Durability & Crash Recovery Evals

> **⚠️ HISTORICAL — partially implemented, partially superseded.**
>
> This proposal predates the shipped V3 surface. As built:
> - `DurabilityFixtureDriver` (was `ScriptedDriver` in this doc) is fixture-only
>   grader scaffolding — it does NOT crash real workers. Production durability
>   is proven by `test/durability-live.test.ts` (real worker handoff with CMS
>   event evidence) and `ChaosDriver` wrapping `LiveDriver` with a real
>   `worker.kill()` `beforeRunHook`.
> - §5.3's "extend FakeDriver" recommendation was NOT followed; ChaosDriver
>   wraps inner drivers instead.
> - `DurabilityFixtureDriver` ships a runtime warning outside test contexts
>   pointing at the real production path.
>
> See `packages/eval-harness/README.md` §V3 and `test/durability-live.test.ts`
> for the actual shipped surface. This file remains for design context only.

**Status:** Research / design proposal — partially shipped, partially historical (see banner above)
**Scope:** `packages/eval-harness/` — new drivers, graders, fixtures for testing PilotSwarm's durability guarantees
**Predecessors:** V1 (EvalRunner + FakeDriver/LiveDriver), V2 (MultiTrialRunner, MatrixRunner, stats)

---

## 1. Problem Statement

The current eval harness answers: *"Given a prompt, does the LLM pick the right tool with the right args?"*

It does **not** answer:

- Does the session survive a worker crash mid-tool-call?
- Does a durable timer actually fire with correct semantics after a restart?
- Is CMS state consistent after orchestration replay?
- Does dehydrate/rehydrate preserve conversation state?
- Does multi-worker handoff preserve correctness?

These are PilotSwarm's **core product differentiators** vs. plain SDK usage. They're tested today in `packages/sdk/test/local/{durability,reliability-crash,chaos}.test.js`, but those are imperative, LLM-dependent integration tests — not scorable, aggregable, CI-friendly eval cases.

V3 brings durability under the eval umbrella: **deterministic, scorable, composable, FakeDriver-friendly.**

---

## 2. Current Architecture Recap

```
EvalTask (JSON) ─▶ Loader ─▶ EvalRunner
                               │
                               ▼
                            Driver.run(sample) ─▶ ObservedResult
                               │
                               ▼
                            gradeEvalCase(observed, expected) ─▶ Score[]
                               │
                               ▼
                            Reporter (console/jsonl)
```

**Driver interface:**
```ts
interface Driver {
  run(sample: EvalSample, options?: DriverOptions): Promise<ObservedResult>;
}
```

**ObservedResult:** `{ toolCalls, finalResponse, sessionId, model?, latencyMs, cmsState? }`

**Existing graders:** `tool-selection`, `match-args`, `ordering`, `response`, `cms-state`.

Drivers:
- **FakeDriver** — looks up a pre-scripted `ObservedResult` by `sample.id`. Pure, sub-ms, no LLM.
- **LiveDriver** — spins up a real `createTestEnv()` + `PilotSwarmWorker` + `PilotSwarmClient` per sample, calls `session.sendAndWait()`, reads CMS state. Requires `GITHUB_TOKEN` and Postgres.

---

## 3. Design Principles for V3

1. **Decorator pattern, not a third base driver.** A `CrashDriver` should *wrap* any `Driver` so you can exercise crash scenarios with both FakeDriver (pure, CI) and LiveDriver (real worker, higher fidelity).
2. **Two test modes, one fixture shape.** The same durability scenario should run deterministically in CI (FakeDriver + scripted transcripts) and optionally in "integration" mode against real workers.
3. **Durability is observable, not inferred.** Scoring reads concrete artifacts — CMS state rows, orchestration custom-status, event counts, timer fire-times — rather than trying to infer recovery from LLM output alone.
4. **No retries, no hacks.** Same rules as the main suite: a durability eval that fails means PilotSwarm has a durability bug, or the fixture is wrong. Never paper over.
5. **FakeDriver-first.** Every durability dimension must have at least one FakeDriver fixture so the V3 suite runs in CI with zero external dependencies.
6. **Compose with V2.** `MultiTrialRunner` and `MatrixRunner` should work unchanged against `CrashDriver`-wrapped drivers — crash scenarios benefit enormously from multi-trial runs because recovery can be racy.

---

## 4. What "Durability" Means — Testable Dimensions

From reading `orchestration.ts`, `session-proxy.ts`, `managed-session.ts`, and the existing SDK durability tests, PilotSwarm's durability guarantees decompose into six testable dimensions:

| # | Dimension | What it guarantees | Observable artifacts |
|---|-----------|--------------------|----------------------|
| **D1** | **Orchestration replay correctness** | Re-executing the generator from history yields identical custom-status sequence | `customStatus.iteration`, no `nondeterministic: custom status mismatch` error |
| **D2** | **CMS state consistency across crash** | Session row + events remain monotonic and consistent after worker death | CMS `state` column, `events` count, `updatedAt` ordering |
| **D3** | **Durable timer fidelity** | A `scheduleTimer(ms)` fires after `ms` wall-clock, even across a worker restart | Actual elapsed time vs. requested, wait state transitions (`waiting` → `running`) |
| **D4** | **Dehydrate/rehydrate transcript preservation** | After dehydration, a new worker rehydrates the session with no lost LLM turns | Conversation history length, tool-call history preserved, no `SYSTEM: lossy replay` notice unless expected |
| **D5** | **Multi-worker handoff correctness** | A session started on worker A completes correctly on worker B | Session completes, CMS `workerNodeId` changes, turn count monotonic |
| **D6** | **Crash-blast radius** | A crash of one session does not corrupt sibling sessions | Sibling session state unchanged, sibling events unaffected |

These map directly onto scoring primitives (see §6).

---

## 5. Driver Design — `CrashDriver`

### 5.1 Decorator over any inner driver

```ts
// packages/eval-harness/src/drivers/crash-driver.ts

export type CrashInjectionPoint =
  | "pre-run"           // crash before driver.run() starts
  | "mid-run"           // crash during driver.run() (requires FaultableDriver)
  | "post-run"          // crash between driver.run() and grading
  | "mid-tool-call"     // crash between tool call N and N+1 (scripted)
  | "pre-dehydrate"     // crash just before dehydrate activity
  | "post-dehydrate"    // crash after dehydrate, before rehydrate
  | "mid-timer";        // crash while a durable timer is armed

export interface CrashScenario {
  injectionPoint: CrashInjectionPoint;
  // For mid-run / mid-tool-call scripts:
  afterToolCall?: number;    // 1-indexed — crash AFTER the Nth tool call
  afterElapsedMs?: number;   // wall-clock offset from run start
  // Recovery expectations:
  expectResume: boolean;     // should the session resume on a second worker?
  expectStatePreserved: boolean;
  maxResumeLatencyMs?: number;
}

export interface CrashDriverOptions {
  inner: Driver;
  scenarios: Map<string, CrashScenario>;  // keyed by sample.id
  // Worker factory (for LiveDriver path) — creates a fresh worker instance
  workerFactory?: () => Promise<DurableWorkerHandle>;
}

export class CrashDriver implements Driver {
  async run(sample: EvalSample, options?: DriverOptions): Promise<ObservedResult> {
    const scenario = this.scenarios.get(sample.id);
    if (!scenario) {
      // No crash configured — pass through transparently
      return this.inner.run(sample, options);
    }

    // Phase 1: run up to the injection point
    const phase1 = await this.runPhase1(sample, scenario, options);

    // Phase 2: simulate crash + recovery
    const phase2 = await this.runPhase2(sample, scenario, phase1, options);

    // Merge observations — phase2.observed is the "final" state,
    // but we need to record pre-crash artifacts for durability grading.
    return mergeObservations(phase1, phase2, scenario);
  }
}
```

### 5.2 Fault-injection protocol

For **FakeDriver** (no real worker), crash simulation is pure data manipulation:

```ts
// Extended ObservedResult for durability:
export interface DurabilityObservations {
  preCrashToolCalls: ObservedToolCall[];
  preCrashCmsState?: string;
  preCrashCustomStatus?: { iteration: number; sequence: number };
  crashInjectedAt: CrashInjectionPoint;
  crashElapsedMs: number;

  postCrashToolCalls: ObservedToolCall[];
  postCrashCmsState?: string;
  postCrashCustomStatus?: { iteration: number; sequence: number };

  workerA: string;           // nodeId before crash
  workerB?: string;          // nodeId after crash
  resumeLatencyMs?: number;  // wall-clock from crash to first post-crash event
  replayError?: string;      // any nondeterminism error captured
  totalElapsedMs: number;
}
```

The `ObservedResult` schema is extended to optionally carry `durability?: DurabilityObservations`. Existing graders ignore it; new durability graders consume it.

### 5.3 ScriptedDriver vs. extending FakeDriver?

**Recommendation: extend `FakeDriver`, not a new class.**

`FakeDriver` today returns a single pre-canned `ObservedResult`. For crash scenarios we need it to return **two halves** (pre-crash + post-crash), plus the durability metadata. Rather than a third driver type, add:

```ts
export interface FakeScenario {
  sampleId: string;
  response: ObservedResult;
  // V3 additions (optional, backward-compatible):
  crashSplit?: {
    preCrash: Partial<ObservedResult>;   // tool calls and CMS state "before"
    postCrash: Partial<ObservedResult>;  // tool calls and CMS state "after"
    durability: DurabilityObservations;
  };
}
```

`CrashDriver(FakeDriver)` then reads `crashSplit` from the inner scenario and returns a merged `ObservedResult` with `durability` populated. This keeps all V1 fixtures valid, adds V3 without a new driver class.

### 5.4 Against LiveDriver — real crash

For integration-mode (opt-in, requires env), `CrashDriver` wraps `LiveDriver` and:

1. Starts worker A via `workerFactory()`.
2. Starts a client, creates session, sends prompt.
3. At the injection point (determined by a tool-call observer callback, or a timer), calls `workerA.stop()` — a clean `stop()` is sufficient; the orchestration is paused because its host died.
4. Starts worker B.
5. Calls `client.resumeSession(sessionId)` and observes what happens.
6. Reads CMS state + orchestration custom-status before and after.

This is exactly what `chaos.test.js` and `reliability-crash.test.js` already do — V3 just codifies it behind the `Driver` interface and adds structured scoring.

For `mid-tool-call` injection, `LiveDriver` needs a hook. Suggestion: expose an `onBeforeToolCall(call)` / `onAfterToolCall(call)` callback on the eval tool tracker. `CrashDriver` installs a callback that kills worker A after the Nth call. The existing `EvalToolTracker` already records every invocation with `order` — a small extension.

### 5.5 Determinism knobs

Crash evals are racy by nature. To make them CI-stable:

- **FakeDriver path** is trivially deterministic — no real time, no real I/O.
- **LiveDriver path** uses:
  - Fixed `waitThreshold` so the durable-timer path is forced regardless of wall-clock.
  - `DUROXIDE_LOG_LEVEL=error` to avoid log-interleaving issues.
  - `maxResumeLatencyMs` assertions with generous bounds (say 30s) — we're testing *correctness*, not latency.
  - Multi-trial via V2's `MultiTrialRunner` with `pass@k` semantics for any non-determinism that remains.

---

## 6. Grader Design — Durability Graders

All new graders live in `packages/eval-harness/src/graders/durability/` and are additive to `gradeEvalCase()`. None of the existing V1/V2 graders change.

### 6.1 Schema additions

```ts
// Extend EvalExpected:
export const DurabilityExpectedSchema = z.object({
  statePreservation: z.object({
    toolCallsBeforeCrashPreserved: z.boolean().default(true),
    cmsStateMonotonic: z.boolean().default(true),
    allowedStatesAcrossCrash: z.array(z.string()).optional(),
  }).optional(),
  replay: z.object({
    noNondeterminism: z.boolean().default(true),
    iterationMonotonic: z.boolean().default(true),
    maxIterationDelta: z.number().int().optional(),
  }).optional(),
  timer: z.object({
    expectedFireAtMs: z.number().int().positive(),
    toleranceMs: z.number().int().default(1000),
  }).optional(),
  handoff: z.object({
    expectWorkerChange: z.boolean().default(false),
    maxResumeLatencyMs: z.number().int().optional(),
  }).optional(),
  blastRadius: z.object({
    siblingSessionIds: z.array(z.string()),
    siblingsMustRemainInStates: z.array(z.string()).optional(),
  }).optional(),
});

// Attach to EvalExpected:
export const EvalExpectedSchema = z.object({
  // ...existing V1 fields...
  durability: DurabilityExpectedSchema.optional(),
});
```

### 6.2 Individual graders

Each produces one or more `Score` objects, each 0..1 with `pass: boolean`.

**`gradeStatePreservation(durability, expected.statePreservation)`**
- `tool-calls-preserved`: pre-crash tool-call order is a **prefix** of final tool-call order (value = prefix-match ratio; pass iff all pre-crash calls appear in same order).
- `cms-state-monotonic`: CMS `updatedAt` values are non-decreasing across the crash, and state transitions respect the known state machine (`idle → running → waiting → running → completed`, no regressions).

**`gradeReplay(durability, expected.replay)`**
- `no-nondeterminism`: binary — `durability.replayError` is absent. Single most important durability score.
- `iteration-monotonic`: orchestration iteration counter after resume is `>=` iteration before crash and `<= preCrash.iteration + maxIterationDelta`.

**`gradeDurableTimer(durability, expected.timer)`**
- `timer-fire-accuracy`: `abs(actualElapsedMs - expectedFireAtMs) <= toleranceMs`. Score = `max(0, 1 - deviation/tolerance)`.

**`gradeHandoff(durability, expected.handoff)`**
- `worker-changed`: `workerA !== workerB` when `expectWorkerChange`.
- `resume-latency`: `resumeLatencyMs <= maxResumeLatencyMs`.

**`gradeBlastRadius(durability, expected.blastRadius, siblingObservations)`**
- `siblings-unaffected`: each sibling's CMS state is in `siblingsMustRemainInStates`, their event counts pre vs. post-crash are unchanged. Requires the runner to fetch sibling state — a small extension to `LiveDriver`/`CrashDriver`.

### 6.3 Composer extension

`gradeEvalCase()` grows a final block:

```ts
if (expected.durability && observed.durability) {
  scores.push(...gradeStatePreservation(observed.durability, expected.durability.statePreservation));
  scores.push(...gradeReplay(observed.durability, expected.durability.replay));
  if (expected.durability.timer)  scores.push(gradeDurableTimer(observed.durability, expected.durability.timer));
  if (expected.durability.handoff) scores.push(...gradeHandoff(observed.durability, expected.durability.handoff));
  if (expected.durability.blastRadius) scores.push(gradeBlastRadius(...));
}
```

Missing `observed.durability` when `expected.durability` is set → infra error (grader can't score), logged as `grader-error` via the existing catch-all in `runner.ts`.

---

## 7. Fixture Design

### 7.1 Dataset file

New dataset: `packages/eval-harness/datasets/durability.v1.json`

```json
{
  "schemaVersion": 1,
  "id": "durability-v1",
  "name": "PilotSwarm Durability Evals",
  "description": "Crash recovery, replay correctness, durable timers, handoff, blast radius.",
  "version": "1.0.0",
  "passRateFloor": 1.0,
  "samples": [ /* see below */ ]
}
```

### 7.2 Sample fixtures — one per dimension

**D1 — Orchestration replay correctness**
```jsonc
{
  "id": "replay-post-tool-call",
  "description": "Worker crashes after tool call 1; replay reproduces iteration sequence exactly.",
  "input": { "prompt": "Add 2+2, then multiply the result by 3." },
  "expected": {
    "toolCalls": [
      { "name": "test_add", "args": { "a": 2, "b": 2 } },
      { "name": "test_multiply", "args": { "a": 4, "b": 3 } }
    ],
    "toolSequence": "strict",
    "durability": {
      "replay": { "noNondeterminism": true, "iterationMonotonic": true },
      "statePreservation": { "toolCallsBeforeCrashPreserved": true }
    }
  },
  "tags": ["durability", "replay", "mid-tool-call"]
}
```

**D2 — CMS state consistency**
```jsonc
{
  "id": "cms-consistent-across-crash",
  "description": "CMS state is monotonic and never regresses across a mid-run crash.",
  "expected": {
    "cms": { "stateIn": ["completed"] },
    "durability": {
      "statePreservation": {
        "cmsStateMonotonic": true,
        "allowedStatesAcrossCrash": ["running", "waiting", "completed"]
      }
    }
  }
}
```

**D3 — Durable timer fires across crash**
```jsonc
{
  "id": "timer-fires-across-crash",
  "description": "Durable wait of 2s survives a mid-wait worker crash.",
  "input": { "prompt": "Wait 2 seconds then tell me the capital of Germany." },
  "expected": {
    "response": { "containsAny": ["Berlin", "berlin"] },
    "durability": {
      "timer": { "expectedFireAtMs": 2000, "toleranceMs": 2000 }
    }
  }
}
```

**D4 — Dehydrate / rehydrate transcript preservation**
```jsonc
{
  "id": "rehydrate-preserves-transcript",
  "description": "After forced dehydrate, rehydrated session has full transcript.",
  "expected": {
    "durability": {
      "statePreservation": { "toolCallsBeforeCrashPreserved": true },
      "replay": { "noNondeterminism": true }
    }
  }
}
```

**D5 — Multi-worker handoff**
```jsonc
{
  "id": "handoff-to-new-worker",
  "description": "Session hands off from worker A to worker B and completes.",
  "expected": {
    "cms": { "stateIn": ["completed"] },
    "durability": {
      "handoff": { "expectWorkerChange": true, "maxResumeLatencyMs": 30000 }
    }
  }
}
```

**D6 — Blast-radius isolation**
```jsonc
{
  "id": "sibling-unaffected-by-crash",
  "description": "Crashing session A does not affect session B's state or events.",
  "expected": {
    "durability": {
      "blastRadius": {
        "siblingSessionIds": ["sibling-B"],
        "siblingsMustRemainInStates": ["idle", "completed"]
      }
    }
  }
}
```

### 7.3 FakeDriver scenarios

Companion file `packages/eval-harness/src/fixtures/durability-scenarios.ts` maps each `sampleId` → `FakeScenario` with a hand-authored `crashSplit`. This is the **CI-critical** artifact — these scenarios run on every PR, no GitHub token, no Postgres.

Example:
```ts
export const durabilityFakeScenarios: FakeScenario[] = [
  {
    sampleId: "replay-post-tool-call",
    response: {
      toolCalls: [
        { name: "test_add", args: { a: 2, b: 2 }, result: 4, order: 0 },
        { name: "test_multiply", args: { a: 4, b: 3 }, result: 12, order: 1 },
      ],
      finalResponse: "The answer is 12.",
      sessionId: "fake-replay-1",
      latencyMs: 5000,
      cmsState: "completed",
      durability: {
        preCrashToolCalls: [{ name: "test_add", args: { a: 2, b: 2 }, result: 4, order: 0 }],
        preCrashCmsState: "running",
        preCrashCustomStatus: { iteration: 2, sequence: 5 },
        crashInjectedAt: "mid-tool-call",
        crashElapsedMs: 2000,
        postCrashToolCalls: [
          { name: "test_add", args: { a: 2, b: 2 }, result: 4, order: 0 },
          { name: "test_multiply", args: { a: 4, b: 3 }, result: 12, order: 1 },
        ],
        postCrashCmsState: "completed",
        postCrashCustomStatus: { iteration: 4, sequence: 9 },
        workerA: "crash-a",
        workerB: "crash-b",
        resumeLatencyMs: 800,
        totalElapsedMs: 5000,
      },
    },
  },
  // ... one per D1-D6
];
```

---

## 8. Implementation Plan (TDD, single writer)

Follow the repo's mandatory TDD / single-implementer rules. Each phase is a RED → GREEN → REFACTOR unit.

| Phase | Deliverable | Tests first |
|---|---|---|
| **P1** | Extend `ObservedResult` with optional `durability` field. Zod schema + types only. No behavior change. | `types.test.ts` parses new field; existing fixtures still valid. |
| **P2** | `gradeStatePreservation`, `gradeReplay` graders. Pure functions over `DurabilityObservations`. | Grader unit tests: prefix-match, monotonic states, replay errors. |
| **P3** | `gradeDurableTimer`, `gradeHandoff`, `gradeBlastRadius` graders. | Tolerance math, worker-change detection, sibling state checks. |
| **P4** | `gradeEvalCase()` composer integration (opt-in on `expected.durability`). | Combined scoring test with a fake durability observation. |
| **P5** | `FakeScenario.crashSplit` support + durability scenarios fixture file. | `FakeDriver` returns merged `ObservedResult` with `durability` populated. |
| **P6** | `CrashDriver` decorator over `FakeDriver` path. Passes through when no scenario configured. | Decorator test: pass-through, inject-crash, merge. |
| **P7** | Dataset `durability.v1.json` with D1–D6 samples; E2E test via `EvalRunner` + `CrashDriver(FakeDriver)`. | Full suite run, pass rate = 1.0, reporter output verified. |
| **P8** | Extend `EvalToolTracker` with `onAfterToolCall` callback. Extend `LiveDriver` to thread it through. | Unit test tracker callback; LiveDriver still green. |
| **P9** | `CrashDriver` over `LiveDriver` with real worker stop/start. Gated behind `RUN_LIVE_DURABILITY=1`. | One smoke sample (D5 handoff) verified against real Postgres. |
| **P10** | Integrate with V2 `MultiTrialRunner` — durability suite runs with `trials=5, passAtK=[1,3]`. | Multi-trial test against CrashDriver(FakeDriver). |

Phases P1–P7 land V3 for CI (FakeDriver-only). P8–P10 are the live-mode upgrade — optional, gated, not required for green CI.

---

## 9. What NOT to do

- **Don't test determinism by running real LLMs twice.** Determinism is about the *orchestration*, not the model. Use FakeDriver for D1/D4, LiveDriver only for surfaces that require a real turn.
- **Don't add retries to durability graders.** If replay is non-deterministic, that's a bug. Flag loudly.
- **Don't invent a new "chaos DSL".** Crash scenarios are simple enums + a `sampleId`-keyed map. No YAML, no DSL, no interpreter. If we need more expressiveness, the fixture JSON schema already supports it.
- **Don't weaken FakeDriver.** FakeDriver's value is sub-ms, zero-dependency runs. Durability scenarios must not require Postgres to grade — everything needed is in the scripted `DurabilityObservations`.
- **Don't block commits on LiveDriver durability runs.** They're higher-fidelity but slow and occasionally flaky. Gate behind env var, run on nightly CI.
- **Don't try to test "orchestration version migration."** That's a separate concern with a separate proposal (`orchestration-registry.ts`). V3 scope is crash/replay within one version.

---

## 10. Open Questions

1. **Should blast-radius grading require a multi-session fixture format?** V1 `EvalSample` is single-session. We'd need a sibling-spawn hook or a new `EvalScenario` wrapping multiple samples. Recommended deferral to a later V3.x.
2. **Should `mid-timer` injection be a separate dimension from D3?** They overlap; proposing D3 covers both "crash during timer" and "timer fires on schedule."
3. **Portal/TUI integration?** Out of scope. V3 is runtime-durability only.
4. **Do we score "lossy replay notices" as pass or fail?** Proposing they are *expected* for specific scenarios (e.g. Copilot-transport-loss fixtures) and scored via a new `lossyReplay: { allowed: true }` flag under `durability.replay`.

---

## 11. Summary Recommendation

Ship V3 in three visible slices:

1. **Types + graders + FakeDriver crashSplit** (Phases P1–P5) — pure additions, no behavior change, all V1/V2 tests stay green.
2. **`CrashDriver` decorator + D1–D6 fixtures + dataset file** (Phases P6–P7) — ships a CI-runnable durability eval suite.
3. **LiveDriver crash integration** (Phases P8–P10) — optional, env-gated, nightly-only.

This keeps the durability story decorator-composable with the existing harness, preserves FakeDriver-only CI, and makes PilotSwarm's core differentiators (crash recovery, replay, durable timers, handoff) first-class citizens of the eval product surface.
