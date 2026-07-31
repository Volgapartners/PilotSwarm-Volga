/**
 * Reasoning-effort widening tests.
 *
 * The Codex model catalog exposes reasoning-effort values beyond the original
 * `low | medium | high | xhigh` set — specifically `max` and `ultra` on the
 * gpt-5.6-* family. These tests pin the required behavior so a chosen effort
 * survives every layer between provider config and the Codex runtime:
 *
 *   provider config → ModelProviderRegistry
 *                   → management client listModels()
 *                   → UI picker / sessionOptions
 *                   → spawn_agent tool schema (used by parent agents when
 *                     they programmatically forward efforts to children)
 *                   → managed-session normalizeReasoningEffort
 *
 * Vitest, no Postgres/preflight dependency — pure unit level.
 */

import { describe, it, expect, vi } from "vitest";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { ManagedSession } from "../../src/managed-session.ts";

// Minimal FakeCopilotSession scaffolding, copied from inline-control-tools.
class FakeCopilotSession {
    registeredTools = [];
    listeners = new Map();
    catchAllHandlers = [];
    scriptedToolCalls = [];
    scriptedToolResults = [];
    assistantContent = "ok";
    aborted = false;

    on(eventType, handler) {
        if (typeof eventType === "function") {
            this.catchAllHandlers.push(eventType);
            return () => {
                this.catchAllHandlers = this.catchAllHandlers.filter((c) => c !== eventType);
            };
        }
        const handlers = this.listeners.get(eventType) ?? [];
        handlers.push(handler);
        this.listeners.set(eventType, handlers);
        return () => {
            const current = this.listeners.get(eventType) ?? [];
            this.listeners.set(eventType, current.filter((c) => c !== handler));
        };
    }

    registerTools(tools) {
        this.registeredTools = tools;
    }

    emit(eventType, payload = {}) {
        for (const handler of this.catchAllHandlers) {
            handler({ type: eventType, data: payload.data ?? payload });
        }
        const handlers = this.listeners.get(eventType) ?? [];
        for (const handler of handlers) {
            handler(payload);
        }
    }

    async send() {
        this.aborted = false;
        queueMicrotask(async () => {
            for (const call of this.scriptedToolCalls) {
                if (this.aborted) break;
                const tool = this.registeredTools.find((t) => t.name === call.name);
                if (!tool) throw new Error(`Missing fake tool: ${call.name}`);
                const result = await tool.handler(call.args ?? {});
                this.scriptedToolResults.push({ name: call.name, result });
            }
            if (!this.aborted && this.assistantContent != null) {
                this.emit("assistant.message", { data: { content: this.assistantContent } });
            }
            this.emit("session.idle", { data: {} });
        });
    }

    abort() {
        this.aborted = true;
    }
}

// ─── ModelProviderRegistry preserves max/ultra ────────────────────

describe("model-providers reasoning-effort widening", () => {
    it("preserves 'max' and 'ultra' in supportedReasoningEfforts on descriptors", () => {
        const registry = new ModelProviderRegistry({
            providers: [{
                id: "codex",
                type: "codex",
                codexHome: "env:CODEX_HOME_UNUSED_FOR_DESCRIPTOR",
                models: [
                    {
                        name: "gpt-5.6-sol",
                        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
                        defaultReasoningEffort: "low",
                    },
                    {
                        name: "gpt-5.6-terra",
                        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
                        defaultReasoningEffort: "medium",
                    },
                    {
                        name: "gpt-5.6-luna",
                        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
                        defaultReasoningEffort: "medium",
                    },
                ],
            }],
        });

        const sol = registry.getDescriptor("codex:gpt-5.6-sol");
        expect(sol?.supportedReasoningEfforts).toEqual([
            "low", "medium", "high", "xhigh", "max", "ultra",
        ]);
        expect(sol?.defaultReasoningEffort).toBe("low");

        const terra = registry.getDescriptor("codex:gpt-5.6-terra");
        expect(terra?.supportedReasoningEfforts).toEqual([
            "low", "medium", "high", "xhigh", "max", "ultra",
        ]);
        expect(terra?.defaultReasoningEffort).toBe("medium");

        const luna = registry.getDescriptor("codex:gpt-5.6-luna");
        expect(luna?.supportedReasoningEfforts).toEqual([
            "low", "medium", "high", "xhigh", "max",
        ]);
        expect(luna?.defaultReasoningEffort).toBe("medium");
    });

    it("keeps a defaultReasoningEffort of 'ultra' when it is in the supported set", () => {
        const registry = new ModelProviderRegistry({
            providers: [{
                id: "codex",
                type: "codex",
                codexHome: "env:CODEX_HOME_UNUSED",
                models: [{
                    name: "gpt-5.6-hypothetical",
                    supportedReasoningEfforts: ["high", "max", "ultra"],
                    defaultReasoningEffort: "ultra",
                }],
            }],
        });

        const desc = registry.getDescriptor("codex:gpt-5.6-hypothetical");
        expect(desc?.supportedReasoningEfforts).toEqual(["high", "max", "ultra"]);
        expect(desc?.defaultReasoningEffort).toBe("ultra");
    });

    it("still drops unrecognized effort strings but keeps valid max/ultra alongside them", () => {
        const registry = new ModelProviderRegistry({
            providers: [{
                id: "codex",
                type: "codex",
                codexHome: "env:CODEX_HOME_UNUSED",
                models: [{
                    name: "gpt-5.6-mixed",
                    // "bogus" must be dropped; max/ultra must survive.
                    supportedReasoningEfforts: ["medium", "bogus", "max", "ultra"],
                    defaultReasoningEffort: "max",
                }],
            }],
        });

        const desc = registry.getDescriptor("codex:gpt-5.6-mixed");
        expect(desc?.supportedReasoningEfforts).toEqual(["medium", "max", "ultra"]);
        expect(desc?.defaultReasoningEffort).toBe("max");
    });

    it("advertises max/ultra in the LLM-facing model summary", () => {
        const registry = new ModelProviderRegistry({
            providers: [{
                id: "codex",
                type: "codex",
                codexHome: "env:CODEX_HOME_UNUSED",
                models: [{
                    name: "gpt-5.6-sol",
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
                    defaultReasoningEffort: "low",
                }],
            }],
        });

        const summary = registry.getModelSummaryForLLM();
        expect(summary).toMatch(/max/);
        expect(summary).toMatch(/ultra/);
    });
});

