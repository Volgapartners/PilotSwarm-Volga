/**
 * Codex native MCP wiring end-to-end (fake transport).
 *
 * Pins the contract that the Codex branch of SessionManager forwards
 * a translated `config.mcp_servers` map to the Codex app-server via
 * `thread/start` (and again on `thread/resume`), while STILL declaring
 * PilotSwarm's worker-registry and framework tools through
 * `dynamicTools`. Also asserts that a headless-worker-registered tool
 * (`teams_alert`) shows up in `dynamicTools` when the client requests
 * it by name.
 *
 * The Copilot branch must NOT receive the Codex-only translated config,
 * and must continue to receive the original `mcpServers` map so the
 * Copilot SDK can use it.
 *
 * Run: npx vitest run test/local/codex-native-mcp.test.js
 */

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineTool } from "@github/copilot-sdk";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { createFakeCodexTransport, CODEX_THREAD_STATE_FILENAME } from "../../src/codex-runtime.ts";

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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-mcp-"));
    const codexHome = path.join(root, "codex-home");
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionStateDir, { recursive: true });
    return { root, codexHome, sessionStateDir };
}

describe("Codex native MCP wiring", () => {
    it("thread/start receives translated mcp_servers config AND still declares dynamicTools", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-mcp-1" },
            turnScript: [],
        });
        const providers = new ModelProviderRegistry({
            providers: [
                { id: "codex-subscription", type: "codex", codexHome, models: ["gpt-5.5"] },
            ],
            defaultModel: "codex-subscription:gpt-5.5",
        });

        // WorkerDefaults.codexMcpServers is the already-safe-translated
        // shape (as produced by translateMcpConfigForCodex). No `type`
        // — Codex 0.145 rejects it.
        const codexMcpServers = {
            signoz: {
                url: "https://api.algovity.ai/signoz-mcp",
                bearer_token_env_var: "SIGNOZ_MCP_PROXY_TOKEN",
                enabled_tools: ["signoz_query", "signoz_list"],
            },
        };

        const manager = new SessionManager(undefined, null, {
            modelProviders: providers,
            codexMcpServers,
        }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        manager._setCodexTransportFactoryForTests(() => transport);

        await manager.getOrCreate("ps-codex-mcp-1", {
            model: "codex-subscription:gpt-5.5",
            toolNames: [],
        }, { turnIndex: 0 });

        const start = transport.recordedRequests.find((r) => r.method === "thread/start");
        expect(start).toBeTruthy();

        // Native Codex MCP config MUST arrive under params.config.mcp_servers.
        expect(start.params.config).toBeTruthy();
        expect(start.params.config.mcp_servers).toBeTruthy();
        expect(start.params.config.mcp_servers.signoz).toEqual({
            url: "https://api.algovity.ai/signoz-mcp",
            bearer_token_env_var: "SIGNOZ_MCP_PROXY_TOKEN",
            enabled_tools: ["signoz_query", "signoz_list"],
        });
        // Codex 0.145 rejects `mcp_servers.<name>.type` — verified live
        // via `codex --strict-config -c mcp_servers.test.type=http`.
        expect(start.params.config.mcp_servers.signoz.type).toBeUndefined();

        // PilotSwarm dynamic tools must still be declared (wait/ask_user at minimum).
        expect(Array.isArray(start.params.dynamicTools)).toBe(true);
        const names = start.params.dynamicTools.map((t) => t.name);
        expect(names).toContain("wait");
        expect(names).toContain("ask_user");
    });

    it("thread/resume retains the mcp_servers config so warm resumes keep MCP wiring", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        // Pre-seed a persisted Codex thread mapping so resume is the
        // path taken, without touching disk in this test's own setup.
        const sid = "ps-codex-mcp-resume";
        fs.mkdirSync(path.join(sessionStateDir, sid), { recursive: true });
        fs.writeFileSync(
            path.join(sessionStateDir, sid, CODEX_THREAD_STATE_FILENAME),
            JSON.stringify({ codexThreadId: "codex-thread-mcp-resume", codexHome }),
        );

        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-mcp-resume" },
            turnScript: [],
        });
        const providers = new ModelProviderRegistry({
            providers: [
                { id: "codex-subscription", type: "codex", codexHome, models: ["gpt-5.5"] },
            ],
            defaultModel: "codex-subscription:gpt-5.5",
        });

        const codexMcpServers = {
            signoz: {
                url: "https://api.algovity.ai/signoz-mcp",
                bearer_token_env_var: "SIGNOZ_MCP_PROXY_TOKEN",
            },
        };

        const manager = new SessionManager(undefined, null, {
            modelProviders: providers,
            codexMcpServers,
        }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        manager._setCodexTransportFactoryForTests(() => transport);

        await manager.getOrCreate(sid, {
            model: "codex-subscription:gpt-5.5",
            toolNames: [],
        }, { turnIndex: 1 });

        const resume = transport.recordedRequests.find((r) => r.method === "thread/resume");
        expect(resume).toBeTruthy();
        expect(resume.params.config?.mcp_servers?.signoz?.bearer_token_env_var).toBe("SIGNOZ_MCP_PROXY_TOKEN");
    });

    it("resolves worker-registered `teams_alert` toolName and declares it in thread/start.dynamicTools", async () => {        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-teams-1" },
            turnScript: [],
        });
        const providers = new ModelProviderRegistry({
            providers: [
                { id: "codex-subscription", type: "codex", codexHome, models: ["gpt-5.5"] },
            ],
            defaultModel: "codex-subscription:gpt-5.5",
        });

        const teamsAlertTool = defineTool("teams_alert", {
            description: "Post an alert to a Teams channel",
            parameters: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
            },
            handler: async () => "ok",
        });

        const manager = new SessionManager(undefined, null, {
            modelProviders: providers,
        }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        // Simulate PilotSwarmWorker.registerTools([...]) -> setToolRegistry.
        manager.setToolRegistry(new Map([["teams_alert", teamsAlertTool]]));
        manager._setCodexTransportFactoryForTests(() => transport);

        await manager.getOrCreate("ps-codex-teams-1", {
            model: "codex-subscription:gpt-5.5",
            toolNames: ["teams_alert"],
        }, { turnIndex: 0 });

        const start = transport.recordedRequests.find((r) => r.method === "thread/start");
        expect(start).toBeTruthy();
        expect(Array.isArray(start.params.dynamicTools)).toBe(true);
        const names = start.params.dynamicTools.map((t) => t.name);
        expect(names).toContain("teams_alert");
        const teamsSpec = start.params.dynamicTools.find((t) => t.name === "teams_alert");
        expect(teamsSpec.description).toContain("Teams");
    });

    it("suppresses diagnostic warnings ONLY for names plausibly exposed by a wildcard Codex MCP server (server-name prefixed)", async () => {
        // A Codex MCP server with NO enabled_tools may expose anything
        // under its own namespace, but MUST NOT silence the diagnostic
        // for unrelated worker tool names. Live bug: signoz configured
        // without enabled_tools was making SessionManager treat EVERY
        // unresolved worker toolName (e.g. teams_alert) as "probably
        // an MCP tool", so the missing-tool warning never fired and
        // the deployment-topology bug stayed silent.
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-diag-wildcard" },
            turnScript: [],
        });
        const providers = new ModelProviderRegistry({
            providers: [
                { id: "codex-subscription", type: "codex", codexHome, models: ["gpt-5.5"] },
            ],
            defaultModel: "codex-subscription:gpt-5.5",
        });

        // No enabled_tools -> server "may expose anything under its
        // own namespace" but nothing outside of it.
        const codexMcpServers = {
            signoz: {
                url: "https://api.algovity.ai/signoz-mcp",
                bearer_token_env_var: "SIGNOZ_MCP_PROXY_TOKEN",
            },
        };

        const manager = new SessionManager(undefined, null, {
            modelProviders: providers,
            codexMcpServers,
        }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        // Deliberately register NOTHING. teams_alert is missing.
        manager.setToolRegistry(new Map());
        manager._setCodexTransportFactoryForTests(() => transport);

        const warnings = [];
        const spy = vi.spyOn(console, "warn").mockImplementation((...args) => {
            warnings.push(args.join(" "));
        });

        try {
            await manager.getOrCreate("ps-codex-diag-wildcard", {
                model: "codex-subscription:gpt-5.5",
                toolNames: [
                    "signoz_list_services",   // plausibly a signoz MCP tool -> silent
                    "mcp__signoz__query",     // MCP-style prefixed name -> silent
                    "teams_alert",            // NOT under signoz -> MUST warn
                ],
            }, { turnIndex: 0 });
        } finally {
            spy.mockRestore();
        }

        const unresolvedWarnings = warnings.filter((w) =>
            w.includes("listed in toolNames is not registered")
        );

        // teams_alert must warn — this is the deployment-topology
        // diagnostic (portal embedded worker missing the tool).
        expect(unresolvedWarnings.some((w) => w.includes('"teams_alert"'))).toBe(true);

        // Signoz-namespaced names must NOT warn — they are plausibly
        // provided by the native Codex MCP server at runtime.
        expect(unresolvedWarnings.some((w) => w.includes('"signoz_list_services"'))).toBe(false);
        expect(unresolvedWarnings.some((w) => w.includes('"mcp__signoz__query"'))).toBe(false);
    });

    it("suppresses diagnostic for EXACT names in enabled_tools and still warns for unrelated names", async () => {
        const { codexHome, sessionStateDir } = mkTmpDirs();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-diag-exact" },
            turnScript: [],
        });
        const providers = new ModelProviderRegistry({
            providers: [
                { id: "codex-subscription", type: "codex", codexHome, models: ["gpt-5.5"] },
            ],
            defaultModel: "codex-subscription:gpt-5.5",
        });

        const codexMcpServers = {
            signoz: {
                url: "https://api.algovity.ai/signoz-mcp",
                bearer_token_env_var: "SIGNOZ_MCP_PROXY_TOKEN",
                enabled_tools: ["signoz_query"],
            },
        };

        const manager = new SessionManager(undefined, null, {
            modelProviders: providers,
            codexMcpServers,
        }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        manager.setToolRegistry(new Map());
        manager._setCodexTransportFactoryForTests(() => transport);

        const warnings = [];
        const spy = vi.spyOn(console, "warn").mockImplementation((...args) => {
            warnings.push(args.join(" "));
        });

        try {
            await manager.getOrCreate("ps-codex-diag-exact", {
                model: "codex-subscription:gpt-5.5",
                toolNames: [
                    "signoz_query",           // exact allow-list match -> silent
                    "signoz_list_services",   // NOT in allow-list -> MUST warn
                    "teams_alert",            // unrelated -> MUST warn
                ],
            }, { turnIndex: 0 });
        } finally {
            spy.mockRestore();
        }

        const unresolvedWarnings = warnings.filter((w) =>
            w.includes("listed in toolNames is not registered")
        );

        expect(unresolvedWarnings.some((w) => w.includes('"signoz_query"'))).toBe(false);
        expect(unresolvedWarnings.some((w) => w.includes('"signoz_list_services"'))).toBe(true);
        expect(unresolvedWarnings.some((w) => w.includes('"teams_alert"'))).toBe(true);
    });
});
