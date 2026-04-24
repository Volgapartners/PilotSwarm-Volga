import { z } from "zod";

export const EvalToolCallSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  match: z.enum(["exact", "subset", "fuzzy", "setEquals"]).default("subset"),
  order: z.number().int().optional(),
});
export type EvalToolCall = z.infer<typeof EvalToolCallSchema>;

export const EvalExpectedSchema = z
  .object({
    toolCalls: z.array(EvalToolCallSchema).optional(),
    toolSequence: z.enum(["strict", "unordered"]).default("unordered"),
    forbiddenTools: z.array(z.string()).optional(),
    minCalls: z.number().int().nonnegative().optional(),
    maxCalls: z.number().int().nonnegative().optional(),
    noToolCall: z.boolean().optional(),
    response: z
      .object({
        containsAny: z.array(z.string()).optional(),
        containsAll: z.array(z.string()).optional(),
      })
      .optional(),
    cms: z
      .object({
        stateIn: z.array(z.string()).optional(),
      })
      .optional(),
    durability: z.lazy(() => DurabilityExpectedSchema).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.noToolCall === true && val.toolCalls && val.toolCalls.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "noToolCall=true cannot be combined with non-empty toolCalls",
        path: ["noToolCall"],
      });
    }
    if (
      typeof val.minCalls === "number" &&
      typeof val.maxCalls === "number" &&
      val.minCalls > val.maxCalls
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `minCalls (${val.minCalls}) must be <= maxCalls (${val.maxCalls})`,
        path: ["minCalls"],
      });
    }
  });
export type EvalExpected = z.infer<typeof EvalExpectedSchema>;

export const EvalContextMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export const EvalSampleInputSchema = z.object({
  prompt: z.string(),
  systemMessage: z.string().optional(),
  context: z.array(EvalContextMessageSchema).optional(),
});

export const EvalSampleSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  input: EvalSampleInputSchema,
  expected: EvalExpectedSchema,
  tools: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().default(120000),
});
export type EvalSample = z.infer<typeof EvalSampleSchema>;

export const EvalTaskSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  passRateFloor: z.number().min(0).max(1).optional(),
  samples: z.array(EvalSampleSchema).min(1),
});
export type EvalTask = z.infer<typeof EvalTaskSchema>;

export const ScoreSchema = z.object({
  name: z.string(),
  value: z.number().min(0).max(1),
  pass: z.boolean(),
  reason: z.string(),
  actual: z.unknown().optional(),
  expected: z.unknown().optional(),
});
export type Score = z.infer<typeof ScoreSchema>;

export const ObservedToolCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
  timestamp: z.number().optional(),
  order: z.number().int().nonnegative(),
});
export type ObservedToolCall = z.infer<typeof ObservedToolCallSchema>;

export const ObservedResultSchema = z.object({
  toolCalls: z.array(ObservedToolCallSchema),
  finalResponse: z.string(),
  sessionId: z.string(),
  model: z.string().optional(),
  latencyMs: z.number().nonnegative(),
  cmsState: z.string().optional(),
  durability: z.lazy(() => DurabilityObservationSchema).optional(),
});
export type ObservedResult = z.infer<typeof ObservedResultSchema>;

export const CaseResultSchema = z.object({
  caseId: z.string(),
  pass: z.boolean(),
  scores: z.array(ScoreSchema),
  observed: ObservedResultSchema,
  infraError: z.string().optional(),
  durationMs: z.number().nonnegative(),
});
export type CaseResult = z.infer<typeof CaseResultSchema>;

export const RunSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errored: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1),
});

export const RunResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  taskId: z.string(),
  taskVersion: z.string(),
  gitSha: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  summary: RunSummarySchema,
  cases: z.array(CaseResultSchema),
});
export type RunResult = z.infer<typeof RunResultSchema>;

// ---------------------------------------------------------------------------
// V2: multi-trial and matrix result types
// ---------------------------------------------------------------------------

