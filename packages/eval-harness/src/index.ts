// Types
export type {
  EvalTask,
  EvalSample,
  EvalExpected,
  EvalToolCall,
  Score,
  ObservedToolCall,
  ObservedResult,
  CaseResult,
  RunResult,
} from "./types.js";
export {
  EvalTaskSchema,
  EvalSampleSchema,
  ScoreSchema,
  RunResultSchema,
} from "./types.js";

// Runner
export { EvalRunner } from "./runner.js";
export type { RunnerOptions } from "./runner.js";

// Loader
export { loadEvalTask, loadEvalTaskFromDir } from "./loader.js";

// Graders
export { gradeEvalCase } from "./graders/index.js";
export { matchArgs } from "./graders/match-args.js";

// Drivers
export type { Driver, DriverOptions } from "./drivers/types.js";
export { FakeDriver } from "./drivers/fake-driver.js";
export { LiveDriver } from "./drivers/live-driver.js";

// Reporters
export type { Reporter } from "./reporters/types.js";
export { ConsoleReporter } from "./reporters/console.js";
export { JsonlReporter } from "./reporters/jsonl.js";

// Fixtures
export {
  createEvalToolTracker,
  createEvalAddTool,
  createEvalMultiplyTool,
  createEvalWeatherTool,
} from "./fixtures/eval-tools.js";

// Observers
export { extractObservedCalls } from "./observers/tool-tracker.js";

// --- V2: Stats ---
export {
  passAtK,
  meanStddev,
  wilsonInterval,
  bootstrapCI,
  mcNemarTest,
  mannWhitneyU,
} from "./stats.js";

// --- V2: Multi-Trial ---
export { MultiTrialRunner } from "./multi-trial.js";
export type { MultiTrialRunnerOptions } from "./multi-trial.js";

// --- V2: Matrix ---
export { MatrixRunner } from "./matrix.js";
export type { MatrixRunnerOptions } from "./matrix.js";

// --- V2: Aggregate Reporters ---
export type { AggregateReporter } from "./reporters/aggregate-types.js";
export { ConsoleAggregateReporter } from "./reporters/console-aggregate.js";
export { MarkdownReporter } from "./reporters/markdown.js";

// --- V2: Types ---
export type {
  SampleTrialResult,
  MultiTrialSummary,
  MultiTrialResult,
  MatrixConfigOverrides,
  MatrixConfig,
  MatrixCell,
  MatrixSummary,
  MatrixResult,
} from "./types.js";
export {
  SampleTrialResultSchema,
  MultiTrialSummarySchema,
  MultiTrialResultSchema,
  MatrixConfigOverridesSchema,
  MatrixConfigSchema,
  MatrixCellSchema,
  MatrixSummarySchema,
  MatrixResultSchema,
} from "./types.js";
