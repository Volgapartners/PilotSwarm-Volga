# Eval Harness

The PilotSwarm Eval Harness (`packages/eval-harness/`) is a production-grade evaluation system for PilotSwarm agents. It measures tool-call correctness, argument accuracy, sequencing, response quality, and session state through deterministic code graders.

## Overview

The eval harness answers: **given a prompt and available tools, does the LLM call the right tools with the right arguments in the right order?**

It is separate from the integration test suite (`packages/sdk/test/local/`). Integration tests verify system behavior (events fire, CMS persists, orchestration replays). Evals verify LLM behavior (tool selection, arg accuracy, sequencing quality).

## Running

```bash
# Fast — FakeDriver, no LLM, no .env needed
./scripts/run-tests.sh --suite=eval

# Direct
cd packages/eval-harness && npx vitest run
```

## Key Design Decisions

1. **Constraint-based matching** — `subset` is the default arg match mode, not `exact`. LLMs add harmless extra args; exact match produces false failures.
2. **Eval-owned system prompts** — each fixture specifies its own `systemMessage`. This is not "compensating for product behavior" — it's defining the system under test.
3. **FakeDriver for CI** — the default test suite uses scripted traces (no LLM calls, <1s total). LiveDriver is available for real model evaluation.
4. **Word-boundary response matching** — `containsAny`/`containsAll` use regex `\b...\b` to prevent false positives.
5. **AbortSignal cancellation** — timeouts cancel the driver, not just race against it. No leaked LLM calls.
6. **Async-ready reporters** — `void | Promise<void>` interface, ready for Langfuse without breaking changes.
7. **Incremental JSONL writes** — crash mid-run → partial results preserved.
8. **Specificity-ordered matching** — most-constrained expected calls matched first to avoid greedy mis-pairing.

## Fixture Schema

See `packages/eval-harness/src/types.ts` for the full Zod schema. Quick reference:

### EvalTask (top-level)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | `1` (literal) | ✅ | Must be `1` |
| `id` | string | ✅ | Stable task identifier |
| `name` | string | ✅ | Display name |
| `description` | string | ✅ | What this task evaluates |
| `version` | string | ✅ | Semver of the dataset |
| `passRateFloor` | number (0..1) | | Minimum pass rate for the task |
| `samples` | EvalSample[] | ✅ | At least one sample |

### EvalSample

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | ✅ | | Stable sample identifier |
| `description` | string | ✅ | | What this sample tests |
| `input.prompt` | string | ✅ | | User message to send |
| `input.systemMessage` | string | | | System prompt for the session |
| `expected.toolCalls` | EvalToolCall[] | | | Expected tool calls |
| `expected.toolSequence` | `"strict"` \| `"unordered"` | | `"unordered"` | Ordering requirement |
| `expected.forbiddenTools` | string[] | | | Tools that must NOT be called |
| `expected.noToolCall` | boolean | | | If true, asserts zero tool calls |
| `expected.minCalls` / `maxCalls` | number | | | Call count bounds |
| `expected.response.containsAny` | string[] | | | At least one must appear (word-boundary) |
| `expected.response.containsAll` | string[] | | | All must appear (word-boundary) |
| `expected.cms.stateIn` | string[] | | | CMS session state must be one of these |
| `tools` | string[] | | all | Which eval tools to register |
| `tags` | string[] | | | For filtering/grouping |
| `timeoutMs` | number | | `120000` | Per-sample timeout |

### EvalToolCall

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | | Tool name |
| `args` | object | | Expected arguments |
| `match` | `"exact"` \| `"subset"` \| `"fuzzy"` \| `"setEquals"` | `"subset"` | Matching mode |
| `order` | number | | Position in sequence (for `strict` mode) |

### Schema Invariants

The schema rejects contradictory configurations at load time:
- `noToolCall: true` + non-empty `toolCalls` → error
- `minCalls > maxCalls` → error

## Graders

| Score Name | What It Checks | Type |
|------------|---------------|------|
| `tool-names` | Were the right tools called? (multiset — handles duplicate calls) | Fractional (0..1) |
| `forbidden-tools` | Were forbidden tools avoided? | Binary |
| `call-count` | Were min/max call constraints met? | Binary |
| `no-tool-compliance` | If `noToolCall: true`, were zero tools called? | Binary |
| `tool-args:<name>` | Per expected tool call, did the arguments match? | Per match mode |
| `tool-ordering` | Were tools called in the right order? | Fractional |
| `response` | Does the final response contain expected strings? | Fractional |
| `cms-state` | Is the session in an expected CMS state? | Binary |

