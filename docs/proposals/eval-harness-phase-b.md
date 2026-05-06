# Eval Harness Phase B — Production-Grade Coverage of PilotSwarm SDK

**Status:** Proposed — gated on Phase A completion + LIVE smoke green
**Scope:** `packages/eval-harness/` — replace remaining stub paths with real LIVE evidence + add eval coverage for every untested SDK capability
**Predecessor:** Phase A (clarity + warnings on fixture-only durability surface)
**Branch:** `feat/eval-harness`
**Author:** Claude Code session, authorized 2026-05-06

---

## Goal

Today's harness:
- Real on: tool selection, response, CMS state, durability worker-handoff (LIVE), regression detection, baselines, judge plumbing, OpenAI judge client, PilotSwarm judge client.
- Stub or absent: real-chaos durability, swarm/multi-agent eval, facts-store eval, knowledge-index (RAG) eval, streaming, per-tool cost attribution, semantic response grading.

Phase B closes those gaps. Each suite must produce real LLM calls + real CMS events + real graders. No fixture playback. No tautologies. Maintainer-demoable.

---

## Sequence (highest demo-value first)

| # | Suite | Hours | LLM Cost (rough) | Demo Value |
|---|---|---:|---:|---|
| B8 | Swarm / multi-agent | 4-5 | ~$3-5 | ⭐⭐⭐⭐⭐ pilotswarm differentiator |
| B7 | Real chaos durability | 3-4 | ~$2-3 | ⭐⭐⭐⭐ closes original tautology |
| B10 | Knowledge-index RAG | 3-4 | ~$2-4 | ⭐⭐⭐⭐ RAG is table stakes |
| B9 | Facts-store | 2-3 | ~$1-2 | ⭐⭐⭐ persistence proof |
| B12 | Per-tool cost attribution | 2-3 | ~$0.50 | ⭐⭐ ops visibility |
| B13 | Semantic judge fallback | 2-3 | ~$2-3 | ⭐⭐ quality polish |
| B11 | Streaming response | 3-4 | ~$2-3 | ⭐ may need SDK surface |

**Total:** ~20-25 hours engineering, ~$15-30 LLM cost across verification runs. Plus residual gates: PG saturation budget, parallel-pollution guard, and DB cleanup.

---

## B7 — Real chaos durability replaces fixture grader scoring

### Problem

`DurabilityFixtureDriver` derives `recovered` from JSON script structure (`scripted-driver.ts:78-90`), not runtime. Phase A added warnings + docstrings but the path still exists for `gradeDurability` to score fixture-derived observations. CIGate baselines + matrix cells can still target the fixture path.

### Build

Pick one:

**(a) Real chaos hook on ChaosDriver** *(recommended)*
- Extend `ChaosDriverOptions` with `realKill: { signal: "SIGKILL" | "SIGTERM"; timing: "before-tool" | "during-tool" | "after-tool" }`
- `beforeRunHook` resolves SDK worker handle, fires kill at chosen point
- `LiveDriver` inner driver, observes survival + replay through CMS
- New `test/chaos-live.test.ts` — 3-5 tests, real workers killed, real handoff verified

**(b) Hard-block fixture path for production scoring**
- `DurabilityObservation` gains `source: "fixture" | "live"`
- `gradeDurability` throws if `source === "fixture"` and called from CIGate context
- Fixture path becomes test-only

Recommend (a) — actual chaos engineering, no defensive guards.

### Files
- `src/drivers/chaos-driver.ts` — extend options
- `src/drivers/live-driver.ts` — surface worker handle for kill
- `test/chaos-live.test.ts` — new

### Acceptance
- 3 tests killing real workers SIGKILL, observe `worker.respawned` CMS event, session resumes on second worker, CMS event log contains distinct `workerNodeId`s.

---

## B8 — Swarm / multi-agent eval suite

### Problem

SDK exposes `spawn_agent` tool + child sessions. Today's coverage = 1 manual smoke at `live-driver-live.test.ts:139`. Zero systematic eval. Pilotswarm's marquee feature is untested.

### Build

New `test/swarm-live.test.ts`:
- **Fan-out test:** parent agent spawns 3 children, each computes math, parent aggregates results
- **Sequential handoff:** parent passes context to child, child completes, returns to parent with new state
- **Tool inheritance:** child has subset of parent's tools; assert child cannot call parent-only tool
- **Failure isolation:** one child errors, sibling children + parent continue

