/**
 * Codex rollout snapshot integrity.
 *
 * The rollout JSONL copied out of `CODEX_HOME/sessions/**` into
 * `<sessionStateDir>/<sessionId>/codex-rollout.jsonl` is the ONLY
 * artifact that lets a Codex thread be resumed on a different node. Two
 * defects made it unsafe:
 *
 *   1. `_snapshotRolloutIfPresent` wrote the destination in place with a
 *      single `writeFileSync`. A crash / ENOSPC / EIO mid-write left a
 *      TRUNCATED rollout on top of a previously good one, and the marker
 *      was then updated to advertise it.
 *   2. Nothing validated rollout completeness on the read side, so a
 *      truncated rollout was treated as resumable: the local resume path
 *      won over hydrating a known-good stored checkpoint, and a
 *      subsequent checkpoint would archive the truncated file over the
 *      good blob.
 *
 * Contract enforced here:
 *   - the snapshot is written to a same-directory unique temp (mode
 *     0600) and atomically renamed; on failure the previous rollout is
 *     byte-identical and no temp residue is left behind.
 *   - a rollout is only "usable" when it is non-empty AND complete
 *     JSONL (terminated by a newline, last nonempty line parses as
 *     JSON). `_readThreadState` / `hasUsableThreadState` and the
 *     session-store readiness gate both reject truncated rollouts.
 *   - SessionManager therefore hydrates the stored checkpoint instead of
 *     resuming locally (and never overwrites the good blob).
 *
 * Run: npx vitest run test/local/codex-rollout-integrity.test.js
 */

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    CodexRuntimeClient,
    createFakeCodexTransport,
    CODEX_THREAD_STATE_FILENAME,
    CODEX_ROLLOUT_SNAPSHOT_FILENAME,
} from "../../src/codex-runtime.ts";
import { waitForSessionSnapshot, FilesystemSessionStore } from "../../src/session-store.ts";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";

const COMPLETE_ROLLOUT =
    '{"type":"session_meta","payload":{"id":"THREAD"}}\n' +
    '{"type":"response_item","payload":{"role":"user","text":"hello"}}\n';

function mkTmpHomes() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-integrity-"));
    const codexHome = path.join(root, "codex-home");
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionStateDir, { recursive: true });
    return { root, codexHome, sessionStateDir };
}

