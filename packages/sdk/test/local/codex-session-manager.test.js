/**
 * Codex-provider routing in SessionManager.
 *
 * Verifies that `SessionManager.getOrCreate` picks the Codex runtime for
 * codex-typed model refs, works WITHOUT a GITHUB_TOKEN, and leaves the
 * Copilot path untouched.
 *
 * Run: npx vitest run test/local/codex-session-manager.test.js
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineTool } from "@github/copilot-sdk";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { createFakeCodexTransport } from "../../src/codex-runtime.ts";

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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sm-test-"));
    const codexHome = path.join(root, "codex-home");
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionStateDir, { recursive: true });
    return { root, codexHome, sessionStateDir };
}

describe("SessionManager Codex routing", () => {
    it("creates a codex-backed session without any GITHUB_TOKEN", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-sm-1" },
            turnScript: [],
        });
        const providers = new ModelProviderRegistry({
            providers: [
                {
                    id: "codex-subscription",
                    type: "codex",
                    codexHome,
                    models: ["gpt-5.6-sol"],
                },
            ],
            defaultModel: "codex-subscription:gpt-5.6-sol",
        });

        // No githubToken on the manager. Test-only injection: pre-register
        // a Codex runtime client with the fake transport.
        const manager = new SessionManager(undefined, null, {
            modelProviders: providers,
        }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        manager._setCodexTransportFactoryForTests(() => transport);

        const managed = await manager.getOrCreate("ps-codex-1", {
            model: "codex-subscription:gpt-5.6-sol",
            toolNames: [],
        }, { turnIndex: 0 });

        expect(managed).toBeTruthy();
        expect(managed.runtimeKind).toBe("codex");
        // Persistence written under sessionStateDir, not codexHome.
        expect(fs.existsSync(path.join(sessionStateDir, "ps-codex-1", "codex-thread.json"))).toBe(true);
        expect(fs.readdirSync(codexHome)).not.toContain("ps-codex-1");
    });

    it("throws for codex model when CODEX_HOME does not exist", async () => {
        const { sessionStateDir } = mkTmpDirs();
        const providers = new ModelProviderRegistry({
            providers: [
                {
                    id: "codex-subscription",
                    type: "codex",
                    codexHome: "/nonexistent/does/not/exist/codex-xyz",
                    models: ["gpt-5.6-sol"],
                },
            ],
        });
        const manager = new SessionManager(undefined, null, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        manager._setCodexTransportFactoryForTests(() => createFakeCodexTransport({ thread: { id: "n/a" } }));

        await expect(
            manager.getOrCreate("ps-codex-nohome", { model: "codex-subscription:gpt-5.6-sol" }, { turnIndex: 0 }),
        ).rejects.toThrow(/CODEX_HOME/);
    });

    it("still throws the GITHUB_TOKEN-missing error for a github-typed model", async () => {
        const { sessionStateDir } = mkTmpDirs();
        const providers = new ModelProviderRegistry({
            providers: [
                {
                    id: "github-copilot",
                    type: "github",
                    // no githubToken env value here
                    models: ["claude-sonnet-4.6"],
                },
            ],
            defaultModel: "github-copilot:claude-sonnet-4.6",
        });
        const manager = new SessionManager(undefined, null, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());

        await expect(
            manager.getOrCreate("ps-github-nohome", { model: "github-copilot:claude-sonnet-4.6" }, { turnIndex: 0 }),
        ).rejects.toThrow(/GitHub Copilot key not configured/);
    });

    it("passes model, cwd, developerInstructions, reasoning effort and dynamicTools to thread/start", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-parity" },
            turnScript: [],
        });
        const providers = new ModelProviderRegistry({
            providers: [
                {
                    id: "codex-subscription",
                    type: "codex",
                    codexHome,
                    models: [
                        { name: "gpt-5.6-sol", supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" },
                    ],
                },
            ],
            defaultModel: "codex-subscription:gpt-5.6-sol",
        });
        const manager = new SessionManager(undefined, null, {
            modelProviders: providers,
            frameworkBasePrompt: "You are PilotSwarm.",
            appDefaultPrompt: "You help operators.",
        }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        manager._setCodexTransportFactoryForTests(() => transport);

        await manager.getOrCreate("ps-codex-parity", {
            model: "codex-subscription:gpt-5.6-sol",
            reasoningEffort: "medium",
            workingDirectory: sessionStateDir,
            toolNames: [],
        }, { turnIndex: 0 });

        const start = transport.recordedRequests.find((r) => r.method === "thread/start");
        expect(start).toBeTruthy();
        expect(start.params.model).toBe("gpt-5.6-sol");
        expect(start.params.cwd).toBe(sessionStateDir);
        expect(typeof start.params.developerInstructions).toBe("string");
        expect(start.params.developerInstructions.length).toBeGreaterThan(0);
        expect(start.params.developerInstructions).toContain("You are PilotSwarm.");
        expect(start.params.developerInstructions).toContain("You help operators.");
        // dynamicTools must include PilotSwarm's durable `wait` primitive by
        // default so the model can call it.
        expect(Array.isArray(start.params.dynamicTools)).toBe(true);
        const names = start.params.dynamicTools.map((t) => t.name);
        expect(names).toContain("wait");
        expect(names).toContain("ask_user");
    });

    it("SessionManager.shutdown stops every cached Codex runtime client", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-shutdown" } });
        const providers = new ModelProviderRegistry({
            providers: [{ id: "codex-subscription", type: "codex", codexHome, models: ["gpt-5.6-sol"] }],
            defaultModel: "codex-subscription:gpt-5.6-sol",
        });
        const manager = new SessionManager(undefined, null, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());

        let closed = 0;
        const origClose = transport.close.bind(transport);
        transport.close = async () => { closed += 1; return origClose(); };

        manager._setCodexTransportFactoryForTests(() => transport);

        await manager.getOrCreate("ps-shutdown", { model: "codex-subscription:gpt-5.6-sol", toolNames: [] }, { turnIndex: 0 });
        expect(manager.getCachedCodexClientCountForTests()).toBeGreaterThan(0);

        await manager.shutdown();

        expect(closed).toBeGreaterThan(0);
        expect(manager.getCachedCodexClientCountForTests()).toBe(0);
    });

    it("wraps the initialize handshake with the initialized notification", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-init" } });
        const providers = new ModelProviderRegistry({
            providers: [
                { id: "codex-subscription", type: "codex", codexHome, models: ["gpt-5.6-sol"] },
            ],
        });
        const manager = new SessionManager(undefined, null, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        manager._setCodexTransportFactoryForTests(() => transport);

        await manager.getOrCreate("ps-init-order", { model: "codex-subscription:gpt-5.6-sol", toolNames: [] }, { turnIndex: 0 });

        const methods = transport.recordedRequests.map((r) => `${r.kind}:${r.method}`);
        const initIdx = methods.indexOf("request:initialize");
        const initedIdx = methods.indexOf("notification:initialized");
        const startIdx = methods.indexOf("request:thread/start");
        expect(initIdx).toBeGreaterThanOrEqual(0);
        expect(initedIdx).toBeGreaterThan(initIdx);
        expect(startIdx).toBeGreaterThan(initedIdx);
    });

    it("(R2-D1b) turn0 with a dirty local dir AND a stored archive removes both and starts fresh", async () => {
        // Regression: SessionManager currently keys stale-cleanup on
        // marker presence. If the per-session directory exists but has
        // no marker (dirty Copilot files, orphan rollout, unrelated
        // bytes), turn 0 used to skip the cleanup path and write the
        // fresh Codex marker on top of that dirt, poisoning future
        // archives. Meanwhile a stale stored archive would sit in the
        // session store forever.
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const { FilesystemSessionStore } = await import("../../src/session-store.ts");
        const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sm-store-"));
        const sid = "ps-r2-d1b-dirty";
        // Seed a dirty local dir WITHOUT any Codex marker.
        const sessDir = path.join(sessionStateDir, sid);
        fs.mkdirSync(sessDir, { recursive: true });
        fs.writeFileSync(path.join(sessDir, "workspace.yaml"), "cwd: /old\n");
        fs.writeFileSync(path.join(sessDir, "codex-rollout.jsonl"), "STALE-ROLLOUT-SENTINEL\n");
        fs.writeFileSync(path.join(sessDir, "sentinel.txt"), "R2-D1B-SENTINEL");
        // Seed a stale stored archive too. Content deliberately not a
        // valid tarball — we only care that its bytes get erased.
        fs.writeFileSync(path.join(storeDir, `${sid}.tar.gz`), "R2-D1B-OLD-ARCHIVE-BYTES");
        fs.writeFileSync(path.join(storeDir, `${sid}.meta.json`), JSON.stringify({
            sessionId: sid, dehydratedAt: new Date(0).toISOString(), worker: "old", sizeBytes: 24,
        }));

        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-r2-d1b" } });
        const providers = new ModelProviderRegistry({
            providers: [{ id: "codex-subscription", type: "codex", codexHome, models: ["gpt-5.6-sol"] }],
            defaultModel: "codex-subscription:gpt-5.6-sol",
        });
        const store = new FilesystemSessionStore(storeDir, sessionStateDir);
        const manager = new SessionManager(undefined, store, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        manager._setCodexTransportFactoryForTests(() => transport);

        await manager.getOrCreate(sid, { model: "codex-subscription:gpt-5.6-sol", toolNames: [] }, { turnIndex: 0 });

        // Local dir: only the fresh Codex marker with the new threadId
        // (plus any current-turn artifacts the runtime writes, but no
        // trace of the seeded dirt).
        const remaining = fs.readdirSync(sessDir).sort();
        expect(remaining).toContain("codex-thread.json");
        expect(remaining).not.toContain("workspace.yaml");
        expect(remaining).not.toContain("codex-rollout.jsonl");
        expect(remaining).not.toContain("sentinel.txt");
        for (const entry of remaining) {
            const abs = path.join(sessDir, entry);
            if (fs.statSync(abs).isFile()) {
                const contents = fs.readFileSync(abs, "utf-8");
                expect(contents).not.toContain("R2-D1B-SENTINEL");
                expect(contents).not.toContain("STALE-ROLLOUT-SENTINEL");
            }
        }
        const meta = JSON.parse(fs.readFileSync(path.join(sessDir, "codex-thread.json"), "utf-8"));
        expect(meta.codexThreadId).toBe("codex-thread-r2-d1b");

        // Stored archive erased.
        expect(fs.existsSync(path.join(storeDir, `${sid}.tar.gz`))).toBe(false);
        expect(fs.existsSync(path.join(storeDir, `${sid}.meta.json`))).toBe(false);

        await manager.shutdown();
        fs.rmSync(storeDir, { recursive: true, force: true });
    });

    it("(R4-D1a) SessionManager Codex getOrCreate rejects traversal/absolute session ids BEFORE any sessionStore or thread call", async () => {
        // Regression: SessionManager's Codex branch previously reached
        // `sessionStore.exists()` / `.delete()` / `.hydrate()` with the
        // raw sessionId argument. A malicious `../victim` walked out of
        // storeDir and could delete or clobber `../victim.tar.gz` /
        // `.meta.json` before Codex runtime validation ever ran.
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const { FilesystemSessionStore } = await import("../../src/session-store.ts");
        const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4-d1a-store-"));
        const parent = path.dirname(storeDir);
        // Sentinels the escape would have targeted: `../victim` from the
        // storeDir/sessionStateDir perspective.
        const victimTar = path.join(parent, "victim.tar.gz");
        const victimMeta = path.join(parent, "victim.meta.json");
        fs.writeFileSync(victimTar, "R4-D1A-VICTIM-TAR");
        fs.writeFileSync(victimMeta, "R4-D1A-VICTIM-META");

        const badIds = [
            "../victim",
            "..\\victim",
            "a/b",
            "a\\b",
            ".",
            "..",
            "",
            path.join(parent, "absolute-victim"),
        ];

        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-r4-d1a" } });
        const providers = new ModelProviderRegistry({
            providers: [{ id: "codex-subscription", type: "codex", codexHome, models: ["gpt-5.6-sol"] }],
            defaultModel: "codex-subscription:gpt-5.6-sol",
        });
        const store = new FilesystemSessionStore(storeDir, sessionStateDir);
        const manager = new SessionManager(undefined, store, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        manager._setCodexTransportFactoryForTests(() => transport);

        for (const bad of badIds) {
            for (const turnIndex of [0, 1, undefined]) {
                const p = manager.getOrCreate(bad, { model: "codex-subscription:gpt-5.6-sol", toolNames: [] }, { turnIndex });
                await expect(p).rejects.toThrow(/Invalid PilotSwarm session id/);
            }
        }

        // Outside-of-store sentinels must be untouched.
        expect(fs.readFileSync(victimTar, "utf-8")).toBe("R4-D1A-VICTIM-TAR");
        expect(fs.readFileSync(victimMeta, "utf-8")).toBe("R4-D1A-VICTIM-META");
        // No thread/start / thread/resume / thread/delete request should
        // have gone to the app-server for any of these invalid ids.
        expect(transport.recordedRequests.some((r) => r.method === "thread/start")).toBe(false);
        expect(transport.recordedRequests.some((r) => r.method === "thread/resume")).toBe(false);
        expect(transport.recordedRequests.some((r) => r.method === "thread/delete")).toBe(false);

        await manager.shutdown();
        fs.rmSync(storeDir, { recursive: true, force: true });
        fs.unlinkSync(victimTar);
        fs.unlinkSync(victimMeta);
    }, 5_000);
});
