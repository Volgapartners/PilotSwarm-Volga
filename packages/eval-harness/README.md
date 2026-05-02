# PilotSwarm Eval Harness

Evaluation harness for PilotSwarm agents. The deterministic fixture runner, statistics, reporters, and code graders are shipped; live LLM evaluation, durability validation, multi-turn reasoning measurement, and LLM-as-judge calibration remain experimental unless explicitly noted.

The harness is organized into six capability suites — see [`docs/SUITES.md`](./docs/SUITES.md) for the full catalog and gating matrix.

| Suite        | File                              | LIVE tests | Gating                                  |
|--------------|-----------------------------------|-----------:|-----------------------------------------|
| FUNCTIONAL   | `test/live-driver-live.test.ts`   | 9          | `LIVE=1`                                |
| DURABILITY   | `test/durability-live.test.ts`    | 7          | `LIVE=1`                                |
| ABLATIONS    | `test/ablations-live.test.ts`     | 5          | `LIVE=1`                                |
| LLM-JUDGE    | `test/llm-judge-live.test.ts`     | 5          | `LIVE=1 LIVE_JUDGE=1` + `OPENAI_API_KEY`|
| PERFORMANCE  | `test/performance-live.test.ts`   | 4          | `LIVE=1`                                |
| SAFETY       | `test/safety-live.test.ts`        | 14         | `LIVE=1` (+ `LIVE_JUDGE=1`)             |

## Quick Start

```bash
# Run eval suite (uses FakeDriver — no LLM calls, no .env needed)
cd packages/eval-harness
npx vitest run

# Via the repo test runner
./scripts/run-tests.sh --suite=eval

# All LIVE suites (requires PostgreSQL + GitHub token)
LIVE=1 npx vitest run -- packages/eval-harness/test/*-live.test.ts

# Single LIVE suite
LIVE=1 npx vitest run -- packages/eval-harness/test/ablations-live.test.ts
```

Monorepo consumers import `pilotswarm-eval-harness` through the package export
(`dist/index.js`). Run `npm run build` in `packages/eval-harness` before using
that package-root import from another workspace; `npm test` runs the build first
and includes a package-root smoke test to catch stale `dist/` exports.

## Architecture

**Data flow:** JSON fixture → Loader (Zod validates) → Runner → Driver (execute) → Graders (score) → Reporter / CI output.

The harness has four runner paths:

- `EvalRunner` for single-turn fixtures with `FakeDriver` (shipped) or `LiveDriver` (🧪 experimental real PilotSwarm execution).
- `MultiTrialRunner` for repeated stochastic trials, `pass@k`, Wilson intervals, and infra-error-aware pass rates.
- `MatrixRunner` for model/config sweeps across multi-trial cells.
- `TrajectoryRunner` for V4 multi-turn fixtures (🧪 experimental measurement).

Graders include deterministic tool selection, argument matching, ordering, response, CMS state, and durability-fixture checks, plus `LLMJudgeGrader` with `FakeJudgeClient` and `OpenAIJudgeClient` (🧪 calibration not shipped). Output surfaces include `ConsoleReporter`, `JsonlReporter`, `ConsoleAggregateReporter`, `MarkdownReporter`, `PRCommentReporter`, `CIGate`, and `RegressionDetector`.

## Package Structure

