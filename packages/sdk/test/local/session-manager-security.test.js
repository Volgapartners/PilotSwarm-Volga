/**
 * SessionManager security — session-id validation at destructive /
 * public entry points.
 *
 * Regression: SessionManager's Codex branch validated its sessionId
 * before reaching sessionStore / codexClient / fs.rmSync (see
 * rounds R3-R5), but three Copilot / shared paths still fell through
 * with a raw id:
 *
 *   - `_resetSessionState(sessionId)` runs `path.join(this.sessionStateDir, sessionId)`
 *     then `fs.rmSync(..., { recursive: true, force: true })`. A `../victim`
 *     id lets the recursive rm escape sessionStateDir and wipe host files.
 *   - Public `resetSessionState(sessionId)` reaches `_resetSessionState`
 *     without validation, exposing the same attack to any caller.
 *   - Copilot `getOrCreate` turn0 computes `sessionDir = path.join(...)`,
 *     probes `fs.existsSync(sessionDir)`, and — when sessionStore.exists()
 *     rejects — still sees `localExists === true` for a `../` id that
 *     resolves onto an existing sibling. It then calls `_resetSessionState`
 *     and the recursive rm follows.
 *   - Public `dehydrate(sessionId, reason)` calls `_dehydrateUnlocked`
 *     which also builds `path.join(this.sessionStateDir, sessionId)` and
 *     hands it to the destroy / rm pipeline.
 *
 * The fix wires the same shared `validateSessionId` /
 * `resolveContainedSessionDir` used by session-store / blob-store /
 * codex-runtime into the SessionManager destructive entry points as
 * the FIRST statement — before any map access, client call, store
 * call, or fs probe.
 *
 * Run: npx vitest run test/local/session-manager-security.test.js
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../../src/session-manager.ts";
import { createTempSessionLayout } from "../helpers/temp-session-layout.js";

// A minimal fact-store stub — SessionManager insists on one before
// creating sessions but the R7 paths never actually call it.
function createNoopFactStore() {
    return {
        async initialize() {},
        async storeFact(input) { return { key: input.key, shared: input.shared === true, stored: true }; },
        async readFacts() { return { count: 0, facts: [] }; },
        async deleteFact(input) { return { key: input.key, shared: input.shared === true, deleted: true }; },
        async deleteSessionFactsForSession() { return 0; },
        async close() {},
    };
}

class RecordingClient {
    createCalls = [];
    resumeCalls = [];
    deleteCalls = [];
    async createSession(config) { this.createCalls.push(config); return {}; }
    async resumeSession(sessionId, config) { this.resumeCalls.push({ sessionId, config }); return {}; }
    async deleteSession(sessionId) { this.deleteCalls.push(sessionId); }
    async stop() {}
}

class RecordingSessionStore {
    existsCalls = [];
    deleteCalls = [];
    dehydrateCalls = [];
    hydrateCalls = [];
    checkpointCalls = [];
    async exists(sessionId) { this.existsCalls.push(sessionId); return false; }
    async delete(sessionId) { this.deleteCalls.push(sessionId); }
    async dehydrate(sessionId, meta) { this.dehydrateCalls.push({ sessionId, meta }); }
    async hydrate(sessionId) { this.hydrateCalls.push(sessionId); }
    async checkpoint(sessionId) { this.checkpointCalls.push(sessionId); }
    async getSnapshotSizeBytes() { return undefined; }
}

function harness(prefix) {
    const layout = createTempSessionLayout(prefix);
    // Sentinels OUTSIDE the sessionStateDir to prove no traversal
    // ever escaped. `outsideDir` lives above `sessionStateDir` (its
    // parent) so `../victim` from sessionStateDir would land here.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}victim-`));
    const outsideFile = path.join(outsideDir, "outside-KEEP.txt");
    fs.writeFileSync(outsideFile, "R7-OUTSIDE-KEEP");
    // Sibling-prefix sentinel: a directory next to sessionStateDir
    // whose name matches what a `../victim`-style traversal would
    // resolve to. path.join('sessionStateDir', '../victim') resolves
    // to `dirname(sessionStateDir)/victim`, so pre-create that sibling.
    const siblingVictimDir = path.join(path.dirname(layout.sessionStateDir), "victim");
    fs.mkdirSync(siblingVictimDir, { recursive: true });
    const siblingFile = path.join(siblingVictimDir, "sibling-KEEP.txt");
    fs.writeFileSync(siblingFile, "R7-SIBLING-KEEP");

    const client = new RecordingClient();
    const store = new RecordingSessionStore();
    const manager = new SessionManager(process.env.GITHUB_TOKEN, store, {}, layout.sessionStateDir);
    manager.client = client;
    manager.setFactStore(createNoopFactStore());

    return {
        manager,
        client,
        store,
        sessionStateDir: layout.sessionStateDir,
        outsideDir,
        outsideFile,
        siblingVictimDir,
        siblingFile,
        cleanup() {
            layout.cleanup();
            try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch {}
            try { fs.rmSync(siblingVictimDir, { recursive: true, force: true }); } catch {}
        },
    };
}

const UNSAFE_IDS = [
    "../victim",
    "..\\victim",
    "a/b",
    "a\\b",
    ".",
    "..",
    "",
    "/absolute/victim",
];

describe("SessionManager destructive/public entry points reject unsafe session ids", () => {
    it("resetSessionState (public) rejects every unsafe id before any map access, client call, store call, or fs mutation", async () => {
        const h = harness("pilotswarm-r7-reset-");
        try {
            for (const bad of UNSAFE_IDS) {
                const settled = await h.manager.resetSessionState(bad).then(
                    (value) => ({ kind: "resolved", value }),
                    (err) => ({ kind: "rejected", err }),
                );
                expect(settled.kind).toBe("rejected");
                expect(String(settled.err?.message || "")).toMatch(/^Invalid PilotSwarm session id/);
            }
            // No client / store side effects.
            expect(h.client.deleteCalls).toEqual([]);
            expect(h.store.deleteCalls).toEqual([]);
            // Sentinels intact.
            expect(fs.readFileSync(h.outsideFile, "utf-8")).toBe("R7-OUTSIDE-KEEP");
            expect(fs.readFileSync(h.siblingFile, "utf-8")).toBe("R7-SIBLING-KEEP");
            expect(fs.existsSync(h.siblingVictimDir)).toBe(true);
        } finally {
            h.cleanup();
        }
    });

    it("dehydrate (public) rejects every unsafe id before any client/store/fs side effect", async () => {
        const h = harness("pilotswarm-r7-dehydrate-");
        try {
            for (const bad of UNSAFE_IDS) {
                const settled = await h.manager.dehydrate(bad, "cron").then(
                    (value) => ({ kind: "resolved", value }),
                    (err) => ({ kind: "rejected", err }),
                );
                expect(settled.kind).toBe("rejected");
                expect(String(settled.err?.message || "")).toMatch(/^Invalid PilotSwarm session id/);
            }
            expect(h.store.dehydrateCalls).toEqual([]);
            expect(h.client.deleteCalls).toEqual([]);
            expect(fs.readFileSync(h.outsideFile, "utf-8")).toBe("R7-OUTSIDE-KEEP");
            expect(fs.readFileSync(h.siblingFile, "utf-8")).toBe("R7-SIBLING-KEEP");
            expect(fs.existsSync(h.siblingVictimDir)).toBe(true);
        } finally {
            h.cleanup();
        }
    });

    it("Copilot getOrCreate turn0 rejects unsafe ids BEFORE reaching _resetSessionState / client / store", async () => {
        // The stale-reset path is the deepest attack: a `../victim`
        // that resolves onto an EXISTING sibling directory sets
        // `localExists=true`, and the pre-fix code would then run
        // `_resetSessionState` → `fs.rmSync(sessionDir, { recursive })`
        // wiping the sibling. The sibling sentinel dir is pre-created
        // by the harness so `path.join(sessionStateDir, '../victim')`
        // resolves into it.
        const h = harness("pilotswarm-r7-getorcreate-");
        try {
            for (const bad of UNSAFE_IDS) {
                const settled = await h.manager
                    .getOrCreate(bad, { toolNames: [] }, { turnIndex: 0 })
                    .then((value) => ({ kind: "resolved", value }), (err) => ({ kind: "rejected", err }));
                expect(settled.kind).toBe("rejected");
                expect(String(settled.err?.message || "")).toMatch(/^Invalid PilotSwarm session id/);
            }
            // No CopilotClient create/resume/delete for any unsafe id.
            expect(h.client.createCalls).toEqual([]);
            expect(h.client.resumeCalls).toEqual([]);
            expect(h.client.deleteCalls).toEqual([]);
            // No sessionStore exists probe / delete either.
            expect(h.store.existsCalls).toEqual([]);
            expect(h.store.deleteCalls).toEqual([]);
            // Sibling sentinel (which `../victim` resolves onto) intact.
            expect(fs.existsSync(h.siblingVictimDir)).toBe(true);
            expect(fs.readFileSync(h.siblingFile, "utf-8")).toBe("R7-SIBLING-KEEP");
            expect(fs.readFileSync(h.outsideFile, "utf-8")).toBe("R7-OUTSIDE-KEEP");
        } finally {
            h.cleanup();
        }
    });

    it("normal UUID resetSessionState still removes only the local dir and stored snapshot", async () => {
        const h = harness("pilotswarm-r7-good-reset-");
        const sid = "019dcfc8-cafe-7133-a002-45ec3742e777";
        const sessionDir = path.join(h.sessionStateDir, sid);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n");
        try {
            await h.manager.resetSessionState(sid);
            // Local dir gone.
            expect(fs.existsSync(sessionDir)).toBe(false);
            // Store.delete called with the exact id.
            expect(h.store.deleteCalls).toEqual([sid]);
            // Sentinels intact.
            expect(fs.readFileSync(h.outsideFile, "utf-8")).toBe("R7-OUTSIDE-KEEP");
            expect(fs.readFileSync(h.siblingFile, "utf-8")).toBe("R7-SIBLING-KEEP");
        } finally {
            h.cleanup();
        }
    });
});
