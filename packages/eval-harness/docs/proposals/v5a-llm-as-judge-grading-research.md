# V5a Research: LLM-as-Judge Grading

## Executive summary

V5a should add optional LLM-based response-quality grading without weakening the current deterministic grader path.

Recommendation:

1. Keep `gradeEvalCase(observed, expected) -> Score[]` as the synchronous, deterministic V1-V4 composer.
2. Add an async `LLMJudgeGrader` that runs after deterministic graders when a sample includes a judge rubric and a judge client is configured.
3. Keep real LLM calls env-gated and dependency-light by injecting a `JudgeClient`; ship `FakeJudgeClient` for deterministic tests.
4. Represent rubric criteria as Zod-validated reusable objects with explicit scale anchors and pass thresholds.
5. Add optional judge metadata to scores/results for usage, cost, cache hit, model, rubric version, and skipped/unjudged status.
6. Cache on a stable hash of `(prompt, response, rubric, judge model, prompt template version)` and include budget enforcement before every uncached judge call.

This gives PilotSwarm subjective quality, coherence, and rubric scoring while preserving CI determinism and keeping cost under operator control.

## Current state

The eval harness is currently case-oriented and code-graded:

- `EvalRunner.runTask()` executes each `EvalSample` through a `Driver`, then calls `gradeEvalCase(observed, sample.expected)`.
- `gradeEvalCase()` synchronously composes tool selection, ordering, tool argument, response containment, CMS state, and durability graders.
- `gradeResponse()` only supports deterministic `containsAny` / `containsAll` response checks.
- `Score` is normalized: `{ name, value: 0..1, pass, reason, actual?, expected? }`.
- A case passes when all scores pass: `scores.length === 0 || scores.every((s) => s.pass)`.
- Existing package dependencies are intentionally small: only `zod` at runtime.
- V4 trajectory scoring reuses the single-turn grader per turn, then adds code-based cross-turn and holistic scores.

The main design consequence: LLM judging is async and potentially unavailable, so it should not be forced into the existing sync `gradeEvalCase()` unless that function is deliberately versioned or paired with an async wrapper.

## External research

### MT-Bench / LMSYS FastChat

MT-Bench uses strong LLMs, typically GPT-4-class judges, to evaluate open-ended chat responses. It supports single-answer grading and pairwise comparison; for MT-Bench, single-answer grading gives each turn a 1-10 score and averages across turns. The paper reports GPT-4 judges can reach over 80% agreement with human preferences, comparable to human-human agreement, while also warning about position, verbosity, self-enhancement, and reasoning biases.

PilotSwarm takeaways:

- Use single-answer rubric grading for V5a; pairwise model battles can be a later V5b/V6 feature.
- Include anti-bias instructions: do not reward verbosity, formatting polish, or judge-model identity.
- For trajectories, grade per turn and optionally aggregate, rather than judging only the final answer.

References:

- https://arxiv.org/abs/2306.05685
- https://github.com/lm-sys/FastChat/tree/main/fastchat/llm_judge

### G-Eval

G-Eval evaluates NLG outputs with LLM judges using chain-of-thought-style evaluation plus form-filling. It is designed for criteria-controlled tasks such as summarization and dialogue, and reports stronger correlation with human judgments than older reference metrics. It also flags bias toward LLM-generated text.

PilotSwarm takeaways:

- Use explicit criteria and form-style structured output.
- Ask the judge to produce concise evidence/rationale, not free-form prose.
- Prefer private reasoning or short justifications over exposed chain-of-thought. The persisted artifact should be evidence and rationale, not a full hidden reasoning trace.

Reference:

- https://arxiv.org/abs/2303.16634

### Anthropic Constitutional AI / principle-based critique

Constitutional AI uses an explicit set of principles to critique and revise model outputs. While it is an alignment/training method rather than a direct eval harness API, the pattern maps well to rubrics: each criterion is a named principle with clear behavioral expectations and examples.

PilotSwarm takeaways:

- Rubrics should be reusable, versioned, and principle-like.
- Each criterion needs explicit anchors so future eval authors can calibrate what "good" means.

Reference:

- https://arxiv.org/abs/2212.08073

### RAGAS

RAGAS provides LLM-based and traditional metrics for LLM applications. Its current docs and examples emphasize prebuilt metrics, custom aspect/discrete metrics, reasons attached to scores, and integrations with observability tools.