```
packages/eval-harness/
├── datasets/
│   ├── durability-scenarios.v1.json       # 🧪 illustrative durability fixtures
│   ├── multi-turn-scenarios.v1.json       # 🧪 V4 trajectory fixtures
│   └── tool-call-correctness.v1.json      # Golden single-turn dataset v1
├── src/
│   ├── baseline.ts           # Baseline load/save helpers
│   ├── ci-gate.ts            # CI quality/regression gate
│   ├── index.ts              # Public API exports
│   ├── loader.ts             # JSON fixture loader + validation
│   ├── matrix.ts             # Model/config matrix sweeps
│   ├── multi-trial.ts        # Repeated trials, pass@k, infra-aware rates
│   ├── regression.ts         # Baseline-vs-current regression detection
│   ├── runner.ts             # EvalRunner single-turn lifecycle
│   ├── stats.ts              # Statistical utilities
│   ├── trajectory-runner.ts  # 🧪 V4 multi-turn trajectory lifecycle
│   ├── types.ts              # Zod schemas + TS types
│   ├── drivers/
│   │   ├── fake-driver.ts             # Single-turn scripted traces
│   │   ├── fake-multi-turn-driver.ts  # 🧪 scripted trajectory traces
│   │   ├── live-driver.ts             # 🧪 real PilotSwarm execution
│   │   ├── multi-turn-types.ts        # 🧪 trajectory driver interfaces
│   │   ├── scripted-driver.ts         # Durability fixture driver
│   │   └── types.ts                   # Single-turn driver interfaces
│   ├── fixtures/
│   │   └── eval-tools.ts     # test_add, test_multiply, test_weather
│   ├── graders/
│   │   ├── cms-state.ts      # CMS session state assertion
│   │   ├── durability.ts     # Durability fixture scoring
│   │   ├── fake-judge-client.ts      # Deterministic judge client
│   │   ├── index.ts          # Single-turn composer: gradeEvalCase()
│   │   ├── judge-cache.ts    # Judge response cache
│   │   ├── judge-types.ts    # Judge client/cache contracts
│   │   ├── llm-judge.ts      # 🧪 rubric-based LLM-as-judge grader
│   │   ├── match-args.ts     # Arg matching (exact/subset/fuzzy/setEquals)
│   │   ├── openai-judge-client.ts    # 🧪 OpenAI-compatible judge client
│   │   ├── ordering.ts       # exactSequence/subsequence/unordered grading
│   │   ├── response.ts       # Word-boundary containsAny/All
│   │   ├── tool-selection.ts # Tool name + forbidden + call counts
│   │   └── trajectory.ts     # 🧪 V4 per-turn/cross-turn/holistic scoring
│   ├── observers/
│   │   └── tool-tracker.ts   # EvalToolTracker → ObservedToolCall[]
│   ├── reporters/
│   │   ├── aggregate-types.ts     # Aggregate reporter interface
│   │   ├── console-aggregate.ts   # Multi-trial/matrix console output
│   │   ├── console.ts        # ✅/❌/⚠️ summary table to stdout
│   │   ├── jsonl.ts          # Incremental JSONL + failure artifacts
│   │   ├── markdown.ts       # Aggregate Markdown file output
│   │   ├── pr-comment.ts     # Aggregate PR-comment Markdown output
│   │   ├── types.ts          # Reporter interface (async-ready)
│   │   └── util.ts           # Shared Markdown/formatting helpers
├── test/                     # Vitest coverage for harness behavior
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

## Core Concepts

### Fixture (EvalTask)

A JSON file defining a set of eval scenarios:

```json
{
  "schemaVersion": 1,
  "id": "tool-call-correctness",
  "name": "Tool Call Correctness",
  "description": "Core tool calling scenarios",
  "version": "1.0.0",
  "passRateFloor": 0.8,
  "samples": [...]
}
```

### Sample (EvalSample)

A single eval scenario within a task:

```json
{
  "id": "single.add.basic",
  "description": "Single tool call with integer args",
  "input": {
    "prompt": "What is 17 plus 25? Use the test_add tool."
  },
  "expected": {
    "toolCalls": [
      { "name": "test_add", "args": { "a": 17, "b": 25 }, "match": "subset" }
    ],
    "forbiddenTools": [],
    "response": { "containsAny": ["42"] },
    "cms": { "stateIn": ["idle", "completed"] }
  },
  "tools": ["test_add"],
  "tags": ["single-tool", "arithmetic"],
  "timeoutMs": 120000
}
```

### Score

Every grader returns normalized scores:

```typescript
{
  name: "tool-names",       // which grader
  value: 1.0,               // 0..1 normalized
  pass: true,               // binary verdict
  reason: "all 1 expected tool(s) were called",
  actual: ["test_add"],     // what the LLM did
  expected: ["test_add"]    // what we expected
}
```

A case passes only when **all** applicable scores pass.

### Driver

Drivers execute eval samples and return observed results:

| Driver | Purpose | LLM Calls | Speed |
|--------|---------|-----------|-------|
| `FakeDriver` | TDD, CI, fast iteration | No | <1ms/case |
| `LiveDriver` | Experimental real model smoke/eval path | Yes | 5-30s/case |

### Reporter

Reporters receive events as evals execute:

| Reporter | Output | Use Case |
|----------|--------|----------|
| `ConsoleReporter` | ✅/❌/⚠️ table to stdout | Interactive use |
| `JsonlReporter` | `.eval-results/<runId>.jsonl` + failure artifacts | CI, history |
| `ConsoleAggregateReporter` | Multi-trial / matrix summary to stdout | Interactive V2 runs |
| `MarkdownReporter` | Markdown report to file | CI artifacts, PR comments |

Reporter interface is async-ready (`void | Promise<void>`) for future Langfuse integration.

V2 aggregate reporters implement a separate `AggregateReporter` interface with `onMultiTrialComplete(result)` and `onMatrixComplete(result)` hooks.

## Grading Reference

### Argument Matching Modes

| Mode | Behavior | Default |
|------|----------|---------|
| `exact` | JSON equality after key sorting | |
| `subset` | Every expected key must match exactly; extra actual keys OK. Set `subsetCaseInsensitive: true` to opt into legacy lowercase/trim string matching. | ✅ |
| `fuzzy` | Levenshtein for strings (`fuzzyStringMaxRelativeDistance`, default `0.2`), exact numeric matching unless `numericTolerance` is set, order-insensitive arrays | |
| `setEquals` | Same keys and values in both directions, order-insensitive | |

### Tool Selection Scoring

| Score | What It Checks |
|-------|---------------|
| `tool-names` | Were the right tools called? (multiset counting — handles duplicate calls) |
| `forbidden-tools` | Were forbidden tools avoided? |
| `call-count` | Were `minCalls`/`maxCalls` constraints met? |
| `no-tool-compliance` | If `noToolCall: true`, were zero tools called? |
| `tool-args:<name>` | Per expected tool call, did the arguments match? (uses selected match mode) |

### Ordering

| Mode | Behavior |
|------|----------|
| `exactSequence` | Observed tool names must exactly match the expected sequence; no interleaved calls |
| `subsequence` | Expected tools appear in order as a subsequence of observed calls |
| `strict` | Deprecated alias for `subsequence` |
| `unordered` | All expected tools appear somewhere in observed (any order) |

### Response Matching

Uses **word-boundary matching** (regex `\b...\b`) for `containsAny`/`containsAll` — prevents false positives like `"hi"` matching `"this"`.

### Schema Validation

Zod validates fixtures at load time with cross-field invariants:
- Rejects `noToolCall: true` combined with `toolCalls`
- Rejects `minCalls > maxCalls`
- Requires `schemaVersion: 1`
- Requires at least one sample

## Adding a New Eval Case

### Step 1: Add to the dataset

Edit `datasets/tool-call-correctness.v1.json` and add a sample:

```json
{
  "id": "selection.divide-not-multiply",
  "description": "Should pick divide, not multiply",
  "input": {
    "prompt": "What is 20 divided by 4? Use the appropriate tool."
  },
  "expected": {
    "toolCalls": [{ "name": "test_divide", "args": { "a": 20, "b": 4 }, "match": "subset" }],
    "forbiddenTools": ["test_multiply"]
  },
  "tools": ["test_multiply", "test_divide"],
  "tags": ["selection"]
}
```

### Step 2: Add a fake scenario for CI

In `test/eval-core.test.ts`, add a matching fake response:

```typescript
"selection.divide-not-multiply": {
  toolCalls: [{ name: "test_divide", args: { a: 20, b: 4 }, result: { result: 5 }, order: 0 }],
  finalResponse: "20 ÷ 4 = 5.",
  sessionId: "fake-session-new",
  latencyMs: 100,
  cmsState: "idle",
},
```

### Step 3: Run

```bash
cd packages/eval-harness && npx vitest run
```

### Step 4 (optional): Add new eval tools

If your scenario needs a new tool, add it to `src/fixtures/eval-tools.ts` and register in `createEvalToolTracker()`.

## Running Against a Real Model

The experimental `LiveDriver` executes samples against a real LLM using `PilotSwarmClient`/`PilotSwarmWorker`, but it currently depends on a monorepo-only SDK test helper for environment setup. It is not portable as a standalone package consumer. Use only inside the PilotSwarm monorepo until the SDK exposes a public env helper, or inject equivalent dependencies yourself.

**Prerequisites:**
- PostgreSQL running (`DATABASE_URL` in `.env`)
- `GITHUB_TOKEN` in `.env` (or model provider keys in `.model_providers.json`)

**Example usage in a test:**

```typescript
import {
  LiveDriver,
  EvalRunner,
  loadEvalTask,
  ConsoleReporter,
  JsonlReporter,
} from "pilotswarm-eval-harness";

