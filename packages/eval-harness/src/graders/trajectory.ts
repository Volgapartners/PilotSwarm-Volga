import type {
  EvalExpected,
  ObservedResult,
  ObservedTrajectory,
  Score,
  TrajectorySample,
  TrajectoryScore,
} from "../types.js";
import { gradeEvalCase } from "./index.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prefix(scores: Score[], p: string): Score[] {
  return scores.map((s) => ({ ...s, name: `${p}${s.name}` }));
}

export function gradeTrajectory(
  observed: ObservedTrajectory,
  sample: TrajectorySample,
): TrajectoryScore {
  const turnScores: Score[][] = [];

  for (let i = 0; i < sample.turns.length; i++) {
    const turn = sample.turns[i];
    const observedTurn = observed.turns[i];
    if (!observedTurn) {
      turnScores.push([
        {
          name: `t${i + 1}/missing`,
          value: 0,
          pass: false,
          reason: `Turn ${i + 1} not observed`,
        },
      ]);
      continue;
    }

    const turnObserved: ObservedResult = {
      toolCalls: observedTurn.toolCalls,
      finalResponse: observedTurn.response,
      sessionId: observed.sessionId,
      latencyMs: observedTurn.latencyMs,
      model: observed.model,
    };

    const turnExpected: EvalExpected = {
      toolCalls: turn.expected.toolCalls,
      toolSequence: turn.expected.toolSequence ?? "unordered",
      forbiddenTools: turn.expected.forbiddenTools,
      noToolCall: turn.expected.noToolCall,
      response: turn.expected.response,
    };

    const raw = gradeEvalCase(turnObserved, turnExpected);
    turnScores.push(prefix(raw, `t${i + 1}/`));
  }

  // Cross-turn: context retention
  const crossTurnScores: Score[] = [];
  if (sample.expected?.contextRetention) {
    for (const cr of sample.expected.contextRetention) {
      const after = observed.turns.slice(cr.mustAppearAfterTurn + 1);
      const re = new RegExp(`\\b${escapeRegExp(cr.term)}\\b`, "i");
      const found = after.some((t) => re.test(t.response));
      crossTurnScores.push({
        name: `context-retention/${cr.term}`,
        value: found ? 1 : 0,
        pass: found,
        reason: found
          ? `"${cr.term}" retained after turn ${cr.mustAppearAfterTurn}`
          : `"${cr.term}" not found after turn ${cr.mustAppearAfterTurn}`,
      });
    }
  }

  // Holistic
  const holisticScores: Score[] = [];

  const expectedTurnCount = sample.turns.length;
  const observedTurnCount = observed.turns.length;
  const turnCountOk = observedTurnCount === expectedTurnCount;
  holisticScores.push({
    name: "turn-count",
    value: turnCountOk ? 1 : 0,
    pass: turnCountOk,
    reason: turnCountOk
      ? `${observedTurnCount} turns as expected`
      : `Expected ${expectedTurnCount} turns but observed ${observedTurnCount}`,
    actual: observedTurnCount,
    expected: expectedTurnCount,
  });

  if (sample.expected?.goalCompleted !== undefined) {
    const allTurnsPass =
      turnScores.length > 0 && turnScores.every((ts) => ts.every((s) => s.pass));
    const goalMet = allTurnsPass;
    const expectGoal = sample.expected.goalCompleted;
    const pass = goalMet === expectGoal;
    holisticScores.push({
      name: "goal-completed",
      value: pass ? 1 : 0,
      pass,
      reason: expectGoal
        ? allTurnsPass
          ? "All turns passed"
          : "Some turns failed"
        : allTurnsPass
          ? "Expected goal not to be completed, but all turns passed"
          : "Goal correctly not completed",
    });
  }
  if (sample.expected?.maxTotalToolCalls !== undefined) {
    const totalCalls = observed.turns.reduce((sum, t) => sum + t.toolCalls.length, 0);
    const budget = sample.expected.maxTotalToolCalls;
    const ok = totalCalls <= budget;
    holisticScores.push({
      name: "call-budget",
      value: ok ? 1 : 0,
      pass: ok,
      reason: ok
        ? `${totalCalls} calls within budget of ${budget}`
        : `${totalCalls} calls exceeds budget of ${budget}`,
      actual: totalCalls,
      expected: budget,
    });
  }

  return { turnScores, crossTurnScores, holisticScores };
}
