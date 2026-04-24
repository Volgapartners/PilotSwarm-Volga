import { describe, it, expect } from "vitest";
import {
  RubricSchema,
  RubricCriterionSchema,
  JudgeResultSchema,
  type Rubric,
  type JudgeResult,
} from "../src/types.js";
import { FakeJudgeClient } from "../src/graders/fake-judge-client.js";
import { InMemoryJudgeCache } from "../src/graders/judge-cache.js";
import { LLMJudgeGrader } from "../src/graders/llm-judge.js";
import type {
  JudgeCache,
  JudgeClient,
  JudgeRequest,
  JudgeResponse,
} from "../src/graders/judge-types.js";

const wellFormedCriterion = {
  id: "clarity",
  description: "Is the response clear?",
  scale: { min: 1, max: 5 },
  passThreshold: 0.6,
};

const wellFormedRubric: Rubric = {
  id: "rubric.basic",
  name: "Basic",
  version: "1.0.0",
  criteria: [wellFormedCriterion],
};

function passResult(criterionId: string, normalized = 0.9): JudgeResult {
  return {
    criterionId,
    reasoning: `ok ${criterionId}`,
    rawScore: 5,
    normalizedScore: normalized,
    pass: true,
  };
}

describe("Rubric types", () => {
  it("validates well-formed rubric", () => {
    const parsed = RubricSchema.parse(wellFormedRubric);
    expect(parsed.id).toBe("rubric.basic");
    expect(parsed.criteria).toHaveLength(1);
  });

  it("rejects empty criteria", () => {
    expect(() =>
      RubricSchema.parse({ ...wellFormedRubric, criteria: [] }),
    ).toThrow();
  });

  it("validates criterion with anchors", () => {
    const withAnchors = {
      ...wellFormedCriterion,
      anchors: { "1": "terrible", "5": "excellent" },
    };
    const parsed = RubricCriterionSchema.parse(withAnchors);
    expect(parsed.anchors?.["5"]).toBe("excellent");
  });
});

describe("FakeJudgeClient", () => {
  it("returns scripted result for known criterion", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity") },
    ]);
    const resp = await fake.judge({
      prompt: "p",
      response: "r",
      criterion: wellFormedCriterion,
    });
    expect(resp.result.criterionId).toBe("clarity");
    expect(resp.result.pass).toBe(true);
    expect(resp.cost.model).toBe("fake-model");
  });

  it("throws for unknown criterion", async () => {
    const fake = new FakeJudgeClient([]);
    await expect(
      fake.judge({
        prompt: "p",
        response: "r",
        criterion: wellFormedCriterion,
      }),
    ).rejects.toThrow(/no scenario/);
  });

  it("tracks call count", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity") },
    ]);
    await fake.judge({
      prompt: "p",
      response: "r",
      criterion: wellFormedCriterion,
    });
    await fake.judge({
      prompt: "p",
      response: "r",
      criterion: wellFormedCriterion,
    });
    expect(fake.callCount).toBe(2);
  });
});