const task = loadEvalTask("datasets/tool-call-correctness.v1.json");
const runner = new EvalRunner({
  driver: new LiveDriver({ model: "gpt-4o" }),
  reporters: [new ConsoleReporter(), new JsonlReporter(".eval-results")],
});

const result = await runner.runTask(task);
console.log(`Pass rate: ${(result.summary.passRate * 100).toFixed(1)}%`);
```

**Current LiveDriver limitations:**
- Does not support `input.context` (multi-turn priors) — will throw
- Each sample creates an isolated test environment (fresh DB schemas)
- `workerNodeId` is unique per run to avoid collisions
- Timeouts abort the harness wait and trigger session cleanup. Provider-level call cancellation depends on SDK support; in-flight LLM requests may continue billing until they complete naturally.

### Running live evals

The default test suite does **not** exercise real LLM calls. To smoke-test the experimental `LiveDriver` path against a real PilotSwarm session, run:

```bash
cd packages/eval-harness
LIVE=1 npx vitest run test/live-driver-live.test.ts
```

## JSONL Output Format

Each run produces `.eval-results/<runId>.jsonl`:

```jsonl
{"type":"run","runId":"abc-123","task":"tool-call-correctness","version":"1.0.0","startedAt":"..."}
{"type":"sample","runId":"abc-123","caseId":"single.add.basic","pass":true,"scores":[...],"observed":{...},"durationMs":102}
{"type":"sample","runId":"abc-123","caseId":"selection.multiply-not-add","pass":false,"scores":[...],"observed":{...},"durationMs":8421}
{"type":"summary","runId":"abc-123","total":6,"passed":5,"failed":1,"errored":0,"passRate":0.833}
```

Failed cases also get a detailed artifact: `.eval-results/<runId>/<caseId>.json`

File paths are sanitized — `runId` and `caseId` are stripped of path separators.

## Extension Points (Phase 2+)

The harness is designed for incremental extension:

| Interface | V1 Implementation | V2-V5 status |
|-----------|-------------------|-----------------|
| `Driver` | FakeDriver shipped; LiveDriver experimental | DurabilityFixtureDriver fixture-only (V3), FakeMultiTurnDriver fixture-only (V4) |
| `Reporter` | Console, JSONL | PRCommentReporter (V5b) |
| Graders | Code-only (deterministic) | gradeDurability (V3), gradeTrajectory (V4), LLMJudgeGrader (V5a) |
| Runners | EvalRunner | MultiTrialRunner (V2), TrajectoryRunner (V4) |
| Datasets | Static JSON | Durability + multi-turn fixtures (V3, V4) |
| Matrix | Single model | Model × context × compaction × reasoning (V2) |
| CI | passRateFloor only | RegressionDetector + CIGate + Baseline (V5b) |

### Writing a Custom Reporter

```typescript
import type { Reporter } from "pilotswarm-eval-harness";

