# V4 Research Report: Multi-Turn and Sub-Agent Evaluation

**Status:** Research / proposal. Local-only until explicitly approved.
**Scope:** Extend eval-harness to score (a) multi-turn conversation trajectories and
(b) sub-agent coordination, while keeping V1–V3 single-turn evals intact.

---

## 1. Current state (what V4 must preserve)

- `Driver.run(sample, options) → ObservedResult` is the single-turn contract
  (`src/drivers/types.ts`).
- `EvalSample.input` already carries `context: Array<{role, content}>` for prior
  turns — but it's used as *pre-seeded history*, not an evaluated trajectory.
  The `LiveDriver` currently throws when `context` is non-empty
  (`live-driver.ts:35-39`), so no production consumer relies on it yet. That
  field is free real estate for V4.
- `ObservedResult` is single-shot: `toolCalls`, `finalResponse`, `sessionId`,
  `cmsState`, `durability?`. It has no notion of a turn index.
- Graders all consume `(ObservedResult, EvalExpected) → Score[]`.
- `EvalRunner.runCase` calls `driver.run(sample)` once, then
  `gradeEvalCase(observed, sample.expected)` once. Nothing assumes multi-turn.
- Sub-agent semantics in the runtime (`packages/sdk/src/orchestration.ts`)
  are: `spawn_agent`, `check_agents`, `wait_for_agents`, `message_agent`,
  `MAX_SUB_AGENTS`, `MAX_NESTING_LEVEL`. Child sessions are first-class rows
  in CMS with `parentSessionId`, `agentId`, `title`.

**Design constraint:** V1–V3 samples must continue to pass unmodified. V4 is
additive — new types, new drivers, new graders, new grader entry point. No
breaking changes to `EvalSample`, `ObservedResult`, or `Driver`.

---

## 2. Prior art (web research synthesis)

| Framework | Multi-turn model | Scoring model | Takeaway for V4 |
|---|---|---|---|
| **MT-Bench** (LMSYS) | Fixed 2 turns; turn-2 probes context retention | LLM-as-judge scores turn-1 and turn-2 *separately* | Turn-level scores matter more than a single holistic score; turn-2 is where memory failures show up. |
| **AgentBench / ToolBench** | N-turn trajectories with tool use | Step-wise correctness + global goal achievement + error taxonomy | Need both per-turn and trajectory-level graders, plus explicit error categorization. |
| **OpenAI Evals (chat completions)** | `input` is a list of messages; evals replay the conversation | Graders receive the full completion list | Simplest useful primitive: a sample *is* a sequence of user turns; the driver produces a matching sequence of assistant observations. |
| **Braintrust / Langfuse** | "Dataset row = conversation"; `input` is `messages[]`, `expected` is `messages[]` or per-turn rubric | Custom scorers over the full trajectory, with helpers for per-turn containment and tool-call match | Trajectory = first-class object; scorers compose (per-turn + cross-turn). |
| **AutoGen / CrewAI** | Judge/critic agent evaluates sub-agent spawning, tool use, coordination | Rubric with explicit "was sub-agent spawning justified?" criterion | For sub-agent evals, score: (1) spawn correctness, (2) child metadata, (3) coordination primitives (check/wait), (4) goal completion by parent. |

**Consensus patterns worth copying:**

1. A multi-turn sample declares a **list of user turns**, each with its own
   expected tool calls / response containment.
2. The driver returns a **list of per-turn observations** plus an optional
   trajectory-level summary.
3. Graders split into three buckets:
   - **Per-turn graders** reuse the existing single-turn graders.
   - **Cross-turn graders** check context retention / no-forgetting /
     no-hallucination-of-prior-state.
   - **Holistic graders** (optional) check goal completion, coherence.
4. Sub-agent evals are modeled as **structural assertions over child
   observations** — not a separate paradigm; they're a specialization of
   trajectory eval where one "turn" produces children.

---

## 3. Design decisions

### 3.1 Sample type — extend, don't fork

**Recommendation:** Add an optional `turns[]` field to `EvalSample`. Keep
`input.prompt` for single-turn (V1–V3) and treat `turns` as the multi-turn
switch.

**Why not a separate `MultiTurnEvalSample`:** forces the runner, loader,
reporters, and matrix config to branch on sample type everywhere. A union
type balloons the surface area for little benefit. The runner can decide
"multi-turn" from `sample.turns?.length > 0` and dispatch internally.

