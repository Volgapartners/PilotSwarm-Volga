import type { Rubric, RubricCriterion, JudgeResult, JudgeCost } from "../types.js";

export interface JudgeRequest {
  prompt: string;
  response: string;
  criterion: RubricCriterion;
  systemMessage?: string;
}

export interface JudgeOptions {
  signal?: AbortSignal;
}

export interface JudgeResponse {
  result: JudgeResult;
  cost: JudgeCost;
  cached: boolean;
}

export interface JudgeClient {
  judge(request: JudgeRequest, options?: JudgeOptions): Promise<JudgeResponse>;
  estimateCost?(
    request: JudgeRequest,
    options?: { completionTokens?: number },
  ): number | undefined;
  /**
   * Optional stable identity string for cache keying. Implementations should
   * return a deterministic value derived from any configuration that affects
   * judge output (e.g., model name, temperature, response_format, max tokens).
   * Two clients that return the same `cacheIdentity()` are considered
   * cache-compatible. Two clients that differ in any output-affecting
   * configuration MUST return different values to avoid cache poisoning.
   */
  cacheIdentity?(): string;
  dispose?(): Promise<void>;
}

export interface JudgeCache {
  get(key: string): Promise<JudgeResponse | undefined>;
  set(key: string, value: JudgeResponse): Promise<void>;
}

export type { Rubric, RubricCriterion, JudgeResult, JudgeCost };