class LangfuseReporter implements Reporter {
  async onRunStart(task, runId) { /* create Langfuse trace */ }
  async onCaseResult(result) { /* log span + scores */ }
  async onRunComplete(result) { /* finalize trace */ }
}
```

### Writing a Custom Driver

```typescript
import type { Driver, DriverOptions } from "pilotswarm-eval-harness";

class RemoteDriver implements Driver {
  async run(sample, options) {
    // Call remote PilotSwarm cluster
    // options.signal for cancellation
    return { toolCalls: [...], finalResponse: "...", sessionId: "...", latencyMs: 0 };
  }
}
```

## V2: Multi-Trial, Matrix, and Statistics

### Multi-Trial Evaluation

Run a task N times to get a statistically meaningful pass rate with confidence intervals and pass@k.

```ts
import { MultiTrialRunner, FakeDriver, ConsoleAggregateReporter } from "pilotswarm-eval-harness";

const runner = new MultiTrialRunner({
  driverFactory: () => new FakeDriver(scenarios),
  trials: 10,
  passAtKValues: [1, 5, 10],
});

const result = await runner.runTask(task);
console.log(result.summary.meanPassRate); // 0.85
new ConsoleAggregateReporter().onMultiTrialComplete(result);
```

`MultiTrialResult` includes per-sample aggregates (`passRate`, `passAtK`, `wilsonCI`, per-score mean/stddev) and a task-level summary (`meanPassRate`, `stddevPassRate`, `pooledPassRateCI`). `pooledPassRateCI` is a Wilson interval over pooled non-infra-error trials across heterogeneous samples; it is **not** a confidence interval for `meanPassRate`. The deprecated `passRateCI` alias is retained for compatibility.

### Parameter Matrix

Compare models × configs for a single task. Each cell runs its own multi-trial evaluation internally.

```ts
import { MatrixRunner, MarkdownReporter, LiveDriver } from "pilotswarm-eval-harness";