**Why not reuse `input.context`:** `context` is *pre-seeded history* (turns
that already happened, feeding the model as background), while V4 turns are
*live user turns the driver must actually send sequentially*. They're
semantically different — context is input state, turns are script. A test may
legitimately use both (pre-seed 3 turns of prior conversation, then run 4 new
turns).

```ts
// types.ts additions (all optional → fully backward compatible)

export const EvalTurnSchema = z.object({
  id: z.string().min(1),                  // e.g. "t1", "t2"
  prompt: z.string(),                     // user message for this turn
  expected: EvalExpectedSchema.optional(), // per-turn expectations (same shape)
  // Optional synthetic delay between turns (useful for timer/dehydration evals)
  delayMsBefore: z.number().int().nonnegative().optional(),
});
export type EvalTurn = z.infer<typeof EvalTurnSchema>;

export const TrajectoryExpectedSchema = z.object({
  // Cross-turn checks
  contextRetention: z.object({
    // Facts from earlier turns the final response (or any later turn) must reference
    mustRecall: z.array(z.string()).optional(),
    // Facts the model must NOT contradict or re-ask for
    mustNotForget: z.array(z.string()).optional(),
  }).optional(),
  // Tool-call budget across all turns
  totalMaxCalls: z.number().int().nonnegative().optional(),
  // Holistic goal — final response must satisfy this (same shape as per-turn response)
  goal: z.object({
    containsAll: z.array(z.string()).optional(),
    containsAny: z.array(z.string()).optional(),
  }).optional(),
  // Sub-agent structural assertions (see §3.5)
  subAgents: SubAgentExpectedSchema.optional(),
});
export type TrajectoryExpected = z.infer<typeof TrajectoryExpectedSchema>;

// EvalSample gains two optional fields
export const EvalSampleSchema = z.object({
  // ... existing fields ...
  turns: z.array(EvalTurnSchema).optional(),
  trajectory: TrajectoryExpectedSchema.optional(),
});
```

**Runner dispatch rule:**
- `sample.turns` empty/absent → single-turn path (unchanged).
- `sample.turns` non-empty → multi-turn path. `sample.input.prompt` is
  ignored (warn on load if both are set); `sample.expected` is ignored in
  favor of per-turn `turns[i].expected` + `sample.trajectory`.

### 3.2 Driver — new `MultiTurnDriver` interface (Option B)

**Recommendation:** Option **B** — new `MultiTurnDriver` interface alongside
`Driver`. Keep `Driver` untouched. Provide an adapter so every
`MultiTurnDriver` *is also* a `Driver` (by treating a single prompt as a
one-turn trajectory).

**Why B over A:** Option A (extend `Driver.run`) breaks every existing
driver and every caller; it also muddies the signature — a single-turn
driver shouldn't need to know about turns. Option C (trajectory as
composed `EvalSamples`) is tempting because it "just reuses" existing
pieces, but the session-lifecycle problem kills it: V1's `LiveDriver`
creates and tears down a whole worker/client/env per `run()`. You cannot
share a session across V1 `run()` calls without rewriting the driver. A
`MultiTurnDriver` that owns the session across turns is cleaner and matches
how every other eval harness models this.

```ts
// src/drivers/types.ts additions

export interface TurnObservation {
  turnId: string;
  prompt: string;                 // echo back the prompt for reporter UX
  toolCalls: ObservedToolCall[];  // tool calls emitted during this turn
  response: string;               // assistant response for this turn
  cmsStateAfter?: string;         // CMS state snapshot after turn completes
  latencyMs: number;
}

export interface ObservedTrajectory {
  sessionId: string;
  model?: string;
  turns: TurnObservation[];       // one per EvalTurn, in order
  // Aggregated across all turns, for grader convenience (not a separate source of truth)
  finalResponse: string;          // last turn's response
  totalToolCalls: ObservedToolCall[]; // flattened, order preserved
  totalLatencyMs: number;
  cmsStateFinal?: string;
  // Sub-agent structural observation (populated if children were spawned)
  subAgents?: SubAgentObservation;
}

export interface MultiTurnDriver {
  runTrajectory(sample: EvalSample, options?: DriverOptions): Promise<ObservedTrajectory>;
  dispose?(): Promise<void>;
}

// Adapter — lets any MultiTurnDriver also satisfy Driver for the single-turn path.
export function asDriver(mtd: MultiTurnDriver): Driver {
  return {
    async run(sample, options) {
      const singleTurnSample = sample.turns?.length
        ? sample
        : {
            ...sample,
            turns: [{ id: "t1", prompt: sample.input.prompt, expected: sample.expected }],
          };
      const traj = await mtd.runTrajectory(singleTurnSample, options);
      const last = traj.turns[traj.turns.length - 1];
      return {
        toolCalls: traj.totalToolCalls,
        finalResponse: last?.response ?? "",
        sessionId: traj.sessionId,
        model: traj.model,
        latencyMs: traj.totalLatencyMs,
        cmsState: traj.cmsStateFinal,
      };
    },
    dispose: mtd.dispose?.bind(mtd),
  };
}
```

