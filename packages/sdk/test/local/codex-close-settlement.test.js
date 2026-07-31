/**
 * Codex session-close settlement.
 *
 * `CodexRuntimeClient.stop()` already settles in-flight turns before it
 * tears listeners down. The per-session close paths did NOT:
 *
 *   - `CodexRuntimeSession.disconnect()` unsubscribed, unregistered and
 *     called `_teardown()` (which clears every event listener) while the
 *     queued send() lambda was still parked on `await completion`. The
 *     shared per-CODEX_HOME turn queue therefore stayed held forever, so
 *     no other session on the same client could ever start a turn.
 *   - `CodexRuntimeClient.deleteSession()` had the same defect.
 *   - `SessionManager.shutdown()` compounds it: `destroy()` →
 *     `disconnect()` unregisters the handle from `client.sessions`, so
 *     the later `client.stop()` no longer sees the session to settle and
 *     wedges forever on `await this.turnQueue`.
 *
 * Contract enforced here: every close path settles the active/current
 * turn (ack rejection + `session.idle` + queue release) BEFORE
 * unsubscribe / unregister / teardown, and does so idempotently.
 *
 * Run: npx vitest run test/local/codex-close-settlement.test.js
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexRuntimeClient, createFakeCodexTransport } from "../../src/codex-runtime.ts";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";

function mkTmpHomes() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-close-settlement-"));
    const codexHome = path.join(root, "codex-home");
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionStateDir, { recursive: true });
    return { root, codexHome, sessionStateDir };
}

function mkHeldTransport(threadId) {
    return createFakeCodexTransport({
        thread: { id: threadId },
        turnId: `${threadId}-turn`,
        turnScript: [
            {
                emit: "notification",
                method: "turn/started",
                params: { threadId, turn: { id: `${threadId}-turn` } },
            },
            { emit: "hold" },
        ],
    });
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise.then(() => "settled", () => "settled"),
        new Promise((resolve) => setTimeout(() => resolve(`timeout:${label}`), ms)),
    ]);
}

function mkFactStoreStub() {
    return {
        listFacts: async () => [],
        readFacts: async () => [],
        storeFact: async () => {},
        deleteFact: async () => {},
        deleteSessionFactsForSession: async () => {},
        upsertFacts: async () => {},
        writeFactsForSession: async () => {},
        listRootKeys: async () => [],
        buildKnowledgeIndex: async () => ({ askEntries: [], skillEntries: [] }),
        buildKnowledgeIndexFromCatalog: async () => ({ askEntries: [], skillEntries: [] }),
        pruneFactsForSession: async () => {},
        pruneStaleFacts: async () => {},
    };
}

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

describe("Codex session-close settlement", () => {
    it("disconnect() settles the held turn and releases the shared turn queue for other sessions", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = mkHeldTransport("codex-thread-disc");
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        const held = await client.createSession({ sessionId: "ps-disc-held" });
        const other = await client.createSession({ sessionId: "ps-disc-other" });
        const heldEvents = [];
        held.on((event) => heldEvents.push(event));
        other.on(() => {});

        await held.send({ prompt: "hold this turn" });
        const otherSend = other.send({ prompt: "must not wedge behind the held turn" });

        // Sanity: the queue is genuinely held — only one turn/start so far.
        await new Promise((r) => setTimeout(r, 25));
        expect(transport.recordedRequests.filter((r) => r.method === "turn/start")).toHaveLength(1);

        await held.disconnect();

        // Settlement must have happened while the handle's listeners
        // were still wired, so the idle event is observable.
        expect(heldEvents.some((event) => event.type === "session.idle")).toBe(true);

        expect(await withTimeout(otherSend, 1_000, "other-send")).toBe("settled");
        expect(transport.recordedRequests.filter((r) => r.method === "turn/start")).toHaveLength(2);

        // The remote turn must be interrupted before local settlement
        // releases the queue and before the thread is unsubscribed.
        const methods = transport.recordedRequests.map((request) => request.method);
        const interrupts = transport.recordedRequests.filter((request) => request.method === "turn/interrupt");
        const interruptIndex = methods.indexOf("turn/interrupt");
        const unsubscribeIndex = methods.indexOf("thread/unsubscribe");
        const secondTurnStartIndex = methods.lastIndexOf("turn/start");
        expect(interrupts).toHaveLength(1);
        expect(interrupts[0].params).toEqual({
            threadId: held.codexThreadId,
            turnId: `${held.codexThreadId}-turn`,
        });
        expect(interruptIndex).toBeLessThan(unsubscribeIndex);
        expect(interruptIndex).toBeLessThan(secondTurnStartIndex);

        // Cleanup order must still leave the disconnected handle
        // unroutable after the interrupt and unsubscribe requests.
        expect(client["sessions"].has("ps-disc-held")).toBe(false);
        expect(transport.recordedRequests.some((r) => r.method === "thread/unsubscribe")).toBe(true);

        // Repeat disconnect must be a safe no-op (no second idle).
        await held.disconnect();
        expect(heldEvents.filter((event) => event.type === "session.idle")).toHaveLength(1);

        await client.stop();
    }, 5_000);

    it("deleteSession() settles the held turn and releases the shared turn queue", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = mkHeldTransport("codex-thread-del");
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        const held = await client.createSession({ sessionId: "ps-del-held" });
        const other = await client.createSession({ sessionId: "ps-del-other" });
        const heldEvents = [];
        held.on((event) => heldEvents.push(event));
        other.on(() => {});

        await held.send({ prompt: "hold this turn" });
        const otherSend = other.send({ prompt: "must not wedge behind the deleted session" });
        await new Promise((r) => setTimeout(r, 25));
        expect(transport.recordedRequests.filter((r) => r.method === "turn/start")).toHaveLength(1);

        await client.deleteSession("ps-del-held");

        expect(heldEvents.some((event) => event.type === "session.idle")).toBe(true);
        expect(await withTimeout(otherSend, 1_000, "other-send")).toBe("settled");
        expect(transport.recordedRequests.filter((r) => r.method === "turn/start")).toHaveLength(2);
        expect(client["sessions"].has("ps-del-held")).toBe(false);
        expect(fs.existsSync(path.join(sessionStateDir, "ps-del-held"))).toBe(false);

        const methods = transport.recordedRequests.map((request) => request.method);
        const interrupts = transport.recordedRequests.filter((request) => request.method === "turn/interrupt");
        const interruptIndex = methods.indexOf("turn/interrupt");
        const deleteIndex = methods.indexOf("thread/delete");
        const secondTurnStartIndex = methods.lastIndexOf("turn/start");
        expect(interrupts).toHaveLength(1);
        expect(interrupts[0].params).toEqual({
            threadId: held.codexThreadId,
            turnId: `${held.codexThreadId}-turn`,
        });
        expect(interruptIndex).toBeLessThan(deleteIndex);
        expect(interruptIndex).toBeLessThan(secondTurnStartIndex);

        await client.stop();
    }, 5_000);

    it("disconnect() settles a queued no-id turn without sending a bogus interrupt", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = mkHeldTransport("codex-thread-queued-close");
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        const blocker = await client.createSession({ sessionId: "ps-queued-close-blocker" });
        const queued = await client.createSession({ sessionId: "ps-queued-close-target" });
        const next = await client.createSession({ sessionId: "ps-queued-close-next" });
        const queuedEvents = [];
        blocker.on(() => {});
        queued.on((event) => queuedEvents.push(event));
        next.on(() => {});

        await blocker.send({ prompt: "hold the shared turn queue" });
        const queuedSend = queued.send({ prompt: "never receives a remote turn id" });
        const nextSend = next.send({ prompt: "must run after the queued close is skipped" });
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(transport.recordedRequests.filter((request) => request.method === "turn/start")).toHaveLength(1);

        await queued.disconnect();

        expect(await withTimeout(queuedSend, 1_000, "queued-send")).toBe("settled");
        expect(queuedEvents.filter((event) => event.type === "session.idle")).toHaveLength(1);
        expect(transport.recordedRequests.filter((request) => request.method === "turn/interrupt")).toHaveLength(0);
        expect(transport.recordedRequests.filter((request) => request.method === "turn/start")).toHaveLength(1);

        blocker.abort();
        expect(await withTimeout(nextSend, 1_000, "next-send")).toBe("settled");
        expect(transport.recordedRequests.filter((request) => request.method === "turn/start")).toHaveLength(2);
        const interrupts = transport.recordedRequests.filter((request) => request.method === "turn/interrupt");
        expect(interrupts).toHaveLength(1);
        expect(interrupts[0].params.threadId).toBe(blocker.codexThreadId);
        expect(interrupts[0].params.threadId).not.toBe(queued.codexThreadId);

        await client.stop();
    }, 5_000);

    it("SessionManager.shutdown() resolves promptly with a held Codex turn in flight", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = mkHeldTransport("codex-thread-shutdown");
        const providers = new ModelProviderRegistry({
            providers: [{ id: "codex-subscription", type: "codex", codexHome, models: ["gpt-5.6-sol"] }],
            defaultModel: "codex-subscription:gpt-5.6-sol",
        });
        const manager = new SessionManager(undefined, undefined, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        manager._setCodexTransportFactoryForTests(() => transport);

        const managed = await manager.getOrCreate(
            "ps-shutdown-held",
            { model: "codex-subscription:gpt-5.6-sol", toolNames: [] },
            { turnIndex: 0 },
        );
        const runtime = managed.getRuntimeSession();
        await runtime.send({ prompt: "hold this turn open across shutdown" });

        expect(await withTimeout(manager.shutdown(), 2_000, "shutdown")).toBe("settled");
        expect(manager.getCachedCodexClientCountForTests()).toBe(0);
    }, 8_000);
});
