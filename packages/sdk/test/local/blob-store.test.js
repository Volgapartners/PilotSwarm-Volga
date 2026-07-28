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

describe("SessionBlobStore", () => {
    it("archives the current session snapshot layout on dehydrate", async () => {
        // The post-disconnect contract: by the time we call dehydrate, the SDK
        // has either flushed durably or it never will. There is no race to
        // wait for; the directory either has the layout or it doesn't.
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-blob-store-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "current-layout-session";
        const sessionDir = path.join(sessionStateDir, sessionId);

        const store = new SessionBlobStore(makeConnectionString(), "test-container", sessionStateDir);
        const uploads = [];
        const metadataWrites = [];

        store.containerClient = {
            getBlockBlobClient(name) {
                return {
                    async uploadFile(filePath) {
                        uploads.push({ name, filePath, exists: fs.existsSync(filePath) });
                    },
                    async upload(body) {
                        metadataWrites.push({ name, body: String(body) });
                    },
                    async deleteIfExists() {},
                    async downloadToFile() {
                        throw new Error("downloadToFile should not be called in this test");
                    },
                    async exists() {
                        return true;
                    },
                    url: `https://example.test/${name}`,
                };
            },
            async *listBlobsFlat() {},
        };

        // Write the layout synchronously, the way a healthy post-disconnect
        // session directory looks on disk.
        fs.mkdirSync(path.join(sessionDir, "checkpoints"), { recursive: true });
        fs.mkdirSync(path.join(sessionDir, "files"), { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "checkpoints", "index.md"), "# checkpoint\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "files", "README.md"), "workspace file\n", "utf-8");

        try {
            await store.dehydrate(sessionId, { reason: "cron" });

            expect(uploads).toHaveLength(1);
            expect(uploads[0].name).toBe(`${sessionId}.tar.gz`);
            expect(uploads[0].exists).toBe(true);
            expect(metadataWrites).toHaveLength(1);
            expect(metadataWrites[0].name).toBe(`${sessionId}.meta.json`);
            expect(JSON.parse(metadataWrites[0].body).reason).toBe("cron");
            expect(fs.existsSync(sessionDir)).toBe(false);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("rejects when the session directory is missing the required layout", async () => {
        // Single-shot semantics: if the dir is missing or empty when dehydrate
        // is called, that's terminal — the SDK will never produce more state
        // for this session.
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-blob-store-empty-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "missing-layout-session";

        const store = new SessionBlobStore(makeConnectionString(), "test-container", sessionStateDir);
        store.containerClient = {
            getBlockBlobClient() {
                return {
                    async uploadFile() { throw new Error("uploadFile should not be called"); },
                    async upload() { throw new Error("upload should not be called"); },
                    async deleteIfExists() {},
                    async exists() { return false; },
                    url: "https://example.test/missing",
                };
            },
            async *listBlobsFlat() {},
        };

        try {
            await expect(store.dehydrate(sessionId, { reason: "cron" }))
                .rejects.toThrow(/Session state directory not ready during dehydrate/i);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("continues to accept the legacy events.jsonl snapshot layout", async () => {
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-blob-store-legacy-"));
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "legacy-session";
        const sessionDir = path.join(sessionStateDir, sessionId);

        const store = new SessionBlobStore(makeConnectionString(), "test-container", sessionStateDir);
        const uploads = [];

        store.containerClient = {
            getBlockBlobClient(name) {
                return {
                    async uploadFile(filePath) {
                        uploads.push({ name, filePath, exists: fs.existsSync(filePath) });
                    },
                    async upload() {},
                    async deleteIfExists() {},
                    async downloadToFile() {
                        throw new Error("downloadToFile should not be called in this test");
                    },
                    async exists() {
                        return true;
                    },
                    url: `https://example.test/${name}`,
                };
            },
            async *listBlobsFlat() {},
        };

        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "events.jsonl"), "{}\n", "utf-8");

        try {
            await store.dehydrate(sessionId, { reason: "legacy" });

            expect(uploads).toHaveLength(1);
            expect(uploads[0].name).toBe(`${sessionId}.tar.gz`);
            expect(fs.existsSync(sessionDir)).toBe(false);
        } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
        }
    });

    it("throws NotSupportedInManagedIdentityMode when generating a SAS URL in MI mode", () => {
        // MI-mode invariant: when the store is constructed via the
        // managed-identity factory branch (no shared-key credential),
        // generateArtifactSasUrl() must refuse with a typed error so
        // callers (TUI / portal) know to proxy the download through the
        // worker instead of relying on a shared-key SAS. This is the
        // contract the JSDoc on createSessionBlobStore() and on
        // generateArtifactSasUrl() promises; locking it in a test means
        // a future "helpful" fallback that silently mints a UDK SAS or
        // returns a public URL would break this assertion loudly.
        const fakeContainerClient = {
            getBlockBlobClient() {
                throw new Error("getBlockBlobClient should not be reached in MI-mode SAS test");
            },
            async *listBlobsFlat() {},
        };

        const store = new SessionBlobStore({
            containerClient: fakeContainerClient,
            containerName: "copilot-sessions",
            sharedKeyCredential: null,
            sessionStateDir: os.tmpdir(),
        });

        let caught;
        try {
            store.generateArtifactSasUrl("session-mi", "out.txt", 1);
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(Error);
        expect(caught.code).toBe("NotSupportedInManagedIdentityMode");
        expect(caught.message).toMatch(/managed-identity mode/i);
    });

    // ─── R5: shared session-id validation across every public method ──

    describe("(R5) session-id validation is enforced at the first line of every public method", () => {
        // Regression: SessionBlobStore did not use the shared validator.
        // A malformed sessionId (`../victim`, absolute path, cross-
        // separator, empty, `.`, `..`) reached blob-name construction,
        // `getBlockBlobClient`, log calls, local fs paths, temp tar
        // names, the `snapshotSizeBySession` map, and SAS URL minting
        // before anything raised. Every public method must reject
        // BEFORE producing any side effect.
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

        function tempDirs(prefix) {
            const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
            const sessionStateDir = path.join(baseDir, "session-state");
            fs.mkdirSync(sessionStateDir, { recursive: true });
            return { baseDir, sessionStateDir };
        }

        function makeSpyContainerClient(recorder) {
            const spy = {
                calls: recorder,
                getBlockBlobClient(name) {
                    recorder.push({ op: "getBlockBlobClient", name });
                    return new Proxy({}, {
                        get(_target, prop) {
                            return async (...args) => {
                                recorder.push({ op: `blob.${String(prop)}`, name, args });
                                if (prop === "exists") return false;
                                if (prop === "deleteIfExists") return { succeeded: false };
                                if (prop === "downloadToFile") return;
                                if (prop === "download") throw new Error("mock download not implemented");
                                if (prop === "getProperties") throw new Error("mock getProperties not implemented");
                                return;
                            };
                        },
                    });
                },
                async *listBlobsFlat(...args) {
                    recorder.push({ op: "listBlobsFlat", args });
                },
            };
            return spy;
        }

        function captureConsole(recorder) {
            const original = {
                info: console.info,
                warn: console.warn,
                error: console.error,
            };
            console.info = (...args) => { recorder.push({ level: "info", args }); };
            console.warn = (...args) => { recorder.push({ level: "warn", args }); };
            console.error = (...args) => { recorder.push({ level: "error", args }); };
            return () => {
                console.info = original.info;
                console.warn = original.warn;
                console.error = original.error;
            };
        }

        // Every public method that accepts a sessionId as the first arg.
        // Some methods also take a filename; we pass a benign one so
        // the sessionId is the ONLY unsafe input.
        const METHODS = [
            { name: "dehydrate", invoke: (s, id) => s.dehydrate(id, { reason: "r5" }) },
            { name: "hydrate", invoke: (s, id) => s.hydrate(id) },
            { name: "checkpoint", invoke: (s, id) => s.checkpoint(id) },
            { name: "getSnapshotSizeBytes", invoke: (s, id) => s.getSnapshotSizeBytes(id) },
            { name: "exists", invoke: (s, id) => s.exists(id) },
            { name: "delete", invoke: (s, id) => s.delete(id) },
            { name: "uploadArtifact", invoke: (s, id) => s.uploadArtifact(id, "note.md", "hello", "text/markdown") },
            { name: "downloadArtifact", invoke: (s, id) => s.downloadArtifact(id, "note.md") },
            { name: "downloadArtifactText", invoke: (s, id) => s.downloadArtifactText(id, "note.md") },
            { name: "listArtifacts", invoke: (s, id) => s.listArtifacts(id) },
            { name: "deleteArtifact", invoke: (s, id) => s.deleteArtifact(id, "note.md") },
            { name: "artifactExists", invoke: (s, id) => s.artifactExists(id, "note.md") },
            {
                name: "generateArtifactSasUrl",
                invoke: (s, id) => Promise.resolve().then(() => s.generateArtifactSasUrl(id, "note.md", 1)),
            },
            { name: "deleteArtifacts", invoke: (s, id) => s.deleteArtifacts(id) },
        ];

        for (const method of METHODS) {
            it(`${method.name} rejects unsafe session ids before any container client, log, or local fs side effect`, async () => {
                const { baseDir, sessionStateDir } = tempDirs(`pilotswarm-r5-${method.name}-`);
                // Sentinel that would be created if hydrate/dehydrate
                // ever touched a `../` path relative to sessionStateDir.
                // Put it in an INDEPENDENT tmpdir so `rmSync(baseDir)`
                // never cleans it up out from under our assertion.
                const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-r5-victim-"));
                const outsideVictim = path.join(outsideDir, "victim-sentinel.txt");
                fs.writeFileSync(outsideVictim, "R5-OUTSIDE-KEEP");

                const clientCalls = [];
                const containerClient = makeSpyContainerClient(clientCalls);
                const store = new SessionBlobStore(makeConnectionString(), "test-container", sessionStateDir);
                store.containerClient = containerClient;

                const logCalls = [];
                const restoreConsole = captureConsole(logCalls);

                try {
                    for (const bad of UNSAFE_IDS) {
                        const settled = await method.invoke(store, bad).then(
                            (value) => ({ kind: "resolved", value }),
                            (err) => ({ kind: "rejected", err }),
                        );
                        expect(settled.kind).toBe("rejected");
                        expect(String(settled.err?.message || "")).toMatch(/^Invalid PilotSwarm session id/);
                    }
                } finally {
                    restoreConsole();
                }

                // Zero container client / listBlobsFlat activity.
                expect(clientCalls).toEqual([]);
                // Zero log output — a rejection before logBlobStore ran.
                expect(logCalls).toEqual([]);
                // snapshotSizeBySession map untouched.
                expect(store.snapshotSizeBySession.size).toBe(0);
                // Outside sentinel intact.
                expect(fs.readFileSync(outsideVictim, "utf-8")).toBe("R5-OUTSIDE-KEEP");

                fs.rmSync(baseDir, { recursive: true, force: true });
                fs.rmSync(outsideDir, { recursive: true, force: true });
            });
        }

        it("normal UUID-like session ids still succeed end-to-end (dehydrate + exists + delete)", async () => {
            const { baseDir, sessionStateDir } = tempDirs("pilotswarm-r5-good-");
            const sid = "019dcfc8-cafe-7133-a002-45ec3742e777";
            const sessionDir = path.join(sessionStateDir, sid);
            fs.mkdirSync(path.join(sessionDir, "checkpoints"), { recursive: true });
            fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");

            const uploads = [];
            const store = new SessionBlobStore(makeConnectionString(), "test-container", sessionStateDir);
            store.containerClient = {
                getBlockBlobClient(name) {
                    return {
                        async uploadFile(filePath) { uploads.push({ name, filePath }); },
                        async upload() {},
                        async deleteIfExists() { return { succeeded: true }; },
                        async exists() { return true; },
                        async downloadToFile() {},
                        url: `https://example.test/${name}`,
                    };
                },
                async *listBlobsFlat() {},
            };

            await store.dehydrate(sid, { reason: "r5-happy" });
            expect(uploads.map((u) => u.name)).toContain(`${sid}.tar.gz`);
            expect(await store.exists(sid)).toBe(true);
            await store.delete(sid);
            fs.rmSync(baseDir, { recursive: true, force: true });
        });

        it("blob name construction never receives a malformed session id (guard against traversal in `${sessionId}.tar.gz` blob name)", async () => {
            // Belt-and-braces: even if a future refactor moved
            // validation into a helper called AFTER blob name
            // interpolation, this test still catches the leak by
            // proving `getBlockBlobClient` is never invoked with any
            // string containing the malformed id.
            const { baseDir, sessionStateDir } = tempDirs("pilotswarm-r5-blobname-");
            const clientCalls = [];
            const containerClient = makeSpyContainerClient(clientCalls);
            const store = new SessionBlobStore(makeConnectionString(), "test-container", sessionStateDir);
            store.containerClient = containerClient;

            for (const bad of UNSAFE_IDS) {
                await expect(store.exists(bad)).rejects.toThrow(/^Invalid PilotSwarm session id/);
                await expect(store.delete(bad)).rejects.toThrow(/^Invalid PilotSwarm session id/);
                await expect(store.getSnapshotSizeBytes(bad)).rejects.toThrow(/^Invalid PilotSwarm session id/);
            }

            for (const call of clientCalls) {
                if (call.op === "getBlockBlobClient") {
                    for (const bad of UNSAFE_IDS) {
                        expect(call.name).not.toContain(bad);
                    }
                }
            }
            fs.rmSync(baseDir, { recursive: true, force: true });
        });
    });
});