/** Plant a rollout JSONL inside CODEX_HOME the way the codex CLI would. */
function plantCodexHomeRollout(codexHome, threadId, contents) {
    const dir = path.join(codexHome, "sessions", "2026", "07", "31");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-07-31T00-00-00-${threadId}.jsonl`);
    fs.writeFileSync(file, contents);
    return file;
}

function seedSessionDir(sessionStateDir, sessionId, { codexHome, threadId, rollout }) {
    const dir = path.join(sessionStateDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    if (rollout != null) {
        fs.writeFileSync(path.join(dir, CODEX_ROLLOUT_SNAPSHOT_FILENAME), rollout, { mode: 0o600 });
    }
    fs.writeFileSync(
        path.join(dir, CODEX_THREAD_STATE_FILENAME),
        JSON.stringify({
            codexThreadId: threadId,
            codexHome,
            ...(rollout != null ? { rolloutSnapshotRelPath: CODEX_ROLLOUT_SNAPSHOT_FILENAME } : {}),
        }),
        { mode: 0o600 },
    );
    return dir;
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

describe("Codex rollout snapshot atomicity", () => {
    it("writes the snapshot through a same-directory unique temp with mode 0600 and renames it into place", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const sid = "ps-rollout-atomic-ok";
        const threadId = "codex-thread-atomic-ok";
        plantCodexHomeRollout(codexHome, threadId, COMPLETE_ROLLOUT);

        const transport = createFakeCodexTransport({ thread: { id: threadId } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        const observedTempTargets = [];
        const realRename = fs.renameSync;
        const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
            observedTempTargets.push({ from: String(from), to: String(to) });
            return realRename(from, to);
        });

        try {
            expect(client._snapshotRolloutIfPresent(sid, threadId)).toBe(true);
        } finally {
            spy.mockRestore();
        }

        const sessionDir = path.join(sessionStateDir, sid);
        const dest = path.join(sessionDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        expect(fs.readFileSync(dest, "utf-8")).toBe(COMPLETE_ROLLOUT);
        expect(fs.statSync(dest).mode & 0o777).toBe(0o600);

        // The rollout must have arrived via a rename from a temp inside
        // the SAME directory (rename across filesystems is not atomic).
        const rolloutRename = observedTempTargets.find((entry) => entry.to === dest);
        expect(rolloutRename).toBeTruthy();
        expect(path.dirname(rolloutRename.from)).toBe(sessionDir);
        expect(path.basename(rolloutRename.from)).not.toBe(CODEX_ROLLOUT_SNAPSHOT_FILENAME);

        // No temp residue.
        const residue = fs.readdirSync(sessionDir).filter((name) =>
            name !== CODEX_ROLLOUT_SNAPSHOT_FILENAME && name !== CODEX_THREAD_STATE_FILENAME);
        expect(residue).toEqual([]);

        await client.stop();
    });

    it("leaves the previous rollout byte-identical and no temp residue when the atomic commit fails", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const sid = "ps-rollout-atomic-fail";
        const threadId = "codex-thread-atomic-fail";
        const previous = '{"type":"session_meta","payload":{"id":"previous-good"}}\n';
        const sessionDir = seedSessionDir(sessionStateDir, sid, { codexHome, threadId, rollout: previous });
        const dest = path.join(sessionDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        const before = fs.readFileSync(dest);

        plantCodexHomeRollout(codexHome, threadId, COMPLETE_ROLLOUT);

        const transport = createFakeCodexTransport({ thread: { id: threadId } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        const realRename = fs.renameSync;
        const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
            if (path.basename(String(to)) === CODEX_ROLLOUT_SNAPSHOT_FILENAME) {
                throw Object.assign(new Error("simulated ENOSPC on rollout commit"), { code: "ENOSPC" });
            }
            return realRename(from, to);
        });

        try {
            expect(client._snapshotRolloutIfPresent(sid, threadId)).toBe(false);
        } finally {
            spy.mockRestore();
        }

        expect(fs.readFileSync(dest)).toEqual(before);
        const residue = fs.readdirSync(sessionDir).filter((name) =>
            name !== CODEX_ROLLOUT_SNAPSHOT_FILENAME && name !== CODEX_THREAD_STATE_FILENAME);
        expect(residue).toEqual([]);

        await client.stop();
    });
    it("refuses to commit a torn source rollout, preserving the previous good snapshot and marker", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const sid = "ps-rollout-torn-source";
        const threadId = "codex-thread-torn-source";
        const previous = '{"type":"session_meta","payload":{"id":"previous-good"}}\n';
        const sessionDir = seedSessionDir(sessionStateDir, sid, { codexHome, threadId, rollout: previous });
        // Codex is mid-append: the tail record is incomplete.
        plantCodexHomeRollout(codexHome, threadId, COMPLETE_ROLLOUT + '{"type":"response_item","pay');

        const transport = createFakeCodexTransport({ thread: { id: threadId } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        expect(client._snapshotRolloutIfPresent(sid, threadId)).toBe(false);
        expect(fs.readFileSync(path.join(sessionDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME), "utf-8")).toBe(previous);
        expect(client.hasUsableThreadState(sid)).toBe(true);
        const residue = fs.readdirSync(sessionDir).filter((name) =>
            name !== CODEX_ROLLOUT_SNAPSHOT_FILENAME && name !== CODEX_THREAD_STATE_FILENAME);
        expect(residue).toEqual([]);

        await client.stop();
    });

    it("validates and commits the same source bytes when the rollout mutates after its single read", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const sid = "ps-rollout-exact-bytes";
        const threadId = "codex-thread-exact-bytes";
        const previous = Buffer.from('{"type":"session_meta","payload":{"id":"previous-good"}}\n');
        const validated = Buffer.from(COMPLETE_ROLLOUT);
        const invalidAppend = Buffer.from('{"type":"response_item","pay');
        const sessionDir = seedSessionDir(sessionStateDir, sid, {
            codexHome,
            threadId,
            rollout: previous,
        });
        const dest = path.join(sessionDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        const source = plantCodexHomeRollout(codexHome, threadId, validated);
        const resolvedSource = fs.realpathSync(source);

        const transport = createFakeCodexTransport({ thread: { id: threadId } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        const realReadFileSync = fs.readFileSync.bind(fs);
        let sourceReadCount = 0;
        const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((target, ...args) => {
            const contents = realReadFileSync(target, ...args);
            if (path.resolve(String(target)) === path.resolve(resolvedSource)) {
                sourceReadCount += 1;
                if (sourceReadCount === 1) {
                    fs.appendFileSync(source, invalidAppend);
                }
            }
            return contents;
        });

        let snapshotted;
        try {
            snapshotted = client._snapshotRolloutIfPresent(sid, threadId);
        } finally {
            readSpy.mockRestore();
        }

        const committed = fs.readFileSync(dest);
        expect(sourceReadCount).toBe(1);
        if (snapshotted) {
            expect(committed).toEqual(validated);
        } else {
            expect(committed).toEqual(previous);
        }
        expect(committed).not.toEqual(Buffer.concat([validated, invalidAppend]));

        await client.stop();
    });

    it("rejects an exact source buffer without a trailing newline and preserves the previous snapshot", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const sid = "ps-rollout-buffer-no-newline";
        const threadId = "codex-thread-buffer-no-newline";
        const previous = Buffer.from('{"type":"session_meta","payload":{"id":"previous-good"}}\n');
        const sessionDir = seedSessionDir(sessionStateDir, sid, {
            codexHome,
            threadId,
            rollout: previous,
        });
        const source = Buffer.from('{"type":"session_meta","payload":{"id":"unterminated"}}');
        plantCodexHomeRollout(codexHome, threadId, source);

        const transport = createFakeCodexTransport({ thread: { id: threadId } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        expect(client._snapshotRolloutIfPresent(sid, threadId)).toBe(false);
        expect(fs.readFileSync(path.join(sessionDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME))).toEqual(previous);

        await client.stop();
    });
});

describe("Codex rollout completeness gate", () => {
    const truncatedCases = [
        ["empty file", ""],
        ["no trailing newline (torn write)", '{"type":"session_meta","payload":{"id":"x"}}\n{"type":"response_item","pay'],
        ["final line is not valid JSON", '{"type":"session_meta","payload":{"id":"x"}}\n{"type":"response_item","pay\n'],
        ["whitespace only", "\n \n"],
    ];

    for (const [label, contents] of truncatedCases) {
        it(`_readThreadState / hasUsableThreadState reject a rollout with ${label}`, () => {
            const { codexHome, sessionStateDir } = mkTmpHomes();
            const sid = `ps-truncated-${label.replace(/[^a-z]+/gi, "-")}`;
            seedSessionDir(sessionStateDir, sid, { codexHome, threadId: "codex-thread-trunc", rollout: contents });

            const client = new CodexRuntimeClient({
                codexHome,
                sessionStateDir,
                transportFactory: () => createFakeCodexTransport({ thread: { id: "codex-thread-trunc" } }),
            });

            expect(client._readThreadState(sid)).toBeNull();
            expect(client.hasUsableThreadState(sid)).toBe(false);
        });

        it(`session-store readiness rejects a rollout with ${label}`, async () => {
            const { codexHome, sessionStateDir } = mkTmpHomes();
            const sid = `ps-ready-trunc-${label.replace(/[^a-z]+/gi, "-")}`;
            seedSessionDir(sessionStateDir, sid, { codexHome, threadId: "codex-thread-trunc", rollout: contents });

            const snapshot = await waitForSessionSnapshot(sessionStateDir, sid, 250, 50);
            expect(snapshot.ready).toBe(false);
            expect(snapshot.missing.join(" ")).toContain(CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        });
    }

    it("accepts a complete rollout (marker + readiness both usable)", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const sid = "ps-complete-rollout";
        seedSessionDir(sessionStateDir, sid, { codexHome, threadId: "codex-thread-ok", rollout: COMPLETE_ROLLOUT });

        const client = new CodexRuntimeClient({
            codexHome,
            sessionStateDir,
            transportFactory: () => createFakeCodexTransport({ thread: { id: "codex-thread-ok" } }),
        });

        expect(client.hasUsableThreadState(sid)).toBe(true);
        expect(client._readThreadState(sid)?.rolloutSnapshotRelPath).toBe(CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        const snapshot = await waitForSessionSnapshot(sessionStateDir, sid, 1_000, 50);
        expect(snapshot.ready).toBe(true);
    });

    it("still accepts a zero-turn marker that advertises no rollout at all", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const sid = "ps-no-rollout";
        seedSessionDir(sessionStateDir, sid, { codexHome, threadId: "codex-thread-zero", rollout: null });

        const client = new CodexRuntimeClient({
            codexHome,
            sessionStateDir,
            transportFactory: () => createFakeCodexTransport({ thread: { id: "codex-thread-zero" } }),
        });

        expect(client.hasUsableThreadState(sid)).toBe(true);
        const snapshot = await waitForSessionSnapshot(sessionStateDir, sid, 1_000, 50);
        expect(snapshot.ready).toBe(true);
    });

    it("checkpoint refuses to archive a truncated rollout over a previously good blob", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-store-"));
        const sid = "ps-checkpoint-trunc";
        const sessionDir = seedSessionDir(sessionStateDir, sid, {
            codexHome,
            threadId: "codex-thread-cp",
            rollout: COMPLETE_ROLLOUT,
        });

        const store = new FilesystemSessionStore(storeDir, sessionStateDir);
        await store.checkpoint(sid);
        const goodTar = path.join(storeDir, `${sid}.tar.gz`);
        const goodBytes = fs.readFileSync(goodTar);

        // Torn write on the live rollout.
        fs.writeFileSync(path.join(sessionDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME), '{"type":"response_item","pay');

        await expect(store.checkpoint(sid)).rejects.toThrow(/not ready during checkpoint/);
        expect(fs.readFileSync(goodTar)).toEqual(goodBytes);

        fs.rmSync(storeDir, { recursive: true, force: true });
    }, 15_000);
});

describe("SessionManager truncated-rollout fallback", () => {
    it("hydrates the stored checkpoint instead of resuming a locally truncated rollout", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-fallback-store-"));
        const sid = "ps-truncated-fallback";
        const threadId = "codex-thread-fallback";
        const sessionDir = seedSessionDir(sessionStateDir, sid, { codexHome, threadId, rollout: COMPLETE_ROLLOUT });

        const store = new FilesystemSessionStore(storeDir, sessionStateDir);
        await store.checkpoint(sid);
        const goodTarBytes = fs.readFileSync(path.join(storeDir, `${sid}.tar.gz`));

        // Simulate the torn local rollout that motivated this gate. The
        // MARKER is still perfectly valid — only the rollout is short.
        const rolloutPath = path.join(sessionDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        fs.writeFileSync(rolloutPath, '{"type":"session_meta","payload":{"id":"fal');

        const transport = createFakeCodexTransport({ thread: { id: threadId } });
        const providers = new ModelProviderRegistry({
            providers: [{ id: "codex-subscription", type: "codex", codexHome, models: ["gpt-5.6-sol"] }],
            defaultModel: "codex-subscription:gpt-5.6-sol",
        });
        const manager = new SessionManager(undefined, store, { modelProviders: providers }, sessionStateDir);
        manager.setFactStore(mkFactStoreStub());
        manager.setSessionCatalog(mkCatalogStub());
        manager._setCodexTransportFactoryForTests(() => transport);

        try {
            await manager.getOrCreate(
                sid,
                { model: "codex-subscription:gpt-5.6-sol", toolNames: [] },
                { turnIndex: 1 },
            );

            // The truncated local rollout must have been replaced by the
            // known-good archived one.
            expect(fs.readFileSync(rolloutPath, "utf-8")).toBe(COMPLETE_ROLLOUT);
            // The good blob must be untouched — never overwritten by a
            // checkpoint of the truncated state.
            expect(fs.readFileSync(path.join(storeDir, `${sid}.tar.gz`))).toEqual(goodTarBytes);
            // And the thread was resumed (not restarted as a fresh thread).
            const resume = transport.recordedRequests.find((r) => r.method === "thread/resume");
            expect(resume?.params?.threadId).toBe(threadId);
            expect(resume?.params?.path).toBe(rolloutPath);
            expect(transport.recordedRequests.some((r) => r.method === "thread/start")).toBe(false);
        } finally {
            await manager.shutdown();
            fs.rmSync(storeDir, { recursive: true, force: true });
        }
    }, 15_000);
});
