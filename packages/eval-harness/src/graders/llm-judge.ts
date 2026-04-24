import { createHash } from "node:crypto";
import type {
  JudgeClient,
  JudgeCache,
  JudgeResponse,
} from "./judge-types.js";
import {
  JudgeResultSchema,
  JudgeCostSchema,
  RubricSchema,
  type JudgeCost,
  type JudgeResult,
  type Rubric,
  type RubricCriterion,
  type Score,
} from "../types.js";

export interface LLMJudgeGraderOptions {
  client: JudgeClient;
  rubric: Rubric;
  budgetUsd?: number;
  cache?: JudgeCache;
  judgeId?: string;
}

export interface LLMJudgeGradeResult {
  scores: Score[];
  costs: JudgeCost[];
  totalCostUsd: number;
}

export class LLMJudgeGrader {
  private client: JudgeClient;
  private rubric: Rubric;
  private budgetUsd: number;
  private cache?: JudgeCache;
  private judgeId: string;
  private totalCostUsd = 0;

  constructor(options: LLMJudgeGraderOptions) {
    this.rubric = RubricSchema.parse(options.rubric);
    this.client = options.client;
    this.budgetUsd = options.budgetUsd ?? 0;
    this.cache = options.cache;
    this.judgeId = options.judgeId ?? "default";
  }

  async grade(prompt: string, response: string): Promise<LLMJudgeGradeResult> {
    const scores: Score[] = [];
    const costs: JudgeCost[] = [];

    for (const criterion of this.rubric.criteria) {
      if (this.budgetUsd > 0 && this.totalCostUsd >= this.budgetUsd) {
        scores.push({
          name: `judge/${criterion.id}`,
          value: 0,
          pass: false,
          reason: `Budget exceeded (${this.totalCostUsd.toFixed(4)} >= ${this.budgetUsd} USD)`,
        });
        continue;
      }

      const cacheKey = this.buildCacheKey(prompt, response, criterion);
      if (this.cache) {
        try {
          const cached = await this.cache.get(cacheKey);
          if (cached) {
            const cachedParse = JudgeResultSchema.safeParse(cached.result);
            const cachedCostParse = JudgeCostSchema.safeParse(cached.cost);
            if (cachedParse.success && cachedCostParse.success) {
              scores.push(this.resultToScore(cachedParse.data, criterion));
              costs.push(cachedCostParse.data);
              continue;
            }
            // Invalid cache entry — fall through to fresh judge call
          }
        } catch (cacheErr) {
          console.warn(
            `[LLMJudgeGrader] cache.get failed: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
          );
          // Fall through to judge call
        }
      }

      try {
        const judgeResponse = await this.client.judge({
          prompt,
          response,
          criterion,
        });

        const costParse = JudgeCostSchema.safeParse(judgeResponse.cost);
        const validCost: JudgeCost = costParse.success
          ? costParse.data
          : { inputTokens: 0, outputTokens: 0, model: "unknown", estimatedCostUsd: 0 };
        this.totalCostUsd += validCost.estimatedCostUsd;
        costs.push(validCost);

        const resultParse = JudgeResultSchema.safeParse(judgeResponse.result);
        if (!resultParse.success) {
          scores.push({
            name: `judge/${criterion.id}`,
            value: 0,
            pass: false,
            reason: `Invalid judge result: ${resultParse.error.message}`,
          });
          continue;
        }

        scores.push(this.resultToScore(resultParse.data, criterion));

        if (this.cache) {
          try {
            await this.cache.set(cacheKey, {
              ...judgeResponse,
              result: resultParse.data,
              cost: validCost,
            });
          } catch (cacheErr) {
            console.warn(
              `[LLMJudgeGrader] cache.set failed: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`,
            );
          }
        }
      } catch (err) {
        scores.push({
          name: `judge/${criterion.id}`,
          value: 0,
          pass: false,
          reason: `Judge unavailable: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return { scores, costs, totalCostUsd: this.totalCostUsd };
  }

  get cumulativeCostUsd(): number {
    return this.totalCostUsd;
  }

  private resultToScore(result: JudgeResult, criterion: RubricCriterion): Score {
    return {
      name: `judge/${criterion.id}`,
      value: result.normalizedScore,
      pass: result.normalizedScore >= criterion.passThreshold,
      reason: result.reasoning,
    };
  }

  private buildCacheKey(
    prompt: string,
    response: string,
    criterion: RubricCriterion,
  ): string {
    const data = JSON.stringify({
      judgeId: this.judgeId,
      rubricId: this.rubric.id,
      rubricVersion: this.rubric.version,
      criterionId: criterion.id,
      prompt,
      response,
    });
    return `judge_${createHash("sha256").update(data).digest("hex")}`;
  }
}