describe("InMemoryJudgeCache", () => {
  const sampleValue: JudgeResponse = {
    result: passResult("clarity"),
    cost: {
      inputTokens: 10,
      outputTokens: 5,
      model: "m",
      estimatedCostUsd: 0.0001,
    },
    cached: false,
  };

  it("stores and retrieves cached results", async () => {
    const cache = new InMemoryJudgeCache();
    await cache.set("k1", sampleValue);
    const got = await cache.get("k1");
    expect(got?.result.criterionId).toBe("clarity");
  });

  it("returns undefined for cache miss", async () => {
    const cache = new InMemoryJudgeCache();
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("evicts oldest when full", async () => {
    const cache = new InMemoryJudgeCache(2);
    await cache.set("a", sampleValue);
    await cache.set("b", sampleValue);
    await cache.set("c", sampleValue);
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBeDefined();
    expect(await cache.get("c")).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it("clear empties cache", async () => {
    const cache = new InMemoryJudgeCache();
    await cache.set("a", sampleValue);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(await cache.get("a")).toBeUndefined();
  });
});

describe("LLMJudgeGrader", () => {
  const multiRubric: Rubric = {
    id: "rubric.multi",
    name: "Multi",
    version: "1.0.0",
    criteria: [
      {
        id: "clarity",
        description: "d",
        scale: { min: 1, max: 5 },
        passThreshold: 0.5,
      },
      {
        id: "accuracy",
        description: "d",
        scale: { min: 1, max: 5 },
        passThreshold: 0.5,
      },
    ],
  };

  it("grades all criteria in rubric", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity", 0.8) },
      { criterionId: "accuracy", result: passResult("accuracy", 0.9) },
    ]);
    const grader = new LLMJudgeGrader({ client: fake, rubric: multiRubric });
    const out = await grader.grade("p", "r");
    expect(out.scores).toHaveLength(2);
    expect(fake.callCount).toBe(2);
  });

  it("prefixes scores with judge/", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity") },
    ]);
    const grader = new LLMJudgeGrader({ client: fake, rubric: wellFormedRubric });
    const out = await grader.grade("p", "r");
    expect(out.scores[0].name).toBe("judge/clarity");
  });

  it("normalizes scores to 0-1", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity", 0.75) },
    ]);
    const grader = new LLMJudgeGrader({ client: fake, rubric: wellFormedRubric });
    const out = await grader.grade("p", "r");
    expect(out.scores[0].value).toBe(0.75);
    expect(out.scores[0].value).toBeGreaterThanOrEqual(0);
    expect(out.scores[0].value).toBeLessThanOrEqual(1);
  });

  it("uses cache when available", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity") },
    ]);
    const cache = new InMemoryJudgeCache();
    const grader = new LLMJudgeGrader({
      client: fake,
      rubric: wellFormedRubric,
      cache,
    });
    await grader.grade("p", "r");
    expect(cache.size).toBe(1);
  });

  it("skips judge call on cache hit", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity") },
    ]);
    const cache = new InMemoryJudgeCache();
    const grader1 = new LLMJudgeGrader({
      client: fake,
      rubric: wellFormedRubric,
      cache,
    });
    await grader1.grade("p", "r");
    expect(fake.callCount).toBe(1);

    const grader2 = new LLMJudgeGrader({
      client: fake,
      rubric: wellFormedRubric,
      cache,
    });
    const out = await grader2.grade("p", "r");
    expect(fake.callCount).toBe(1); // not increased
    expect(out.scores[0].name).toBe("judge/clarity");
  });

  it("enforces budget limit", async () => {
    const fake = new FakeJudgeClient([
      {
        criterionId: "clarity",
        result: passResult("clarity"),
        cost: {
          inputTokens: 1,
          outputTokens: 1,
          model: "m",
          estimatedCostUsd: 1.0,
        },
      },
      {
        criterionId: "accuracy",
        result: passResult("accuracy"),
      },
    ]);
    const grader = new LLMJudgeGrader({
      client: fake,
      rubric: multiRubric,
      budgetUsd: 0.5,
    });
    const out = await grader.grade("p", "r");
    expect(out.scores).toHaveLength(2);
    expect(out.scores[0].pass).toBe(true);
    expect(out.scores[1].pass).toBe(false);
    expect(out.scores[1].reason).toMatch(/Budget exceeded/);
    expect(fake.callCount).toBe(1);
  });

  it("handles judge client errors gracefully", async () => {
    const brokenClient: JudgeClient = {
      async judge(_req: JudgeRequest): Promise<JudgeResponse> {
        throw new Error("network down");
      },
    };
    const grader = new LLMJudgeGrader({
      client: brokenClient,
      rubric: wellFormedRubric,
    });
    const out = await grader.grade("p", "r");
    expect(out.scores[0].pass).toBe(false);
    expect(out.scores[0].reason).toMatch(/Judge unavailable/);
    expect(out.scores[0].reason).toMatch(/network down/);
  });

  it("tracks cumulative cost", async () => {
    const fake = new FakeJudgeClient([
      {
        criterionId: "clarity",
        result: passResult("clarity"),
        cost: {
          inputTokens: 1,
          outputTokens: 1,
          model: "m",
          estimatedCostUsd: 0.01,
        },
      },
      {
        criterionId: "accuracy",
        result: passResult("accuracy"),
        cost: {
          inputTokens: 1,
          outputTokens: 1,
          model: "m",
          estimatedCostUsd: 0.02,
        },
      },
    ]);
    const grader = new LLMJudgeGrader({ client: fake, rubric: multiRubric });
    const out = await grader.grade("p", "r");
    expect(out.totalCostUsd).toBeCloseTo(0.03, 5);
    expect(grader.cumulativeCostUsd).toBeCloseTo(0.03, 5);
  });

  it("works with empty response", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity", 0) },
    ]);
    const grader = new LLMJudgeGrader({ client: fake, rubric: wellFormedRubric });
    const out = await grader.grade("p", "");
    expect(out.scores).toHaveLength(1);
    expect(out.scores[0].value).toBe(0);
  });

  it("handles multi-criteria rubric", async () => {
    const fake = new FakeJudgeClient([
      { criterionId: "clarity", result: passResult("clarity", 0.8) },
      { criterionId: "accuracy", result: { ...passResult("accuracy", 0.3), pass: false } },
    ]);
    const grader = new LLMJudgeGrader({ client: fake, rubric: multiRubric });
    const out = await grader.grade("p", "r");
    expect(out.scores.map((s) => s.name)).toEqual([
      "judge/clarity",
      "judge/accuracy",
    ]);
    expect(out.scores[0].pass).toBe(true);
    expect(out.scores[1].pass).toBe(false);
  });
});