PilotSwarm takeaways:

- Treat response quality, coherence, and task completion as reusable metrics.
- Preserve score reason strings because they make failures actionable.
- Support categorical/discrete criteria later, but normalize V5a numeric output to `Score.value`.

Reference:

- https://github.com/explodinggradients/ragas

### Braintrust

Braintrust models scorers as functions that receive `input`, `output`, `expected`, and metadata, returning scores between 0 and 1. It supports autoevals, LLM-as-judge, and custom code scorers. Its LLM scorers support span-level and trace-level scope, configurable prompts/models, choice-to-score mappings, and optional CoT for complex evaluations.

PilotSwarm takeaways:

- Mirror the scorer signature: input, output, expected/rubric, metadata.
- Support both single-response and future trace-level judging.
- Keep code graders and LLM graders as peer concepts instead of replacing code graders.

Reference:

- https://www.braintrust.dev/docs/guides/functions/scorers

### Langfuse

Langfuse describes LLM-as-a-judge as giving the model input context, output, rubric, and optional reference, then producing structured score plus reasoning. It distinguishes observation/span, trace, and experiment targets. It also emphasizes numeric, categorical, or boolean scores and notes that the judge model should support structured output.

PilotSwarm takeaways:

- V5a should target experiment samples / single observations first.
- V4 trajectory support can later map to trace-level LLM judging.
- Structured output support should be a capability of `JudgeClient`.

Reference:

- https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge

### OpenAI Evals

OpenAI Evals is a framework for evaluating LLMs and LLM systems with custom private evals and registries. It warns about API cost and encourages task-specific eval creation. The current public repo pattern is dataset plus custom grader logic.

PilotSwarm takeaways:

- Keep fixture JSON declarative, but leave room for programmable graders later.
- Cost visibility is part of the eval UX, not an afterthought.

Reference:

- https://github.com/openai/evals

## Design goals

- Preserve deterministic CI: all unit tests use `FakeJudgeClient`, never real LLM calls.
- Keep LLM judging opt-in at both fixture and runner level.
- Avoid new mandatory provider dependencies in `pilotswarm-eval-harness`.
- Make skipped/unjudged cases visible without making the entire run fail by default.
- Track usage and estimated cost for every uncached judge call.
- Make cache invalidation deterministic and auditable.
- Support single-turn response judging in V5a; leave trajectory/trace judging as a natural extension.

## Proposed API shape

### Runner integration

Add optional judge support to `RunnerOptions`:

```ts
export interface RunnerOptions {
  driver: Driver;
  reporters?: Reporter[];
  runId?: string;
  gitSha?: string;
  model?: string;

  judge?: {
    client: JudgeClient;
    defaultModel?: string;
    defaultTimeoutMs?: number;
    cache?: JudgeCache;
    budget?: JudgeBudget;
    onUnavailable?: "skip" | "fail";
  };
}
```

Then update `runCase()` conceptually:

```ts
const scores = gradeEvalCase(observed, sample.expected);

if (sample.expected.judge && this.judge) {
  const judgeScores = await this.llmJudgeGrader.grade({
    sample,
    observed,
    run: { runId: this.runId, model: this.model },
    signal: controller.signal,
  });
  scores.push(...judgeScores);
}
```

Do not make `gradeEvalCase()` async. Instead add one of:

```ts
export class LLMJudgeGrader {
  constructor(options: LLMJudgeGraderOptions);
  grade(input: LLMJudgeInput): Promise<Score[]>;
}
```

or a generic async grader interface:

```ts
export interface AsyncCaseGrader {
  name: string;
  grade(input: CaseGraderInput): Promise<Score[]>;
}
```

Recommendation: implement `LLMJudgeGrader` directly for V5a, then generalize only if another async grader appears.

### Judge client

Provider adapters should implement a tiny interface:

```ts
export interface JudgeClient {
  readonly name: string;
  grade(request: JudgeRequest, options?: JudgeCallOptions): Promise<JudgeClientResult>;
}

export interface JudgeRequest {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  responseFormat: "json";
  temperature?: number;
  maxOutputTokens?: number;
}

export interface JudgeClientResult {
  content: string;
  model: string;
  usage?: JudgeUsage;
  raw?: unknown;
}

export interface JudgeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}
```

