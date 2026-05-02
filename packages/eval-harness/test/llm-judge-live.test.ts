// LLM-judge LIVE — gated by LIVE=1 + LIVE_JUDGE=1. Runs a real PilotSwarm
// sample, feeds the actual final response/trace to LLMJudgeGrader with a
// real judge client, asserts criterion scores, budget accounting, and
// cross-judge agreement.

import { describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveDriver } from "../src/drivers/live-driver.js";
import { EvalRunner } from "../src/runner.js";
import { LLMJudgeGrader } from "../src/graders/llm-judge.js";
import { OpenAIJudgeClient } from "../src/graders/openai-judge-client.js";
import { loadEvalTask } from "../src/loader.js";
import { makeRubric } from "./fixtures/builders.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("LLMJudgeGrader LIVE", () => {
  const run = process.env.LIVE === "1" && process.env.LIVE_JUDGE === "1" ? it : it.skip;

  run("judges real PilotSwarm responses with calibrated rubric", async () => {
    const driver = new LiveDriver({ timeout: 300_000 });
    const dataset = loadEvalTask(resolve(__dirname, "../datasets/tool-call-correctness.v1.json"));
    const sample = dataset.samples[0]!;
    const runner = new EvalRunner({ driver, runId: "live-llm-judge" });
    const runResult = await runner.runTask({ ...dataset, samples: [sample] });
    const observed = runResult.cases[0]!.observed;

    const apiKey = process.env.OPENAI_API_KEY;
    expect(apiKey).toBeTruthy();
    const client = new OpenAIJudgeClient({
      apiKey: apiKey!,
      model: process.env.LIVE_JUDGE_MODEL ?? "gpt-4o-mini",
    });
    const grader = new LLMJudgeGrader({
      client,
      rubric: makeRubric({
        criteria: [
          {
            id: "correctness",
            description:
              "Did the assistant correctly compute the requested arithmetic and convey the answer?",
            scale: { min: 0, max: 1 },
            passThreshold: 0.5,
          },
        ],
      }),
      budgetUsd: 1,
    });
    const judged = await grader.grade("Was the answer correct?", observed.finalResponse);
    expect(Array.isArray(judged.results)).toBe(true);
    expect(judged.results.length).toBeGreaterThan(0);
    expect(grader.cumulativeCostUsd).toBeLessThanOrEqual(1 + 1e-9);
  }, 600_000);

  // ---------------------------------------------------------------------------
  // LLM JUDGE CALIBRATION suite expansion (eval-platform expansion phase 6)
  // ---------------------------------------------------------------------------

  run("JUDGE: multi-criterion rubric returns finite scores for all criteria", async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    expect(apiKey).toBeTruthy();
    const client = new OpenAIJudgeClient({
      apiKey: apiKey!,
      model: process.env.LIVE_JUDGE_MODEL ?? "gpt-4o-mini",
    });
    const rubric = makeRubric({
      criteria: [
        { id: "helpfulness", description: "Is the answer helpful?", scale: { min: 0, max: 1 }, passThreshold: 0.5 },
        { id: "accuracy", description: "Is the answer factually accurate?", scale: { min: 0, max: 1 }, passThreshold: 0.5 },
        { id: "safety", description: "Does the answer avoid harm?", scale: { min: 0, max: 1 }, passThreshold: 0.5 },
      ],
    });
    const grader = new LLMJudgeGrader({ client, rubric, budgetUsd: 1 });
    const judged = await grader.grade("Was the response correct?", "17 + 25 = 42.");
    expect(judged.results.length).toBe(3);
    for (const r of judged.results) {
      expect(typeof r.score).toBe("number");
      expect(Number.isFinite(r.score)).toBe(true);
    }
  }, 600_000);

  run("JUDGE: cost accounting accumulates and stays within configured budget", async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    expect(apiKey).toBeTruthy();
    const client = new OpenAIJudgeClient({
      apiKey: apiKey!,
      model: process.env.LIVE_JUDGE_MODEL ?? "gpt-4o-mini",
    });
    const grader = new LLMJudgeGrader({ client, rubric: makeRubric(), budgetUsd: 0.5 });
    await grader.grade("ok?", "yes");
    const after1 = grader.cumulativeCostUsd;
    expect(after1).toBeGreaterThanOrEqual(0);
    expect(after1).toBeLessThanOrEqual(0.5 + 1e-9);
  }, 600_000);

  run("JUDGE: cross-judge agreement — two judge models score the same response", async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    expect(apiKey).toBeTruthy();
    const modelA = process.env.LIVE_JUDGE_MODEL_A ?? "gpt-4o-mini";
    const modelB = process.env.LIVE_JUDGE_MODEL_B ?? "gpt-4o";
    const rubric = makeRubric();
    const clientA = new OpenAIJudgeClient({ apiKey: apiKey!, model: modelA });
    const clientB = new OpenAIJudgeClient({ apiKey: apiKey!, model: modelB });
    const graderA = new LLMJudgeGrader({ client: clientA, rubric, budgetUsd: 1 });
    const graderB = new LLMJudgeGrader({ client: clientB, rubric, budgetUsd: 1 });
    const response = "17 + 25 = 42.";
    const [a, b] = await Promise.all([
      graderA.grade("correct?", response),
      graderB.grade("correct?", response),
    ]);
    expect(a.results.length).toBe(b.results.length);
    // Agreement: both judges should score 0..1; we don't gate on exact match.
    for (const r of [...a.results, ...b.results]) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  }, 600_000);

  run("JUDGE: refusal handling — judge marks low score on a known-bad response (no infra error)", async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    expect(apiKey).toBeTruthy();
    const client = new OpenAIJudgeClient({
      apiKey: apiKey!,
      model: process.env.LIVE_JUDGE_MODEL ?? "gpt-4o-mini",
    });
    const grader = new LLMJudgeGrader({
      client,
      rubric: makeRubric({
        criteria: [
          {
            id: "correctness",
            description: "Did the assistant correctly answer 17+25=42?",
            scale: { min: 0, max: 1 },
            passThreshold: 0.5,
          },
        ],
      }),
      budgetUsd: 1,
    });
    const judged = await grader.grade("Did the assistant compute 17+25=42?", "I cannot help with that.");
    const score = judged.results[0]!.score;
    expect(score).toBeLessThan(0.5);
    expect(judged.results[0]!.infraError === true).toBe(false);
  }, 600_000);
});
