/**
 * Child reasoning-effort propagation across orchestration versions.
 *
 * Two invariants are pinned here:
 *
 *  1. **Frozen 1.0.43 is immutable.** It predates child reasoning-effort
 *     propagation, so it must NEVER serialize `reasoningEffort` into the
 *     child config — even when the spawn action carries one. Replay of a
 *     1.0.43 history must produce byte-identical activity input.
 *
 *  2. **Latest (1.0.44) propagates the *effective* effort.** An explicit
 *     `reasoningEffort` on the spawn action wins. A child that overrides
 *     the model but does NOT pick an effort must NOT inherit the parent's
 *     effort — the parent's effort belongs to the parent's model and may
 *     be unsupported (or mean something different) on the child's model.
 *     Same-model children keep inheriting normally.
 *
 * Run: npx vitest run test/local/orchestration-child-reasoning-effort.test.js
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSession;
let mockManager;

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: () => mockSession,
    createSessionManagerProxy: () => mockManager,
}));

function mkCtx() {
    return {
        traceInfo: () => {},
        setCustomStatus: () => {},
        setValue: () => {},
        getValue: () => null,
        clearValue: () => {},
        utcNow: () => ({ effect: "utcNow" }),
        newGuid: () => ({ effect: "newGuid" }),
        dequeueEvent: () => ({ effect: "dequeueEvent" }),
        scheduleTimer: (ms) => ({ effect: "scheduleTimer", ms }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "continueAsNew", input, version }),
    };
}

/**
 * Drive the generator far enough to capture the spawnChildSession call,
 * resolving intermediate effects with harmless values.
 */
function driveToSpawn(gen) {
    let input;
    for (let step = 0; step < 50; step += 1) {
        const next = gen.next(input);
        if (next.done) return;
        const effect = next.value;
        switch (effect?.effect) {
            case "spawnChildSession":
                // The call args are all this test needs; stop here so the
                // driver does not have to model the rest of the loop.
                return;
            case "utcNow":
                input = 1_713_083_589_000;
                break;
            case "race":
                // Drain race (dequeueEvent vs short timer) — resolve to the
                // timer branch so the loop treats the queue as empty and
                // moves on to the pending tool actions.
                input = { index: 1, value: undefined };
                break;
            case "scheduleTimer":
                input = undefined;
                break;
            case "checkpoint":
            case "recordSessionEvent":
            case "destroy":
                input = undefined;
                break;
            case "continueAsNew":
            case "dequeueEvent":
                return;
            default:
                throw new Error(`Unexpected effect: ${JSON.stringify(effect)}`);
        }
    }
    throw new Error("Exceeded step limit before spawn/stop");
}

function childConfigFromSpawn() {
    expect(mockManager.spawnChildSession).toHaveBeenCalled();
    return mockManager.spawnChildSession.mock.calls[0][1];
}

async function runSpawn(handler, { parentConfig, action }) {
    const ctx = mkCtx();
    const gen = handler(ctx, {
        sessionId: "parent-session",
        config: parentConfig,
        blobEnabled: false,
        isSystem: true,
        pendingToolActions: [action],
    });
    driveToSpawn(gen);
    return childConfigFromSpawn();
}

const SPAWN_TASK =
    "Analyze the incoming telemetry stream, correlate anomalies across workers, and report a summary.";