New grader `src/graders/swarm.ts`:
- `gradeChildHandoff(observed, expected)` — checks parent↔child CMS message flow integrity
- Asserts: distinct child `sessionId`s present in CMS, parent CMS sees `child.completed` event per child, aggregate response references each child output

New dataset `datasets/swarm-scenarios.v1.json` with 4-6 scenarios.

### Files
- `test/swarm-live.test.ts` — new
- `src/graders/swarm.ts` — new
- `datasets/swarm-scenarios.v1.json` — new
- `src/types.ts` — `SwarmExpected` Zod schema
- `src/index.ts` — export `gradeSwarm`

### Acceptance
- 4-6 LIVE tests pass with real LLM calls
- CMS event log shows parent-child relationship via `parentSessionId` field
- Grader correctly fails if child output missing from parent aggregation

---

## B9 — Facts-store eval suite

### Problem

SDK exposes `facts-tools` (durable named-fact store). Zero eval coverage.

### Build

New `test/facts-live.test.ts`:
- **Write-then-read:** session A writes `{user_pref: "blue"}`, session B (same user) reads it, response contains "blue"
- **Overwrite:** session writes key twice, second value wins
- **Missing key:** read non-existent fact, agent says "I don't know" not hallucinated value
- **List/enumerate:** if SDK supports, eval lists all facts and asserts shape

CMS evidence: `facts.write` and `facts.read` events present and ordered.

### Files
- `test/facts-live.test.ts` — new
- `datasets/facts-scenarios.v1.json` — new
- `src/graders/facts.ts` — small helper grader for fact persistence

### Acceptance
- 4 LIVE tests, real DB persistence verified, distinct sessions read each other's writes

---

## B10 — Knowledge-index (RAG) eval suite

### Problem

SDK exposes `knowledge-index.ts` semantic retrieval. Zero eval coverage. Critical for any RAG deployment. Without this, hallucination grounding is unmeasured.

### Build

New `test/knowledge-live.test.ts`:
- **Seeded retrieval:** index 5 docs with canary fact ("CEO of NorthernRoad is Jane Lin"), agent answers question, grader asserts response contains "Jane Lin" AND CMS shows `knowledge.query` event hit the canary doc
- **Negative test:** ask question whose answer NOT in index, agent must say "I don't know" — grader uses semantic judge (PilotSwarmJudgeClient) to detect hallucination
- **Multi-doc synthesis:** answer requires combining facts from 2 indexed docs
- **Stale index:** doc updated after agent reads cached version, assert agent reads fresh

### Files
- `test/knowledge-live.test.ts` — new
- `datasets/knowledge-scenarios.v1.json` + seed corpus
- `test/fixtures/knowledge-corpus/` — small fixture corpus (5-10 docs)
- `src/graders/knowledge.ts` — grader checking retrieval evidence in CMS

### Acceptance
- 4 LIVE tests, indexed docs verifiable retrieved, hallucination test passes with semantic judge negative verdict

---

## B11 — Streaming response eval

### Problem

Harness assumes buffered responses. Streaming has different latency/cost/error profile. Real production deployments stream.

### Build

New `test/streaming-live.test.ts`:
- May need new SDK public surface for stream observation — preflight check
- New `LiveDriver.runStreaming()` invocation path
- Capture: first-token latency (TTFT), total tokens, stream-completion event, mid-stream tool calls
- Asserts: TTFT < threshold, mid-stream tool call observable, stream-cancel mid-flight works (no orphan worker)

### Files
- `src/drivers/live-driver.ts` — new `runStreaming` method (or new `StreamingLiveDriver`)
- `test/streaming-live.test.ts` — new
- `src/graders/streaming.ts` — `gradeStreamingHealth`
- `src/perf/latency-tracker.ts` — extend for TTFT capture

### Risk
SDK may need new public surface for stream observation. If so, defer or scope carefully — don't let eval-harness drive SDK API design without owner sign-off.

### Acceptance
- 3 LIVE tests, TTFT measured, mid-stream cancel verified clean

---

## B12 — Per-tool cost attribution