### 3.3 Driver implementations

#### `FakeMultiTurnDriver` (deterministic, unit-test friendly)

Mirrors `FakeDriver`. Each sample maps to a pre-baked `ObservedTrajectory`.
Zero I/O, no session, pure in-memory. Used for grader unit tests and
contract tests.

```ts
export class FakeMultiTurnDriver implements MultiTurnDriver {
  constructor(private scenarios: Map<string, ObservedTrajectory>) {}
  async runTrajectory(sample, options) {
    const t = this.scenarios.get(sample.id);
    if (!t) throw new Error(`FakeMultiTurnDriver: unknown sample "${sample.id}"`);
    if (options?.signal?.aborted) throw new Error("aborted");
    return structuredClone(t);
  }
}
```

#### `ScriptedMultiTurnDriver` (V4 extension of V3 ScriptedDriver)

Extend the step vocabulary to include per-turn scripting and sub-agent
events. Reuses the crash/recover composition from V3.

```ts
type ScriptedTurnStep =
  | { type: "turn"; turnId: string; response: TurnObservation }
  | { type: "spawn_child"; childId: string; agentId?: string; title?: string; parentTurnId: string }
  | { type: "child_complete"; childId: string; finalResponse?: string }
  | { type: "crash"; faultPoint: DurabilityFaultPoint; faultMode: DurabilityFaultMode }
  | { type: "recover"; postRecoveryTurn?: TurnObservation };
```

The driver folds `ScriptedTurnStep[]` into an `ObservedTrajectory` +
optional `SubAgentObservation` + optional `DurabilityObservation`. This is
the workhorse for deterministic trajectory tests (including crash-mid-
trajectory scenarios).

#### `LiveMultiTurnDriver` (real runtime)

Owns a single `PilotSwarmClient`/`PilotSwarmWorker`/session across all
turns — the bit V1's `LiveDriver` cannot do today.

```ts
// Sketch
async runTrajectory(sample, options) {
  const env = envFactory(`eval_${sample.id}`);
  const worker = new PilotSwarmWorker({ ... });
  worker.registerTools(selectedTools);
  await worker.start();
  const client = new PilotSwarmClient({ ... });
  await client.start();

  const session = await client.createSession({ systemMessage, model, toolNames });
  worker.setSessionConfig(session.sessionId, { ... });

  const turns: TurnObservation[] = [];
  const { tracker, tools } = createEvalToolTracker();

  try {
    for (const t of sample.turns ?? []) {
      if (options?.signal?.aborted) throw new Error("aborted");
      if (t.delayMsBefore) await sleep(t.delayMsBefore);

      const toolCallsBefore = extractObservedCalls(tracker).length;
      const start = Date.now();
      const response = await session.sendAndWait(t.prompt, options?.timeout);
      const latencyMs = Date.now() - start;
      const allCalls = extractObservedCalls(tracker);
      const turnCalls = allCalls.slice(toolCallsBefore); // new calls this turn
      const info = await session.getInfo().catch(() => null);

      turns.push({
        turnId: t.id,
        prompt: t.prompt,
        toolCalls: turnCalls,
        response: response ?? "",
        cmsStateAfter: info?.state,
        latencyMs,
      });
    }

    // If sample.trajectory.subAgents is set, snapshot the child tree via catalog
    const subAgents = sample.trajectory?.subAgents
      ? await snapshotSubAgents(catalog, session.sessionId)
      : undefined;

    return {
      sessionId: session.sessionId,
      turns,
      finalResponse: turns.at(-1)?.response ?? "",
      totalToolCalls: turns.flatMap(t => t.toolCalls),
      totalLatencyMs: turns.reduce((s, t) => s + t.latencyMs, 0),
      cmsStateFinal: turns.at(-1)?.cmsStateAfter,
      subAgents,
      model: options?.model,
    };
  } finally {
    // same teardown as LiveDriver
  }
}
```