describe("child reasoning effort across orchestration versions", () => {
    beforeEach(() => {
        mockSession = {
            checkpoint: vi.fn(() => ({ effect: "checkpoint" })),
            destroy: vi.fn(() => ({ effect: "destroy" })),
        };
        mockManager = {
            spawnChildSession: vi.fn(() => ({ effect: "spawnChildSession" })),
            recordSessionEvent: vi.fn(() => ({ effect: "recordSessionEvent" })),
        };
    });

    it("frozen 1.0.43 never serializes child reasoningEffort", async () => {
        const { durableSessionOrchestration_1_0_43 } = await import("../../src/orchestration_1_0_43.ts");

        const childConfig = await runSpawn(durableSessionOrchestration_1_0_43, {
            parentConfig: { model: "codex-subscription:gpt-5.6-sol" },
            action: {
                type: "spawn_agent",
                task: SPAWN_TASK,
                model: "github-copilot:gpt-5.4",
                reasoningEffort: "high",
            },
        });

        expect(childConfig.model).toBe("github-copilot:gpt-5.4");
        expect(childConfig.reasoningEffort).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(childConfig, "reasoningEffort")).toBe(false);
    });

    it("frozen 1.0.43 still inherits the parent's reasoningEffort field verbatim", async () => {
        const { durableSessionOrchestration_1_0_43 } = await import("../../src/orchestration_1_0_43.ts");

        const childConfig = await runSpawn(durableSessionOrchestration_1_0_43, {
            parentConfig: { model: "codex-subscription:gpt-5.6-sol", reasoningEffort: "ultra" },
            action: {
                type: "spawn_agent",
                task: SPAWN_TASK,
                model: "github-copilot:gpt-5.4",
                reasoningEffort: "high",
            },
        });

        // Frozen behavior: the spread of parentConfig is the ONLY source of
        // reasoningEffort in 1.0.43. Changing this would break replay.
        expect(childConfig.reasoningEffort).toBe("ultra");
    });

    it("latest propagates an explicit child reasoningEffort", async () => {
        const { durableSessionOrchestration_1_0_44 } = await import("../../src/orchestration.ts");

        const childConfig = await runSpawn(durableSessionOrchestration_1_0_44, {
            parentConfig: { model: "codex-subscription:gpt-5.6-sol", reasoningEffort: "ultra" },
            action: {
                type: "spawn_agent",
                task: SPAWN_TASK,
                model: "github-copilot:gpt-5.4",
                reasoningEffort: "high",
            },
        });

        expect(childConfig.model).toBe("github-copilot:gpt-5.4");
        expect(childConfig.reasoningEffort).toBe("high");
    });

    it("latest drops the inherited effort when the child overrides the model without picking one", async () => {
        const { durableSessionOrchestration_1_0_44 } = await import("../../src/orchestration.ts");

        const childConfig = await runSpawn(durableSessionOrchestration_1_0_44, {
            parentConfig: { model: "codex-subscription:gpt-5.6-sol", reasoningEffort: "ultra" },
            action: {
                type: "spawn_agent",
                task: SPAWN_TASK,
                model: "github-copilot:gpt-5.4",
            },
        });

        expect(childConfig.model).toBe("github-copilot:gpt-5.4");
        expect(childConfig.reasoningEffort).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(childConfig, "reasoningEffort")).toBe(false);
    });

    it("latest keeps the inherited effort when the child stays on the parent's model", async () => {
        const { durableSessionOrchestration_1_0_44 } = await import("../../src/orchestration.ts");

        const childConfig = await runSpawn(durableSessionOrchestration_1_0_44, {
            parentConfig: { model: "codex-subscription:gpt-5.6-sol", reasoningEffort: "ultra" },
            action: { type: "spawn_agent", task: SPAWN_TASK },
        });

        expect(childConfig.model).toBe("codex-subscription:gpt-5.6-sol");
        expect(childConfig.reasoningEffort).toBe("ultra");
    });

    it("latest keeps an explicit effort even when the child model equals the parent model", async () => {
        const { durableSessionOrchestration_1_0_44 } = await import("../../src/orchestration.ts");

        const childConfig = await runSpawn(durableSessionOrchestration_1_0_44, {
            parentConfig: { model: "codex-subscription:gpt-5.6-sol", reasoningEffort: "ultra" },
            action: {
                type: "spawn_agent",
                task: SPAWN_TASK,
                model: "codex-subscription:gpt-5.6-sol",
                reasoningEffort: "low",
            },
        });

        expect(childConfig.reasoningEffort).toBe("low");
    });
});

describe("orchestration version registry wiring", () => {
    it("registers 1.0.43 as a frozen version and 1.0.44 as latest", async () => {
        const registry = await import("../../src/orchestration-registry.ts");
        const { DURABLE_SESSION_LATEST_VERSION } = await import("../../src/orchestration-version.ts");
        const { durableSessionOrchestration_1_0_43 } = await import("../../src/orchestration_1_0_43.ts");
        const { durableSessionOrchestration_1_0_44 } = await import("../../src/orchestration.ts");

        expect(DURABLE_SESSION_LATEST_VERSION).toBe("1.0.44");

        const entries = registry.DURABLE_SESSION_ORCHESTRATION_REGISTRY;
        const versions = entries.map((e) => e.version);
        expect(versions).toContain("1.0.43");
        expect(versions).toContain("1.0.44");
        expect(versions[versions.length - 1]).toBe("1.0.44");

        const frozen = entries.find((e) => e.version === "1.0.43");
        const latest = entries.find((e) => e.version === "1.0.44");
        expect(frozen.handler).toBe(durableSessionOrchestration_1_0_43);
        expect(latest.handler).toBe(durableSessionOrchestration_1_0_44);
    });
});
