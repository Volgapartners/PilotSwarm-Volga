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
