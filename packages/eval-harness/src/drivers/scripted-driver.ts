import type { Driver, DriverOptions } from "./types.js";
import type {
  DurabilityFaultMode,
  DurabilityFaultPoint,
  DurabilityObservation,
  EvalSample,
  ObservedResult,
} from "../types.js";

export interface ScriptedStep {
  type: "respond" | "crash" | "recover";
  /** For "respond": the ObservedResult to return if this is the last step. */
  response?: ObservedResult;
  /** For "crash": fault details recorded into the DurabilityObservation. */
  faultPoint?: DurabilityFaultPoint;
  faultMode?: DurabilityFaultMode;
  /** For "recover": post-recovery ObservedResult (takes precedence over any earlier respond). */
  recoveryResponse?: ObservedResult;
  /** Optional explicit durability observation override (applied after auto-build). */
  durability?: Partial<DurabilityObservation>;
}

export interface ScriptedScenario {
  sampleId: string;
  steps: ScriptedStep[];
}

/**
 * Driver that replays a scripted sequence of steps (respond / crash / recover)
 * into a single composed ObservedResult. Used to exercise durability graders
 * without running a real worker.
 */
export class ScriptedDriver implements Driver {
  private scenarios: Map<string, ScriptedScenario>;
  private crashOnly: Map<string, { faultPoint: DurabilityFaultPoint; faultMode: DurabilityFaultMode }>;

  constructor(scenarios: ScriptedScenario[]) {
    this.scenarios = new Map();
    this.crashOnly = new Map();
    for (const s of scenarios) {
      this.scenarios.set(s.sampleId, s);
    }
  }

  async run(sample: EvalSample, options?: DriverOptions): Promise<ObservedResult> {
    const scenario = this.scenarios.get(sample.id);
    if (!scenario) {
      throw new Error(`ScriptedDriver: unknown sampleId "${sample.id}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (options?.signal?.aborted) {
      throw new Error(`ScriptedDriver: aborted while serving sample "${sample.id}"`);
    }

    const composed = this.buildResult(scenario);
    if (composed === null) {
      throw new Error(
        `ScriptedDriver: scenario "${sample.id}" crashed without recovery (infra error)`,
      );
    }
    return structuredClone(composed);
  }

  private buildResult(scenario: ScriptedScenario): ObservedResult | null {
    const steps = scenario.steps;
    if (steps.length === 0) {
      throw new Error(`ScriptedDriver: scenario "${scenario.sampleId}" has no steps`);
    }

    // Locate the last crash step (if any) and the last respond/recover steps.
    let crashIdx = -1;
    let lastRespondIdx = -1;
    let lastRecoverIdx = -1;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.type === "crash") crashIdx = i;
      if (s.type === "respond") lastRespondIdx = i;
      if (s.type === "recover") lastRecoverIdx = i;
    }

    const hasCrash = crashIdx !== -1;
    const hasRecover = lastRecoverIdx !== -1 && lastRecoverIdx > crashIdx;

    if (hasCrash && !hasRecover) {
      return null; // infra error path
    }

    // Base result comes from whichever is later: last recover or last respond.
    // This allows a respond step after recover to supply the final answer
    // while the recover step still contributes durability metadata.
    const finalIdx = Math.max(lastRecoverIdx, lastRespondIdx);
    if (finalIdx === -1) {
      throw new Error(
        `ScriptedDriver: scenario "${scenario.sampleId}" has no respond/recover step`,
      );
    }
    const finalStep = steps[finalIdx];
    const base =
      finalStep.type === "recover" ? finalStep.recoveryResponse : finalStep.response;
    if (!base) {
      throw new Error(
        `ScriptedDriver: scenario "${scenario.sampleId}" step ${finalIdx} missing payload`,
      );
    }
    const result: ObservedResult = structuredClone(base);

    // Pre-crash respond (if any) contributes tool call counts to the durability observation.
    let preCrashRespond: ObservedResult | undefined;
    if (hasCrash) {
      for (let i = crashIdx - 1; i >= 0; i--) {
        if (steps[i].type === "respond") {
          preCrashRespond = steps[i].response;
          break;
        }
      }
    }

    if (hasCrash) {
      const crash = steps[crashIdx];
      const recover = hasRecover ? steps[lastRecoverIdx] : undefined;
      const observation: DurabilityObservation = {
        scenario: scenario.sampleId,
        faultPoint: crash.faultPoint ?? "during_tool_call",
        faultMode: crash.faultMode ?? "worker_crash",
        injected: true,
        recovered: hasRecover,
        preCrashState: preCrashRespond?.cmsState,
        toolCallsBeforeFault: preCrashRespond?.toolCalls.length ?? 0,
        ...(crash.durability ?? {}),
        ...(recover?.durability ?? {}),
        ...(finalStep.type === "respond" ? finalStep.durability ?? {} : {}),
        postRecoveryState: result.cmsState,
        toolCallsAfterRecovery: result.toolCalls.length,
      };
      result.durability = observation;
    } else if (finalStep.durability) {
      // Respond-only scenarios may still carry a durability observation (e.g. no fault injected).
      const base: DurabilityObservation = {
        scenario: scenario.sampleId,
        faultPoint: "before_turn",
        faultMode: "worker_crash",
        injected: false,
        recovered: true,
        toolCallsBeforeFault: 0,
        toolCallsAfterRecovery: result.toolCalls.length,
        ...finalStep.durability,
      };
      result.durability = base;
    }

    return result;
  }

  static fromScenarios(scenarios: ScriptedScenario[]): ScriptedDriver {
    return new ScriptedDriver(scenarios);
  }
}
