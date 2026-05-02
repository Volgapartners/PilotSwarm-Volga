# V4 Research: Multi-Turn and Sub-Agent Evaluation

## Executive summary

V4 should add trajectory evaluation without breaking the current V1-V3 single-turn API.

Recommendation:

1. Keep `Driver.run(sample, options) -> ObservedResult` unchanged.
2. Add a parallel `MultiTurnDriver.runTrajectory(sample, options) -> ObservedTrajectory`.
3. Add `TrajectorySample`/`TrajectoryTask` as explicit V4 schemas instead of overloading `EvalSample.input.context`.
4. Reuse existing `EvalExpected` per turn, then add trajectory-level expectations for context retention, goal completion, sub-agent topology, and lifecycle sequencing.
5. Implement deterministic tests first with a `FakeTrajectoryDriver`, then add a `LiveTrajectoryDriver` that keeps one PilotSwarm session alive across turns.

This preserves existing datasets, reporters, graders, and `MultiTrialRunner` behavior while making multi-turn cases first-class.

## Current state

The eval harness is currently case-oriented:

- `EvalTask.samples[]` contains independent `EvalSample` cases.
- `Driver.run(sample)` returns a single `ObservedResult`.
- `ObservedResult` captures one final response, one flat tool-call list, a `sessionId`, latency, CMS state, and optional V3 durability observation.
- `EvalRunner.runTask()` loops samples, runs one driver call per sample, grades with `gradeEvalCase()`, and reports `CaseResult`.
- `EvalSample.input.context` already accepts prior `{ role, content }` messages, but `LiveDriver` explicitly rejects context. That field is useful for "single response with static history" but is not enough for an interactive trajectory where the model's actual turn-1 response must become turn-2 context.
- `ScriptedDriver` composes crash/recovery steps into one `ObservedResult`, but does not represent user/assistant turns.

PilotSwarm sub-agent behavior is already observable in the SDK:

- `spawn_agent` resolves named agents, enforces nesting limits, validates model overrides, spawns child sessions, records `session.agent_spawned`, and tracks `{ orchId, sessionId, task, status, agentId }`.
- `check_agents` polls child session status and reports task/status/iterations/output.
- `wait_for_agents` stores `waitingForAgentIds` and schedules an `agent-poll` durable timer.
- Tests cover child metadata, named-agent resolution, status checking, multiple agents, model override, nested spawning, and parent-child round trips.

## External patterns

### MT-Bench / LMSYS

MT-Bench evaluates multi-turn conversational ability by running curated two-turn dialogues and judging response quality with human or strong-model judges. The key pattern is: keep a complete conversation trajectory, score each turn for response quality, and also judge whether the model preserves context and coherence across turns.

References:

- https://arxiv.org/abs/2306.05685
- https://github.com/lm-sys/FastChat

### Chatbot Arena / ChatArena

Arena-style evaluation compares two systems over the same multi-turn interaction. Votes are often collected per conversation or per turn, but the important product lesson is that a conversation is the evaluation unit; turn-level judgments are supporting evidence.

Reference:

- https://arena.lmsys.org/

### Braintrust

Braintrust's agent-evaluation guidance emphasizes evaluating whole agent trajectories, not only final answers. Scorers can inspect intermediate steps, actions, tool calls, and final outcomes. That maps well to PilotSwarm because CMS events and tool observations can be deterministic inputs to code graders.

References:

- https://www.braintrust.dev/docs
- https://www.braintrust.dev/docs/guides/evals
- https://www.braintrust.dev/docs/best-practices/scorers

### Langfuse

Langfuse models multi-step interactions as traces and attaches scores either to individual observations/spans or to the full trace. This suggests V4 should have both turn-level scores and trajectory-level scores rather than forcing everything into one flat score list.

References:

- https://langfuse.com/docs/evaluation/overview
- https://langfuse.com/docs/tracing
- https://langfuse.com/docs/scores

### OpenAI Evals

OpenAI-style evals commonly encode conversation history as message arrays and use programmable graders for task-specific checks. The lesson for PilotSwarm is to keep the fixture JSON declarative but expose a programmable TypeScript grader surface later if static matchers become insufficient.

Reference:

- https://github.com/openai/evals

### Agentic/tool-use benchmarks