describe("JudgeResult types", () => {
  it("validates well-formed judge result", () => {
    const parsed = JudgeResultSchema.parse(passResult("clarity"));
    expect(parsed.criterionId).toBe("clarity");
  });

  it("rejects out-of-range normalizedScore", () => {
    expect(() =>
      JudgeResultSchema.parse({
        ...passResult("clarity"),
        normalizedScore: 1.5,
      }),
    ).toThrow();
    expect(() =>
      JudgeResultSchema.parse({
        ...passResult("clarity"),
        normalizedScore: -0.1,
      }),
    ).toThrow();
  });
});

describe("LLMJudgeGrader review findings", () => {
  it("does not collide cache keys for different prompts", async () => {
    const cache = new InMemoryJudgeCache();
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "c",
          description: "test",
          scale: { min: 1, max: 5 },
          passThreshold: 0.5,
        },
      ],
    };

    const client1 = new FakeJudgeClient([
      {
        criterionId: "c",
        result: {
          criterionId: "c",
          reasoning: "prompt1",
          rawScore: 5,
          normalizedScore: 1,
          pass: true,
        },
      },
    ]);
    const grader1 = new LLMJudgeGrader({ client: client1, rubric, cache });
    await grader1.grade("prompt-alpha", "response-1");

    const client2 = new FakeJudgeClient([
      {
        criterionId: "c",
        result: {
          criterionId: "c",
          reasoning: "prompt2",
          rawScore: 1,
          normalizedScore: 0,
          pass: false,
        },
      },
    ]);
    const grader2 = new LLMJudgeGrader({ client: client2, rubric, cache });
    const result = await grader2.grade("prompt-beta", "response-1");

    expect(client2.callCount).toBe(1);
    const score = result.scores.find((s) => s.name === "judge/c");
    expect(score!.reason).toBe("prompt2");
  });

  it("rejects invalid normalizedScore from judge client", async () => {
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "c",
          description: "test",
          scale: { min: 1, max: 5 },
          passThreshold: 0.5,
        },
      ],
    };
    const badClient: JudgeClient = {
      async judge(): Promise<JudgeResponse> {
        return {
          result: {
            criterionId: "c",
            reasoning: "bad",
            rawScore: 10,
            normalizedScore: 2.0,
            pass: true,
          },
          cost: {
            inputTokens: 10,
            outputTokens: 5,
            model: "fake",
            estimatedCostUsd: 0,
          },
          cached: false,
        };
      },
    };
    const grader = new LLMJudgeGrader({ client: badClient, rubric });
    const result = await grader.grade("test", "test");
    const score = result.scores.find((s) => s.name === "judge/c");
    expect(score!.value).toBeLessThanOrEqual(1);
    expect(score!.value).toBeGreaterThanOrEqual(0);
  });

  it("does not leak cost mutations across calls", async () => {
    const client = new FakeJudgeClient([
      {
        criterionId: "c",
        result: {
          criterionId: "c",
          reasoning: "ok",
          rawScore: 4,
          normalizedScore: 0.8,
          pass: true,
        },
        cost: {
          inputTokens: 100,
          outputTokens: 50,
          model: "fake",
          estimatedCostUsd: 0.001,
        },
      },
    ]);
    const criterion = {
      id: "c",
      description: "t",
      scale: { min: 1, max: 5 },
      passThreshold: 0.5,
    };

    const resp1 = await client.judge({ prompt: "p", response: "r", criterion });
    resp1.cost.inputTokens = 999;

    const resp2 = await client.judge({ prompt: "p", response: "r", criterion });
    expect(resp2.cost.inputTokens).toBe(100);
  });

  it("validates cached results before emitting scores", async () => {
    const cache = new InMemoryJudgeCache();
    const rubric: Rubric = {
      id: "r1", name: "test", version: "1.0",
      criteria: [{ id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 }],
    };

    const goodClient = new FakeJudgeClient([{
      criterionId: "c",
      result: { criterionId: "c", reasoning: "ok", rawScore: 4, normalizedScore: 0.8, pass: true },
    }]);
    const grader1 = new LLMJudgeGrader({ client: goodClient, rubric, cache });
    await grader1.grade("p1", "r1");

    for (const [, val] of (cache as any).store) {
      val.result.normalizedScore = 5.0;
    }

    const grader2 = new LLMJudgeGrader({ client: goodClient, rubric, cache });
    const result = await grader2.grade("p1", "r1");
    const score = result.scores.find((s) => s.name === "judge/c");
    expect(score!.value).toBeLessThanOrEqual(1);
    expect(score!.value).toBeGreaterThanOrEqual(0);
  });

  it("handles NaN cost from judge client gracefully", async () => {
    const rubric: Rubric = {
      id: "r1", name: "test", version: "1.0",
      criteria: [{ id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 }],
    };
    const badCostClient: JudgeClient = {
      async judge() {
        return {
          result: { criterionId: "c", reasoning: "ok", rawScore: 4, normalizedScore: 0.8, pass: true },
          cost: { inputTokens: 10, outputTokens: 5, model: "fake", estimatedCostUsd: NaN },
          cached: false,
        };
      },
    };
    const grader = new LLMJudgeGrader({ client: badCostClient, rubric });
    const result = await grader.grade("test", "test");
    expect(Number.isFinite(result.totalCostUsd)).toBe(true);
  });
});

