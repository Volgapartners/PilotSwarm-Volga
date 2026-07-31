/**
 * Warm-session runtime / model / reasoning-effort drift.
 *
 * `SessionManager.getOrCreate` keeps a warm `ManagedSession` per session id
 * and reuses it on every subsequent turn. That reuse is only safe while the
 * warm handle was created with the SAME runtime kind, the SAME effective
 * model, and the SAME effective reasoning effort as the incoming config.
 *
 * When any of those drift (a `set_model` command, a cross-provider switch,
 * or an effort change from the model picker) the warm handle is bound to
 * the OLD backend state and reusing it silently drops the change:
 *
 *   - a Codex-backed handle keeps firing `turn/start` with the old
 *     `effort` / `model`
 *   - a Copilot-backed handle keeps running the old model even though the
 *     session config now points at a Codex model (and vice-versa)
 *
 * These tests pin recycle-on-drift and reuse-on-match, plus the effective
 * reasoning-effort resolution (validated against the model descriptor's
 * `supportedReasoningEfforts`).
 *
 * Run: npx vitest run test/local/session-runtime-drift.test.js
 */

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { createFakeCodexTransport } from "../../src/codex-runtime.ts";

// ─── Stubs ────────────────────────────────────────────────────────

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

function mkTmpDirs() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-drift-test-"));
    const codexHome = path.join(root, "codex-home");
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionStateDir, { recursive: true });
    return { root, codexHome, sessionStateDir };
}

/**
 * Minimal Copilot-session double. Only the members `ManagedSession` and
 * `SessionManager` actually touch.
 */
function mkFakeCopilotSession(id) {
    return {
        id,
        disconnected: 0,
        registerTools() {},
        on() { return () => {}; },
        async send() {},
        abort() {},
        async disconnect() { this.disconnected += 1; },
        async getMessages() { return []; },
    };
}

/** Fake CopilotClient that records create/resume/delete traffic. */
function mkFakeCopilotClient() {
    const calls = [];
    let n = 0;
    return {
        calls,
        async createSession(config) {
            n += 1;
            calls.push({ kind: "create", config });
            return mkFakeCopilotSession(`copilot-${n}`);
        },
        async resumeSession(sessionId, config) {
            n += 1;
            calls.push({ kind: "resume", sessionId, config });
            return mkFakeCopilotSession(`copilot-${n}`);
        },
        async deleteSession(sessionId) {
            calls.push({ kind: "delete", sessionId });
        },
        async stop() {},
    };
}

function mkCodexManager({ sessionStateDir, codexHome, models, defaultModel, transport }) {
    const providers = new ModelProviderRegistry({
        providers: [{ id: "codex-subscription", type: "codex", codexHome, models }],
        defaultModel,
    });
    const manager = new SessionManager(undefined, null, { modelProviders: providers }, sessionStateDir);
    manager.setFactStore(mkFactStoreStub());
    manager.setSessionCatalog(mkCatalogStub());
    manager._setCodexTransportFactoryForTests(() => transport);
    return manager;
}

function turnStarts(transport) {
    return transport.recordedRequests.filter((r) => r.method === "turn/start");
}

// ─── B: warm runtime / model / effort drift ───────────────────────