ToolBench/ReAct-style evaluations score the trajectory of actions: correct tool selection, correct arguments, correct ordering, unnecessary actions, missing actions, and final answer quality. For sub-agent evals, `spawn_agent`, `check_agents`, `wait_for_agents`, and `message_agent` should be treated as first-class actions in the trajectory.

## Sample type design

Do not overload `EvalSample.input.context` for V4. It represents fixed prior context for a single prompt, not an interactive trajectory.

Add explicit trajectory schemas:

```ts
export const TrajectoryTurnInputSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  expected: EvalExpectedSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const SubAgentExpectedSchema = z.object({
  minChildren: z.number().int().nonnegative().optional(),
  maxChildren: z.number().int().nonnegative().optional(),
  children: z.array(z.object({
    agentId: z.string().optional(),
    title: z.string().optional(),
    taskContains: z.array(z.string()).optional(),
    parent: z.enum(["root", "previous-child"]).optional(),
    nestingLevel: z.number().int().nonnegative().optional(),
  })).optional(),
  requireParentLinks: z.boolean().default(true),
  requireWaitForAgents: z.boolean().optional(),
  requireCheckAgents: z.boolean().optional(),
  maxNestingDepth: z.number().int().nonnegative().optional(),
});

export const TrajectoryExpectedSchema = z.object({
  turnsPass: z.boolean().default(true),
  response: z.object({
    containsAny: z.array(z.string()).optional(),
    containsAll: z.array(z.string()).optional(),
    forbidden: z.array(z.string()).optional(),
  }).optional(),
  context: z.object({
    mustRemember: z.array(z.string()).optional(),
    mustNotInvent: z.array(z.string()).optional(),
  }).optional(),
  goal: z.object({
    containsAll: z.array(z.string()).optional(),
  }).optional(),
  subAgents: SubAgentExpectedSchema.optional(),
});

export const TrajectorySampleSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  input: z.object({
    systemMessage: z.string().optional(),
    context: z.array(EvalContextMessageSchema).optional(),
    turns: z.array(TrajectoryTurnInputSchema).min(1),
  }),
  expected: TrajectoryExpectedSchema,
  tools: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().default(300000),
});

export const TrajectoryTaskSchema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("trajectory"),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  passRateFloor: z.number().min(0).max(1).optional(),
  samples: z.array(TrajectorySampleSchema).min(1),
});
```

Example fixture:

```json
{
  "schemaVersion": 2,
  "kind": "trajectory",
  "id": "multi-turn-memory",
  "name": "Multi-turn Memory",
  "description": "Conversation state is retained across turns.",
  "version": "1.0.0",
  "samples": [
    {
      "id": "remember-color-followup",
      "description": "Agent recalls a fact from turn 1 on turn 2.",
      "input": {
        "turns": [
          {
            "id": "record-fact",
            "prompt": "Remember that my launch codename is Blue Heron.",
            "expected": {
              "response": { "containsAny": ["Blue Heron", "remember"] }
            }
          },
          {
            "id": "recall-fact",
            "prompt": "What is my launch codename?",
            "expected": {
              "response": { "containsAll": ["Blue Heron"] }
            }
          }
        ]
      },
      "expected": {
        "context": {
          "mustRemember": ["Blue Heron"]
        },
        "goal": {
          "containsAll": ["Blue Heron"]
        }
      }
    }
  ]
}
```

Sub-agent fixture:

```json
{
  "schemaVersion": 2,
  "kind": "trajectory",
  "id": "sub-agent-coordination",
  "name": "Sub-agent Coordination",
  "description": "Parent spawns, waits for, and summarizes child agents.",
  "version": "1.0.0",
  "samples": [
    {
      "id": "spawn-wait-summarize",
      "description": "Parent delegates two independent checks and waits for completion.",
      "input": {
        "turns": [
          {
            "id": "delegate",
            "prompt": "Spawn two sub-agents: one says alpha, one says beta. Wait for both and summarize."
          },
          {
            "id": "status",
            "prompt": "Check all agents and report their final outputs.",
            "expected": {
              "toolCalls": [
                { "name": "check_agents", "order": 0 },
                { "name": "wait_for_agents", "order": 1 }
              ],
              "toolSequence": "strict",
              "response": { "containsAll": ["alpha", "beta"] }
            }
          }
        ]
      },
      "expected": {
        "subAgents": {
          "minChildren": 2,
          "requireParentLinks": true,
          "requireWaitForAgents": true,
          "requireCheckAgents": true,
          "maxNestingDepth": 1
        },
        "goal": { "containsAll": ["alpha", "beta"] }
      }
    }
  ]
}
```