describe("LLMJudgeGrader passThreshold enforcement", () => {
  it("applies rubric passThreshold instead of trusting client pass", async () => {
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "quality",
          description: "Response quality",
          scale: { min: 1, max: 5 },
          passThreshold: 0.6,
        },
      ],
    };
    const client = new FakeJudgeClient([
      {
        criterionId: "quality",
        result: {
          criterionId: "quality",
          reasoning: "low quality",
          rawScore: 2,
          normalizedScore: 0.3,
          pass: true,
        },
      },
    ]);
    const grader = new LLMJudgeGrader({ client, rubric });
    const result = await grader.grade("test prompt", "bad response");
    const score = result.scores.find((s) => s.name === "judge/quality");
    expect(score).toBeDefined();
    expect(score!.pass).toBe(false);
    expect(score!.value).toBeCloseTo(0.3);
  });

  it("passes when normalizedScore meets passThreshold", async () => {
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "quality",
          description: "Response quality",
          scale: { min: 1, max: 5 },
          passThreshold: 0.6,
        },
      ],
    };
    const client = new FakeJudgeClient([
      {
        criterionId: "quality",
        result: {
          criterionId: "quality",
          reasoning: "good",
          rawScore: 4,
          normalizedScore: 0.8,
          pass: false,
        },
      },
    ]);
    const grader = new LLMJudgeGrader({ client, rubric });
    const result = await grader.grade("test prompt", "good response");
    const score = result.scores.find((s) => s.name === "judge/quality");
    expect(score!.pass).toBe(true);
  });
});