**Key detail:** the tool tracker is scoped to the session, so per-turn
tool-call slicing is simply `[tracker.calls.length_before, …length_after]`.
No new instrumentation needed for V4 per-turn tool isolation.

### 3.4 Grader — trajectory entry point

**Recommendation:** Add `gradeTrajectory(trajectory, sample)` that composes
the existing single-turn graders per turn and adds cross-turn / holistic /
sub-agent graders. Keep `gradeEvalCase` unchanged and untouched by V4 —
`runCase` picks the grader based on `sample.turns`.

```ts
// src/graders/trajectory.ts

export function gradeTrajectory(
  observed: ObservedTrajectory,
  sample: EvalSample,
): Score[] {
  const scores: Score[] = [];
  const turns = sample.turns ?? [];

  // 1. Per-turn graders — reuse V1-V3 logic. Prefix score names with turnId.
  for (let i = 0; i < turns.length; i++) {
    const expected = turns[i].expected;
    if (!expected) continue;
    const observedTurn = observed.turns[i];
    if (!observedTurn) {
      scores.push({
        name: `${turns[i].id}/missing`,
        value: 0, pass: false,
        reason: `Expected turn ${turns[i].id} but driver produced only ${observed.turns.length} turn(s)`,
      });
      continue;
    }
    // Synthesize a single-turn ObservedResult so we can reuse gradeEvalCase.
    const synthetic: ObservedResult = {
      toolCalls: observedTurn.toolCalls,
      finalResponse: observedTurn.response,
      sessionId: observed.sessionId,
      latencyMs: observedTurn.latencyMs,
      cmsState: observedTurn.cmsStateAfter,
    };
    const turnScores = gradeEvalCase(synthetic, expected);
    for (const s of turnScores) scores.push({ ...s, name: `${turns[i].id}/${s.name}` });
  }

  // 2. Cross-turn: context retention
  if (sample.trajectory?.contextRetention) {
    scores.push(...gradeContextRetention(observed, sample.trajectory.contextRetention));
  }

  // 3. Budget: total tool calls
  if (sample.trajectory?.totalMaxCalls !== undefined) {
    const n = observed.totalToolCalls.length;
    const pass = n <= sample.trajectory.totalMaxCalls;
    scores.push({
      name: "trajectory/call-budget",
      value: pass ? 1 : 0, pass,
      reason: pass ? `${n} total calls within budget` : `${n} calls exceeds ${sample.trajectory.totalMaxCalls}`,
      actual: n, expected: sample.trajectory.totalMaxCalls,
    });
  }

  // 4. Holistic goal
  if (sample.trajectory?.goal) {
    const s = gradeResponse(observed.finalResponse, sample.trajectory.goal);
    if (s) scores.push({ ...s, name: "trajectory/goal" });
  }

  // 5. Sub-agent assertions
  if (sample.trajectory?.subAgents) {
    scores.push(...gradeSubAgents(observed.subAgents, sample.trajectory.subAgents));
  }

  return scores;
}
```

**Context-retention grader:** checks that every `mustRecall` token appears
in at least one turn *after* the turn that introduced it. `mustNotForget`
checks that the model never re-asks for a fact it was already given (a weak
proxy — the real signal is "did the final turn contradict an earlier
turn", which is better done by LLM-as-judge; for deterministic scoring we
keep it substring-based and flag the limitation).

### 3.5 Sub-agent eval

Sub-agent evals are a specialization of trajectory eval, not a parallel
paradigm. The parent's `runTrajectory` produces a `SubAgentObservation`
snapshot from CMS after the parent's turns complete.