`FakeJudgeClient` should accept a map or function:

```ts
const judge = new FakeJudgeClient({
  "sample-1:coherence": {
    criteria: [{ id: "coherence", score: 4, reason: "Clear and consistent." }],
    overall: { score: 4, reason: "Coherent." },
  },
});
```

Real clients are env-gated:

- No `judge.client` means no LLM calls.
- `OpenAIJudgeClient.fromEnv()` should throw a clear configuration error if the needed key is absent.
- Tests should not depend on provider credentials.

## Rubric schema

Add judge expectations under `EvalExpected`:

```ts
export const JudgeScaleSchema = z.object({
  min: z.number().int().default(1),
  max: z.number().int().default(5),
  passThreshold: z.number(),
});

export const JudgeAnchorSchema = z.object({
  score: z.number(),
  label: z.string().optional(),
  description: z.string().min(1),
  examples: z.array(z.string()).optional(),
});

export const JudgeCriterionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  scale: JudgeScaleSchema,
  anchors: z.array(JudgeAnchorSchema).min(2),
  weight: z.number().positive().default(1),
  required: z.boolean().default(true),
});

export const JudgeRubricSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  model: z.string().optional(),
  criteria: z.array(JudgeCriterionSchema).min(1),
  overallPassThreshold: z.number().min(0).max(1).default(0.7),
  referenceAnswer: z.string().optional(),
});

export const EvalExpectedSchema = z.object({
  // existing fields...
  judge: JudgeRubricSchema.optional(),
});
```

Example fixture:

```json
{
  "expected": {
    "response": { "containsAny": ["summary"] },
    "judge": {
      "id": "response-quality",
      "version": "1.0.0",
      "model": "gpt-4o-mini",
      "overallPassThreshold": 0.8,
      "criteria": [
        {
          "id": "coherence",
          "name": "Coherence",
          "description": "The response is internally consistent and easy to follow.",
          "scale": { "min": 1, "max": 5, "passThreshold": 4 },
          "anchors": [
            { "score": 1, "description": "Contradictory or incoherent." },
            { "score": 3, "description": "Mostly understandable, but has gaps." },
            { "score": 5, "description": "Clear, well-structured, and consistent." }
          ]
        },
        {
          "id": "task_completion",
          "name": "Task completion",
          "description": "The response directly satisfies the user's request.",
          "scale": { "min": 1, "max": 5, "passThreshold": 4 },
          "anchors": [
            { "score": 1, "description": "Does not address the task." },
            { "score": 3, "description": "Partially addresses the task." },
            { "score": 5, "description": "Fully addresses the task." }
          ]
        }
      ]
    }
  }
}
```

## Judge prompt template

Use a stable `promptTemplateVersion`, e.g. `pilotswarm-judge-v1`, because prompt changes must invalidate cache entries.

Recommended structure:

```text
System:
You are an impartial evaluator for PilotSwarm agent responses.
Score only the response quality against the provided rubric.
Do not reward verbosity, brand names, model identity, or confident tone.
Use the full scale. Apply the anchors literally.
Return valid JSON only. Do not include markdown.

User:
<task>
Original user prompt:
{{prompt}}

Optional prior context:
{{context}}

Optional reference answer:
{{referenceAnswer}}
</task>

<response_to_grade>
{{response}}
</response_to_grade>

<rubric>
{{rubricAsText}}
</rubric>

Return JSON matching this schema:
{
  "criteria": [
    {
      "id": "criterion_id",
      "score": 1,
      "reason": "brief evidence-based rationale",
      "evidence": ["short quote or observation"]
    }
  ],
  "overall": {
    "score": 1,
    "reason": "brief summary"
  }
}
```

Prompt engineering choices:

- Use `temperature: 0`.
- Require JSON only; use provider structured output when available.
- Include anchors and examples inline.
- Ask for brief evidence rather than hidden chain-of-thought.
- Make the judge score each criterion independently before overall.
- Keep all rubric text in the user message so the system message stays stable.

## Score parsing and normalization

Validate judge output with Zod:

```ts
export const JudgeCriterionResultSchema = z.object({
  id: z.string(),
  score: z.number(),
  reason: z.string().min(1),
  evidence: z.array(z.string()).optional(),
});

export const JudgeOutputSchema = z.object({
  criteria: z.array(JudgeCriterionResultSchema),
  overall: z.object({
    score: z.number(),
    reason: z.string().min(1),
  }),
});
```

Normalization:

```ts
function normalize(score: number, scale: { min: number; max: number }): number {
  if (scale.max === scale.min) return score >= scale.max ? 1 : 0;
  return Math.max(0, Math.min(1, (score - scale.min) / (scale.max - scale.min)));
}
```

Return one score per criterion plus an overall weighted score:

```ts
{
  name: "llm-judge:coherence",
  value: 0.75,
  pass: true,
  reason: "Clear and internally consistent.",
  actual: {
    rawScore: 4,
    scale: { min: 1, max: 5 },
    model: "gpt-4o-mini",
    cacheHit: false,
    usage: { inputTokens: 812, outputTokens: 133 },
    estimatedCostUsd: 0.00021
  },
  expected: criterion
}
```

Overall score:

```ts
{
  name: "llm-judge:overall",
  value: weightedNormalizedAverage,
  pass: weightedNormalizedAverage >= rubric.overallPassThreshold,
  reason: judgeOutput.overall.reason,
  expected: {
    rubricId: rubric.id,
    rubricVersion: rubric.version,
    threshold: rubric.overallPassThreshold
  }
}
```

Parsing failures should produce an unjudged marker, not a misleading zero-quality score, unless `onUnavailable: "fail"` is configured.

## Unjudged / skipped fallback

The cleanest long-term design is to add optional score status:

```ts
export const ScoreStatusSchema = z.enum(["scored", "skipped", "error"]);

export const ScoreSchema = z.object({
  name: z.string(),
  value: z.number().min(0).max(1),
  pass: z.boolean(),
  reason: z.string(),
  status: ScoreStatusSchema.default("scored").optional(),
  actual: z.unknown().optional(),
  expected: z.unknown().optional(),
});
```

Then update case pass logic:

```ts
function scoreContributesToPass(score: Score): boolean {
  return score.status !== "skipped";
}

const contributing = scores.filter(scoreContributesToPass);
const allPass = contributing.length === 0 || contributing.every((s) => s.pass);
```

Fallback policy:

- `onUnavailable: "skip"`: emit `status: "skipped"`, `pass: true`, `value: 0`, `reason: "LLM judge unavailable: ..."`; excluded from pass/fail.
- `onUnavailable: "fail"`: emit `status: "error"`, `pass: false`, `value: 0`; included in pass/fail.
- Provider timeout/rate-limit: skip by default for local exploratory runs; fail for CI if explicitly configured.
- Budget exceeded: skip by default with a `llm-judge:budget` skipped score.

If V5a wants to avoid modifying `ScoreSchema`, the fallback can omit judge scores and add `judgeUsage` / `judgeStatus` to `CaseResult`. That is less visible in existing reporters, so the optional `status` field is preferable.

## Cost tracking

Add a small usage/cost model:

```ts
export interface JudgePricing {
  model: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M?: number;
}

export interface JudgeCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estimatedUsd: number;
}

export interface JudgeBudget {
  maxCallsPerRun?: number;
  maxTokensPerRun?: number;
  maxUsdPerRun?: number;
  maxUsdPerCase?: number;
  pricing?: Record<string, JudgePricing>;
}
```

Budget enforcement:

1. Before uncached call: check call count and projected worst-case `maxOutputTokens`.
2. After call: record actual usage and estimated cost.
3. If a limit is exceeded before a call, return skipped/error score according to policy.
4. Cache hits should count as `cacheHits`, not judge calls, and should not consume budget except optional accounting fields.

Result/reporting additions:

```ts
export interface JudgeRunUsage {
  calls: number;
  cacheHits: number;
  skipped: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}
```

Add optional `judgeUsage` to `RunResult.summary` or `RunResult`, and optional per-case usage to `CaseResult`. Existing consumers remain compatible if fields are optional.

## Caching

Cache key:

```ts
sha256(stableJson({
  promptTemplateVersion: "pilotswarm-judge-v1",
  samplePrompt: sample.input.prompt,
  context: sample.input.context ?? [],
  finalResponse: observed.finalResponse,
  rubric,
  judgeModel,
  judgeClient: client.name
}))
```

