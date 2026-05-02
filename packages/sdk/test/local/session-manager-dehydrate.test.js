import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/session-manager.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function createSessionStoreMock() {
    return {
        dehydrate: vi.fn(),
        hydrate: vi.fn(async () => {}),
        checkpoint: vi.fn(async () => {}),
        exists: vi.fn(async () => false),
        delete: vi.fn(async () => {}),
        getSnapshotSizeBytes: vi.fn(async () => undefined),
    };
}

describe("SessionManager dehydrate retries", () => {
    it("retries session-store dehydration before succeeding", async () => {
        vi.useFakeTimers();
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-retry-success";
        const sessionDir = path.join(sessionStateDir, sessionId);
        try {
            fs.mkdirSync(sessionDir, { recursive: true });
            const sessionStore = createSessionStoreMock();
            sessionStore.dehydrate
                .mockRejectedValueOnce(new Error("blob timeout"))
                .mockRejectedValueOnce(new Error("socket hangup"))
                .mockResolvedValueOnce(undefined);
            const manager = new SessionManager(undefined, sessionStore, {}, sessionStateDir);

            const promise = manager.dehydrate(sessionId, "cron");
            await vi.runAllTimersAsync();
            await expect(promise).resolves.toEqual({ kind: "dehydrated", reason: "cron" });

            expect(sessionStore.dehydrate).toHaveBeenCalledTimes(3);
            expect(sessionStore.dehydrate).toHaveBeenNthCalledWith(
                1,
                sessionId,
                { reason: "cron" },
            );
        } finally {
            vi.useRealTimers();
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("bubbles the final session-store dehydration failure after retries are exhausted", async () => {
        vi.useFakeTimers();
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-retry-fail";
        const sessionDir = path.join(sessionStateDir, sessionId);
        try {
            fs.mkdirSync(sessionDir, { recursive: true });
            const sessionStore = createSessionStoreMock();
            sessionStore.dehydrate.mockRejectedValue(new Error("blob unavailable"));
            const manager = new SessionManager(undefined, sessionStore, {}, sessionStateDir);

            const failurePromise = manager.dehydrate(sessionId, "cron").catch((err) => err);
            await vi.runAllTimersAsync();
            const failure = await failurePromise;

            expect(sessionStore.dehydrate).toHaveBeenCalledTimes(3);
            expect(failure).toBeTruthy();
            expect(failure.message).toContain("after 3 attempts");
            expect(failure.message).toContain("reason=cron");
            expect(failure.sessionStoreAttemptCount).toBe(3);
            expect(failure.sessionStoreError).toBe("blob unavailable");
        } finally {
            vi.useRealTimers();
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("classifies as ghost when no in-memory + no local + store.exists() returns false", async () => {
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-ghost";
        try {
            const sessionStore = createSessionStoreMock();
            sessionStore.exists.mockResolvedValue(false);
            const manager = new SessionManager(undefined, sessionStore, {}, sessionStateDir);

            await expect(manager.dehydrate(sessionId, "cron")).resolves.toEqual({ kind: "ghost", reason: "cron" });

            expect(sessionStore.exists).toHaveBeenCalledTimes(1);
            expect(sessionStore.checkpoint).not.toHaveBeenCalled();
            expect(sessionStore.dehydrate).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("classifies as preserved-snapshot when store.exists() returns true", async () => {
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-with-prior-snapshot";
        try {
            const sessionStore = createSessionStoreMock();
            sessionStore.exists.mockResolvedValue(true);
            const manager = new SessionManager(undefined, sessionStore, {}, sessionStateDir);

            await expect(manager.dehydrate(sessionId, "cron")).resolves.toEqual({
                kind: "preserved-snapshot",
                reason: "cron",
            });

            expect(sessionStore.exists).toHaveBeenCalledTimes(1);
            expect(sessionStore.checkpoint).not.toHaveBeenCalled();
            expect(sessionStore.dehydrate).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("FAILS CLOSED: when store.exists() throws, falls through to normal dehydrate path (no silent ghost classification)", async () => {
        // Audit BLOCKER #1 + #3: a transient store probe failure must NOT be
        // converted into a silent ghost-success outcome. The guard must fall
        // through so the normal dehydrate path runs and any real durable state
        // is observed (or surfaces a loud error).
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-store-probe-fail";
        try {
            const sessionStore = createSessionStoreMock();
            sessionStore.exists.mockRejectedValue(new Error("blob storage unreachable"));
            // The store dehydrate will throw the missing-snapshot error since
            // there really are no local files — we want to verify the guard
            // does NOT swallow the probe error and the loud failure surfaces.
            sessionStore.dehydrate.mockRejectedValue(
                new Error(
                    `Session state directory not ready during dehydrate: ${sessionId}. ` +
                    `Missing: ${sessionId}/`,
                ),
            );
            const manager = new SessionManager(undefined, sessionStore, {}, sessionStateDir);

            // The guard must NOT classify as ghost — it must fall through to
            // normal dehydrate, which then throws (loud) for the missing state.
            await expect(manager.dehydrate(sessionId, "cron")).rejects.toThrow(
                /Session state directory not ready during dehydrate/,
            );

            expect(sessionStore.exists).toHaveBeenCalledTimes(1);
            expect(sessionStore.dehydrate).toHaveBeenCalled();
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("TOCTOU: re-checks predicates after store probe; falls through if state appeared mid-await", async () => {
        // Audit BLOCKER #2: the guard must re-check in-memory/local state
        // AFTER the awaited store probe, since concurrent createSession or
        // file materialization can happen during the await.
        //
        // We prove this by: (a) making the probe slow + materializing local
        // state during the await, (b) asserting the normal dehydrate path
        // ran (sessionStore.dehydrate was called) — NOT the guard's early
        // return. The outcome is "dehydrated" via the existing post-destroy
        // checkpoint fallback (the appeared state was empty, so the
        // missing-workspace.yaml fallback at line 627 covers the rest).
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-toctou";
        const sessionDir = path.join(sessionStateDir, sessionId);
        try {
            const sessionStore = createSessionStoreMock();
            sessionStore.exists.mockImplementation(async () => {
                // Concurrent actor materializes local dir during the probe.
                fs.mkdirSync(sessionDir, { recursive: true });
                return false;
            });
            // Store dehydrate fails with the missing-workspace.yaml error,
            // which the existing post-destroy checkpoint fallback handles.
            sessionStore.dehydrate.mockRejectedValue(
                new Error(
                    `Session state directory not ready during dehydrate: ${sessionId}. ` +
                    `Missing: ${sessionId}/workspace.yaml`,
                ),
            );

            const manager = new SessionManager(undefined, sessionStore, {}, sessionStateDir);
            const outcome = await manager.dehydrate(sessionId, "cron");

            // The KEY assertion for TOCTOU correctness: we entered the normal
            // dehydrate path (probe ran, store.dehydrate was called) instead
            // of returning a stale ghost classification.
            expect(sessionStore.exists).toHaveBeenCalledTimes(1);
            expect(sessionStore.checkpoint).toHaveBeenCalledTimes(1);
            expect(sessionStore.dehydrate).toHaveBeenCalled();
            // Outcome reflects normal dehydrate path (not ghost / not preserved).
            expect(outcome.kind).toBe("dehydrated");
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("classifies as ghost when no session store is configured and no local state", async () => {
        // When sessionStore is null we cannot probe for prior snapshots — the
        // session truly has nowhere to store/recover from. Without local state
        // there's nothing to dehydrate, so ghost is the correct classification.
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-no-store";
        try {
            const manager = new SessionManager(undefined, null, {}, sessionStateDir);
            await expect(manager.dehydrate(sessionId, "cron")).resolves.toEqual({
                kind: "ghost",
                reason: "cron",
            });
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("serializes concurrent dehydrate() calls for the same sessionId via per-session lock", async () => {
        // Concurrency safety: per-session lock prevents two dehydrate calls
        // from racing on the guard. With a delayed exists() probe, the second
        // call MUST wait for the first to release the lock — proven by checking
        // that the second probe didn't start until the first one resolved.
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-concurrent-dehydrate";
        try {
            const sessionStore = createSessionStoreMock();
            const probeStarts = [];
            const probeReleases = [];
            sessionStore.exists.mockImplementation(async () => {
                const myIndex = probeStarts.length;
                probeStarts.push(Date.now());
                // Second probe must NOT start until first probe completes.
                await new Promise((r) => setTimeout(r, 50));
                probeReleases.push({ index: myIndex, at: Date.now() });
                return false;
            });
            const manager = new SessionManager(undefined, sessionStore, {}, sessionStateDir);

            const [r1, r2] = await Promise.all([
                manager.dehydrate(sessionId, "cron-1"),
                manager.dehydrate(sessionId, "cron-2"),
            ]);

            expect(r1).toEqual({ kind: "ghost", reason: "cron-1" });
            expect(r2).toEqual({ kind: "ghost", reason: "cron-2" });
            // Lock proves serialization: second probe started AFTER first probe's release.
            expect(probeStarts.length).toBe(2);
            expect(probeReleases.length).toBe(2);
            // probe[1] start must be >= probe[0] release time → enforced serialization.
            expect(probeStarts[1]).toBeGreaterThanOrEqual(probeReleases[0].at);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("LIFECYCLE LOCK: serializes getOrCreate() with concurrent dehydrate() for same sessionId", async () => {
        // Audit BLOCKER #2 + HIGH #4: the lifecycle lock must serialize
        // BOTH directions — getOrCreate and dehydrate — so a concurrent
        // create cannot leave a window where dehydrate sees absence (no
        // in-memory, no local) while a session is materializing.
        //
        // Setup: a slow exists() probe gives dehydrate a window. We start
        // dehydrate first, then start getOrCreate concurrently. The lock
        // must force getOrCreate to wait until dehydrate releases.
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-lifecycle-race";
        try {
            const sessionStore = createSessionStoreMock();
            // Slow probe: 100ms simulates real Azure round-trip latency.
            sessionStore.exists.mockImplementation(async () => {
                await new Promise((r) => setTimeout(r, 100));
                return false;
            });

            const manager = new SessionManager(undefined, sessionStore, {}, sessionStateDir);

            // Track lifecycle ordering by timestamps.
            const events = [];
            const dehydratePromise = manager.dehydrate(sessionId, "cron").then(
                (o) => { events.push({ kind: "dehydrate-complete", t: Date.now(), outcome: o.kind }); return o; },
                (e) => { events.push({ kind: "dehydrate-error", t: Date.now(), msg: e?.message }); throw e; },
            );

            // Wait briefly so dehydrate actually starts and acquires the lock.
            await new Promise((r) => setTimeout(r, 10));

            // Now attempt to acquire the lock from another lifecycle call.
            const lockProbe = (async () => {
                events.push({ kind: "lock-probe-start", t: Date.now() });
                const release = await manager._acquireLifecycleLock(sessionId);
                events.push({ kind: "lock-probe-acquired", t: Date.now() });
                release();
                return "acquired";
            })();

            const [dehydrateOutcome, lockOutcome] = await Promise.all([dehydratePromise, lockProbe]);

            expect(dehydrateOutcome).toEqual({ kind: "ghost", reason: "cron" });
            expect(lockOutcome).toBe("acquired");

            // The lock probe must have been acquired AFTER dehydrate completed.
            const dehydrateCompleteAt = events.find((e) => e.kind === "dehydrate-complete").t;
            const lockAcquiredAt = events.find((e) => e.kind === "lock-probe-acquired").t;
            expect(lockAcquiredAt).toBeGreaterThanOrEqual(dehydrateCompleteAt);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("END-TO-END LIFECYCLE LOCK: real getOrCreate() waits for in-flight dehydrate() to complete", async () => {
        // Audit V2 MEDIUM: prove the lock works for the actual public API,
        // not just the private helper. We inject a mock CopilotClient so we
        // can run getOrCreate without GitHub auth, then race it against
        // dehydrate. The lock must serialize them — getOrCreate must not
        // call client.createSession() until dehydrate returns.
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-e2e-lifecycle-race";
        try {
            const sessionStore = createSessionStoreMock();
            // 100ms slow probe gives dehydrate a meaningful critical region.
            sessionStore.exists.mockImplementation(async () => {
                await new Promise((r) => setTimeout(r, 100));
                return false;
            });

            const manager = new SessionManager(undefined, sessionStore, {}, sessionStateDir);

            // Inject a fake CopilotClient + factStore so getOrCreate can run
            // without real GitHub auth.
            const events = [];
            const fakeCopilotSession = {
                sessionId,
                destroy: vi.fn(async () => {}),
            };
            const fakeClient = {
                createSession: vi.fn(async () => {
                    events.push({ kind: "create-session-called", t: Date.now() });
                    return fakeCopilotSession;
                }),
                resumeSession: vi.fn(async () => fakeCopilotSession),
                deleteSession: vi.fn(async () => {}),
                stop: vi.fn(async () => {}),
            };
            manager.client = fakeClient;
            manager.factStore = { listFacts: async () => [], getFactsByAgent: async () => [] };

            // Start dehydrate first; it acquires the lock and holds it during
            // the 100ms probe.
            const dehydratePromise = manager.dehydrate(sessionId, "cron").then((o) => {
                events.push({ kind: "dehydrate-complete", t: Date.now(), outcome: o.kind });
                return o;
            });

            // Brief delay so dehydrate has acquired the lock before getOrCreate starts.
            await new Promise((r) => setTimeout(r, 10));

            const getOrCreatePromise = manager.getOrCreate(
                sessionId,
                { toolNames: [] },
                { turnIndex: 0 },
            ).then((s) => {
                events.push({ kind: "getOrCreate-complete", t: Date.now() });
                return s;
            });

            const [dehydrateOutcome] = await Promise.all([dehydratePromise, getOrCreatePromise]);

            // Dehydrate observed an empty session, returned ghost.
            expect(dehydrateOutcome).toEqual({ kind: "ghost", reason: "cron" });
            // getOrCreate succeeded.
            expect(fakeClient.createSession).toHaveBeenCalledTimes(1);

            // PROOF: client.createSession was called AFTER dehydrate completed,
            // demonstrating the lifecycle lock serialized the two paths.
            const dehydrateCompleteAt = events.find((e) => e.kind === "dehydrate-complete").t;
            const createSessionCalledAt = events.find((e) => e.kind === "create-session-called").t;
            expect(createSessionCalledAt).toBeGreaterThanOrEqual(dehydrateCompleteAt);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("falls back to the pre-destroy checkpoint when the post-destroy snapshot never appears", async () => {
        vi.useFakeTimers();
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-session-manager-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "session-checkpoint-fallback";
        const sessionDir = path.join(sessionStateDir, sessionId);

        try {
            fs.mkdirSync(sessionDir, { recursive: true });

            const sessionStore = createSessionStoreMock();
            sessionStore.checkpoint.mockResolvedValue(undefined);
            sessionStore.dehydrate.mockRejectedValue(
                new Error(
                    `Session state directory not ready during dehydrate: ${sessionId} (${sessionDir}). ` +
                    `Missing: ${sessionId}/`,
                ),
            );

            const manager = new SessionManager(undefined, sessionStore, {}, sessionStateDir);
            manager.sessions.set(sessionId, {
                destroy: vi.fn(async () => {}),
            });

            const promise = manager.dehydrate(sessionId, "cron");
            await vi.runAllTimersAsync();
            // Outcome should still be "dehydrated" (the existing fallback
            // path archives the pre-destroy checkpoint).
            await expect(promise).resolves.toEqual({ kind: "dehydrated", reason: "cron" });

            expect(sessionStore.checkpoint).toHaveBeenCalledTimes(1);
            expect(sessionStore.checkpoint).toHaveBeenCalledWith(sessionId);
            expect(sessionStore.dehydrate).toHaveBeenCalledTimes(3);
            expect(fs.existsSync(sessionDir)).toBe(false);
        } finally {
            vi.useRealTimers();
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });
});