```ts
// types.ts

export const SubAgentExpectedSchema = z.object({
  minCount: z.number().int().nonnegative().optional(),
  maxCount: z.number().int().nonnegative().optional(),
  // Expected children — each entry matched against some observed child
  children: z.array(z.object({
    agentId: z.string().optional(),       // if set, must match child.agentId
    titleContains: z.string().optional(), // substring on title
    terminalStateIn: z.array(z.string()).optional(), // e.g. ["completed"]
    minToolCalls: z.number().int().nonnegative().optional(),
    responseContains: z.array(z.string()).optional(),
    // Recursive: expected grandchildren
    children: z.lazy(() => z.array(SubAgentChildExpectedSchema)).optional(),
  })).optional(),
  // Parent-side: check_agents / wait_for_agents was actually called
  requireCoordinationCalls: z.object({
    checkAgents: z.boolean().optional(),
    waitForAgents: z.boolean().optional(),
  }).optional(),
  maxDepth: z.number().int().positive().optional(),
});

export const SubAgentObservationSchema = z.object({
  children: z.array(z.object({
    sessionId: z.string(),
    parentSessionId: z.string(),
    agentId: z.string().optional(),
    title: z.string().optional(),
    terminalState: z.string().optional(),
    toolCalls: z.array(ObservedToolCallSchema),
    finalResponse: z.string().optional(),
    depth: z.number().int().nonnegative(),  // 1 = direct child of sample root
    children: z.lazy(() => z.array(SubAgentChildObservationSchema)).optional(),
  })),
  coordinationCalls: z.object({
    checkAgents: z.number().int().nonnegative(),
    waitForAgents: z.number().int().nonnegative(),
    spawnAgent: z.number().int().nonnegative(),
  }),
});
```

**Observation capture (`LiveMultiTurnDriver`):**
1. After the final turn, query CMS via `catalog.getDescendantSessionIds(root)`
   (already exists — used by sub-agent integration tests).
2. Build the tree by joining on `parentSessionId`.
3. For each child, pull tool calls from its duroxide trace (same extraction
   path as `extractObservedCalls`) and `finalResponse` from CMS.
4. Count `spawn_agent`/`check_agents`/`wait_for_agents` occurrences in the
   root session's tool calls.

**Grader (`gradeSubAgents`):**
- Count match against `minCount`/`maxCount`.
- For each `expected.children[i]`, find a matching observed child (greedy,
  most-constrained first, same strategy as `match-args.ts`). Score per
  match: agentId, title substring, terminal state, tool-call floor,
  response containment.
- Depth check: any observed depth > `maxDepth` → fail.
- Coordination calls: if `requireCoordinationCalls.checkAgents` is true,
  `coordinationCalls.checkAgents ≥ 1`.
- Recursive: if an expected child declares its own `children`, recurse.

### 3.6 Runner integration

`EvalRunner.runCase` becomes a two-line dispatcher:

```ts
private async runCase(sample: EvalSample): Promise<CaseResult> {
  if (sample.turns && sample.turns.length > 0) return this.runMultiTurnCase(sample);
  return this.runSingleTurnCase(sample);   // existing body, renamed
}
```

`runMultiTurnCase`:
- Requires the driver to be (or adapt to) a `MultiTurnDriver`. A small
  runtime guard: `if ("runTrajectory" in this.driver) … else throw`.
- Same timeout / `AbortController` / reporter hooks as single-turn.
- Grader is `gradeTrajectory(observed, sample)`.
- `CaseResult.observed` keeps its current `ObservedResult` shape for back-
  compat in reporters — we flatten the trajectory exactly the way
  `asDriver()` does, and attach the full trajectory under a new optional
  `observedTrajectory?: ObservedTrajectory` field on `CaseResult`. JSONL
  reporters that ignore unknown fields stay happy; V4-aware reporters pick
  it up.

### 3.7 Deterministic testing story

For every new grader and driver, the test path is the same as V1–V3:

1. **Hand-built `ObservedTrajectory`** fixture in the test file.
2. `FakeMultiTurnDriver.fromMap({ sampleId: trajectory })` wired into the
   runner.
3. Assert exact score shape.

For sub-agent evals specifically, tests use `ScriptedMultiTurnDriver` with
`spawn_child` / `child_complete` steps — no real worker, no real CMS. The
`LiveMultiTurnDriver` gets its own smoke test (one sample, one turn,
default model) behind the same `preflightChecks` gate the sub-agent SDK
tests use.

Golden file: `test/fixtures/multi-turn-snapshot.json` captures the scored
output of a canonical 3-turn + 1-child-spawn trajectory so grader changes
surface in diff.

---

## 4. Implementation plan (phased, TDD)

Each phase ships RED → GREEN → REFACTOR, with no commits until the user
approves.

### Phase 4.1 — Types and schemas (no behavior change)
- Add `EvalTurn`, `TrajectoryExpected`, `SubAgentExpected/Observation`
  schemas to `types.ts`.
- Add optional `turns`, `trajectory` to `EvalSampleSchema`.
- Extend `CaseResult` with optional `observedTrajectory`.
- Tests: schema round-trip, optionality (V1 samples still parse).

