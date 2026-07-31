/**
 * End-to-end `reasoningEffort` plumbing through the REAL transports.
 *
 * The shared UI controller collects a reasoning-effort selection from the
 * model picker and hands it to `transport.createSession(options)` /
 * `transport.createSessionForAgent(agentName, options)`. Every hop between
 * that call and the SDK has to forward the field or the user's pick is
 * silently dropped:
 *
 *   ui-core controller
 *     -> packages/portal/runtime.js  (browser RPC dispatch)
 *     -> packages/cli/src/node-sdk-transport.js  (NodeSdkTransport)
 *     -> PilotSwarmClient.createSession / createSessionForAgent
 *     -> SerializableSessionConfig (worker / Codex runtime)
 *
 * These tests exercise the real `NodeSdkTransport`, the real `PortalRuntime`
 * RPC dispatch, and the real `PilotSwarmClient` rather than the fake ui-core
 * transport, so a dropped field in any of those layers fails here.
 *
 * Run: npx vitest run test/local/reasoning-effort-transport.test.js
 */

import { describe, it, expect } from "vitest";
import { NodeSdkTransport } from "pilotswarm-cli/portal";
import { PortalRuntime } from "../../../portal/runtime.js";
import { PilotSwarmClient } from "../../src/client.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function mkTransport({ defaultModel = "codex-subscription:gpt-5.5" } = {}) {
    const transport = new NodeSdkTransport({ store: { kind: "test" }, mode: "local" });
    const createSessionCalls = [];
    const createSessionForAgentCalls = [];

    transport.client = {
        async createSession(config) {
            createSessionCalls.push(config);
            return { sessionId: "sess-generic" };
        },
        async createSessionForAgent(agentName, opts) {
            createSessionForAgentCalls.push({ agentName, opts });
            return { sessionId: "sess-agent" };
        },
    };
    transport.mgmt = {
        getDefaultModel() { return defaultModel; },
    };

    return { transport, createSessionCalls, createSessionForAgentCalls };
}

function mkPortalRuntime() {
    const runtime = Object.create(PortalRuntime.prototype);
    const calls = [];
    runtime.started = true;
    runtime.startPromise = null;
    runtime.mode = "local";
    runtime.transport = {
        async createSession(options) {
            calls.push({ method: "createSession", options });
            return { sessionId: "portal-generic" };
        },
        async createSessionForAgent(agentName, options) {
            calls.push({ method: "createSessionForAgent", agentName, options });
            return { sessionId: "portal-agent" };
        },
    };
    return { runtime, calls };
}

function mkCatalogStub() {
    return {
        async initialize() {},
        async createSession() {},
        async updateSession() {},
        async listSessions() { return []; },
        async getSession() { return null; },
        async close() {},
    };
}

// ─── NodeSdkTransport (native TUI + portal server transport) ──────

describe("NodeSdkTransport reasoningEffort forwarding", () => {
    it("forwards reasoningEffort to client.createSession for generic sessions", async () => {
        const { transport, createSessionCalls } = mkTransport();

        const result = await transport.createSession({
            model: "codex-subscription:gpt-5.6-sol",
            reasoningEffort: "ultra",
        });

        expect(createSessionCalls).toHaveLength(1);
        expect(createSessionCalls[0].model).toBe("codex-subscription:gpt-5.6-sol");
        expect(createSessionCalls[0].reasoningEffort).toBe("ultra");
        expect(result.reasoningEffort).toBe("ultra");
    });

    it("forwards reasoningEffort to client.createSessionForAgent for named agents", async () => {
        const { transport, createSessionForAgentCalls } = mkTransport();

        const result = await transport.createSessionForAgent("watcher", {
            model: "codex-subscription:gpt-5.5",
            reasoningEffort: "high",
            title: "Watcher",
        });

        expect(createSessionForAgentCalls).toHaveLength(1);
        const { agentName, opts } = createSessionForAgentCalls[0];
        expect(agentName).toBe("watcher");
        expect(opts.reasoningEffort).toBe("high");
        expect(opts.title).toBe("Watcher");
        expect(result.reasoningEffort).toBe("high");
    });

    it("omits reasoningEffort entirely when the caller did not pick one", async () => {
        const { transport, createSessionCalls, createSessionForAgentCalls } = mkTransport();

        await transport.createSession({});
        await transport.createSessionForAgent("watcher", {});

        expect(createSessionCalls[0]).not.toHaveProperty("reasoningEffort");
        expect(createSessionForAgentCalls[0].opts).not.toHaveProperty("reasoningEffort");
    });

    it("still applies the default model when only reasoningEffort is provided", async () => {
        const { transport, createSessionCalls } = mkTransport({ defaultModel: "codex-subscription:gpt-5.5" });

        await transport.createSession({ reasoningEffort: "max" });

        expect(createSessionCalls[0].model).toBe("codex-subscription:gpt-5.5");
        expect(createSessionCalls[0].reasoningEffort).toBe("max");
    });
});