## Driver design

### Option A: extend `Driver.run()` to accept multi-turn

Rejected. It breaks the clean current contract and forces every existing driver, runner, grader, reporter, and test to understand trajectory semantics.

### Option B: add `MultiTurnDriver` alongside `Driver`

Recommended. It is non-breaking, keeps V4 explicit, and allows the live implementation to preserve one session across turns.

```ts
export interface MultiTurnDriverOptions extends DriverOptions {
  keepSessionOpen?: boolean;
}

export interface MultiTurnDriver {
  runTrajectory(
    sample: TrajectorySample,
    options?: MultiTurnDriverOptions,
  ): Promise<ObservedTrajectory>;
  dispose?(): Promise<void>;
}
```

Observed trajectory shape:

```ts
export const ObservedTrajectoryTurnSchema = z.object({
  turnId: z.string(),
  prompt: z.string(),
  observed: ObservedResultSchema,
});

export const ObservedSubAgentSchema = z.object({
  sessionId: z.string(),
  parentSessionId: z.string().optional(),
  agentId: z.string().optional(),
  title: z.string().optional(),
  task: z.string().optional(),
  state: z.string().optional(),
  nestingLevel: z.number().int().nonnegative().optional(),
});

export const ObservedTrajectorySchema = z.object({
  sessionId: z.string(),
  turns: z.array(ObservedTrajectoryTurnSchema),
  finalResponse: z.string(),
  latencyMs: z.number().nonnegative(),
  cmsState: z.string().optional(),
  subAgents: z.array(ObservedSubAgentSchema).optional(),
  events: z.array(z.object({
    eventType: z.string(),
    data: z.unknown().optional(),
    timestamp: z.number().optional(),
  })).optional(),
});
```

`LiveTrajectoryDriver` should:

1. Create one env, worker, client, and session for the whole sample.
2. Apply `input.context` by sending synthetic setup messages only if PilotSwarm exposes a public API for history injection. Until then, use context only in fake tests or fold it into `systemMessage` for live runs with an explicit warning.
3. For each `input.turns[]`, call `session.sendAndWait(turn.prompt, turn.timeoutMs ?? sample.timeoutMs)`.
4. After every turn, extract tool calls since the previous turn from the tracker.
5. Capture `ObservedResult` per turn.
6. Query CMS after the final turn for root session state and descendant sessions.
7. Stop client/worker/env in `finally`.

### Option C: compose existing `EvalSample`s sharing a session

Useful internally but not sufficient as the public API. The fixture format becomes awkward, and `EvalRunner` currently assumes independent samples. If used, make it an implementation detail inside `LiveTrajectoryDriver`: each turn can be lowered into a transient `EvalSample` for existing per-turn graders.

## Runner design

Add a new runner rather than complicating `EvalRunner`:

```ts
export interface TrajectoryRunnerOptions {
  driver: MultiTurnDriver;
  reporters?: TrajectoryReporter[];
  runId?: string;
  gitSha?: string;
  model?: string;
}

export class TrajectoryRunner {
  async runTask(task: TrajectoryTask): Promise<TrajectoryRunResult>;
}
```

Result types should mirror existing `RunResult`:

```ts
export interface TrajectoryCaseResult {
  caseId: string;
  pass: boolean;
  turnResults: Array<{
    turnId: string;
    pass: boolean;
    scores: Score[];
    observed: ObservedResult;
  }>;
  trajectoryScores: Score[];
  observed: ObservedTrajectory;
  infraError?: string;
  durationMs: number;
}
```

Reporters can be separate:

```ts
export interface TrajectoryReporter {
  onTrajectoryRunStart(task: TrajectoryTask, runId: string): void | Promise<void>;
  onTrajectoryCaseResult(result: TrajectoryCaseResult): void | Promise<void>;
  onTrajectoryRunComplete(result: TrajectoryRunResult): void | Promise<void>;
}
```