const runner = new MatrixRunner({
  driverFactory: () => new LiveDriver(),
  models: ["gpt-4o", "claude-sonnet"],
  configs: [
    { id: "default", label: "Default", overrides: {} },
    { id: "strict", label: "Strict Prompt", overrides: { systemMessage: "Be precise." } },
  ],
  trials: 5,
  maxCells: 1000,
});

const result = await runner.runTask(task);
new MarkdownReporter("/path/to/output.md").onMatrixComplete(result);
```

`MatrixConfigOverrides` currently supports `systemMessage` and `timeoutMs` for explicit prompt experiments. `MatrixRunner` guards cost with `maxCells` (models × configs × trials × samples, default `1000`; set `Infinity` to opt out) and supports `dryRun: true` to return the full matrix plan without creating drivers or making LLM calls. Dry-run matrix cells mark their inner `MultiTrialResult` with `dryRun: true` and no quality signal so they cannot be mistaken for real 0%-quality results by CI gates. `MatrixResult.summary` surfaces `bestPassRate` and `worstPassRate` cells.

### Statistical Utilities

Pure functions exported from `stats.ts` — no eval dependencies, safe to use standalone.

```ts
import {
  passAtK,
  meanStddev,
  wilsonInterval,
  bootstrapCI,
  mcNemarTest,
  mannWhitneyU,
} from "pilotswarm-eval-harness";

// pass@k from Chen et al. (HumanEval) — unbiased estimator
const pk = passAtK([true, false, true, false, true], 3);

// Wilson score interval (binomial CI)
const ci = wilsonInterval(17, 20); // { lower, upper, point, z }

// Bootstrap percentile CI for the mean (default alpha=0.05, reps=10_000)
// Signature: bootstrapCI(values, alpha?, reps?, rng?)
const boot = bootstrapCI([0.7, 0.8, 0.9, 0.85], 0.05, 10_000);
// { lower, upper, point, reps, alpha }

// Regression detection between paired runs (A vs B)
const mc = mcNemarTest([
  [true, false],  // regression
  [false, true],  // improvement
  [true, true],   // concordant
]);
console.log(mc.pValue, mc.method); // p-value, "exact" or "chi2-yates"

// Non-parametric comparison of two independent distributions
const mw = mannWhitneyU([0.8, 0.9, 0.85], [0.6, 0.7, 0.65]);
```

## V3: Crash Recovery & Durability Fixtures (experimental)

> ⚠️ **V3 fixture-only — does NOT test real worker crashes.** To validate real durability, you must implement a `ChaosDriver` that calls `worker.kill()` mid-`runTurn`. PilotSwarm does not ship one yet.

V3 currently ships durability **grader plumbing and fixture-based examples**, not a chaos driver. `DurabilityFixtureDriver` derives observations from a test-authored script; it does not crash a real worker, replay orchestration history, or prove hydration/worker handoff. Use it to test grader behavior only.

```typescript
import {
  EvalRunner,
  DurabilityFixtureDriver,
  gradeDurability,
  type DurabilityFixtureScenario,
  type EvalTask,
} from "pilotswarm-eval-harness";

const scenarios: DurabilityFixtureScenario[] = [
  {
    sampleId: "crash.recovers",
    steps: [
      { type: "respond", response: /* ObservedResult */ },
      { type: "crash", faultPoint: "during_tool_call", faultMode: "worker_crash" },
      {
        type: "recover",
        recoveryResponse: /* ObservedResult with cmsState: "idle" */,
        durability: { dehydrated: true, hydrated: true, workerHandoff: true },
      },
    ],
  },
];