export const WilsonCISchema = z.object({
  lower: z.number().finite().min(0).max(1),
  upper: z.number().finite().min(0).max(1),
  point: z.number().finite().min(0).max(1),
  z: z.number().finite(),
});

export const TrialScoreAggregateSchema = z.object({
  mean: z.number().finite(),
  stddev: z.number().finite().min(0),
  n: z.number().int().nonnegative(),
  values: z.array(z.number().finite()),
});

export const SampleTrialResultSchema = z.object({
  sampleId: z.string().min(1),
  trials: z.number().int().nonnegative(),
  passCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1),
  passAtK: z.record(z.coerce.number().int().nonnegative(), z.number().finite().min(0).max(1)),
  scores: z.record(z.string(), TrialScoreAggregateSchema),
  wilsonCI: WilsonCISchema,
});
export type SampleTrialResult = z.infer<typeof SampleTrialResultSchema>;

export const MultiTrialSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  trials: z.number().int().nonnegative(),
  meanPassRate: z.number().min(0).max(1),
  stddevPassRate: z.number().finite().min(0),
  passRateCI: WilsonCISchema,
});
export type MultiTrialSummary = z.infer<typeof MultiTrialSummarySchema>;

export const MultiTrialResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  taskId: z.string(),
  taskVersion: z.string(),
  gitSha: z.string().optional(),
  model: z.string().optional(),
  trials: z.number().int().nonnegative(),
  startedAt: z.string(),
  finishedAt: z.string(),
  summary: MultiTrialSummarySchema,
  samples: z.array(SampleTrialResultSchema),
  rawRuns: z.array(RunResultSchema),
});
export type MultiTrialResult = z.infer<typeof MultiTrialResultSchema>;

export const MatrixConfigOverridesSchema = z.object({
  systemMessage: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type MatrixConfigOverrides = z.infer<typeof MatrixConfigOverridesSchema>;

export const MatrixConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  overrides: MatrixConfigOverridesSchema,
});
export type MatrixConfig = z.infer<typeof MatrixConfigSchema>;

export const MatrixCellSchema = z.object({
  model: z.string(),
  configId: z.string(),
  configLabel: z.string(),
  result: MultiTrialResultSchema,
});
export type MatrixCell = z.infer<typeof MatrixCellSchema>;

export const MatrixPassRateRefSchema = z.object({
  model: z.string(),
  configId: z.string(),
  passRate: z.number().min(0).max(1),
});

export const MatrixSummarySchema = z.object({
  totalCells: z.number().int().nonnegative(),
  bestPassRate: MatrixPassRateRefSchema,
  worstPassRate: MatrixPassRateRefSchema,
});
export type MatrixSummary = z.infer<typeof MatrixSummarySchema>;

export const MatrixResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  taskId: z.string(),
  taskVersion: z.string(),
  gitSha: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  models: z.array(z.string()),
  configs: z.array(MatrixConfigSchema),
  cells: z.array(MatrixCellSchema),
  summary: MatrixSummarySchema,
});
export type MatrixResult = z.infer<typeof MatrixResultSchema>;

export const MissingScorePolicySchema = z.enum(["exclude", "zero"]);
export type MissingScorePolicy = z.infer<typeof MissingScorePolicySchema>;

// ---------------------------------------------------------------------------
// V3: durability / crash-recovery types
// ---------------------------------------------------------------------------

export const DurabilityFaultPointSchema = z.enum([
  "before_turn",
  "during_tool_call",
  "after_tool_call",
  "after_turn",
  "after_dehydrate",
  "before_hydrate",
]);
export type DurabilityFaultPoint = z.infer<typeof DurabilityFaultPointSchema>;

export const DurabilityFaultModeSchema = z.enum([
  "worker_crash",
  "tool_timeout",
  "tool_throw",
  "network_disconnect",
]);
export type DurabilityFaultMode = z.infer<typeof DurabilityFaultModeSchema>;