## Drivers

| Driver | When to Use | Requirements |
|--------|------------|--------------|
| `FakeDriver` | CI, TDD, fast iteration | None |
| `LiveDriver` | Real model evaluation | PostgreSQL + GITHUB_TOKEN |

LiveDriver limitations:
- Does not support `input.context` (multi-turn priors)
- Creates isolated test env per sample (schema isolation)
- Requires PilotSwarm SDK as peer dependency

## Reporters

| Reporter | Output | Persistence |
|----------|--------|-------------|
| `ConsoleReporter` | `✅`/`❌`/`⚠️` summary to stdout | None |
| `JsonlReporter` | `.eval-results/<runId>.jsonl` | Incremental (crash-safe) |

JsonlReporter also writes failure artifacts: `.eval-results/<runId>/<caseId>.json`

## Public API

```typescript
import {
  // Runner
  EvalRunner,
  loadEvalTask,
  loadEvalTaskFromDir,

  // Drivers
  FakeDriver,
  LiveDriver,

  // Reporters
  ConsoleReporter,
  JsonlReporter,

  // Graders (for custom pipelines)
  gradeEvalCase,
  matchArgs,

  // Fixtures (for custom tools)
  createEvalToolTracker,

  // V2: Multi-trial + matrix runners
  MultiTrialRunner,
  MatrixRunner,

  // V2: Aggregate reporters
  ConsoleAggregateReporter,
  MarkdownReporter,

  // V2: Statistical utilities
  passAtK,
  meanStddev,
  wilsonInterval,
  bootstrapCI,
  mcNemarTest,
  mannWhitneyU,
  standardNormalCdf,

  // V3: Durability
  ScriptedDriver,
  gradeDurability,

  // V4: Trajectory
  TrajectoryRunner,
  FakeMultiTurnDriver,
  gradeTrajectory,

  // V5a: LLM-as-judge
  LLMJudgeGrader,
  FakeJudgeClient,
  InMemoryJudgeCache,

  // V5b: CI gates
  saveBaseline,
  loadBaseline,
  RegressionDetector,
  CIGate,
  PRCommentReporter,

  // Types
  type EvalTask,
  type EvalSample,
  type Score,
  type RunResult,
  type Driver,
  type Reporter,

  // V2 Types
  type MultiTrialResult,
  type MultiTrialSummary,
  type SampleTrialResult,
  type MatrixResult,
  type MatrixCell,
  type MatrixConfig,
  type MatrixConfigOverrides,
  type MatrixSummary,
  type AggregateReporter,

  // V3-V5 Types
  type DurabilityObservation,
  type ScriptedScenario,
  type ScriptedStep,
  type TrajectoryTask,
  type TrajectorySample,
  type ObservedTrajectory,
  type ObservedTurn,
  type TrajectoryScore,
  type TrajectoryRunResult,
  type Rubric,
  type RubricCriterion,
  type JudgeResult,
  type JudgeCost,
  type JudgeClient,
  type JudgeCache,
  type Baseline,
  type BaselineSample,
  type RegressionResult,
  type CIGateConfig,
  type CIGateResult,
} from "pilotswarm-eval-harness";
```

## V2: Multi-Trial, Matrix, and Statistics

V2 adds statistical rigor on top of the V1 single-run runner: repeated trials with confidence intervals and pass@k, and a parameter matrix for comparing models × configs.

### MultiTrialRunner

Runs a task N times and aggregates per-sample and task-level results.

```ts
import { MultiTrialRunner, FakeDriver, ConsoleAggregateReporter } from "pilotswarm-eval-harness";

const runner = new MultiTrialRunner({
  driverFactory: () => new FakeDriver(scenarios),
  trials: 10,
  passAtKValues: [1, 5, 10],
});

const result = await runner.runTask(task);
new ConsoleAggregateReporter().onMultiTrialComplete(result);
```

`MultiTrialRunnerOptions`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `driverFactory` | `() => Driver` | ✅ | Returns a fresh driver per trial |
| `trials` | number | ✅ | Number of repetitions (≥ 1) |
| `reporters` | `Reporter[]` | `[]` | Per-trial V1 reporters |
| `concurrency` | number | `1` | Parallel trials |
| `passAtKValues` | `number[]` | `[1, 5, 10]` | `k` values to compute |
| `reporterFactory` | `() => Reporter[]` | | Required for stateful reporters when `concurrency > 1`; creates fresh reporters per trial |
| `gitSha` / `model` | string | | Passed into the nested runners |

`MultiTrialResult` shape:

- `summary`: `{ total, trials, meanPassRate, stddevPassRate, passRateCI }`
- `samples`: `SampleTrialResult[]` — per-sample `{ passRate, passCount/failCount/errorCount, passAtK, scores, wilsonCI }`
- `rawRuns`: the underlying `RunResult[]` for deeper analysis

### MatrixRunner

Sweeps models × configs for a single task. Each cell delegates to `MultiTrialRunner`.

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
});

const result = await runner.runTask(task);
new MarkdownReporter("eval-matrix.md").onMatrixComplete(result);
```

`MatrixConfig.overrides` (type `MatrixConfigOverrides`) currently supports:

- `systemMessage` — overrides each sample's `input.systemMessage`
- `timeoutMs` — overrides each sample's per-sample timeout

`MatrixResult.summary` exposes `bestPassRate` and `worstPassRate` as `{ model, configId, passRate }` refs. `MatrixResult.cells` contains the full `MultiTrialResult` for each (model × config) pair.

### Aggregate Reporters

V2 introduces a new `AggregateReporter` interface distinct from V1's per-case `Reporter`:

```ts
interface AggregateReporter {
  onMultiTrialComplete(result: MultiTrialResult): void | Promise<void>;
  onMatrixComplete(result: MatrixResult): void | Promise<void>;
}
```

| Reporter | Output |
|----------|--------|
| `ConsoleAggregateReporter` | Formatted summary (mean pass rate, CI, per-sample table, best/worst cell) |
| `MarkdownReporter` | Markdown report written to a file path — suitable for CI artifacts / PR comments |

### Statistical Utilities

Pure functions exported from `stats.ts`:

| Function | Use |
|----------|-----|
| `passAtK(results, k)` | Chen et al. unbiased `pass@k` estimator |
| `meanStddev(values)` | Sample mean + stddev + n |
| `wilsonInterval(successes, n, z?)` | Wilson score interval for binomial proportion |
| `bootstrapCI(values, alpha?, reps?, rng?)` | Bootstrap percentile CI for the mean. Defaults: `alpha=0.05`, `reps=10_000`. Returns `{ lower, upper, point, reps, alpha }`. |
| `mcNemarTest(pairs)` | McNemar's test for paired binary outcomes (regression detection). Picks exact binomial vs chi² with Yates continuity correction; returns `method` discriminator. |
| `mannWhitneyU(a, b)` | Mann-Whitney U for two independent samples |
| `standardNormalCdf(z)` | Standard normal CDF (used internally; exported for advanced custom stats) |

## V3: Crash Recovery & Durability

V3 adds first-class scoring for PilotSwarm's durable-execution guarantees. The `ScriptedDriver` injects faults at well-known points and the durability grader scores recovery against `expected.durability` constraints in the fixture.

```typescript
import {
  EvalRunner,
  ScriptedDriver,
  type ScriptedScenario,
} from "pilotswarm-eval-harness";

const scenarios: ScriptedScenario[] = [{
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
}];

const runner = new EvalRunner({ driver: new ScriptedDriver(scenarios) });
const result = await runner.runTask(taskWithDurabilityExpectations);
```

`gradeDurability` emits `crash-recovery`, `post-recovery-state`, `tool-calls-after-recovery`, `dehydration`, `hydration`, and `worker-handoff` scores. Fault points: `before_turn`, `during_tool_call`, `after_tool_call`, `after_turn`, `after_dehydrate`, `before_hydrate`. Fault modes: `worker_crash`, `tool_timeout`, `tool_throw`, `network_disconnect`. Canonical scenarios: `datasets/durability-scenarios.v1.json`.

## V4: Multi-Turn & Trajectory Evaluation

V4 grades trajectories — multi-turn conversations with per-turn, cross-turn, and holistic scoring. `TrajectoryRunner` drives a `TrajectoryTask` through a `MultiTurnDriver` and feeds the observed trajectory through `gradeTrajectory()`.

```typescript
import {
  TrajectoryRunner,
  FakeMultiTurnDriver,
  type TrajectoryTask,
} from "pilotswarm-eval-harness";

const task: TrajectoryTask = {
  schemaVersion: 1, id: "trajectory-demo", name: "...", description: "...", version: "1.0.0",
  samples: [{
    id: "remember-color",
    turns: [
      { input: { prompt: "Remember my favorite color is blue." }, expected: { noToolCall: true } },
      { input: { prompt: "What is my favorite color?" }, expected: { response: { containsAny: ["blue"] } } },
    ],
    expected: {
      goalCompleted: true,
      maxTotalToolCalls: 0,
      contextRetention: [{ term: "blue", mustAppearAfterTurn: 0 }],
    },
  }],
};