### Phase 4.2 — `MultiTurnDriver` interface + `FakeMultiTurnDriver`
- Add `src/drivers/multi-turn-types.ts` (or expand `types.ts`).
- Implement `FakeMultiTurnDriver` and `asDriver()` adapter.
- Tests: fake driver round-trips trajectories, adapter preserves V1
  contract.

### Phase 4.3 — Trajectory grader
- Implement `gradeTrajectory`, `gradeContextRetention`, and
  sub-agent-free path (no `subAgents` observation yet).
- Tests: per-turn score name prefixing, missing-turn handling, context
  recall hits/misses, call-budget enforcement, goal containment.

### Phase 4.4 — Runner dispatch
- `runCase` dispatches by `sample.turns`.
- `runMultiTurnCase` mirrors `runSingleTurnCase` with timeout / abort /
  reporter parity.
- Tests: runner calls right grader, runner surfaces infra errors, runner
  honors timeout mid-trajectory.

### Phase 4.5 — `ScriptedMultiTurnDriver`
- Extend V3 scripted step vocabulary.
- Tests: crash-mid-trajectory scenarios compose a valid trajectory with
  `durability` populated; recovery produces a post-recovery turn.

### Phase 4.6 — Sub-agent observation + grader
- Implement `snapshotSubAgents(catalog, rootSessionId)` (reuses
  `getDescendantSessionIds`).
- Implement `gradeSubAgents` (with recursion, depth check, coordination
  calls).
- `ScriptedMultiTurnDriver` gains `spawn_child`/`child_complete` steps.
- Tests: matching, min/max count, depth cap, coordination-call
  requirement, recursive grandchild matching.

### Phase 4.7 — `LiveMultiTurnDriver`
- New file, owns session lifecycle across turns.
- Tool-tracker slicing per turn.
- Optional sub-agent snapshot post-trajectory.
- Tests: one-turn smoke (parity with `LiveDriver`), two-turn context
  retention smoke, one-spawn smoke — all behind `preflightChecks`.

### Phase 4.8 — Fixtures + docs
- Add example `multi-turn.task.json` and `sub-agents.task.json` to
  `test/fixtures/`.
- Update `docs/` with V4 usage.

---

## 5. Open questions for review

1. **Per-turn expected tools list.** Should `EvalTurn` allow overriding the
   session's tool list per turn? The runtime supports changing
   `toolNames` between turns via `setSessionConfig`, but most tests won't
   need it. *Proposal:* keep it out of V4.1; revisit if a real test wants
   it.
2. **Streaming / interim observations.** Multi-turn could expose
   interim-response events for long-running turns. *Proposal:* not in V4.
   Reporter-level streaming stays a V5 concern.
3. **Context-retention grading quality.** Substring-based retention
   grading is known-weak. *Proposal:* ship the substring grader in V4 and
   add an optional `llmJudge` hook in V5 (parallel to how durability
   shipped deterministic first, LLM-judge later).
4. **Sub-agent `message_agent`.** Do we evaluate parent↔child messaging?
   *Proposal:* out of scope for V4; add `messageExchanges[]` to
   `SubAgentObservation` in a follow-up once there's a concrete eval that
   needs it.
5. **Reporter changes.** JSONL + HTML reporters currently print a single
   response. Multi-turn should render turn-by-turn. *Proposal:* reporters
   read `observedTrajectory` when present; otherwise fall back to the
   flattened `observed`. No reporter API break.

---

## 6. Summary — recommended V4 shape

- `EvalSample` gains optional `turns[]` and `trajectory`; no V1 breakage.
- New `MultiTurnDriver` interface with `runTrajectory()`; existing `Driver`
  untouched; `asDriver()` adapter for backwards compat.
- Three drivers: `FakeMultiTurnDriver` (unit), `ScriptedMultiTurnDriver`
  (deterministic crash / sub-agent scenarios), `LiveMultiTurnDriver` (real
  runtime, session lifecycle owned).
- New `gradeTrajectory` composes existing graders per turn, adds
  cross-turn context retention, holistic goal, and sub-agent structural
  assertions.
- Sub-agent eval is a subset of trajectory eval — one new observation type
  (`SubAgentObservation`, sourced from CMS descendants) and one new grader
  (`gradeSubAgents`, recursive).
- Runner dispatches on `sample.turns`. Everything else — reporters,
  matrix, multi-trial, stats — keeps working because V4 preserves the
  existing single-turn contract via the adapter.

No V1–V3 test needs to change. V4 is purely additive.