const runner = new EvalRunner({ driver: new DurabilityFixtureDriver(scenarios) });
const result = await runner.runTask(taskWithDurabilityExpectations);
```

The grader emits `crash-recovery`, `post-recovery-state`, `tool-calls-after-recovery`, `dehydration`, `hydration`, and `worker-handoff` scores. Fault points: `before_turn`, `during_tool_call`, `after_tool_call`, `after_turn`, `after_dehydrate`, `before_hydrate`. Fault modes: `worker_crash`, `tool_timeout`, `tool_throw`, `network_disconnect`. The `datasets/durability-scenarios.v1.json` fixture is marked `runnable: false` because it is illustrative fixture data, not a live-runnable crash test; `loadEvalTask(path, { mode: "live" })` skips non-runnable datasets with a clear warning.

`ChaosDriver` is exported only as an extension-point skeleton. Its base `run()` throws until a caller subclasses it and implements real worker-kill timing plus recovery observation.

## V4: Multi-Turn & Trajectory Evaluation (experimental)

V4 grades fixture trajectories with per-turn, cross-turn, and holistic scoring. The bundled `FakeMultiTurnDriver` is deterministic fixture plumbing; live multi-turn reasoning evaluation is not yet shipped.

```typescript
import {
  TrajectoryRunner,
  FakeMultiTurnDriver,
  type TrajectoryTask,
  type ObservedTrajectory,
} from "pilotswarm-eval-harness";

const task: TrajectoryTask = {
  schemaVersion: 1,
  id: "trajectory-demo",
  // ...
  samples: [
    {
      id: "remember-color",
      tools: ["paint_tool"],
      turns: [
        { input: { prompt: "Remember my favorite color is blue." }, expected: { noToolCall: true } },
        {
          input: { prompt: "Paint a swatch using my favorite color." },
          expected: { toolCalls: [{ name: "paint_tool", args: { color: "blue" } }] },
        },
      ],
      expected: {
        goalCompleted: true,
        maxTotalToolCalls: 1,
        contextRetention: [
          {
            term: "blue",
            mustAppearAfterTurn: 0,
            requireToolArgUse: { toolName: "paint_tool", argPath: "color" },
          },
        ],
      },
    },
  ],
};

const runner = new TrajectoryRunner({
  driver: new FakeMultiTurnDriver([{ sampleId: "remember-color", trajectory: observedTrajectory }]),
});
const result = await runner.runTask(task);
// result.cases[0].trajectoryScore = { turnScores, crossTurnScores, holisticScores }
```

Holistic scores include `turn-count`, `goal-completed`, and `call-budget`. Cross-turn `contextRetention` falls back to lexical response matching, which can pass if an agent merely parrots a term. When a trajectory sample declares `tools`, the default grader first checks whether the retained term appears in any later tool-call argument value and warns if only lexical matching succeeded. Prefer explicit `requireToolArgUse: { toolName, argPath }` to require the retained term to appear as a specific later tool-call argument value (for example `test_weather.city`). The `datasets/multi-turn-scenarios.v1.json` fixture bundles canonical multi-turn flows.

## V5: LLM-as-Judge + CI Gates

V5 has two halves.

### V5a — LLM-as-Judge (experimental)

For subjective dimensions (helpfulness, accuracy, safety, …) `LLMJudgeGrader` runs a `Rubric` of criteria against a prompt+response pair using a pluggable `JudgeClient`. The package includes `FakeJudgeClient` for deterministic tests and an OpenAI-compatible `OpenAIJudgeClient` adapter, but judge calibration against human ratings is not yet shipped. Cost capping requires `OpenAIJudgeClient` `costRates` configuration; without rates, the OpenAI adapter reports unknown cost and the grader emits a judge `infraError` instead of pretending the call cost $0. An optional `JudgeCache` deduplicates by judge ID, rubric ID + version, criterion ID, prompt, response, and a hashed `systemMessage` value (`undefined` is distinct from an empty string or any explicit value). `LLMJudgeGraderOptions.systemMessage` lets callers pass judge-specific instructions through to the `JudgeClient` and participates in that cache identity.

```typescript
import {
  LLMJudgeGrader,
  OpenAIJudgeClient,
  InMemoryJudgeCache,
  type Rubric,
} from "pilotswarm-eval-harness";

const rubric: Rubric = {
  id: "quality",
  name: "Quality",
  version: "1.0.0",
  criteria: [
    { id: "helpfulness", description: "Is the response helpful?", scale: { min: 1, max: 5 }, passThreshold: 0.6 },
    { id: "accuracy",    description: "Is the response accurate?", scale: { min: 1, max: 5 }, passThreshold: 0.6 },
  ],
};