// ─── PortalRuntime RPC dispatch (browser portal) ──────────────────

describe("PortalRuntime reasoningEffort RPC forwarding", () => {
    it("forwards reasoningEffort on the createSession RPC", async () => {
        const { runtime, calls } = mkPortalRuntime();

        await runtime.call("createSession", {
            model: "codex-subscription:gpt-5.6-sol",
            reasoningEffort: "ultra",
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].options.model).toBe("codex-subscription:gpt-5.6-sol");
        expect(calls[0].options.reasoningEffort).toBe("ultra");
    });

    it("forwards reasoningEffort on the createSessionForAgent RPC", async () => {
        const { runtime, calls } = mkPortalRuntime();

        await runtime.call("createSessionForAgent", {
            agentName: "watcher",
            model: "codex-subscription:gpt-5.5",
            reasoningEffort: "high",
            title: "Watcher",
            splash: "hello",
            initialPrompt: "go",
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].agentName).toBe("watcher");
        expect(calls[0].options.reasoningEffort).toBe("high");
        expect(calls[0].options.model).toBe("codex-subscription:gpt-5.5");
        expect(calls[0].options.title).toBe("Watcher");
        expect(calls[0].options.splash).toBe("hello");
        expect(calls[0].options.initialPrompt).toBe("go");
    });

    it("leaves reasoningEffort undefined when the client did not send one", async () => {
        const { runtime, calls } = mkPortalRuntime();

        await runtime.call("createSession", { model: "codex-subscription:gpt-5.5" });
        await runtime.call("createSessionForAgent", { agentName: "watcher" });

        expect(calls[0].options.reasoningEffort).toBeUndefined();
        expect(calls[1].options.reasoningEffort).toBeUndefined();
    });
});

// ─── PilotSwarmClient (SDK entry points) ──────────────────────────

describe("PilotSwarmClient reasoningEffort capture", () => {
    it("stores reasoningEffort on the in-memory session config from createSession", async () => {
        const client = new PilotSwarmClient({ databaseUrl: "postgres://unused" });
        client._catalog = mkCatalogStub();

        const session = await client.createSession({
            model: "codex-subscription:gpt-5.6-sol",
            reasoningEffort: "ultra",
        });

        const stored = client.sessionConfigs.get(session.sessionId);
        expect(stored.model).toBe("codex-subscription:gpt-5.6-sol");
        expect(stored.reasoningEffort).toBe("ultra");
    });

    it("leaves reasoningEffort undefined when no effort was selected", async () => {
        const client = new PilotSwarmClient({ databaseUrl: "postgres://unused" });
        client._catalog = mkCatalogStub();

        const session = await client.createSession({ model: "codex-subscription:gpt-5.5" });

        expect(client.sessionConfigs.get(session.sessionId).reasoningEffort).toBeUndefined();
    });

    it("forwards reasoningEffort through createSessionForAgent", async () => {
        const client = new PilotSwarmClient({
            databaseUrl: "postgres://unused",
            allowedAgentNames: ["watcher"],
        });
        client._catalog = mkCatalogStub();

        const session = await client.createSessionForAgent("watcher", {
            model: "codex-subscription:gpt-5.5",
            reasoningEffort: "high",
        });

        const stored = client.sessionConfigs.get(session.sessionId);
        expect(stored.reasoningEffort).toBe("high");
        expect(stored.boundAgentName).toBe("watcher");
    });
});