export const DurabilityObservationSchema = z.object({
  scenario: z.string(),
  faultPoint: DurabilityFaultPointSchema,
  faultMode: DurabilityFaultModeSchema,
  injected: z.boolean(),
  recovered: z.boolean(),
  preCrashState: z.string().optional(),
  postRecoveryState: z.string().optional(),
  toolCallsBeforeFault: z.number().int().nonnegative(),
  toolCallsAfterRecovery: z.number().int().nonnegative(),
  timerAccuracyMs: z.number().finite().optional(),
  dehydrated: z.boolean().optional(),
  hydrated: z.boolean().optional(),
  workerHandoff: z.boolean().optional(),
});
export type DurabilityObservation = z.infer<typeof DurabilityObservationSchema>;

export const DurabilityExpectedSchema = z.object({
  mustRecover: z.boolean().default(true),
  finalStateIn: z.array(z.string()).optional(),
  minToolCallsAfterRecovery: z.number().int().nonnegative().optional(),
  maxTimerDriftMs: z.number().finite().nonnegative().optional(),
  requireDehydrated: z.boolean().optional(),
  requireHydrated: z.boolean().optional(),
  requireWorkerHandoff: z.boolean().optional(),
});
export type DurabilityExpected = z.infer<typeof DurabilityExpectedSchema>;

// ---------------------------------------------------------------------------
// V4: multi-turn / trajectory types
// ---------------------------------------------------------------------------

export const TurnExpectedSchema = z.object({
  toolCalls: z.array(EvalToolCallSchema).optional(),
  toolSequence: z.enum(["strict", "unordered"]).default("unordered"),
  forbiddenTools: z.array(z.string()).optional(),
  noToolCall: z.boolean().optional(),
  response: z
    .object({
      containsAny: z.array(z.string()).optional(),
      containsAll: z.array(z.string()).optional(),
    })
    .optional(),
});
export type TurnExpected = z.infer<typeof TurnExpectedSchema>;

export const TurnInputSchema = z.object({
  prompt: z.string(),
  systemMessage: z.string().optional(),
});
export type TurnInput = z.infer<typeof TurnInputSchema>;

export const TrajectoryTurnSchema = z.object({
  input: TurnInputSchema,
  expected: TurnExpectedSchema,
});
export type TrajectoryTurn = z.infer<typeof TrajectoryTurnSchema>;

export const TrajectorySampleSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  turns: z.array(TrajectoryTurnSchema).min(1),
  tools: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().default(120000),
  expected: z
    .object({
      goalCompleted: z.boolean().optional(),
      maxTotalToolCalls: z.number().int().nonnegative().optional(),
      contextRetention: z
        .array(
          z.object({
            term: z.string(),
            mustAppearAfterTurn: z.number().int().nonnegative(),
          }),
        )
        .optional(),
    })
    .optional(),
});
export type TrajectorySample = z.infer<typeof TrajectorySampleSchema>;

export const TrajectoryTaskSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  passRateFloor: z.number().min(0).max(1).optional(),
  samples: z.array(TrajectorySampleSchema).min(1),
});
export type TrajectoryTask = z.infer<typeof TrajectoryTaskSchema>;

export const ObservedTurnSchema = z.object({
  toolCalls: z.array(ObservedToolCallSchema),
  response: z.string(),
  latencyMs: z.number().finite().nonnegative(),
});
export type ObservedTurn = z.infer<typeof ObservedTurnSchema>;

export const ObservedTrajectorySchema = z.object({
  turns: z.array(ObservedTurnSchema),
  sessionId: z.string(),
  totalLatencyMs: z.number().finite().nonnegative(),
  model: z.string().optional(),
});
export type ObservedTrajectory = z.infer<typeof ObservedTrajectorySchema>;

export const TrajectoryScoreSchema = z.object({
  turnScores: z.array(z.array(ScoreSchema)),
  crossTurnScores: z.array(ScoreSchema),
  holisticScores: z.array(ScoreSchema),
});
export type TrajectoryScore = z.infer<typeof TrajectoryScoreSchema>;

