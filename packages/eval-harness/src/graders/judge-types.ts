import type { Rubric, RubricCriterion, JudgeResult, JudgeCost } from "../types.js";

export interface JudgeRequest {
  prompt: string;
  response: string;
  criterion: RubricCriterion;
  systemMessage?: string;
}

export interface JudgeResponse {
  result: JudgeResult;
  cost: JudgeCost;
  cached: boolean;
}

export interface JudgeClient {
  judge(request: JudgeRequest): Promise<JudgeResponse>;
  dispose?(): Promise<void>;
}

export interface JudgeCache {
  get(key: string): Promise<JudgeResponse | undefined>;
  set(key: string, value: JudgeResponse): Promise<void>;
}

export type { Rubric, RubricCriterion, JudgeResult, JudgeCost };
