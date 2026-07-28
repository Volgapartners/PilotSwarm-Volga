/**
 * Codex durability tests — snapshot / dehydrate / hydrate round-trip.
 *
 * Verifies that a Codex-backed session can:
 *   - copy its rollout out of CODEX_HOME on disconnect
 *   - have its session directory archived by FilesystemSessionStore
 *     even though it does NOT contain the Copilot-only `workspace.yaml`
 *   - be restored from the archive on a different CODEX_HOME (fresh
 *     machine simulation) and resumed via `thread/resume` with a
 *     `path` pointing at the restored rollout
 *   - never carry `auth.json` into the archive or the restored snapshot
 *
 * Run: npx vitest run test/local/codex-durability.test.js
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
    CodexRuntimeClient,
    createFakeCodexTransport,
    CODEX_THREAD_STATE_FILENAME,
    CODEX_ROLLOUT_SNAPSHOT_FILENAME,
} from "../../src/codex-runtime.ts";
import { FilesystemSessionStore } from "../../src/session-store.ts";

function mkTmpEnv(prefix = "codex-durability-") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const codexHome = path.join(root, "codex-home");
    const sessionStateDir = path.join(root, "session-state");
    const storeDir = path.join(root, "store");
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(codexHome, "auth.json"), '{"secret":"do-not-copy"}', { mode: 0o600 });
    fs.mkdirSync(sessionStateDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    return { root, codexHome, sessionStateDir, storeDir };
}

function seedRolloutOnDisk(codexHome, threadId, contents) {
    const dir = path.join(codexHome, "sessions", "2026", "07", "27");
    fs.mkdirSync(dir, { recursive: true });
    const rollout = path.join(dir, `rollout-2026-07-27T00-00-00-${threadId}.jsonl`);
    fs.writeFileSync(rollout, contents, { mode: 0o600 });
    return rollout;
}

describe("Codex durability (rollout snapshot + FilesystemSessionStore round-trip)", () => {
    it("SessionManager.checkpoint on a warm Codex session archives the rollout", async () => {
        const env = mkTmpEnv("codex-durability-warm-ckp-");
        const threadId = "019dcfc8-cafe-7133-a002-45ec3742e400";
        seedRolloutOnDisk(env.codexHome, threadId, '{"type":"session_meta","payload":{"id":"' + threadId + '"}}\n');

        const providers = new (await import("../../src/model-providers.ts")).ModelProviderRegistry({
            providers: [{ id: "codex-subscription", type: "codex", codexHome: env.codexHome, models: ["gpt-5.6-sol"] }],
            defaultModel: "codex-subscription:gpt-5.6-sol",
        });
        const transport = createFakeCodexTransport({ thread: { id: threadId } });
        const { SessionManager } = await import("../../src/session-manager.ts");
        const manager = new SessionManager(undefined, new FilesystemSessionStore(env.storeDir, env.sessionStateDir), { modelProviders: providers }, env.sessionStateDir);
        manager.setFactStore({ listFacts: async () => [], readFacts: async () => [], storeFact: async () => {}, deleteFact: async () => {}, deleteSessionFactsForSession: async () => {}, upsertFacts: async () => {}, writeFactsForSession: async () => {}, listRootKeys: async () => [], buildKnowledgeIndex: async () => ({ askEntries: [], skillEntries: [] }), buildKnowledgeIndexFromCatalog: async () => ({ askEntries: [], skillEntries: [] }), pruneFactsForSession: async () => {}, pruneStaleFacts: async () => {} });
        manager.setSessionCatalog({ initialize: async () => {}, createSession: async () => {}, updateSession: async () => {}, softDeleteSession: async () => {}, listSessions: async () => [], getSession: async () => null, getDescendantSessionIds: async () => [], getLastSessionId: async () => null, recordEvents: async () => {}, getSessionEvents: async () => [], getSessionEventsBefore: async () => [], getSessionMetricSummary: async () => null, getSessionTreeStats: async () => null, getFleetStats: async () => ({ totals: {}, perAgent: [] }), upsertSessionMetricSummary: async () => {}, pruneDeletedSummaries: async () => 0, getUserGitHubCopilotKey: async () => null, close: async () => {} });
        manager._setCodexTransportFactoryForTests(() => transport);

        const sessionId = "ps-warm-ckp";
        await manager.getOrCreate(sessionId, { model: "codex-subscription:gpt-5.6-sol", toolNames: [] }, { turnIndex: 0 });

        // Warm checkpoint — must snapshot the rollout out of CODEX_HOME
        // even though the session was NOT disconnected.
        await manager.checkpoint(sessionId);

        const tarFile = fs.readdirSync(env.storeDir).find((f) => f.endsWith(".tar.gz") || f.endsWith(".tgz"));
        expect(tarFile).toBeTruthy();
        const listing = execSync(`tar tzf ${JSON.stringify(path.join(env.storeDir, tarFile))}`).toString();
        expect(listing).toContain(CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        expect(listing).toContain(CODEX_THREAD_STATE_FILENAME);
        expect(listing).not.toContain("auth.json");

        await manager.shutdown();
    });

    it("disconnect() snapshots the rollout even after the transport has already closed", async () => {
        const env = mkTmpEnv("codex-durability-post-close-");
        const threadId = "019dcfc8-cafe-7133-a002-45ec3742e401";
        seedRolloutOnDisk(env.codexHome, threadId, '{"type":"session_meta","payload":{"id":"' + threadId + '"}}\n');
        const transport = createFakeCodexTransport({ thread: { id: threadId } });
        const client = new CodexRuntimeClient({ codexHome: env.codexHome, sessionStateDir: env.sessionStateDir, transportFactory: () => transport });
        const sessionId = "ps-post-close";
        const session = await client.createSession({ sessionId });

        // Close the transport BEFORE the runtime session tries to
        // disconnect. The snapshot copy must still happen because it's
        // filesystem-only and does not need the app-server round-trip.
        await transport.close();
        await new Promise((r) => setTimeout(r, 5));
        await session.disconnect();

        const rollout = path.join(env.sessionStateDir, sessionId, CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        expect(fs.existsSync(rollout)).toBe(true);
        const meta = JSON.parse(fs.readFileSync(path.join(env.sessionStateDir, sessionId, CODEX_THREAD_STATE_FILENAME), "utf-8"));
        expect(meta.rolloutSnapshotRelPath).toBe(CODEX_ROLLOUT_SNAPSHOT_FILENAME);

        await client.stop();
    });

    it("SessionManager auto-hydrates a dehydrated Codex session on turn>0 (real FilesystemSessionStore)", async () => {
        const env = mkTmpEnv("codex-durability-sm-hydrate-");
        const threadId = "019dcfc8-cafe-7133-a002-45ec3742e500";
        seedRolloutOnDisk(env.codexHome, threadId, '{"type":"session_meta","payload":{"id":"' + threadId + '"}}\n');

        const { ModelProviderRegistry } = await import("../../src/model-providers.ts");
        const { SessionManager } = await import("../../src/session-manager.ts");
        const providers = new ModelProviderRegistry({
            providers: [{ id: "codex-subscription", type: "codex", codexHome: env.codexHome, models: ["gpt-5.6-sol"] }],
            defaultModel: "codex-subscription:gpt-5.6-sol",
        });
        const store = new FilesystemSessionStore(env.storeDir, env.sessionStateDir);
        const factory = () => createFakeCodexTransport({ thread: { id: threadId } });
        const manager = new SessionManager(undefined, store, { modelProviders: providers }, env.sessionStateDir);
        manager.setFactStore({ listFacts: async () => [], readFacts: async () => [], storeFact: async () => {}, deleteFact: async () => {}, deleteSessionFactsForSession: async () => {}, upsertFacts: async () => {}, writeFactsForSession: async () => {}, listRootKeys: async () => [], buildKnowledgeIndex: async () => ({ askEntries: [], skillEntries: [] }), buildKnowledgeIndexFromCatalog: async () => ({ askEntries: [], skillEntries: [] }), pruneFactsForSession: async () => {}, pruneStaleFacts: async () => {} });
        manager.setSessionCatalog({ initialize: async () => {}, createSession: async () => {}, updateSession: async () => {}, softDeleteSession: async () => {}, listSessions: async () => [], getSession: async () => null, getDescendantSessionIds: async () => [], getLastSessionId: async () => null, recordEvents: async () => {}, getSessionEvents: async () => [], getSessionEventsBefore: async () => [], getSessionMetricSummary: async () => null, getSessionTreeStats: async () => null, getFleetStats: async () => ({ totals: {}, perAgent: [] }), upsertSessionMetricSummary: async () => {}, pruneDeletedSummaries: async () => 0, getUserGitHubCopilotKey: async () => null, close: async () => {} });
        manager._setCodexTransportFactoryForTests(factory);

        const sessionId = "ps-sm-hydrate";
        // Turn 0 — create + snapshot rollout into session dir.
        const warm = await manager.getOrCreate(sessionId, { model: "codex-subscription:gpt-5.6-sol", toolNames: [] }, { turnIndex: 0 });
        await warm.getRuntimeSession().disconnect(); // ensure rollout snapshot lands
        await manager.dehydrate(sessionId, "test");
        // Local session dir is now gone; archive exists in the store.
        expect(fs.existsSync(path.join(env.sessionStateDir, sessionId))).toBe(false);

        // Simulate a fresh worker: shut down and rebuild the SessionManager.
        await manager.shutdown();

        const manager2 = new SessionManager(undefined, new FilesystemSessionStore(env.storeDir, env.sessionStateDir), { modelProviders: providers }, env.sessionStateDir);
        manager2.setFactStore({ listFacts: async () => [], readFacts: async () => [], storeFact: async () => {}, deleteFact: async () => {}, deleteSessionFactsForSession: async () => {}, upsertFacts: async () => {}, writeFactsForSession: async () => {}, listRootKeys: async () => [], buildKnowledgeIndex: async () => ({ askEntries: [], skillEntries: [] }), buildKnowledgeIndexFromCatalog: async () => ({ askEntries: [], skillEntries: [] }), pruneFactsForSession: async () => {}, pruneStaleFacts: async () => {} });
        manager2.setSessionCatalog({ initialize: async () => {}, createSession: async () => {}, updateSession: async () => {}, softDeleteSession: async () => {}, listSessions: async () => [], getSession: async () => null, getDescendantSessionIds: async () => [], getLastSessionId: async () => null, recordEvents: async () => {}, getSessionEvents: async () => [], getSessionEventsBefore: async () => [], getSessionMetricSummary: async () => null, getSessionTreeStats: async () => null, getFleetStats: async () => ({ totals: {}, perAgent: [] }), upsertSessionMetricSummary: async () => {}, pruneDeletedSummaries: async () => 0, getUserGitHubCopilotKey: async () => null, close: async () => {} });
        const t2 = createFakeCodexTransport({ thread: { id: threadId } });
        manager2._setCodexTransportFactoryForTests(() => t2);

        // Turn > 0 must auto-hydrate WITHOUT the caller invoking hydrate().
        await manager2.getOrCreate(sessionId, { model: "codex-subscription:gpt-5.6-sol", toolNames: [] }, { turnIndex: 1 });

        // Session dir restored on disk after hydrate.
        expect(fs.existsSync(path.join(env.sessionStateDir, sessionId, CODEX_THREAD_STATE_FILENAME))).toBe(true);
        // thread/resume was issued with the restored rollout path.
        const resume = t2.recordedRequests.find((r) => r.method === "thread/resume");
        expect(resume).toBeTruthy();
        expect(resume.params.threadId).toBe(threadId);
        expect(typeof resume.params.path).toBe("string");
        expect(resume.params.path.endsWith(CODEX_ROLLOUT_SNAPSHOT_FILENAME)).toBe(true);

        await manager2.shutdown();
    });

    it("deleteSession removes the entire per-session state directory including stale rollout", async () => {
        const env = mkTmpEnv("codex-durability-delete-");
        const threadId = "019dcfc8-cafe-7133-a002-45ec3742e600";
        // Seed a fresh session dir with a marker, an old rollout, and
        // some unrelated PilotSwarm-managed junk. deleteSession must
        // wipe the whole subtree.
        const sessionId = "ps-del";
        const sessDir = path.join(env.sessionStateDir, sessionId);
        fs.mkdirSync(sessDir, { recursive: true });
        fs.writeFileSync(path.join(sessDir, CODEX_THREAD_STATE_FILENAME), JSON.stringify({ codexThreadId: threadId, codexHome: env.codexHome }));
        fs.writeFileSync(path.join(sessDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME), 'STALE-ROLLOUT-SENTINEL\n');
        fs.mkdirSync(path.join(sessDir, "artifacts"));
        fs.writeFileSync(path.join(sessDir, "artifacts", "junk.bin"), "junk");

        // Also make sure we do not touch unrelated sibling session dirs.
        const otherId = "ps-other";
        const otherDir = path.join(env.sessionStateDir, otherId);
        fs.mkdirSync(otherDir);
        fs.writeFileSync(path.join(otherDir, CODEX_THREAD_STATE_FILENAME), "{}");
        fs.writeFileSync(path.join(otherDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME), "other-rollout");

        const transport = createFakeCodexTransport({ thread: { id: threadId } });
        const client = new CodexRuntimeClient({ codexHome: env.codexHome, sessionStateDir: env.sessionStateDir, transportFactory: () => transport });

        await client.deleteSession(sessionId);
        expect(fs.existsSync(sessDir)).toBe(false);

        // Unrelated session untouched.
        expect(fs.existsSync(path.join(otherDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME))).toBe(true);

        // Now start a fresh session with the SAME id and prove no
        // stale rollout survives — a subsequent checkpoint archive
        // must NOT carry the STALE-ROLLOUT-SENTINEL.
        await client.createSession({ sessionId });
        const store = new FilesystemSessionStore(env.storeDir, env.sessionStateDir);
        // Persist a plain marker (no new rollout on disk yet) then
        // dehydrate; readiness accepts a marker-only zero-turn session.
        await store.dehydrate(sessionId, { reason: "post-delete" });
        const tarFile = fs.readdirSync(env.storeDir).find((f) => f.endsWith(".tar.gz") || f.endsWith(".tgz"));
        expect(tarFile).toBeTruthy();
        const listing = execSync(`tar tzf ${JSON.stringify(path.join(env.storeDir, tarFile))}`).toString();
        expect(listing).not.toContain(CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        // Extract to a temp dir to prove content isn't the old sentinel.
        const dump = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tar-dump-"));
        execSync(`tar xzf ${JSON.stringify(path.join(env.storeDir, tarFile))} -C ${JSON.stringify(dump)}`);
        for (const entry of fs.readdirSync(path.join(dump, sessionId))) {
            expect(fs.readFileSync(path.join(dump, sessionId, entry), "utf-8")).not.toContain("STALE-ROLLOUT-SENTINEL");
        }

        await client.stop();
    });

    it("rejects a session dir whose codex-thread.json claims a rollout that is not on disk", async () => {
        // Zero-turn (marker only) sessions are valid ready snapshots.
        // But if metadata says "rollout snapshot at codex-rollout.jsonl"
        // and the file is missing, the archive would ship a broken
        // promise. Readiness must reject it.
        const env = mkTmpEnv("codex-durability-broken-meta-");
        const sessionId = "ps-broken";
        const sessionDir = path.join(env.sessionStateDir, sessionId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, CODEX_THREAD_STATE_FILENAME), JSON.stringify({
            codexThreadId: "abc",
            codexHome: env.codexHome,
            rolloutSnapshotRelPath: CODEX_ROLLOUT_SNAPSHOT_FILENAME,
        }));
        // NOTE: no rollout file written.
        const store = new FilesystemSessionStore(env.storeDir, env.sessionStateDir);
        await expect(store.dehydrate(sessionId, { reason: "broken" })).rejects.toThrow(/not ready/);

        // Marker-only (no rolloutSnapshotRelPath) must still be ready.
        const okId = "ps-ok";
        const okDir = path.join(env.sessionStateDir, okId);
        fs.mkdirSync(okDir, { recursive: true });
        fs.writeFileSync(path.join(okDir, CODEX_THREAD_STATE_FILENAME), JSON.stringify({ codexThreadId: "xyz", codexHome: env.codexHome }));
        await store.dehydrate(okId, { reason: "zero-turn" });
        expect(fs.existsSync(okDir)).toBe(false);
    });

    it("rejects symlinked rollout files so auth.json cannot be smuggled into the archive", async () => {
        const env = mkTmpEnv("codex-durability-symlink-");
        const threadId = "019dcfc8-cafe-7133-a002-45ec3742e307";
        // Attacker (or misconfigured CODEX_HOME): a rollout file that is
        // actually a symlink to auth.json. Discovery must NOT follow it.
        const sessionsDay = path.join(env.codexHome, "sessions", "2026", "07", "27");
        fs.mkdirSync(sessionsDay, { recursive: true });
        const decoy = path.join(sessionsDay, `rollout-2026-07-27T00-00-00-${threadId}.jsonl`);
        const authPath = path.join(env.codexHome, "auth.json");
        // Ensure auth.json is a real file with a sentinel we would
        // recognize if it ever got copied.
        fs.writeFileSync(authPath, '{"secret":"do-not-copy"}', { mode: 0o600 });
        fs.symlinkSync(authPath, decoy);

        const transport = createFakeCodexTransport({ thread: { id: threadId } });
        const client = new CodexRuntimeClient({
            codexHome: env.codexHome,
            sessionStateDir: env.sessionStateDir,
            transportFactory: () => transport,
        });
        const sessionId = "ps-symlink";
        const session = await client.createSession({ sessionId });
        await session.disconnect();

        // Snapshot must have skipped the decoy: no rollout file created,
        // metadata must not claim a rollout snapshot exists.
        const sessionDir = path.join(env.sessionStateDir, sessionId);
        expect(fs.readdirSync(sessionDir)).not.toContain(CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, CODEX_THREAD_STATE_FILENAME), "utf-8"));
        expect(meta.rolloutSnapshotRelPath == null).toBe(true);
        // Nothing under the session dir carries the secret.
        for (const entry of fs.readdirSync(sessionDir)) {
            expect(fs.readFileSync(path.join(sessionDir, entry), "utf-8")).not.toContain("do-not-copy");
        }

        await client.stop();
    });

    it("disconnect() copies the rollout into the session dir; snapshot excludes auth.json; resume uses restored path", async () => {
        // Machine A: fresh session, seed rollout, disconnect → snapshot.
        const a = mkTmpEnv("codex-durability-a-");
        const threadId = "019dcfc8-caf2-7133-a002-45ec3742e307";
        seedRolloutOnDisk(a.codexHome, threadId, '{"type":"session_meta","payload":{"id":"' + threadId + '"}}\n');

        const aTransport = createFakeCodexTransport({ thread: { id: threadId } });
        const aClient = new CodexRuntimeClient({
            codexHome: a.codexHome,
            sessionStateDir: a.sessionStateDir,
            transportFactory: () => aTransport,
        });
        const sessionId = "ps-durable-1";
        const aSession = await aClient.createSession({ sessionId });
        await aSession.disconnect();

        // The rollout snapshot must now live under the session dir, and
        // the persisted thread metadata must reference it.
        const sessionDir = path.join(a.sessionStateDir, sessionId);
        expect(fs.readdirSync(sessionDir).sort()).toEqual(
            [CODEX_THREAD_STATE_FILENAME, CODEX_ROLLOUT_SNAPSHOT_FILENAME].sort(),
        );
        const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, CODEX_THREAD_STATE_FILENAME), "utf-8"));
        expect(meta.rolloutSnapshotRelPath).toBe(CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        // No auth material sneaked in.
        for (const entry of fs.readdirSync(sessionDir)) {
            const contents = fs.readFileSync(path.join(sessionDir, entry), "utf-8");
            expect(contents).not.toContain("do-not-copy");
        }

        // FilesystemSessionStore.dehydrate must accept the Codex layout
        // (no workspace.yaml) and produce an archive that does NOT contain
        // auth.json.
        const store = new FilesystemSessionStore(a.storeDir, a.sessionStateDir);
        await store.dehydrate(sessionId, { reason: "test" });
        // sessionDir removed by dehydrate.
        expect(fs.existsSync(sessionDir)).toBe(false);
        // Archive on disk; peek inside.
        const files = fs.readdirSync(a.storeDir);
        const tarFile = files.find((f) => f.endsWith(".tar.gz") || f.endsWith(".tgz"));
        expect(tarFile).toBeTruthy();
        const tarAbs = path.join(a.storeDir, tarFile);
        const listing = execSync(`tar tzf ${JSON.stringify(tarAbs)}`).toString();
        expect(listing).toContain(CODEX_THREAD_STATE_FILENAME);
        expect(listing).toContain(CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        expect(listing).not.toContain("auth.json");

        await aClient.stop();

        // Machine B: fresh empty CODEX_HOME + sessionStateDir + storeDir
        // (copy the archive over). Simulates cross-worker restore. Auth
        // stays local to the operator; we do not copy CODEX_HOME.
        const b = mkTmpEnv("codex-durability-b-");
        // Preserve original filename since FilesystemSessionStore uses
        // `<sessionId>.tar.gz` on the store side.
        fs.copyFileSync(tarAbs, path.join(b.storeDir, tarFile));
        const bStore = new FilesystemSessionStore(b.storeDir, b.sessionStateDir);
        await bStore.hydrate(sessionId);
        const bSessionDir = path.join(b.sessionStateDir, sessionId);
        expect(fs.existsSync(path.join(bSessionDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME))).toBe(true);
        for (const entry of fs.readdirSync(bSessionDir)) {
            const contents = fs.readFileSync(path.join(bSessionDir, entry), "utf-8");
            expect(contents).not.toContain("do-not-copy");
        }

        // Fresh CodexRuntimeClient on machine B: resume with restored path.
        const bTransport = createFakeCodexTransport({ thread: { id: threadId } });
        const bClient = new CodexRuntimeClient({
            codexHome: b.codexHome,
            sessionStateDir: b.sessionStateDir,
            transportFactory: () => bTransport,
        });
        await bClient.resumeSession(sessionId, { sessionId });

        const resume = bTransport.recordedRequests.find((r) => r.method === "thread/resume");
        expect(resume).toBeTruthy();
        expect(resume.params.threadId).toBe(threadId);
        expect(resume.params.path).toBe(path.join(bSessionDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME));

        await bClient.stop();
    });
});

describe("Codex checkpoint readiness (checkpoint must reject non-resumable state)", () => {
    // Helper: create a store + session dir populated with a valid
    // marker-only zero-turn session so tests can prove the first
    // checkpoint succeeds and later invalid states cannot overwrite it.
    function makeCheckpointEnv(sessionId, prefix = "codex-ckp-") {
        const env = mkTmpEnv(prefix);
        const sessionDir = path.join(env.sessionStateDir, sessionId);
        fs.mkdirSync(sessionDir, { recursive: true });
        const store = new FilesystemSessionStore(env.storeDir, env.sessionStateDir);
        return { ...env, sessionDir, store };
    }

    it("(a) rejects a second checkpoint whose codex-thread.json is corrupt and preserves the previous good archive", async () => {
        const sessionId = "ps-corrupt-marker";
        const { sessionStateDir, storeDir, sessionDir, store } = makeCheckpointEnv(sessionId, "codex-ckp-corrupt-");
        // Valid marker → first checkpoint succeeds.
        fs.writeFileSync(path.join(sessionDir, CODEX_THREAD_STATE_FILENAME), JSON.stringify({
            codexThreadId: "codex-thread-valid",
            codexHome: "/tmp/fake",
        }));
        await store.checkpoint(sessionId);
        const tarPath = path.join(storeDir, `${sessionId}.tar.gz`);
        const metaPath = path.join(storeDir, `${sessionId}.meta.json`);
        expect(fs.existsSync(tarPath)).toBe(true);
        const goodArchiveBytes = fs.readFileSync(tarPath);
        const goodMetaJson = fs.readFileSync(metaPath, "utf-8");

        // Corrupt / truncate the marker in place.
        fs.writeFileSync(path.join(sessionDir, CODEX_THREAD_STATE_FILENAME), "{not-json");
        // Second checkpoint MUST reject with the actionable message.
        await expect(store.checkpoint(sessionId)).rejects.toThrow(
            /Session state directory not ready during checkpoint/,
        );
        // Previous good archive must be intact byte-for-byte, and the
        // metadata must not have been rewritten to point at a truncated
        // archive.
        expect(fs.existsSync(tarPath)).toBe(true);
        expect(fs.readFileSync(tarPath).equals(goodArchiveBytes)).toBe(true);
        expect(fs.readFileSync(metaPath, "utf-8")).toBe(goodMetaJson);

        // Hydrating the preserved archive must restore a valid session dir.
        fs.rmSync(sessionDir, { recursive: true, force: true });
        await store.hydrate(sessionId);
        const restored = JSON.parse(fs.readFileSync(path.join(sessionDir, CODEX_THREAD_STATE_FILENAME), "utf-8"));
        expect(restored.codexThreadId).toBe("codex-thread-valid");
    });

    it("(b) rejects checkpoint and dehydrate when the marker is {} or has an empty codexThreadId", async () => {
        for (const bad of ["{}", JSON.stringify({ codexThreadId: "" }), JSON.stringify({ codexThreadId: null })]) {
            const sessionId = "ps-empty-" + Buffer.from(bad).toString("hex").slice(0, 8);
            const { sessionDir, store, storeDir } = makeCheckpointEnv(sessionId, "codex-ckp-empty-");
            fs.writeFileSync(path.join(sessionDir, CODEX_THREAD_STATE_FILENAME), bad);
            await expect(store.checkpoint(sessionId)).rejects.toThrow(
                /Session state directory not ready during checkpoint/,
            );
            await expect(store.dehydrate(sessionId, { reason: "bad" })).rejects.toThrow(
                /Session state directory not ready during dehydrate/,
            );
            // Nothing must have been archived for this session.
            expect(fs.existsSync(path.join(storeDir, `${sessionId}.tar.gz`))).toBe(false);
            expect(fs.existsSync(path.join(storeDir, `${sessionId}.meta.json`))).toBe(false);
        }
    });

    it("(c) rejects checkpoint when rolloutSnapshotRelPath points at a missing file", async () => {
        const sessionId = "ps-missing-rollout-ckp";
        const { sessionDir, store, storeDir } = makeCheckpointEnv(sessionId, "codex-ckp-miss-");
        fs.writeFileSync(path.join(sessionDir, CODEX_THREAD_STATE_FILENAME), JSON.stringify({
            codexThreadId: "codex-thread-mr",
            codexHome: "/tmp/fake",
            rolloutSnapshotRelPath: CODEX_ROLLOUT_SNAPSHOT_FILENAME,
        }));
        // Rollout file NOT written.
        await expect(store.checkpoint(sessionId)).rejects.toThrow(
            /Session state directory not ready during checkpoint/,
        );
        expect(fs.existsSync(path.join(storeDir, `${sessionId}.tar.gz`))).toBe(false);
    });

    it("(d1) rejects an absolute rolloutSnapshotRelPath and never archives", async () => {
        const sessionId = "ps-abs-rollout";
        const { sessionDir, store, storeDir } = makeCheckpointEnv(sessionId, "codex-ckp-abs-");
        // Put a real file OUTSIDE the session dir to prove the store
        // does not follow the pointer and archive foreign content.
        const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "outside-")), "leak.bin");
        fs.writeFileSync(outside, "leaked-secret-payload");
        fs.writeFileSync(path.join(sessionDir, CODEX_THREAD_STATE_FILENAME), JSON.stringify({
            codexThreadId: "codex-thread-abs",
            codexHome: "/tmp/fake",
            rolloutSnapshotRelPath: outside, // absolute
        }));
        await expect(store.checkpoint(sessionId)).rejects.toThrow(
            /Session state directory not ready during checkpoint/,
        );
        await expect(store.dehydrate(sessionId, { reason: "abs" })).rejects.toThrow(
            /Session state directory not ready during dehydrate/,
        );
        // No archive; if one were created, it would risk containing
        // the outside file.
        expect(fs.existsSync(path.join(storeDir, `${sessionId}.tar.gz`))).toBe(false);
        fs.unlinkSync(outside);
    });

    it("(d2) rejects a `../` traversal rolloutSnapshotRelPath and never archives", async () => {
        const sessionId = "ps-traverse-rollout";
        const { sessionStateDir, sessionDir, store, storeDir } = makeCheckpointEnv(sessionId, "codex-ckp-trav-");
        // Sibling file the traversal would resolve to.
        const sibling = path.join(sessionStateDir, "leak.bin");
        fs.writeFileSync(sibling, "sibling-secret");
        fs.writeFileSync(path.join(sessionDir, CODEX_THREAD_STATE_FILENAME), JSON.stringify({
            codexThreadId: "codex-thread-trav",
            codexHome: "/tmp/fake",
            rolloutSnapshotRelPath: "../leak.bin",
        }));
        await expect(store.checkpoint(sessionId)).rejects.toThrow(
            /Session state directory not ready during checkpoint/,
        );
        expect(fs.existsSync(path.join(storeDir, `${sessionId}.tar.gz`))).toBe(false);
    });

    it("(d3) rejects a symlinked rollout file so the archive never leaks foreign content", async () => {
        const sessionId = "ps-symlink-rollout";
        const { sessionStateDir, sessionDir, store, storeDir } = makeCheckpointEnv(sessionId, "codex-ckp-sym-");
        // Sibling target that a naive checker would happily accept.
        const target = path.join(sessionStateDir, "..", "target.bin");
        fs.writeFileSync(target, "external-secret");
        const link = path.join(sessionDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        try {
            fs.symlinkSync(target, link);
        } catch (err) {
            if (err.code === "EPERM") return; // symlink not permitted here, skip
            throw err;
        }
        fs.writeFileSync(path.join(sessionDir, CODEX_THREAD_STATE_FILENAME), JSON.stringify({
            codexThreadId: "codex-thread-sym",
            codexHome: "/tmp/fake",
            rolloutSnapshotRelPath: CODEX_ROLLOUT_SNAPSHOT_FILENAME,
        }));
        await expect(store.checkpoint(sessionId)).rejects.toThrow(
            /Session state directory not ready during checkpoint/,
        );
        expect(fs.existsSync(path.join(storeDir, `${sessionId}.tar.gz`))).toBe(false);
        fs.unlinkSync(target);
    });

    it("(e) accepts a valid zero-turn marker (no rolloutSnapshotRelPath) and produces a good archive", async () => {
        const sessionId = "ps-zero-turn";
        const { sessionDir, store, storeDir } = makeCheckpointEnv(sessionId, "codex-ckp-zero-");
        fs.writeFileSync(path.join(sessionDir, CODEX_THREAD_STATE_FILENAME), JSON.stringify({
            codexThreadId: "codex-thread-zero",
            codexHome: "/tmp/fake",
        }));
        await store.checkpoint(sessionId);
        const tarPath = path.join(storeDir, `${sessionId}.tar.gz`);
        const metaPath = path.join(storeDir, `${sessionId}.meta.json`);
        expect(fs.existsSync(tarPath)).toBe(true);
        expect(fs.existsSync(metaPath)).toBe(true);
        // Metadata sizeBytes matches the committed archive.
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        expect(meta.sizeBytes).toBe(fs.statSync(tarPath).size);
        // No stray temp archive left behind.
        const strayTemps = fs.readdirSync(storeDir).filter((f) => f.includes(".tmp"));
        expect(strayTemps).toEqual([]);
    });
});