Keep `Reporter` unchanged. A later adapter can translate trajectory cases into existing JSONL records for compatibility, but V4 should not squeeze trajectory outputs into `CaseResult.observed`.

## Trajectory grading

Use three layers.

### 1. Per-turn graders

For each observed turn:

- Run existing `gradeEvalCase(turn.observed, turn.expected)`.
- This immediately reuses tool selection, argument matching, ordering, response matching, CMS, and durability graders.
- Prefix score names in reports with `turn:<turnId>:` only at presentation time; keep raw score names stable for aggregation.

### 2. Cross-turn deterministic graders

Add `gradeTrajectory(observed, expected)`:

- `trajectory-context-retention`: checks final or specified turns contain `mustRemember` values.
- `trajectory-no-invention`: fails if final response contains forbidden invented claims from `mustNotInvent`.
- `trajectory-goal-completion`: final response contains required outcome strings.
- `trajectory-turn-count`: observed turn count equals expected turn count.
- `trajectory-session-stability`: all turns share one root `sessionId`.

These are deterministic and belong in CI.

### 3. Sub-agent graders

Add `gradeSubAgents(observed.subAgents, observed.events, expected.subAgents)`:

- `subagent-count`: validates min/max child sessions.
- `subagent-parent-links`: every child has `parentSessionId === rootSessionId`; nested checks preserve parent chain.
- `subagent-agent-id`: expected named agents are present.
- `subagent-title`: expected title metadata is present.
- `subagent-task`: child task contains required strings.
- `subagent-max-depth`: no observed chain exceeds expected max depth.
- `subagent-wait-used`: observed tool calls/events include `wait_for_agents` after spawning when required.
- `subagent-check-used`: observed tool calls/events include `check_agents` when required.
- `subagent-sequence`: `spawn_agent` occurs before `check_agents`/`wait_for_agents`; `wait_for_agents` occurs before final summary when required.

Prefer observable runtime state over textual output. For live runs, use CMS descendants and session events. For fake runs, fixtures can provide `subAgents` and `events` directly.

### 4. Holistic / judge graders

Do not make LLM-as-judge part of the initial V4 gate. Add an extension point only:

```ts
export interface TrajectoryGrader {
  grade(observed: ObservedTrajectory, expected: TrajectoryExpected): Promise<Score[]>;
}
```

Built-in deterministic graders should be the default. A future `JudgeTrajectoryGrader` can score coherence/helpfulness when provider keys are available.

## Deterministic FakeDriver design

Add `FakeTrajectoryDriver`:

```ts
export interface FakeTrajectoryScenario {
  sampleId: string;
  response: ObservedTrajectory;
}

export class FakeTrajectoryDriver implements MultiTurnDriver {
  private scenarios: Map<string, ObservedTrajectory>;

  async runTrajectory(sample: TrajectorySample, options?: MultiTurnDriverOptions) {
    const response = this.scenarios.get(sample.id);
    if (!response) throw new Error(`FakeTrajectoryDriver: unknown sampleId "${sample.id}"`);
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (options?.signal?.aborted) {
      throw new Error(`FakeTrajectoryDriver: aborted while serving sample "${sample.id}"`);
    }
    return structuredClone(response);
  }
}
```

Use it to TDD:

- multi-turn schema parsing
- runner timeout handling
- per-turn grading composition
- context retention pass/fail
- final goal completion pass/fail
- sub-agent count pass/fail
- parent-link pass/fail
- sequence pass/fail
- nested depth pass/fail

Fake trajectories should include full observed turn data, not derive it from prompts. That keeps tests deterministic and avoids embedding model behavior in test fixtures.

## Live sub-agent observation strategy

The current eval tool tracker observes registered eval tools, not necessarily internal PilotSwarm system tools such as `spawn_agent`. V4 needs one of these observation paths:

1. Preferred: capture tool calls from session events if PilotSwarm emits tool-call events for internal tools.
2. If unavailable: subscribe to the public session event stream and persist `session.agent_spawned` plus CMS descendant metadata, then infer spawn actions from events.
3. As a targeted product enhancement: add a public management/client observation API that exposes normalized per-turn tool calls, including system tools, without importing internal SDK modules.

The TUI/portal boundary rules imply the eval harness should also avoid internal SDK imports where possible. Current `LiveDriver` already imports a SDK test helper; V4 can start similarly for test harness purposes, but the long-term direction should be public observation APIs.