### Problem

Cost tracked per-judge only. Cannot answer "how much did `spawn_agent` cost across this run?" Operational blind spot.

### Build

- Extend `ObservedToolCall` with optional `costUsd?: number` and `tokens?: { input: number; output: number }`
- `LiveDriver` populates from CMS event metadata where SDK exposes (check `session.getMessages()` event payloads)
- `JsonlReporter` rolls up per-tool totals
- `MultiTrialResult.summary` adds `toolCostBreakdown: Record<toolName, { totalUsd; callCount }>`
- New unit tests on aggregation
- One LIVE assertion that non-zero cost surfaces for at least one tool call in a non-trivial scenario

### Files
- `src/types.ts` — schema extensions
- `src/drivers/live-driver.ts` — cost capture
- `src/reporters/jsonl.ts` + `src/reporters/console-aggregate.ts` — rollups
- `test/cost-attribution.test.ts` — unit
- `test/cost-attribution-live.test.ts` — LIVE smoke

### Acceptance
- Unit tests green; LIVE run shows non-zero per-tool cost in JSONL output

---

## B13 — Semantic judge fallback for response grader

### Problem

`response.containsAny`/`containsAll` is lexical regex. Agent can parrot keyword without understanding.

### Build

Opt-in: `EvalExpected.response.semanticJudge: { rubric?: Rubric; threshold?: number }` field

When set:
1. Lexical pass first (existing behavior)
2. If lexical passes, route to `PilotSwarmJudgeClient` with rubric "does response substantively answer the prompt using these terms?"
3. Both must pass for grader to pass
4. Lexical-only path unchanged for callers who don't opt in

### Files
- `src/types.ts` — schema extension
- `src/graders/response.ts` — semantic-judge plumbing
- `test/response-semantic.test.ts` — new
- `test/response-semantic-live.test.ts` — new (with `LIVE_JUDGE=1`)

### Acceptance
- Lexical-pass-but-semantic-fail case correctly fails grader
- Documented in `docs/JUDGE-CLIENTS.md` selection precedence

---

## Cross-cutting concerns

### LIVE infrastructure budget
- Phase B runs add ~30-40 new LIVE tests
- PG saturation: existing `fileParallelism: false` under LIVE handles it
- DB cleanup: each `test/setup/` already wires per-test schema isolation
- Cost cap: matrix runs of new suites must use existing `maxCells` guard

### Documentation
- README suite gating matrix updated per new suite
- `docs/SUITES.md` extended
- `docs/PROMPT-ITERATION.md` calls out new graders for prompt iteration loop

### Backward compatibility
- All new fields are optional (Zod `.optional()`)
- Existing fixtures + tests untouched
- New graders gated by presence of corresponding `expected` fields

### CI gating
- New LIVE suites gated by existing `LIVE=1` env
- Heavy suites (swarm, knowledge) gated additionally by `PERF_HEAVY=1` if wallclock > 5min
- Default `npx vitest run` (no LIVE) stays under 5s, 997+ tests passing

---

## Out of scope for Phase B

- Parallel batch eval runner (Phase C)
- Multi-turn live driver (Phase C — lift `FakeMultiTurnDriver` to live)
- Cross-region eval matrix
- Adversarial / red-team safety datasets beyond existing `safety-live.test.ts`

---

## Acceptance for Phase B as a whole

1. All 7 new LIVE suites green
2. README suite gating matrix updated
3. `docs/SUITES.md` reflects new suites
4. CI gate validates all new suites under `bin/run-live.sh --all`
5. No regression on existing 997 unit tests (`npx vitest run --exclude="**/*-live.test.ts"`)
6. Each suite committed atomically with truthful commit message
7. Demo path documented: maintainer can clone repo, run cheap smoke, see real evidence of every claimed capability

---

## Open questions

1. Does pilotswarm SDK currently expose a public worker-kill API for B7 chaos hook? If not, scope adds SDK PR.
2. Does `session.getMessages()` event payload include token cost metadata for B12? If not, B12 reduces to plumbing-only (cannot populate real costs without SDK surface).
3. Streaming surface for B11 — is there a public SDK API to attach a token-by-token observer? If not, defer B11.

Answer these via `gh issue` or sync with maintainer before starting B7/B11/B12.