export const TrajectoryCaseResultSchema = z.object({
  caseId: z.string(),
  pass: z.boolean(),
  trajectoryScore: TrajectoryScoreSchema,
  observed: ObservedTrajectorySchema,
  infraError: z.string().optional(),
  durationMs: z.number().finite().nonnegative(),
});
export type TrajectoryCaseResult = z.infer<typeof TrajectoryCaseResultSchema>;

export const TrajectoryRunResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  taskId: z.string(),
  taskVersion: z.string(),
  gitSha: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
    passRate: z.number().finite().min(0).max(1),
  }),
  cases: z.array(TrajectoryCaseResultSchema),
});
export type TrajectoryRunResult = z.infer<typeof TrajectoryRunResultSchema>;

// V5: LLM-as-Judge types

export const RubricCriterionSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    scale: z.object({
      min: z.number().int().min(0),
      max: z.number().int().min(1),
    }),
    anchors: z.record(z.string(), z.string()).optional(),
    passThreshold: z.number().finite().min(0).max(1),
  })
  .superRefine((val, ctx) => {
    if (val.scale.min >= val.scale.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `scale.min (${val.scale.min}) must be less than scale.max (${val.scale.max})`,
        path: ["scale", "min"],
      });
    }
  });
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export const RubricSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    criteria: z.array(RubricCriterionSchema).min(1),
  })
  .superRefine((val, ctx) => {
    const ids = val.criteria.map((c) => c.id);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate criterion IDs found",
        path: ["criteria"],
      });
    }
  });
export type Rubric = z.infer<typeof RubricSchema>;

export const JudgeResultSchema = z.object({
  criterionId: z.string(),
  reasoning: z.string(),
  rawScore: z.number().finite(),
  normalizedScore: z.number().finite().min(0).max(1),
  pass: z.boolean(),
});
export type JudgeResult = z.infer<typeof JudgeResultSchema>;

export const JudgeCostSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  model: z.string(),
  estimatedCostUsd: z.number().finite().nonnegative(),
});
export type JudgeCost = z.infer<typeof JudgeCostSchema>;

// ---------------------------------------------------------------------------
// V5b: CI Gate / Regression / Baseline types
// ---------------------------------------------------------------------------

export const CIGateConfigSchema = z.object({
  passRateFloor: z.number().finite().min(0).max(1).optional(),
  maxRegressions: z.number().int().nonnegative().optional(),
  maxCostUsd: z.number().finite().nonnegative().optional(),
});
export type CIGateConfig = z.infer<typeof CIGateConfigSchema>;

export const CIGateResultSchema = z.object({
  pass: z.boolean(),
  reasons: z.array(z.string()),
  passRate: z.number().finite().min(0).max(1).optional(),
  regressionCount: z.number().int().nonnegative().optional(),
  totalCostUsd: z.number().finite().nonnegative().optional(),
});
export type CIGateResult = z.infer<typeof CIGateResultSchema>;

export const RegressionResultSchema = z.object({
  sampleId: z.string(),
  baselinePassRate: z.number().finite().min(0).max(1),
  currentPassRate: z.number().finite().min(0).max(1),
  pValue: z.number().finite().min(0).max(1),
  significant: z.boolean(),
  direction: z.enum(["improved", "regressed", "unchanged"]),
});
export type RegressionResult = z.infer<typeof RegressionResultSchema>;

export const BaselineSampleSchema = z.object({
  sampleId: z.string().min(1),
  passRate: z.number().finite().min(0).max(1),
  trials: z.number().int().nonnegative(),
  passCount: z.number().int().nonnegative(),
});
export type BaselineSample = z.infer<typeof BaselineSampleSchema>;

export const BaselineSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  taskVersion: z.string().min(1),
  model: z.string().optional(),
  createdAt: z.string(),
  samples: z.array(BaselineSampleSchema),
});
export type Baseline = z.infer<typeof BaselineSchema>;