Cache interfaces:

```ts
export interface JudgeCacheEntry {
  key: string;
  createdAt: string;
  requestHash: string;
  model: string;
  rubricId: string;
  rubricVersion: string;
  output: unknown;
  usage?: JudgeUsage;
}

export interface JudgeCache {
  get(key: string): Promise<JudgeCacheEntry | undefined>;
  set(key: string, entry: JudgeCacheEntry): Promise<void>;
}
```

Storage options:

- `MemoryJudgeCache`: default for tests and one-off runs.
- `FileJudgeCache`: optional, under `.eval-cache/llm-judge.jsonl` relative to the eval-harness working directory.

Invalidation:

- Any prompt template version change invalidates cache.
- Any rubric ID/version/content change invalidates cache because full rubric content is hashed.
- Any response/prompt/context/model/client change invalidates cache.
- Optional TTL can be added later, but deterministic content hashing should be the primary invalidation mechanism.

Security note: file cache may contain prompts and model responses. It should be opt-in and ignored by git.

## Model selection

Default behavior:

1. `sample.expected.judge.model`
2. `runner.options.judge.defaultModel`
3. throw/skip with clear reason

Recommended model tiers:

- CI/nightly quality gate: a strong, stable judge model.
- Local development: cheaper structured-output capable model.
- Calibration runs: two judges or one strong judge plus a sampled human review set.

Avoid judging a model with itself when possible. If the evaluated model and judge model are the same, attach a warning in `actual` and optionally require explicit `allowSelfJudge: true`.

## Deterministic testing plan

All V5a tests should use `FakeJudgeClient`.

Test cases:

- `JudgeRubricSchema` accepts valid rubric with criteria, anchors, thresholds.
- Schema rejects empty criteria, invalid scale, pass threshold outside scale, duplicate criterion IDs.
- `LLMJudgeGrader` returns criterion and overall `Score`s from fake judge JSON.
- Normalization maps 1/5 -> 0, 3/5 -> 0.5, 5/5 -> 1.
- Pass/fail respects per-criterion and overall thresholds.
- Cache hit avoids calling `FakeJudgeClient` twice.
- Cache key changes when prompt, response, rubric version/content, model, or template version changes.
- Budget exceeded returns skipped or error according to policy.
- Invalid judge JSON returns unjudged/error according to policy.
- Timeout/abort propagates to judge client and returns fallback.
- `EvalRunner` includes LLM judge scores only when both rubric and judge client are configured.
- No env vars are required for default test suite.

Do not add retries to tests. If real provider smoke tests are added, gate them behind an explicit env var such as `PILOTSWARM_EVAL_REAL_JUDGE=1` and keep them outside the default `vitest run` path.

## Implementation sequence

1. Extend `types.ts` with rubric schemas and optional score status / judge usage fields.
2. Add `src/graders/llm-judge.ts` with prompt rendering, cache key generation, parse/normalize, and fallback policy.
3. Add `src/graders/judge-client.ts` or `src/judge/types.ts` for `JudgeClient`, `JudgeCache`, usage, cost, and budget types.
4. Add `FakeJudgeClient` and `MemoryJudgeCache`.
5. Wire `EvalRunner` to run `LLMJudgeGrader` after deterministic `gradeEvalCase()`.
6. Export new schemas, types, fake client, and grader from `src/index.ts`.
7. Add deterministic tests first, then implement.
8. Optionally add an env-gated real provider adapter as a separate final step.
9. Update README with rubric fixture example, env-gated real judge usage, cache/budget notes, and "default tests never call LLMs".

## Open decisions

Recommended defaults:

- Use `onUnavailable: "skip"` by default for local runs.
- Allow CI to set `onUnavailable: "fail"` if LLM judging is part of the gate.
- Add optional `status` to `Score`; do not encode unjudged as a failing quality score.
- Ship provider-agnostic interfaces and fake client first; real provider adapter can use `fetch` to avoid mandatory SDK dependencies.
- Use `.eval-cache/llm-judge.jsonl` for file cache only when explicitly configured.

Deferred:

- Pairwise/A-B judging.
- Multi-judge consensus.
- Trace-level LLM judging for V4 trajectories.
- Human calibration workflows.
- Langfuse/Braintrust export integrations.
