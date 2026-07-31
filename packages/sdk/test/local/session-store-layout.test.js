import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemSessionStore, waitForSessionSnapshot } from "../../src/session-store.ts";

const cleanupDirs = new Set();

function makeTempDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanupDirs.add(dir);
    return dir;
}

function writeTarString(header, offset, length, value) {
    Buffer.from(value).copy(header, offset, 0, length);
}

function writeTarOctal(header, offset, length, value) {
    writeTarString(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function writeTarGz(archivePath, entries) {
    const blocks = [];
    for (const entry of entries) {
        const data = Buffer.from(entry.content ?? "");
        const type = entry.type ?? "0";
        const header = Buffer.alloc(512);
        writeTarString(header, 0, 100, entry.name);
        writeTarOctal(header, 100, 8, type === "5" ? 0o755 : 0o600);
        writeTarOctal(header, 108, 8, 0);
        writeTarOctal(header, 116, 8, 0);
        writeTarOctal(header, 124, 12, type === "0" ? data.length : 0);
        writeTarOctal(header, 136, 12, 0);
        header.fill(0x20, 148, 156);
        header[156] = type.charCodeAt(0);
        if (entry.linkname) writeTarString(header, 157, 100, entry.linkname);
        writeTarString(header, 257, 6, "ustar\0");
        writeTarString(header, 263, 2, "00");
        writeTarString(header, 265, 32, "pilotswarm");
        writeTarString(header, 297, 32, "pilotswarm");
        const checksum = header.reduce((sum, byte) => sum + byte, 0);
        writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
        blocks.push(header);
        if (type === "0" && data.length > 0) {
            blocks.push(data);
            const padding = (512 - (data.length % 512)) % 512;
            if (padding) blocks.push(Buffer.alloc(padding));
        }
    }
    blocks.push(Buffer.alloc(1024));
    fs.writeFileSync(archivePath, zlib.gzipSync(Buffer.concat(blocks)));
}

afterEach(() => {
    for (const dir of cleanupDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
        cleanupDirs.delete(dir);
    }
});

describe("session-store snapshot layout", () => {
    it("accepts the current workspace/checkpoints/files layout without events.jsonl", async () => {
        const baseDir = makeTempDir("pilotswarm-session-store-");
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "current-layout";
        const sessionDir = path.join(sessionStateDir, sessionId);

        fs.mkdirSync(path.join(sessionDir, "checkpoints"), { recursive: true });
        fs.mkdirSync(path.join(sessionDir, "files"), { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "checkpoints", "index.md"), "# checkpoint\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "files", "notes.md"), "artifact\n", "utf-8");

        await expect(waitForSessionSnapshot(sessionStateDir, sessionId, 500, 20, 2)).resolves.toEqual({
            ready: true,
            missing: [],
        });
    });

    it("ignores inuse lock churn while waiting for a stable snapshot", async () => {
        const baseDir = makeTempDir("pilotswarm-session-store-locks-");
        const sessionStateDir = path.join(baseDir, "session-state");
        const sessionId = "lock-churn";
        const sessionDir = path.join(sessionStateDir, sessionId);
        const lockPath = path.join(sessionDir, "inuse.worker.lock");

        fs.mkdirSync(path.join(sessionDir, "checkpoints"), { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "checkpoints", "index.md"), "# checkpoint\n", "utf-8");

        const interval = setInterval(() => {
            fs.writeFileSync(lockPath, String(Date.now()), "utf-8");
        }, 10);

        try {
            await expect(waitForSessionSnapshot(sessionStateDir, sessionId, 1_000, 20, 2)).resolves.toEqual({
                ready: true,
                missing: [],
            });
        } finally {
            clearInterval(interval);
        }
    });

    it("archives the current layout through FilesystemSessionStore dehydrate", async () => {
        const baseDir = makeTempDir("pilotswarm-fs-store-");
        const sessionStateDir = path.join(baseDir, "session-state");
        const storeDir = path.join(baseDir, "session-store");
        const sessionId = "filesystem-layout";
        const sessionDir = path.join(sessionStateDir, sessionId);
        const store = new FilesystemSessionStore(storeDir, sessionStateDir);

        fs.mkdirSync(path.join(sessionDir, "research"), { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "research", "report.md"), "hello\n", "utf-8");

        await store.dehydrate(sessionId, { reason: "test" });

        expect(fs.existsSync(path.join(storeDir, `${sessionId}.tar.gz`))).toBe(true);
        expect(fs.existsSync(path.join(storeDir, `${sessionId}.meta.json`))).toBe(true);
        expect(fs.existsSync(sessionDir)).toBe(false);
    });

    describe("(R4-D1b) FilesystemSessionStore session-id validation", () => {
        // Regression: every public store method used to accept arbitrary
        // sessionId strings and `path.join` them under storeDir /
        // sessionStateDir. `../victim`, absolute paths, and paths
        // containing `/` or `\` all let a caller escape the store roots
        // and delete/overwrite arbitrary tarballs. The shared validator
        // must reject every unsafe form before any FS touch.
        const BAD_IDS = ["../victim", "..\\victim", "a/b", "a\\b", ".", "..", ""];

        function seedVictims(rootDir) {
            const parent = path.dirname(rootDir);
            const tar = path.join(parent, "victim.tar.gz");
            const meta = path.join(parent, "victim.meta.json");
            fs.writeFileSync(tar, "R4-D1B-TAR-SENTINEL");
            fs.writeFileSync(meta, "R4-D1B-META-SENTINEL");
            return { tar, meta };
        }

        it("exists / delete / hydrate / checkpoint / dehydrate / getSnapshotSizeBytes all reject unsafe ids and cannot access outside sentinels", async () => {
            const baseDir = makeTempDir("pilotswarm-r4-d1b-store-");
            const storeDir = path.join(baseDir, "store");
            const stateDir = path.join(baseDir, "state");
            fs.mkdirSync(storeDir, { recursive: true });
            fs.mkdirSync(stateDir, { recursive: true });
            const store = new FilesystemSessionStore(storeDir, stateDir);
            const victimStore = seedVictims(storeDir);
            const victimState = seedVictims(stateDir);

            const badIds = [
                ...BAD_IDS,
                path.join(path.dirname(storeDir), "absolute-victim"),
            ];

            for (const bad of badIds) {
                await expect(store.exists(bad)).rejects.toThrow(/Invalid PilotSwarm session id/);
                await expect(store.delete(bad)).rejects.toThrow(/Invalid PilotSwarm session id/);
                await expect(store.hydrate(bad)).rejects.toThrow(/Invalid PilotSwarm session id/);
                await expect(store.checkpoint(bad)).rejects.toThrow(/Invalid PilotSwarm session id/);
                await expect(store.dehydrate(bad, { reason: "x" })).rejects.toThrow(/Invalid PilotSwarm session id/);
                await expect(store.getSnapshotSizeBytes(bad)).rejects.toThrow(/Invalid PilotSwarm session id/);
            }

            // Sentinels above and outside the roots remain intact.
            expect(fs.readFileSync(victimStore.tar, "utf-8")).toBe("R4-D1B-TAR-SENTINEL");
            expect(fs.readFileSync(victimStore.meta, "utf-8")).toBe("R4-D1B-META-SENTINEL");
            expect(fs.readFileSync(victimState.tar, "utf-8")).toBe("R4-D1B-TAR-SENTINEL");
            expect(fs.readFileSync(victimState.meta, "utf-8")).toBe("R4-D1B-META-SENTINEL");
        });

        it("UUID-shaped and hyphen-alnum session ids remain accepted end-to-end", async () => {
            const baseDir = makeTempDir("pilotswarm-r4-d1b-good-");
            const storeDir = path.join(baseDir, "store");
            const stateDir = path.join(baseDir, "state");
            fs.mkdirSync(storeDir, { recursive: true });
            fs.mkdirSync(stateDir, { recursive: true });
            const store = new FilesystemSessionStore(storeDir, stateDir);

            const goodIds = ["019dcfc8-cafe-7133-a002-45ec3742e999", "ps-abc-1", "ANSWER-42"];
            for (const id of goodIds) {
                const sessionDir = path.join(stateDir, id);
                fs.mkdirSync(sessionDir, { recursive: true });
                fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");
                await store.dehydrate(id, { reason: "r4-good" });
                expect(await store.exists(id)).toBe(true);
                await store.delete(id);
                expect(await store.exists(id)).toBe(false);
            }
        });
    });
});

describe("(R4-D2) session-store tar helpers must not use the shell", () => {
    it("checkpoint / hydrate work when sessionStateDir and storeDir contain spaces and single quotes", async () => {
        // Regression: `execSync("tar ... \"${tarPath}\" -C \"${sessionStateDir}\" \"${sessionId}\"")`
        // would break (or execute injected shell) as soon as any of
        // those interpolated paths carried a space, quote, `$`,
        // backtick, or `;`. Real customer paths often contain spaces
        // (e.g. macOS `~/Library/Application Support/...`), so the
        // helper MUST use argv-based execution with no shell.
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-r4-d2-"));
        cleanupDirs.add(rootDir);
        // Deliberately awkward path: spaces AND a single quote AND `$(...)`.
        const awkwardParent = path.join(rootDir, "with spaces 'quotes' $(and) dollars");
        const stateDir = path.join(awkwardParent, "state");
        const storeDir = path.join(awkwardParent, "store");
        fs.mkdirSync(stateDir, { recursive: true });
        fs.mkdirSync(storeDir, { recursive: true });
        const store = new FilesystemSessionStore(storeDir, stateDir);

        const sid = "r4-d2-good-session";
        const sessionDir = path.join(stateDir, sid);
        fs.mkdirSync(path.join(sessionDir, "checkpoints"), { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");
        fs.writeFileSync(path.join(sessionDir, "checkpoints", "notes.md"), "R4-D2-CHECKPOINT-DATA", "utf-8");

        // Sentinel that would be created if a shell interpreted the
        // path substitution. Nothing must write here.
        const shellSentinel = path.join(rootDir, "shell-injection-sentinel.txt");

        // Checkpoint through the awkward path.
        await store.checkpoint(sid);
        expect(fs.existsSync(path.join(storeDir, `${sid}.tar.gz`))).toBe(true);
        expect(fs.existsSync(shellSentinel)).toBe(false);

        // Wipe live dir, then hydrate through the same awkward paths.
        fs.rmSync(sessionDir, { recursive: true, force: true });
        await store.hydrate(sid);
        expect(fs.readFileSync(path.join(sessionDir, "workspace.yaml"), "utf-8")).toBe("cwd: /tmp\n");
        expect(fs.readFileSync(path.join(sessionDir, "checkpoints", "notes.md"), "utf-8")).toBe("R4-D2-CHECKPOINT-DATA");
        expect(fs.existsSync(shellSentinel)).toBe(false);
    });

    it("dehydrate handles a valid single-segment session id containing shell metacharacters as bytes, never as shell syntax", async () => {
        // The validator permits any single path segment (no `/` or
        // `\`), but that segment can still contain shell metacharacters
        // that WOULD have executed under `execSync`. Exercising these
        // proves the helper runs `tar` through `execFileSync` (argv,
        // no shell) rather than a `sh -c` string.
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-r4-d2-metachars-"));
        cleanupDirs.add(rootDir);
        const stateDir = path.join(rootDir, "state");
        const storeDir = path.join(rootDir, "store");
        fs.mkdirSync(stateDir, { recursive: true });
        fs.mkdirSync(storeDir, { recursive: true });
        const store = new FilesystemSessionStore(storeDir, stateDir);

        // A sentinel a shell would create if `$(...)` were expanded.
        // Keep it inside the test root so the assertion can't hit a
        // pre-existing file elsewhere on the host.
        const shellSentinel = path.join(rootDir, "pwned-sentinel.txt");
        // Single-segment id (no `/`, no `\`) but full of shell noise:
        // `$IFS`, backticks, single quotes, semicolons, `&&`, `|`.
        const sid = "sess $(touch " + shellSentinel.replace(/\//g, "\u2044") + "); echo 'x' && true";
        // NOTE: We escape `/` above only so the ID stays a single path
        // segment for the validator. That means the injected shell
        // fragment references a non-existent path — but a shell would
        // STILL try to `touch` the path if the argv wasn't literal, and
        // the resulting failure (or side-effect elsewhere) would show
        // up in `tar` output. The definitive proof is that dehydrate
        // completes normally and no sentinel file appears.
        const sessionDir = path.join(stateDir, sid);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "workspace.yaml"), "cwd: /tmp\n", "utf-8");

        await store.dehydrate(sid, { reason: "r4-d2" });
        expect(fs.existsSync(path.join(storeDir, `${sid}.tar.gz`))).toBe(true);
        expect(fs.existsSync(shellSentinel)).toBe(false);
    });
});

describe("session-store archive extraction safety", () => {
    it("rejects an archive with a sibling top-level root without overwriting either live directory", async () => {
        const baseDir = makeTempDir("pilotswarm-archive-roots-");
        const stateDir = path.join(baseDir, "state");
        const storeDir = path.join(baseDir, "store");
        const sid = "attacker";
        const victimDir = path.join(stateDir, "victim");
        const attackerDir = path.join(stateDir, sid);
        fs.mkdirSync(victimDir, { recursive: true });
        fs.mkdirSync(attackerDir, { recursive: true });
        fs.writeFileSync(path.join(victimDir, "state"), "VICTIM-KEEP");
        fs.writeFileSync(path.join(attackerDir, "state"), "ATTACKER-OLD-KEEP");
        fs.mkdirSync(storeDir, { recursive: true });
        writeTarGz(path.join(storeDir, `${sid}.tar.gz`), [
            { name: `${sid}/`, type: "5" },
            { name: `${sid}/state`, content: "ATTACKER-NEW" },
            { name: "victim/", type: "5" },
            { name: "victim/state", content: "VICTIM-PWNED" },
        ]);
        const store = new FilesystemSessionStore(storeDir, stateDir);

        await expect(store.hydrate(sid)).rejects.toThrow(/archive|root|entry/i);

        expect(fs.readFileSync(path.join(victimDir, "state"), "utf-8")).toBe("VICTIM-KEEP");
        expect(fs.readFileSync(path.join(attackerDir, "state"), "utf-8")).toBe("ATTACKER-OLD-KEEP");
        expect(fs.readdirSync(stateDir).filter((name) => name.startsWith(".hydrate-"))).toEqual([]);
    });

    for (const attack of [
        {
            name: "path traversal",
            entries: (sid) => [
                { name: `${sid}/`, type: "5" },
                { name: `${sid}/../victim-state`, content: "PWNED" },
            ],
        },
        {
            name: "symbolic link",
            entries: (sid) => [
                { name: `${sid}/`, type: "5" },
                { name: `${sid}/link`, type: "2", linkname: "../victim-state" },
            ],
        },
        {
            name: "hard link",
            entries: (sid) => [
                { name: `${sid}/`, type: "5" },
                { name: `${sid}/data`, content: "safe" },
                { name: `${sid}/copy`, type: "1", linkname: `${sid}/data` },
            ],
        },
    ]) {
        it(`rejects ${attack.name} entries and leaves no staging residue`, async () => {
            const baseDir = makeTempDir(`pilotswarm-archive-${attack.name.replace(/\s+/g, "-")}-`);
            const stateDir = path.join(baseDir, "state");
            const storeDir = path.join(baseDir, "store");
            const sid = "safe-session";
            fs.mkdirSync(storeDir, { recursive: true });
            fs.mkdirSync(path.join(stateDir, sid), { recursive: true });
            fs.writeFileSync(path.join(stateDir, sid, "state"), "OLD-KEEP");
            fs.writeFileSync(path.join(stateDir, "victim-state"), "VICTIM-KEEP");
            writeTarGz(path.join(storeDir, `${sid}.tar.gz`), attack.entries(sid));
            const store = new FilesystemSessionStore(storeDir, stateDir);

            await expect(store.hydrate(sid)).rejects.toThrow(/archive|traversal|link|entry/i);

            expect(fs.readFileSync(path.join(stateDir, sid, "state"), "utf-8")).toBe("OLD-KEEP");
            expect(fs.readFileSync(path.join(stateDir, "victim-state"), "utf-8")).toBe("VICTIM-KEEP");
            expect(fs.readdirSync(stateDir).filter((name) => name.startsWith(".hydrate-"))).toEqual([]);
        });
    }

    it("hydrates a valid single-root archive through the staged replacement path", async () => {
        const baseDir = makeTempDir("pilotswarm-archive-valid-");
        const stateDir = path.join(baseDir, "state");
        const storeDir = path.join(baseDir, "store");
        const sid = "valid-session";
        fs.mkdirSync(storeDir, { recursive: true });
        fs.mkdirSync(path.join(stateDir, sid), { recursive: true });
        fs.writeFileSync(path.join(stateDir, sid, "old"), "OLD");
        writeTarGz(path.join(storeDir, `${sid}.tar.gz`), [
            { name: `${sid}/`, type: "5" },
            { name: `${sid}/codex-thread.json`, content: '{"codexThreadId":"thread-valid"}' },
        ]);
        const store = new FilesystemSessionStore(storeDir, stateDir);

        await store.hydrate(sid);

        expect(fs.existsSync(path.join(stateDir, sid, "old"))).toBe(false);
        expect(JSON.parse(fs.readFileSync(path.join(stateDir, sid, "codex-thread.json"), "utf-8")))
            .toEqual({ codexThreadId: "thread-valid" });
        expect(fs.readdirSync(stateDir).filter((name) => name.startsWith(".hydrate-"))).toEqual([]);
    });
});

describe("(R6) FilesystemArtifactStore session-id validation", () => {
    // Regression: every public FilesystemArtifactStore method used to
    // interpolate `sessionId` directly into `path.join(artifactDir, …)`
    // and its callers (`safePath`, `metadataPath`) never applied the
    // shared validator. A malformed id (`../victim`, absolute path,
    // cross-separator, `.`, `..`, empty) let a caller read/write/rm
    // arbitrary paths outside `artifactDir` — a local-disk equivalent
    // of the SessionBlobStore leak we already closed.
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

    function makeStore(prefix) {
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        cleanupDirs.add(artifactDir);
        return { artifactDir };
    }

    async function importFsArtifactStore() {
        // Lazy import so it lives right next to its usages in the test.
        const mod = await import("../../src/session-store.ts");
        return mod.FilesystemArtifactStore;
    }

    // Every public method that accepts a sessionId as the first arg.
    // For those that also take a filename, we pass a benign one so
    // the sessionId is the ONLY unsafe input.
    const METHODS = [
        { name: "uploadArtifact", invoke: (s, id) => s.uploadArtifact(id, "note.md", "hello", "text/markdown") },
        { name: "downloadArtifact", invoke: (s, id) => s.downloadArtifact(id, "note.md") },
        { name: "downloadArtifactText", invoke: (s, id) => s.downloadArtifactText(id, "note.md") },
        { name: "listArtifacts", invoke: (s, id) => s.listArtifacts(id) },
        { name: "deleteArtifact", invoke: (s, id) => s.deleteArtifact(id, "note.md") },
        { name: "artifactExists", invoke: (s, id) => s.artifactExists(id, "note.md") },
    ];

    for (const method of METHODS) {
        it(`${method.name} rejects unsafe session ids before any local fs read/write`, async () => {
            const FilesystemArtifactStore = await importFsArtifactStore();
            const { artifactDir } = makeStore(`pilotswarm-r6-${method.name}-`);
            // Independent tmpdir so `cleanupDirs` sweep does not remove
            // the sentinels out from under our assertion.
            const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-r6-victim-"));
            cleanupDirs.add(outsideDir);
            const outsideVictim = path.join(outsideDir, "victim-sentinel.txt");
            fs.writeFileSync(outsideVictim, "R6-OUTSIDE-KEEP");
            // Sibling-prefix sentinel: same immediate parent as
            // artifactDir, name starting with a prefix that could be
            // reached via `../<something>`. Prove those stay intact too.
            const siblingDir = path.dirname(artifactDir);
            const siblingVictim = path.join(siblingDir, `${path.basename(artifactDir)}-sibling-KEEP.txt`);
            fs.writeFileSync(siblingVictim, "R6-SIBLING-KEEP");

            const store = new FilesystemArtifactStore(artifactDir);
            // Snapshot artifactDir contents so we can prove nothing new
            // was written under a malformed id.
            const beforeEntries = new Set(fs.readdirSync(artifactDir));

            for (const bad of UNSAFE_IDS) {
                const settled = await method.invoke(store, bad).then(
                    (value) => ({ kind: "resolved", value }),
                    (err) => ({ kind: "rejected", err }),
                );
                expect(settled.kind).toBe("rejected");
                expect(String(settled.err?.message || "")).toMatch(/^Invalid PilotSwarm session id/);
            }

            // artifactDir contents unchanged.
            const afterEntries = new Set(fs.readdirSync(artifactDir));
            expect(afterEntries).toEqual(beforeEntries);
            // Both outside sentinels intact.
            expect(fs.readFileSync(outsideVictim, "utf-8")).toBe("R6-OUTSIDE-KEEP");
            expect(fs.readFileSync(siblingVictim, "utf-8")).toBe("R6-SIBLING-KEEP");
            // Cleanup the sibling sentinel (outside `cleanupDirs`).
            fs.unlinkSync(siblingVictim);
        });
    }

    it("normal UUID-like session ids still round-trip end-to-end (upload → list → download → delete)", async () => {
        const FilesystemArtifactStore = await importFsArtifactStore();
        const { artifactDir } = makeStore("pilotswarm-r6-good-");
        const store = new FilesystemArtifactStore(artifactDir);
        const sid = "019dcfc8-cafe-7133-a002-45ec3742e888";

        const uploadedPath = await store.uploadArtifact(sid, "notes.md", "hello world", "text/markdown");
        expect(typeof uploadedPath).toBe("string");
        expect(uploadedPath.endsWith("notes.md")).toBe(true);

        const list = await store.listArtifacts(sid);
        expect(list).toContain("notes.md");

        const dl = await store.downloadArtifact(sid, "notes.md");
        expect(dl).toBe("hello world");

        const text = await store.downloadArtifactText(sid, "notes.md");
        expect(text).toBe("hello world");

        expect(await store.artifactExists(sid, "notes.md")).toBe(true);
        expect(await store.deleteArtifact(sid, "notes.md")).toBe(true);
        expect(await store.artifactExists(sid, "notes.md")).toBe(false);
    });
});