// ─── managed-session normalizes/advertises max/ultra ──────────────

describe("managed-session reasoning-effort widening", () => {
    it("subAgentToolDefs advertises max and ultra in the spawn_agent enum", () => {
        const spawnTool = ManagedSession.subAgentToolDefs().find((tool) => tool.name === "spawn_agent");
        expect(spawnTool).toBeDefined();
        const enumValues = spawnTool?.parameters?.properties?.reasoning_effort?.enum;
        expect(enumValues).toEqual(expect.arrayContaining([
            "low", "medium", "high", "xhigh", "max", "ultra",
        ]));
    });

    it("live spawn_agent tool schema also advertises max and ultra", async () => {
        const fakeSession = new FakeCopilotSession();
        // Empty scripted calls — we only need to trigger tool registration.
        fakeSession.assistantContent = "noop";

        const controlToolBridge = {
            spawnAgent: vi.fn(async () => ""),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(async () => []),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
        };

        const managed = new ManagedSession("reasoning-widening-live", fakeSession, {});
        await managed.runTurn("register tools", { controlToolBridge });

        const spawnTool = fakeSession.registeredTools.find((tool) => tool.name === "spawn_agent");
        expect(spawnTool).toBeDefined();
        const enumValues = spawnTool?.parameters?.properties?.reasoning_effort?.enum;
        expect(enumValues).toEqual(expect.arrayContaining([
            "low", "medium", "high", "xhigh", "max", "ultra",
        ]));
    });

    it("spawn_agent handler accepts reasoning_effort: 'max' and forwards it to the control bridge", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "spawn_agent", args: { task: "reason at max", model: "codex:gpt-5.6-sol", reasoning_effort: "max" } },
        ];
        fakeSession.assistantContent = "Spawned max-reasoning child.";

        const controlToolBridge = {
            spawnAgent: vi.fn(async () => "[SYSTEM: spawned]"),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(async () => []),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
        };

        const managed = new ManagedSession("reasoning-widening-max", fakeSession, {});
        const result = await managed.runTurn("spawn max child", { controlToolBridge });

        expect(controlToolBridge.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
            task: "reason at max",
            model: "codex:gpt-5.6-sol",
            reasoning_effort: "max",
        }));
        expect(result.type).toBe("completed");
    });

    it("spawn_agent handler accepts reasoning_effort: 'ultra' and forwards it to the control bridge", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "spawn_agent", args: { task: "reason at ultra", model: "codex:gpt-5.6-terra", reasoning_effort: "ultra" } },
        ];
        fakeSession.assistantContent = "Spawned ultra-reasoning child.";

        const controlToolBridge = {
            spawnAgent: vi.fn(async () => "[SYSTEM: spawned]"),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(async () => []),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
        };

        const managed = new ManagedSession("reasoning-widening-ultra", fakeSession, {});
        await managed.runTurn("spawn ultra child", { controlToolBridge });

        expect(controlToolBridge.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({
            task: "reason at ultra",
            model: "codex:gpt-5.6-terra",
            reasoning_effort: "ultra",
        }));
    });

    it("spawn_agent handler rejects a truly invalid reasoning_effort with an error message that reflects the widened set", async () => {
        const fakeSession = new FakeCopilotSession();
        fakeSession.scriptedToolCalls = [
            { name: "spawn_agent", args: { task: "reject me", reasoning_effort: "bogus" } },
        ];
        fakeSession.assistantContent = "Handled invalid effort.";

        const controlToolBridge = {
            spawnAgent: vi.fn(async () => "[SYSTEM: spawned]"),
            messageAgent: vi.fn(),
            checkAgents: vi.fn(),
            resolveWaitForAgents: vi.fn(async () => []),
            listSessions: vi.fn(),
            completeAgent: vi.fn(),
            cancelAgent: vi.fn(),
            deleteAgent: vi.fn(),
        };

        const managed = new ManagedSession("reasoning-widening-invalid", fakeSession, {});
        await managed.runTurn("spawn invalid child", { controlToolBridge });

        expect(controlToolBridge.spawnAgent).not.toHaveBeenCalled();
        const invalid = fakeSession.scriptedToolResults.find((r) => r.name === "spawn_agent");
        expect(invalid?.result).toMatch(/reasoning_effort/i);
        expect(invalid?.result).toMatch(/max/);
        expect(invalid?.result).toMatch(/ultra/);
    });
});