const runner = new TrajectoryRunner({
  driver: new FakeMultiTurnDriver([{ sampleId: "remember-color", trajectory: observed }]),
});
const result = await runner.runTask(task);
// result.cases[0].trajectoryScore = { turnScores, crossTurnScores, holisticScores }
```

Holistic scores include `turn-count`, `goal-completed`, `call-budget`. Cross-turn scores include `context-retention`. Canonical fixtures: `datasets/multi-turn-scenarios.v1.json`.

## V5: LLM-as-Judge + CI Gates

### V5a — LLM-as-Judge

`LLMJudgeGrader` runs a `Rubric` of criteria against a (prompt, response) pair via a pluggable `JudgeClient`. Cost is tracked per criterion and capped by `budgetUsd`; an optional `JudgeCache` (e.g. `InMemoryJudgeCache`) deduplicates by `(prompt, response, criterionId, rubricVersion, judgeId)`.

```typescript
import { LLMJudgeGrader, InMemoryJudgeCache, type Rubric } from "pilotswarm-eval-harness";

const rubric: Rubric = {
  id: "quality", name: "Quality", version: "1.0.0",
  criteria: [
    { id: "helpfulness", description: "Helpful?", scale: { min: 1, max: 5 }, passThreshold: 0.6 },
    { id: "accuracy",    description: "Accurate?", scale: { min: 1, max: 5 }, passThreshold: 0.6 },
  ],
};

const grader = new LLMJudgeGrader({
  client: judgeClient,
  rubric,
  cache: new InMemoryJudgeCache(),
  budgetUsd: 0.50,
});

const { scores, costs, totalCostUsd } = await grader.grade(prompt, response);
```

When the running cost exceeds `budgetUsd`, remaining criteria short-circuit with a `"Budget exceeded"` reason instead of being silently dropped. `JudgeResult.normalizedScore` is in `[0,1]`; `pass` is derived from `passThreshold`.

### V5b — Baselines, Regression Detection, CI Gates, PR Comments

V5b closes the loop: persist a `MultiTrialResult` as a `Baseline`, detect statistically significant regressions on the next run, gate CI on `passRateFloor`/`maxRegressions`/`maxCostUsd`, and emit a PR-ready Markdown summary.

```typescript
import { saveBaseline, loadBaseline, RegressionDetector, CIGate, PRCommentReporter } from "pilotswarm-eval-harness";

saveBaseline(currentResult, ".eval-results/baseline.json");

const baseline = loadBaseline(".eval-results/baseline.json");
const regressions = new RegressionDetector(0.05).detect(baseline, nextResult);

const gate = new CIGate({ passRateFloor: 0.8, maxRegressions: 0, maxCostUsd: 5 });
const verdict = gate.evaluate(nextResult, regressions, totalCostUsd);
process.exit(gate.exitCode(verdict));

const pr = new PRCommentReporter(".eval-results/pr-comment.md");
pr.onMultiTrialComplete(nextResult);
pr.writeGateResult(verdict, regressions);
```

`RegressionDetector` uses a two-proportion z-test on baseline vs. current pass rates (baselines persist aggregate counts, not per-sample paired outcomes); `direction` is `"regressed" | "improved" | "unchanged"`. `CIGate.evaluate()` returns `{ pass, reasons[], passRate, regressionCount, totalCostUsd }`. McNemar's test is still exported as `mcNemarTest` for callers that have paired per-sample data.

## Roadmap

| Phase | What | Status |
|-------|------|--------|
| **V1** | Runner + code graders + golden dataset | ✅ Shipped |
| **V2** | Multi-trial stats + parameter matrix (model × config) | ✅ Shipped |
| **V3** | Crash recovery + durability evals | ✅ Shipped |
| **V4** | Multi-agent + multi-turn evals | ✅ Shipped |
| **V5** | LLM-as-judge + baselines + CI gates + PR comments | ✅ Shipped |

## Related Docs

- [Eval Harness V1 Plan](proposals/eval-harness-v1-plan.md) — Phase-wise implementation plan
- [Eval Harness Design](proposals/eval-harness-design.md) — Full architecture (Phases 1-5)
- [Eval Harness Proposal](proposals/eval-harness-proposal.md) — 22-dimension evaluation framework
- [Eval Harness Research](proposals/eval-harness-research.md) — 2026 industry research
- [Eval Harness Validation](proposals/eval-harness-validation.md) — Architecture decision validation