const grader = new LLMJudgeGrader({
  client: new OpenAIJudgeClient({
    baseUrl,
    apiKey,
    model,
    costRates: {
      inputUsdPerMillionTokens: 2.50,
      outputUsdPerMillionTokens: 10.00,
    },
  }),
  rubric,
  cache: new InMemoryJudgeCache(),
  budgetUsd: 0.50,
  systemMessage: "Judge strictly against the rubric only.",
});

const { scores, costs, totalCostUsd } = await grader.grade(prompt, response);
```

When the running cost exceeds `budgetUsd` mid-batch, remaining criteria short-circuit with `infraError: true` and a `"Budget exceeded"` reason; these are not counted as quality failures by downstream summaries. If an OpenAI response has token usage but the client lacks `costRates`, the criterion is marked `infraError: true` with `"cost unknown — pass costRates to OpenAIJudgeClient"`. `JudgeResult.normalizedScore` is in `[0,1]` and `pass` is derived from `passThreshold`.

### V5b — Baselines, Regression Detection, CI Gates, PR Comments

V5b closes the loop: persist a `MultiTrialResult` as a `Baseline`, detect statistically significant regressions on the next run, and gate CI on a quality floor (`passRateFloor`) plus optional supplementary and operational gates such as `maxRegressions`, `maxCostUsd`, and infra-error limits. A `PRCommentReporter` emits Markdown for surfacing in PR reviews.

```typescript
import {
  saveBaseline,
  loadBaseline,
  RegressionDetector,
  CIGate,
  PRCommentReporter,
} from "pilotswarm-eval-harness";

// 1. Persist this run as the new baseline
saveBaseline(currentResult, ".eval-results/baseline.json");

// 2. On the next run: load baseline, detect regressions
const baseline = loadBaseline(".eval-results/baseline.json");
const detection = new RegressionDetector({ alpha: 0.05, correction: "bh" }).detect(baseline, nextResult);

// 3. Gate CI on the combined signal
const gate = new CIGate({ passRateFloor: 0.8, maxRegressions: 0, maxCostUsd: 5 });
const verdict = gate.evaluate(nextResult, detection, totalCostUsd);
process.exit(gate.exitCode(verdict));