describe("warm session runtime drift", () => {
    it("recycles the warm Codex handle when only the reasoning effort changes", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-effort" }, turnScript: [] });
        const manager = mkCodexManager({
            sessionStateDir,
            codexHome,
            models: [{
                name: "gpt-5.6-sol",
                supportedReasoningEfforts: ["low", "medium", "high"],
                defaultReasoningEffort: "medium",
            }],
            defaultModel: "codex-subscription:gpt-5.6-sol",
            transport,
        });

        const first = await manager.getOrCreate("ps-effort", {
            model: "codex-subscription:gpt-5.6-sol",
            reasoningEffort: "low",
            toolNames: [],
        }, { turnIndex: 0 });
        await first.getRuntimeSession().send({ prompt: "turn one" });

        expect(turnStarts(transport).at(-1).params.effort).toBe("low");

        const second = await manager.getOrCreate("ps-effort", {
            model: "codex-subscription:gpt-5.6-sol",
            reasoningEffort: "high",
            toolNames: [],
        }, { turnIndex: 1 });
        await second.getRuntimeSession().send({ prompt: "turn two" });

        expect(second).not.toBe(first);
        expect(second.runtimeKind).toBe("codex");
        expect(turnStarts(transport).at(-1).params.effort).toBe("high");
    });

    it("reuses the warm Codex handle when the config is unchanged", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-reuse" }, turnScript: [] });
        const manager = mkCodexManager({
            sessionStateDir,
            codexHome,
            models: [{ name: "gpt-5.6-sol", supportedReasoningEfforts: ["low", "high"] }],
            defaultModel: "codex-subscription:gpt-5.6-sol",
            transport,
        });

        const cfg = { model: "codex-subscription:gpt-5.6-sol", reasoningEffort: "low", toolNames: [] };
        const first = await manager.getOrCreate("ps-reuse", cfg, { turnIndex: 0 });
        const second = await manager.getOrCreate("ps-reuse", { ...cfg }, { turnIndex: 1 });

        expect(second).toBe(first);
        // No extra thread/resume round-trip for a plain warm reuse.
        expect(transport.recordedRequests.filter((r) => r.method === "thread/resume")).toHaveLength(0);
    });

    it("recycles the warm Codex handle when the model changes within the Codex provider", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-model" }, turnScript: [] });
        const manager = mkCodexManager({
            sessionStateDir,
            codexHome,
            models: ["gpt-5.6-sol", "gpt-5.5"],
            defaultModel: "codex-subscription:gpt-5.6-sol",
            transport,
        });

        const first = await manager.getOrCreate("ps-model", {
            model: "codex-subscription:gpt-5.6-sol",
            toolNames: [],
        }, { turnIndex: 0 });
        const second = await manager.getOrCreate("ps-model", {
            model: "codex-subscription:gpt-5.5",
            toolNames: [],
        }, { turnIndex: 1 });
        await second.getRuntimeSession().send({ prompt: "after switch" });

        expect(second).not.toBe(first);
        expect(turnStarts(transport).at(-1).params.model).toBe("gpt-5.5");
    });

    it("does not hand back the Codex handle after a cross-provider switch to GitHub", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-x1" }, turnScript: [] });
        const providers = new ModelProviderRegistry({
            providers: [
                { id: "codex-subscription", type: "codex", codexHome, models: ["gpt-5.6-sol"] },
                { id: "github-copilot", type: "github", githubToken: "test-token", models: ["gpt-5.4"] },
            ],
            defaultModel: "codex-subscription:gpt-5.6-sol",
        });
        const manager = new SessionManager("test-token", null, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        manager._setCodexTransportFactoryForTests(() => transport);

        const fakeClient = mkFakeCopilotClient();
        vi.spyOn(manager, "ensureClient").mockResolvedValue(fakeClient);

        const codexManaged = await manager.getOrCreate("ps-cross-1", {
            model: "codex-subscription:gpt-5.6-sol",
            toolNames: [],
        }, { turnIndex: 0 });
        expect(codexManaged.runtimeKind).toBe("codex");

        const copilotManaged = await manager.getOrCreate("ps-cross-1", {
            model: "github-copilot:gpt-5.4",
            toolNames: [],
        }, { turnIndex: 1 });

        expect(copilotManaged).not.toBe(codexManaged);
        expect(copilotManaged.runtimeKind).toBe("copilot");
        expect(fakeClient.calls.some((c) => c.kind === "create" || c.kind === "resume")).toBe(true);
    });

    it("does not hand back the Copilot handle after a cross-provider switch to Codex", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-x2" }, turnScript: [] });
        const providers = new ModelProviderRegistry({
            providers: [
                { id: "codex-subscription", type: "codex", codexHome, models: ["gpt-5.6-sol"] },
                { id: "github-copilot", type: "github", githubToken: "test-token", models: ["gpt-5.4"] },
            ],
            defaultModel: "github-copilot:gpt-5.4",
        });
        const manager = new SessionManager("test-token", null, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        manager._setCodexTransportFactoryForTests(() => transport);

        const fakeClient = mkFakeCopilotClient();
        vi.spyOn(manager, "ensureClient").mockResolvedValue(fakeClient);

        const copilotManaged = await manager.getOrCreate("ps-cross-2", {
            model: "github-copilot:gpt-5.4",
            toolNames: [],
        }, { turnIndex: 0 });
        expect(copilotManaged.runtimeKind).toBe("copilot");

        const codexManaged = await manager.getOrCreate("ps-cross-2", {
            model: "codex-subscription:gpt-5.6-sol",
            toolNames: [],
        }, { turnIndex: 1 });

        expect(codexManaged).not.toBe(copilotManaged);
        expect(codexManaged.runtimeKind).toBe("codex");
        expect(transport.recordedRequests.some((r) => r.method === "thread/start")).toBe(true);
    });

    it("recycles the warm Copilot handle when the model changes and resumes through Copilot", async () => {
        const { sessionStateDir } = mkTmpDirs();
        const providers = new ModelProviderRegistry({
            providers: [
                { id: "github-copilot", type: "github", githubToken: "test-token", models: ["gpt-5.4", "gpt-5.4-mini"] },
            ],
            defaultModel: "github-copilot:gpt-5.4",
        });
        const manager = new SessionManager("test-token", null, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());

        const fakeClient = mkFakeCopilotClient();
        vi.spyOn(manager, "ensureClient").mockResolvedValue(fakeClient);

        const first = await manager.getOrCreate("ps-copilot-model", {
            model: "github-copilot:gpt-5.4",
            toolNames: [],
        }, { turnIndex: 0 });
        // Copilot resume requires a local session directory.
        fs.mkdirSync(path.join(sessionStateDir, "ps-copilot-model"), { recursive: true });

        const second = await manager.getOrCreate("ps-copilot-model", {
            model: "github-copilot:gpt-5.4-mini",
            toolNames: [],
        }, { turnIndex: 1 });

        expect(second).not.toBe(first);
        const resume = fakeClient.calls.filter((c) => c.kind === "resume").at(-1);
        expect(resume).toBeTruthy();
        expect(resume.config.model).toBe("gpt-5.4-mini");
    });
});