## Implementation approach

### Phase 1: Types and schemas

- Add V4 schemas/types to `src/types.ts`.
- Export them from `src/index.ts`.
- Add `TrajectoryTaskSchema` with `schemaVersion: 2` and `kind: "trajectory"` to avoid ambiguity with existing V1 tasks.
- Keep `EvalTaskSchema` unchanged.

### Phase 2: Deterministic graders

- Add `src/graders/trajectory.ts`.
- Compose existing `gradeEvalCase()` per turn.
- Add cross-turn/context/goal/sub-agent deterministic graders.
- Unit-test all pass/fail paths with direct grader tests.

### Phase 3: Fake trajectory driver

- Add `src/drivers/fake-trajectory-driver.ts`.
- Add tests mirroring existing `fake-driver.test.ts`.
- Include sub-agent fake scenarios with nested parent chains.

### Phase 4: Trajectory runner

- Add `src/trajectory-runner.ts`.
- Add `TrajectoryReporter` types.
- Start with a console reporter or JSONL reporter only if needed; runner tests can assert returned result directly.
- Do not modify `EvalRunner`.

### Phase 5: Live trajectory driver

- Add `src/drivers/live-trajectory-driver.ts`.
- Keep one session alive across turns.
- Capture per-turn tool calls by deltaing the tracker.
- Query CMS descendants at the end for sub-agent metadata.
- Add live-driver tests with mocked worker/client constructors first, then a gated integration test if existing eval harness conventions allow.

### Phase 6: Datasets

Add two V4 datasets:

- `datasets/multi-turn-conversations.v1.json`
  - memory recall
  - correction across turns
  - no hallucination of missing prior detail
  - multi-step goal completion
- `datasets/sub-agent-coordination.v1.json`
  - spawn one custom child
  - spawn named agent
  - spawn multiple children
  - check status
  - wait for agents
  - nested spawn depth 2
  - depth 3 denied

### Phase 7: README

Update the eval harness README with:

- V4 trajectory architecture
- fixture examples
- fake vs live trajectory drivers
- deterministic-vs-judge grader distinction

## Key design decisions

1. `input.context` remains static single-turn history. It should not become the V4 trajectory format.
2. Multi-turn trajectory support should be additive and non-breaking.
3. Existing `EvalExpected` should be reused per turn to avoid duplicating tool/response/CMS semantics.
4. Trajectory-level expected data should model what cannot be expressed per turn: memory, goal completion, sub-agent topology, and action sequencing.
5. Deterministic code graders should be the V4 acceptance gate. LLM judges can be an optional later extension.
6. Sub-agent grading should prefer runtime observations (CMS descendants, events, tool traces) over natural-language final responses.

## Open risks

- Live observation of internal tools may not currently expose `spawn_agent`, `check_agents`, and `wait_for_agents` through the eval tool tracker. If not, V4 needs a public event/tool-call observation API or must rely on CMS/events for sub-agent checks.
- `LiveDriver` currently rejects `input.context`; `LiveTrajectoryDriver` can avoid that by using real turns rather than injecting static context.
- Multi-trial aggregation for trajectory results should be a follow-up. Do not block initial V4 on aggregate trajectory reporting; first ship deterministic single-run trajectory support.
- LLM behavior around sub-agent tool use can be model-sensitive. Fixtures should constrain prompts clearly, but tests must not compensate with custom system prompts that mask product issues.

## Recommended V4 acceptance criteria

- Existing V1-V3 tests pass unchanged.
- `TrajectoryTaskSchema` validates multi-turn and sub-agent fixtures.
- `FakeTrajectoryDriver` supports deterministic multi-turn and sub-agent scenarios.
- `TrajectoryRunner` returns per-turn and trajectory-level scores.
- Per-turn grading reuses existing `gradeEvalCase()`.
- Context retention and goal completion graders catch both pass and fail cases.
- Sub-agent graders validate child count, parent links, named metadata, wait/check usage, and nested depth.
- `LiveTrajectoryDriver` can execute at least one two-turn session against a real PilotSwarm session.
- A sub-agent V4 live scenario can observe child session metadata without importing SDK internals beyond existing test harness patterns.