// 4. Emit a PR-ready Markdown summary
const pr = new PRCommentReporter(".eval-results/pr-comment.md");
pr.onMultiTrialComplete(nextResult);
pr.writeGateResult(verdict, detection.regressions);
```

`RegressionDetector` uses a two-proportion z-test on baseline vs. current pass rates (baselines persist aggregate counts, not per-sample paired outcomes). Multiple-testing correction is opt-in via `correction: "none" | "bonferroni" | "bh"` and defaults to `"none"` for compatibility. `detect()` returns `{ regressions, missingBaselineSamples, newCurrentSamples }`: baseline samples missing from the current run are reported so CI cannot pass by deleting hard eval cases, and current samples missing from the baseline are reported so consumers can catch added easy samples that dilute aggregate pass rate. `CIGate.evaluate()` fails on missing baseline samples by default; set `allowMissingBaselineSamples: true` only for intentional sample removals. `failOnNewSamples` defaults to `true`: by default a baseline comparison that reports added current samples fails the gate with `new samples added vs baseline: ...`. Opt out explicitly with `failOnNewSamples: false` only for intentional sample additions. `direction` is `"regressed" | "improved" | "unchanged"`. `CIGate.evaluate()` returns `{ pass, reasons[], passRate, regressionCount, totalCostUsd }`. McNemar's test is still exported as `mcNemarTest` for callers that have paired per-sample data.

`CIGate` requires `passRateFloor` for quality approval. `passRateFloor` is the only gate that constrains absolute quality — without it, `CIGate` rejects the run with `"CIGate requires passRateFloor for quality approval — cost, infra, regression-only, and operational gates cannot replace a pass-rate floor."` (pinned by `test/ci-gate.test.ts`). `maxRegressions` is **supplementary**: it is a "no regression" gate that complements `passRateFloor` by enforcing that the current run does not regress vs the baseline, but it cannot replace `passRateFloor` even when paired with non-empty regression data. A regression-only gate (`maxRegressions: 0` with no `passRateFloor`) does not constrain absolute quality, so it is rejected. `maxCostUsd`, `maxInfraErrors`, and `requireNoInfraOutage` are operational gates only; they can fail a run, but they cannot approve quality on their own.

`CIGate` recomputes aggregate quality signal from `MultiTrialResult.samples` and rejects inputs where the supplied `summary.meanPassRate` disagrees with the recomputed value. This protects CI from post-processed or tampered result JSON. Set `trustSummary: true` only when a caller deliberately accepts the risk of authoritative precomputed summaries; gate decisions still use the recomputed sample-level signal.

`saveBaseline()` refuses to persist samples with no quality signal (`nonErrorTrials === 0`, usually all trials infra-errored) because such baselines suppress future regression detection for those samples. To override intentionally, call `saveBaseline(result, path, { allowNoQualityBaseline: true })`; the save and subsequent load will warn and name the affected samples. It also refuses low-quality baselines with aggregate pass rate below 50%, because a broken baseline can ratify equally broken current runs in regression-only CI gates. To override intentionally, call `saveBaseline(result, path, { allowLowQualityBaseline: true })`; the save will warn with the same low-quality message.

#### Statistical assumptions and caveats

- The two-proportion z-test assumes IID Bernoulli trials. That may not hold for multi-trial LLM evals because repeated trials of the same prompt against the same model can share seed effects, prompt stickiness, or provider-side correlation.
- P-values can be over-optimistic in practice. Treat them as one signal, not proof.
- Multiple-testing correction is opt-in via `bonferroni` or `bh`. Use `bh` for five or more samples; use `bonferroni` for fewer than five when you want the stricter family-wise error bound.
- `RegressionDetector` works best when samples are de-correlated: different prompts, different fixtures, and distinct behaviors.
- If you cannot make IID assumptions, use the exported `mannWhitneyU` and `bootstrapCI` helpers on caller-owned distributions and gate on effect sizes / confidence intervals instead of z-test p-values alone.

## Roadmap

| Version | Scope | Status |
|---------|-------|--------|
| V1 | Schema, FakeDriver runner, graders, console + JSONL reporters, golden fixture | ✅ Shipped |
| V1 LiveDriver | Real PilotSwarm session path | 🧪 Experimental (`LIVE=1` smoke only) |
| V2 | Multi-trial, matrix, statistical utilities (Wilson, bootstrap, McNemar, Mann-Whitney), pass@k | ✅ Shipped |
| V3 | Fixture-derived durability observations and scoring | 🧪 Fixture/scaffold only — not real crash validation |
| V4 | Multi-turn / trajectory fixture evaluation, per-turn + cross-turn + holistic scoring | 🧪 Experimental — lexical retention default is limited |
| V5a | LLM-as-judge, rubric schema, budget caps, judge cache, OpenAI-compatible adapter | 🧪 Experimental — not calibrated |
| V5b | Baselines, regression detection (two-proportion z-test), CI gates, PR comment reporter | ✅ Shipped |

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Constraint-based matching (not exact) | LLMs add harmless extra args; exact match → false failures |
| `subset` as default match mode | Useful structural default; string values are strict unless `subsetCaseInsensitive` is opted in |
| Word-boundary response matching | Prevents `"hi"` matching `"this"` — substring matching is a footgun |
| Default product prompt in canonical datasets | Canonical datasets avoid per-sample custom system prompts; use matrix overrides only for explicit prompt experiments |
| FakeDriver for CI | Fast (< 1s total), free, deterministic — tests the harness, not the model |
| AbortSignal on Driver | Timeouts abort the harness wait and trigger cleanup; provider-level call cancellation depends on SDK support |
| Async-ready Reporter | `void | Promise<void>` — Langfuse/OTel plug in without interface changes |
| Incremental JSONL writes | Crash mid-run → partial results preserved (not buffered-then-lost) |
| Specificity-ordered arg matching | Most-constrained expectations matched first → avoids greedy mis-pairing |
| Path-sanitized artifacts | `runId`/`caseId` stripped of separators → no path traversal |

## Relationship to Existing Tests

| Existing Tests (`packages/sdk/test/local/`) | Eval Harness (`packages/eval-harness/`) |
|---------------------------------------------|----------------------------------------|
| Assert **system** behavior (events fire, CMS persists, orchestration replays) | Measure **LLM** behavior (tool selection, arg accuracy, sequencing) |
| One run, hard fail | passRateFloor, statistical signal (multi-trial + matrix in V2) |
| vitest `describe`/`it` | Same runner, different semantics |
| Share: PilotSwarm SDK, CMS helpers | Share: tool definitions pattern, test env isolation |