// ─── C: effective reasoning effort resolution ─────────────────────

describe("effective reasoning effort resolution", () => {
    it("falls back to the model default when the configured effort is unsupported", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-fallback" }, turnScript: [] });
        const manager = mkCodexManager({
            sessionStateDir,
            codexHome,
            models: [{
                name: "gpt-5.5",
                supportedReasoningEfforts: ["low", "medium", "high"],
                defaultReasoningEffort: "medium",
            }],
            defaultModel: "codex-subscription:gpt-5.5",
            transport,
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const managed = await manager.getOrCreate("ps-fallback", {
            model: "codex-subscription:gpt-5.5",
            reasoningEffort: "ultra",
            toolNames: [],
        }, { turnIndex: 0 });
        await managed.getRuntimeSession().send({ prompt: "hello" });

        expect(turnStarts(transport).at(-1).params.effort).toBe("medium");
        expect(warn.mock.calls.flat().join(" ")).toMatch(/ultra/);
        // The stored config must agree with what the runtime actually uses.
        expect(manager.getSessionConfigForTests("ps-fallback").reasoningEffort).toBe("medium");
        warn.mockRestore();
    });

    it("falls back to the first supported effort when no model default is declared", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-first" }, turnScript: [] });
        const manager = mkCodexManager({
            sessionStateDir,
            codexHome,
            models: [{ name: "gpt-5.5", supportedReasoningEfforts: ["high", "low"] }],
            defaultModel: "codex-subscription:gpt-5.5",
            transport,
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const managed = await manager.getOrCreate("ps-first", {
            model: "codex-subscription:gpt-5.5",
            reasoningEffort: "ultra",
            toolNames: [],
        }, { turnIndex: 0 });
        await managed.getRuntimeSession().send({ prompt: "hello" });

        expect(turnStarts(transport).at(-1).params.effort).toBe("high");
        warn.mockRestore();
    });

    it("keeps the configured effort when the model declares no effort metadata", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-nometa" }, turnScript: [] });
        const manager = mkCodexManager({
            sessionStateDir,
            codexHome,
            models: ["gpt-5.6-sol"],
            defaultModel: "codex-subscription:gpt-5.6-sol",
            transport,
        });

        const managed = await manager.getOrCreate("ps-nometa", {
            model: "codex-subscription:gpt-5.6-sol",
            reasoningEffort: "ultra",
            toolNames: [],
        }, { turnIndex: 0 });
        await managed.getRuntimeSession().send({ prompt: "hello" });

        expect(turnStarts(transport).at(-1).params.effort).toBe("ultra");
    });

    it("applies the model default when the caller picks no effort", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-default" }, turnScript: [] });
        const manager = mkCodexManager({
            sessionStateDir,
            codexHome,
            models: [{
                name: "gpt-5.6-sol",
                supportedReasoningEfforts: ["medium", "xhigh"],
                defaultReasoningEffort: "xhigh",
            }],
            defaultModel: "codex-subscription:gpt-5.6-sol",
            transport,
        });

        const managed = await manager.getOrCreate("ps-default-effort", {
            model: "codex-subscription:gpt-5.6-sol",
            toolNames: [],
        }, { turnIndex: 0 });
        await managed.getRuntimeSession().send({ prompt: "hello" });

        expect(turnStarts(transport).at(-1).params.effort).toBe("xhigh");
    });

    it("forwards the effective effort to the Copilot SDK session config", async () => {
        const { sessionStateDir } = mkTmpDirs();
        const providers = new ModelProviderRegistry({
            providers: [{
                id: "github-copilot",
                type: "github",
                githubToken: "test-token",
                models: [{
                    name: "gpt-5.4",
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
                    defaultReasoningEffort: "medium",
                }],
            }],
            defaultModel: "github-copilot:gpt-5.4",
        });
        const manager = new SessionManager("test-token", null, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        const fakeClient = mkFakeCopilotClient();
        vi.spyOn(manager, "ensureClient").mockResolvedValue(fakeClient);

        await manager.getOrCreate("ps-copilot-effort", {
            model: "github-copilot:gpt-5.4",
            reasoningEffort: "high",
            toolNames: [],
        }, { turnIndex: 0 });

        const create = fakeClient.calls.find((c) => c.kind === "create");
        expect(create.config.reasoningEffort).toBe("high");
    });

    it("never forwards a Codex-only effort to the Copilot SDK session config", async () => {
        const { sessionStateDir } = mkTmpDirs();
        const providers = new ModelProviderRegistry({
            providers: [{
                id: "github-copilot",
                type: "github",
                githubToken: "test-token",
                models: [{
                    name: "gpt-5.4",
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
                    defaultReasoningEffort: "medium",
                }],
            }],
            defaultModel: "github-copilot:gpt-5.4",
        });
        const manager = new SessionManager("test-token", null, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        const fakeClient = mkFakeCopilotClient();
        vi.spyOn(manager, "ensureClient").mockResolvedValue(fakeClient);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await manager.getOrCreate("ps-copilot-ultra", {
            model: "github-copilot:gpt-5.4",
            reasoningEffort: "ultra",
            toolNames: [],
        }, { turnIndex: 0 });

        const create = fakeClient.calls.find((c) => c.kind === "create");
        expect(create.config.reasoningEffort).toBe("medium");
        warn.mockRestore();
    });

    it("omits reasoningEffort from Copilot session config when nothing resolves", async () => {
        const { sessionStateDir } = mkTmpDirs();
        const providers = new ModelProviderRegistry({
            providers: [{ id: "github-copilot", type: "github", githubToken: "test-token", models: ["gpt-5.4"] }],
            defaultModel: "github-copilot:gpt-5.4",
        });
        const manager = new SessionManager("test-token", null, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        const fakeClient = mkFakeCopilotClient();
        vi.spyOn(manager, "ensureClient").mockResolvedValue(fakeClient);

        await manager.getOrCreate("ps-copilot-none", {
            model: "github-copilot:gpt-5.4",
            toolNames: [],
        }, { turnIndex: 0 });

        const create = fakeClient.calls.find((c) => c.kind === "create");
        expect(create.config.reasoningEffort).toBeUndefined();
    });
});

// ─── B: Codex recovery must never route through Copilot ───────────

describe("codex destroy/recovery paths", () => {
    it("resetSessionState for a Codex session never initializes the Copilot client", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-reset" }, turnScript: [] });
        const manager = mkCodexManager({
            sessionStateDir,
            codexHome,
            models: ["gpt-5.6-sol"],
            defaultModel: "codex-subscription:gpt-5.6-sol",
            transport,
        });
        await manager.getOrCreate("ps-codex-reset", {
            model: "codex-subscription:gpt-5.6-sol",
            toolNames: [],
        }, { turnIndex: 0 });

        const ensureClient = vi.spyOn(manager, "ensureClient").mockRejectedValue(
            new Error("CopilotClient must not be initialized for Codex sessions"),
        );

        await manager.resetSessionState("ps-codex-reset");

        expect(ensureClient).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(sessionStateDir, "ps-codex-reset"))).toBe(false);
    });

    it("dehydrate retry for a Codex session never resumes through the Copilot client", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-dehydrate" }, turnScript: [] });
        const manager = mkCodexManager({
            sessionStateDir,
            codexHome,
            models: ["gpt-5.6-sol"],
            defaultModel: "codex-subscription:gpt-5.6-sol",
            transport,
        });
        const managed = await manager.getOrCreate("ps-codex-dehydrate", {
            model: "codex-subscription:gpt-5.6-sol",
            toolNames: [],
        }, { turnIndex: 0 });

        // Force every destroy attempt to fail so the retry path runs.
        vi.spyOn(managed, "destroy").mockRejectedValue(new Error("codex disconnect exploded"));
        const ensureClient = vi.spyOn(manager, "ensureClient").mockRejectedValue(
            new Error("CopilotClient must not be initialized for Codex sessions"),
        );
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await manager.dehydrate("ps-codex-dehydrate", "test");

        expect(ensureClient).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});