describe("RubricSchema validation", () => {
  it("rejects rubric with duplicate criterion IDs", () => {
    const result = RubricSchema.safeParse({
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        { id: "same", description: "a", scale: { min: 1, max: 5 }, passThreshold: 0.5 },
        { id: "same", description: "b", scale: { min: 1, max: 5 }, passThreshold: 0.5 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects criterion with scale.min > scale.max", () => {
    const result = RubricCriterionSchema.safeParse({
      id: "c",
      description: "test",
      scale: { min: 5, max: 1 },
      passThreshold: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects passThreshold outside [0, 1]", () => {
    const result = RubricCriterionSchema.safeParse({
      id: "c",
      description: "test",
      scale: { min: 1, max: 5 },
      passThreshold: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("LLMJudgeGrader criterionId mismatch handling", () => {
  it("uses criterion.id for score name, not judge-returned criterionId", async () => {
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "expected",
          description: "test",
          scale: { min: 1, max: 5 },
          passThreshold: 0.5,
        },
      ],
    };
    const badClient: JudgeClient = {
      async judge(): Promise<JudgeResponse> {
        return {
          result: {
            criterionId: "wrong-id",
            reasoning: "ok",
            rawScore: 4,
            normalizedScore: 0.8,
            pass: true,
          },
          cost: {
            inputTokens: 10,
            outputTokens: 5,
            model: "fake",
            estimatedCostUsd: 0.001,
          },
          cached: false,
        };
      },
    };
    const grader = new LLMJudgeGrader({ client: badClient, rubric });
    const result = await grader.grade("test", "test");
    const score = result.scores.find((s) => s.name === "judge/expected");
    expect(score).toBeDefined();
    expect(score!.value).toBeCloseTo(0.8);
    expect(
      result.scores.find((s) => s.name === "judge/wrong-id"),
    ).toBeUndefined();
  });
});

describe("LLMJudgeGrader constructor rubric validation", () => {
  it("throws on invalid rubric in constructor", () => {
    const invalidRubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "c",
          description: "test",
          scale: { min: 5, max: 1 },
          passThreshold: 0.5,
        },
      ],
    };
    expect(
      () =>
        new LLMJudgeGrader({
          client: new FakeJudgeClient([]),
          rubric: invalidRubric as any,
        }),
    ).toThrow();
  });

  it("throws on rubric with passThreshold > 1", () => {
    const invalidRubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        {
          id: "c",
          description: "test",
          scale: { min: 1, max: 5 },
          passThreshold: 3,
        },
      ],
    };
    expect(
      () =>
        new LLMJudgeGrader({
          client: new FakeJudgeClient([]),
          rubric: invalidRubric as any,
        }),
    ).toThrow();
  });
});

describe("LLMJudgeGrader judgeId cache isolation", () => {
  it("different judgeIds produce different cache keys", async () => {
    const cache = new InMemoryJudgeCache();
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        { id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 },
      ],
    };

    const client1 = new FakeJudgeClient([
      {
        criterionId: "c",
        result: { criterionId: "c", reasoning: "cheap judge", rawScore: 2, normalizedScore: 0.2, pass: false },
      },
    ]);
    const grader1 = new LLMJudgeGrader({ client: client1, rubric, cache, judgeId: "cheap-model" });
    await grader1.grade("test prompt", "test response");

    const client2 = new FakeJudgeClient([
      {
        criterionId: "c",
        result: { criterionId: "c", reasoning: "strong judge", rawScore: 5, normalizedScore: 1.0, pass: true },
      },
    ]);
    const grader2 = new LLMJudgeGrader({ client: client2, rubric, cache, judgeId: "strong-model" });
    const result = await grader2.grade("test prompt", "test response");

    expect(client2.callCount).toBe(1);
    const score = result.scores.find((s) => s.name === "judge/c");
    expect(score!.reason).toBe("strong judge");
  });

  it("same judgeId hits cache as expected", async () => {
    const cache = new InMemoryJudgeCache();
    const rubric: Rubric = {
      id: "r1",
      name: "test",
      version: "1.0",
      criteria: [
        { id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 },
      ],
    };
    const client = new FakeJudgeClient([
      {
        criterionId: "c",
        result: { criterionId: "c", reasoning: "cached", rawScore: 4, normalizedScore: 0.8, pass: true },
      },
    ]);

    const grader1 = new LLMJudgeGrader({ client, rubric, cache, judgeId: "same" });
    await grader1.grade("p", "r");

    const grader2 = new LLMJudgeGrader({ client, rubric, cache, judgeId: "same" });
    await grader2.grade("p", "r");

    expect(client.callCount).toBe(1);
  });

  it("does not emit duplicate scores when cache.set throws", async () => {
    const rubric: Rubric = {
      id: "r1", name: "test", version: "1.0",
      criteria: [{ id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 }],
    };
    const client = new FakeJudgeClient([{
      criterionId: "c",
      result: { criterionId: "c", reasoning: "good", rawScore: 4, normalizedScore: 0.8, pass: true },
    }]);
    const brokenCache: JudgeCache = {
      async get() { return undefined; },
      async set() { throw new Error("cache down"); },
    };
    const grader = new LLMJudgeGrader({ client, rubric, cache: brokenCache });
    const result = await grader.grade("test", "test");

    const cScores = result.scores.filter((s) => s.name === "judge/c");
    expect(cScores).toHaveLength(1);
    expect(cScores[0].pass).toBe(true);
    expect(cScores[0].value).toBeCloseTo(0.8);
  });

  it("falls through to judge client when cache.get throws", async () => {
    const rubric: Rubric = {
      id: "r1", name: "test", version: "1.0",
      criteria: [{ id: "c", description: "test", scale: { min: 1, max: 5 }, passThreshold: 0.5 }],
    };
    const client = new FakeJudgeClient([{
      criterionId: "c",
      result: { criterionId: "c", reasoning: "from judge", rawScore: 4, normalizedScore: 0.8, pass: true },
    }]);
    const brokenCache: JudgeCache = {
      async get() { throw new Error("cache read down"); },
      async set() { /* noop */ },
    };
    const grader = new LLMJudgeGrader({ client, rubric, cache: brokenCache });

    const result = await grader.grade("test", "test");
    expect(client.callCount).toBe(1);
    const score = result.scores.find((s) => s.name === "judge/c");
    expect(score).toBeDefined();
    expect(score!.reason).toBe("from judge");
    expect(score!.pass).toBe(true);
  });
});
