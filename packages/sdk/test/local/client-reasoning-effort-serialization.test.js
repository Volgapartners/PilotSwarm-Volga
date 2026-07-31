/**
 * Client -> SerializableSessionConfig `reasoningEffort` propagation.
 *
 * Regression: `PilotSwarmClient._ensureOrchestrationAndSend()` builds a
 * `SerializableSessionConfig` from the in-memory session config and
 * hands it to duroxide as `OrchestrationInput.config`. If it forgets a
 * field, the worker never sees the user's selection. `reasoningEffort`
 * was omitted, so max/xhigh/ultra picks (including gpt-5.6 `ultra`)
 * silently dropped between the UI and the worker.
 *
 * These tests reach into the client with a stub duroxide client to
 * capture the OrchestrationInput sent on the FIRST call and assert
 * that `reasoningEffort` (including the widened `ultra` value) is
 * preserved alongside the existing config fields.
 *
 * Run: npx vitest run test/local/client-reasoning-effort-serialization.test.js
 */

import { describe, it, expect } from "vitest";
import { PilotSwarmClient } from "../../src/client.ts";

function mkCatalogStub() {
    return {
        async initialize() {},
        async createSession() {},
        async updateSession() {},
        async softDeleteSession() {},
        async listSessions() { return []; },
        async getSession() { return null; },
        async getDescendantSessionIds() { return []; },
        async getLastSessionId() { return null; },
        async recordEvents() {},
        async getSessionEvents() { return []; },
        async getSessionEventsBefore() { return []; },
        async getSessionMetricSummary() { return null; },
        async getSessionTreeStats() { return null; },
        async getFleetStats() { return { totals: {}, perAgent: [] }; },
        async upsertSessionMetricSummary() {},
        async pruneDeletedSummaries() { return 0; },
        async getUserGitHubCopilotKey() { return null; },
        async close() {},
    };
}

function attachFakeDuroxideClient(client) {
    const startCalls = [];
    const enqueueCalls = [];
    const fake = {
        startOrchestrationVersioned: async (id, name, input, _version) => {
            startCalls.push({ id, name, input });
        },
        raiseEvent: async (id, event, payload) => {
            enqueueCalls.push({ id, event, payload });
        },
        // The client wraps its enqueue in this helper when present.
        enqueueEvent: async (id, event) => {
            enqueueCalls.push({ id, event });
        },
        signalOrchestration: async () => {},
        getOrchestrationStatus: async () => null,
        waitForStatusChange: async () => null,
    };
    client.duroxideClient = fake;
    client.started = true;
    client._catalog = mkCatalogStub();
    return { startCalls, enqueueCalls };
}

async function sendPromptViaReflection(client, sessionId, prompt) {
    // The private _ensureOrchestrationAndSend name-mangles into the same
    // string on the compiled JS; TypeScript's `private` is not enforced
    // at runtime. Fall back to calling `send()` on a PilotSwarmSession
    // handle if the private method is unreachable.
    if (typeof client._ensureOrchestrationAndSend === "function") {
        return client._ensureOrchestrationAndSend(sessionId, prompt);
    }
    throw new Error("_ensureOrchestrationAndSend not accessible on client");
}

describe("Client reasoningEffort serialization", () => {
    it("includes `reasoningEffort` in the OrchestrationInput.config when starting a fresh orchestration", async () => {
        const client = new PilotSwarmClient({ databaseUrl: "postgres://unused" });
        const { startCalls } = attachFakeDuroxideClient(client);

        // Seed the session config the way createSession() would.
        client.sessionConfigs.set("sess-1", {
            model: "codex-subscription:gpt-5.5",
            reasoningEffort: "high",
            systemMessage: "hi",
        });

        await sendPromptViaReflection(client, "sess-1", "hello");

        expect(startCalls.length).toBeGreaterThan(0);
        const input = startCalls[0].input;
        expect(input.sessionId).toBe("sess-1");
        expect(input.config.model).toBe("codex-subscription:gpt-5.5");
        expect(input.config.reasoningEffort).toBe("high");
        expect(input.config.systemMessage).toBe("hi");
    });

    it("preserves widened effort values like `ultra` through serialization", async () => {
        const client = new PilotSwarmClient({ databaseUrl: "postgres://unused" });
        const { startCalls } = attachFakeDuroxideClient(client);

        client.sessionConfigs.set("sess-ultra", {
            model: "codex-subscription:gpt-5.6-sol",
            reasoningEffort: "ultra",
        });

        await sendPromptViaReflection(client, "sess-ultra", "go");

        const input = startCalls[0].input;
        expect(input.config.reasoningEffort).toBe("ultra");
    });

    it("still preserves existing config fields (toolNames, model, workingDirectory) alongside reasoningEffort", async () => {
        const client = new PilotSwarmClient({ databaseUrl: "postgres://unused" });
        const { startCalls } = attachFakeDuroxideClient(client);

        client.sessionConfigs.set("sess-full", {
            model: "codex-subscription:gpt-5.5",
            reasoningEffort: "max",
            workingDirectory: "/tmp/whatever",
            toolNames: ["teams_alert"],
        });

        await sendPromptViaReflection(client, "sess-full", "run");

        const input = startCalls[0].input;
        expect(input.config.model).toBe("codex-subscription:gpt-5.5");
        expect(input.config.reasoningEffort).toBe("max");
        expect(input.config.workingDirectory).toBe("/tmp/whatever");
        expect(input.config.toolNames).toEqual(["teams_alert"]);
    });
});
