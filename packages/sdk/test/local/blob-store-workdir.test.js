/**
 * SessionBlobStore archive staging paths.
 *
 * `dehydrate()` and `checkpoint()` staged the session tarball at
 * `os.tmpdir()/<sessionId>.tar.gz` — a fully predictable path in a
 * world-writable directory. Two concrete failures:
 *
 *   1. On a shared host any local user can pre-create that path (or a
 *      symlink pointing at it) and have PilotSwarm write the session
 *      archive through it, or read the staged archive before cleanup.
 *   2. Two concurrent operations on the same session (a periodic
 *      checkpoint racing a dehydrate) collide on the same staging file,
 *      so one uploads a half-written archive and the `finally` block of
 *      the loser unlinks the winner's file.
 *
 * Contract enforced here: every archive operation stages inside its own
 * `mkdtemp` directory (mode 0700) under the PilotSwarm-owned session
 * state root, at an unpredictable path, and removes it recursively when
 * done. Nothing is ever written to `os.tmpdir()/<sessionId>.tar.gz`.
 *
 * Run: npx vitest run test/local/blob-store-workdir.test.js
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionBlobStore } from "../../src/blob-store.ts";

function makeConnectionString() {
    const accountKey = Buffer.from("pilotswarm-test-key").toString("base64");
    return [
        "DefaultEndpointsProtocol=https",
        "AccountName=pilotswarmtest",
        `AccountKey=${accountKey}`,
        "EndpointSuffix=core.windows.net",
    ].join(";");
}

function seedReadyCodexSession(sessionStateDir, sessionId) {
    const dir = path.join(sessionStateDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, "codex-thread.json"),
        JSON.stringify({ codexThreadId: `thread-${sessionId}` }),
        { mode: 0o600 },
    );
    return dir;
}

function stubContainerClient(store, onUpload) {
    const uploads = [];
    store.containerClient = {
        getBlockBlobClient(name) {
            return {
                async uploadFile(filePath) {
                    uploads.push({
                        name,
                        filePath,
                        exists: fs.existsSync(filePath),
                        sizeBytes: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
                        dirMode: fs.existsSync(path.dirname(filePath))
                            ? fs.statSync(path.dirname(filePath)).mode & 0o777
                            : null,
                    });
                    if (onUpload) await onUpload(filePath);
                },
                async upload() {},
                async deleteIfExists() {},
                async exists() { return true; },
                url: `https://example.test/${name}`,
            };
        },
    };
    return uploads;
}

describe("SessionBlobStore archive staging", () => {
    it("never writes through a pre-planted os.tmpdir()/<sessionId>.tar.gz symlink", async () => {
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-blob-canary-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "blob-tmp-canary";
        seedReadyCodexSession(sessionStateDir, sessionId);

        // Attacker-controlled canary: a symlink at the exact legacy
        // staging path pointing at a file the archive must never touch.
        const canaryTarget = path.join(baseDir, "canary.txt");
        const canaryContents = "CANARY-MUST-NOT-BE-OVERWRITTEN";
        fs.writeFileSync(canaryTarget, canaryContents);
        const legacyStagePath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);
        try { fs.rmSync(legacyStagePath, { force: true }); } catch {}
        fs.symlinkSync(canaryTarget, legacyStagePath);

        const store = new SessionBlobStore(makeConnectionString(), "test-container", sessionStateDir);
        const uploads = stubContainerClient(store);

        try {
            await store.checkpoint(sessionId);

            expect(uploads).toHaveLength(1);
            expect(uploads[0].exists).toBe(true);
            expect(uploads[0].filePath).not.toBe(legacyStagePath);
            expect(uploads[0].filePath.startsWith(`${sessionStateDir}${path.sep}`)).toBe(true);
            expect(uploads[0].dirMode).toBe(0o700);

            // Canary untouched: still a symlink, target contents intact.
            expect(fs.lstatSync(legacyStagePath).isSymbolicLink()).toBe(true);
            expect(fs.readFileSync(canaryTarget, "utf-8")).toBe(canaryContents);

            // Staging directory removed recursively.
            const residue = fs.readdirSync(sessionStateDir).filter((name) => name !== sessionId);
            expect(residue).toEqual([]);
        } finally {
            try { fs.unlinkSync(legacyStagePath); } catch {}
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    }, 15_000);

    it("dehydrate stages outside os.tmpdir() and leaves no residue", async () => {
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-blob-dehydrate-path-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "blob-dehydrate-path";
        seedReadyCodexSession(sessionStateDir, sessionId);

        const legacyStagePath = path.join(os.tmpdir(), `${sessionId}.tar.gz`);
        try { fs.rmSync(legacyStagePath, { force: true }); } catch {}

        const store = new SessionBlobStore(makeConnectionString(), "test-container", sessionStateDir);
        const uploads = stubContainerClient(store);

        try {
            await store.dehydrate(sessionId, { reason: "test" });

            const tarUpload = uploads.find((entry) => entry.name.endsWith(".tar.gz"));
            expect(tarUpload).toBeTruthy();
            expect(tarUpload.exists).toBe(true);
            expect(tarUpload.filePath).not.toBe(legacyStagePath);
            expect(tarUpload.filePath.startsWith(`${sessionStateDir}${path.sep}`)).toBe(true);
            expect(tarUpload.dirMode).toBe(0o700);
            expect(fs.existsSync(legacyStagePath)).toBe(false);

            // dehydrate removes the live session dir; nothing else must remain.
            expect(fs.readdirSync(sessionStateDir)).toEqual([]);
        } finally {
            try { fs.unlinkSync(legacyStagePath); } catch {}
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    }, 15_000);

    it("concurrent checkpoint + dehydrate for the same session stage at distinct valid paths", async () => {
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-blob-concurrent-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "blob-concurrent";
        seedReadyCodexSession(sessionStateDir, sessionId);

        const store = new SessionBlobStore(makeConnectionString(), "test-container", sessionStateDir);
        let release;
        const bothStaged = new Promise((resolve) => { release = resolve; });
        const staged = [];
        const uploads = stubContainerClient(store, async (filePath) => {
            staged.push({
                filePath,
                sizeBytes: fs.statSync(filePath).size,
                stillPresent: fs.existsSync(filePath),
            });
            if (staged.length >= 2) release();
            // Hold both operations at the upload boundary so their
            // staging files must coexist.
            await Promise.race([bothStaged, new Promise((r) => setTimeout(r, 3_000))]);
        });

        try {
            const [checkpointResult, dehydrateResult] = await Promise.allSettled([
                store.checkpoint(sessionId),
                store.dehydrate(sessionId, { reason: "concurrent" }),
            ]);
            expect(checkpointResult.status).toBe("fulfilled");
            expect(dehydrateResult.status).toBe("fulfilled");

            const tarStages = uploads.filter((entry) => entry.name.endsWith(".tar.gz"));
            expect(tarStages).toHaveLength(2);
            expect(tarStages[0].filePath).not.toBe(tarStages[1].filePath);
            for (const entry of tarStages) {
                expect(entry.exists).toBe(true);
                expect(entry.sizeBytes).toBeGreaterThan(0);
                expect(entry.filePath.startsWith(`${sessionStateDir}${path.sep}`)).toBe(true);
                expect(entry.dirMode).toBe(0o700);
            }
            // Both staging files were simultaneously live and non-empty.
            expect(staged).toHaveLength(2);
            for (const entry of staged) {
                expect(entry.stillPresent).toBe(true);
                expect(entry.sizeBytes).toBeGreaterThan(0);
            }

            // No staging residue left behind by either operation.
            const residue = fs.readdirSync(sessionStateDir).filter((name) => name !== sessionId);
            expect(residue).toEqual([]);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    }, 20_000);
});
