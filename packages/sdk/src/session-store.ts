import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");
const DEFAULT_FILESYSTEM_STORE_DIR = path.join(os.homedir(), ".copilot", "session-store");

export interface SessionMetadata {
    sessionId: string;
    dehydratedAt: string;
    worker: string;
    sizeBytes: number;
    reason?: string;
    iteration?: number;
    [key: string]: unknown;
}

export interface SessionStateStore {
    dehydrate(sessionId: string, meta?: Record<string, unknown>): Promise<void>;
    hydrate(sessionId: string): Promise<void>;
    checkpoint(sessionId: string): Promise<void>;
    getSnapshotSizeBytes(sessionId: string): Promise<number | undefined>;
    exists(sessionId: string): Promise<boolean>;
    delete(sessionId: string): Promise<void>;
}

// ─── Shared session-id / directory safety ──────────────────────────

/**
 * Validate a PilotSwarm session id for any host that resolves it into a
 * filesystem path. The same rules are enforced by:
 *   - `FilesystemSessionStore` (every public method)
 *   - `SessionManager` Codex branch (first line, BEFORE any store or
 *     runtime call)
 *   - `CodexRuntimeClient` state helpers
 *
 * Rules (kept minimal and cross-platform):
 *   - must be a nonempty string, not `.` or `..`
 *   - must not be absolute
 *   - must not contain `/` or `\` (rejected on BOTH platforms so a
 *     Unix host running against a Windows-authored id is still safe)
 *   - must not contain NUL / other C0 control bytes
 *   - after resolution against a root, must stay strictly inside that
 *     root (see `resolveContainedSessionDir`)
 *
 * Any shell metacharacter (`$`, `` ` ``, quotes, `;`, `&`) is allowed
 * as a byte, because every code path executes external tools through
 * argv (`execFileSync`) — no shell interpretation happens anywhere.
 *
 * Throws `Invalid PilotSwarm session id: <why> (received <json>)` on
 * failure, BEFORE any filesystem mutation.
 */
export function validateSessionId(sessionId: unknown): asserts sessionId is string {
    const invalid = (why: string): Error =>
        new Error(`Invalid PilotSwarm session id: ${why} (received ${JSON.stringify(sessionId)})`);
    if (typeof sessionId !== "string") throw invalid("must be a nonempty string");
    if (sessionId.length === 0) throw invalid("must be a nonempty string");
    if (sessionId === "." || sessionId === "..") throw invalid("must not be '.' or '..'");
    if (sessionId.includes("/") || sessionId.includes("\\")) {
        throw invalid("must not contain path separators");
    }
    // NUL and C0 control bytes (including embedded newlines) would let
    // some downstream tools misinterpret argv or filenames.
    for (let i = 0; i < sessionId.length; i += 1) {
        const code = sessionId.charCodeAt(i);
        if (code === 0 || (code >= 0x01 && code <= 0x1f)) {
            throw invalid("must not contain NUL or control characters");
        }
    }
    if (path.isAbsolute(sessionId)) throw invalid("must not be an absolute path");
    if (path.basename(sessionId) !== sessionId) throw invalid("must be a single path segment");
}

/**
 * Validate `sessionId` AND resolve it against `rootDir`, guaranteeing
 * the returned absolute path stays strictly inside `path.resolve(rootDir)`.
 * Throws before any filesystem mutation on failure.
 */
export function resolveContainedSessionDir(rootDir: string, sessionId: unknown): string {
    validateSessionId(sessionId);
    const rootAbs = path.resolve(rootDir);
    const targetAbs = path.resolve(rootAbs, sessionId as string);
    const rootPrefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
    if (!(targetAbs + path.sep).startsWith(rootPrefix)) {
        throw new Error(
            `Invalid PilotSwarm session id: resolved outside base directory ${rootAbs} ` +
            `(received ${JSON.stringify(sessionId)})`,
        );
    }
    return targetAbs;
}

function tarFileName(sessionId: string): string {
    return `${sessionId}.tar.gz`;
}

function metaFileName(sessionId: string): string {
    return `${sessionId}.meta.json`;
}

function buildMetadata(tarPath: string, sessionId: string, meta?: Record<string, unknown>): SessionMetadata {
    return {
        sessionId,
        dehydratedAt: new Date().toISOString(),
        worker: os.hostname(),
        sizeBytes: fs.statSync(tarPath).size,
        ...meta,
    };
}

function archiveSessionDir(sessionStateDir: string, sessionId: string, tarPath: string): void {
    // Argv-based execution (no shell) — every path/argument is passed
    // as a discrete argv element so shell metacharacters in paths
    // (spaces, `$(...)`, quotes, `;`, `&`) cannot be interpreted. The
    // `--` sentinel before `sessionId` prevents any hypothetical
    // leading-`-` id from being parsed as a tar option.
    // Exclude live `inuse.<pid>.lock` files: they are scoped to the
    // live SDK process and would resurrect a stale lock when
    // extracted on another node.
    execFileSync(
        "tar",
        [
            "--exclude=inuse.*.lock",
            "-czf", tarPath,
            "-C", sessionStateDir,
            "--", sessionId,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
    );
}

/**
 * Archive the session directory atomically: write to a temp file in the
 * destination directory, then rename over the final path only on
 * success. Cleans up the temp file on any failure. This guarantees a
 * previous good archive is never partially overwritten by a failed
 * checkpoint.
 */
function archiveSessionDirAtomic(sessionStateDir: string, sessionId: string, tarPath: string): void {
    const tmpPath = `${tarPath}.tmp.${process.pid}.${Date.now()}`;
    try {
        archiveSessionDir(sessionStateDir, sessionId, tmpPath);
        if (!fs.existsSync(tmpPath)) {
            throw new Error(`Session archive temp not created: ${tmpPath}`);
        }
        fs.renameSync(tmpPath, tarPath);
    } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch {}
        throw err;
    }
}

/**
 * Create a private, per-operation scratch directory for archive work.
 *
 * Session archives must never be staged at a predictable path such as
 * `os.tmpdir()/<sessionId>.tar.gz`: on a shared host that is a classic
 * symlink-swap / pre-creation target, and two concurrent operations on
 * the same session (a periodic checkpoint racing a dehydrate) would
 * clobber each other's staging file.
 *
 * The directory is created with `mkdtemp` (unique, unguessable suffix)
 * under the PilotSwarm-owned session-state root — the same privacy
 * domain the session data already lives in — and is chmod'ed to 0700 so
 * no other local user can read the staged archive. Callers MUST remove
 * it recursively when done.
 */
function createSessionWorkDir(root: string, prefix: string): string {
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, prefix));
    // mkdtemp is 0700 per POSIX, but be explicit: a permissive umask or
    // a non-POSIX filesystem must not widen the staging directory.
    try { fs.chmodSync(dir, 0o700); } catch {}
    return dir;
}

function writeMetadataAtomic(metaPath: string, metadata: SessionMetadata): void {
    const tmp = `${metaPath}.tmp.${process.pid}.${Date.now()}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(metadata));
        fs.renameSync(tmp, metaPath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
    }
}

function archiveListingLines(tarPath: string, verbose: boolean): string[] {
    const output = execFileSync(
        "tar",
        [verbose ? "-tvzf" : "-tzf", tarPath],
        {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 64 * 1024 * 1024,
        },
    );
    return output.split(/\r?\n/).filter((line) => line.length > 0);
}

function preflightSessionArchive(tarPath: string, expectedSessionId: string): void {
    const names = archiveListingLines(tarPath, false);
    const verbose = archiveListingLines(tarPath, true);
    if (names.length === 0) {
        throw new Error(`Session archive is empty: ${tarPath}`);
    }
    if (verbose.length !== names.length) {
        throw new Error(`Session archive listing mismatch: ${tarPath}`);
    }

    const seen = new Set<string>();
    for (let index = 0; index < names.length; index += 1) {
        const rawName = names[index];
        const type = verbose[index]?.[0];
        if (type === "l" || type === "h") {
            throw new Error(`Session archive contains a link entry: ${rawName}`);
        }
        if (type !== "-" && type !== "d") {
            throw new Error(`Session archive contains unsupported entry type "${type ?? "unknown"}": ${rawName}`);
        }
        if (/[\0\r\n]/.test(rawName)) {
            throw new Error("Session archive contains a control character in an entry name");
        }
        if (
            path.posix.isAbsolute(rawName)
            || path.win32.isAbsolute(rawName)
            || rawName.startsWith("/")
            || rawName.startsWith("\\")
            || rawName.includes("\\")
        ) {
            throw new Error(`Session archive contains an absolute or platform-ambiguous entry: ${rawName}`);
        }

        const withoutTrailingSlash = rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
        const segments = withoutTrailingSlash.split("/");
        if (
            !withoutTrailingSlash
            || segments.some((segment) => segment === "" || segment === "." || segment === "..")
        ) {
            throw new Error(`Session archive contains a traversal entry: ${rawName}`);
        }
        if (segments[0] !== expectedSessionId) {
            throw new Error(
                `Session archive top-level root must be exactly "${expectedSessionId}" (got "${segments[0]}")`,
            );
        }
        if (seen.has(rawName)) {
            throw new Error(`Session archive contains a duplicate entry: ${rawName}`);
        }
        seen.add(rawName);
    }
}

function validateExtractedSessionTree(sessionDir: string): void {
    const stack = [sessionDir];
    while (stack.length > 0) {
        const current = stack.pop()!;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const entryPath = path.join(current, entry.name);
            const stat = fs.lstatSync(entryPath);
            if (stat.isSymbolicLink()) {
                throw new Error(`Extracted session archive contains a symbolic link: ${entryPath}`);
            }
            if (stat.isDirectory()) {
                stack.push(entryPath);
                continue;
            }
            if (!stat.isFile()) {
                throw new Error(`Extracted session archive contains a non-regular file: ${entryPath}`);
            }
            if (stat.nlink > 1) {
                throw new Error(`Extracted session archive contains a hard-linked file: ${entryPath}`);
            }
        }
    }
}

function extractSessionArchive(
    sessionStateDir: string,
    expectedSessionId: string,
    tarPath: string,
): void {
    const targetSessionDir = resolveContainedSessionDir(sessionStateDir, expectedSessionId);
    preflightSessionArchive(tarPath, expectedSessionId);
    fs.mkdirSync(sessionStateDir, { recursive: true });

    const stagingRoot = fs.mkdtempSync(path.join(sessionStateDir, ".hydrate-stage-"));
    const stagedSessionDir = path.join(stagingRoot, expectedSessionId);
    const backupSessionDir = `${stagingRoot}.backup`;
    let movedExisting = false;
    let installed = false;
    try {
        execFileSync(
            "tar",
            ["xzf", tarPath, "-C", stagingRoot],
            { stdio: ["ignore", "ignore", "pipe"] },
        );

        const topLevel = fs.readdirSync(stagingRoot);
        if (topLevel.length !== 1 || topLevel[0] !== expectedSessionId) {
            throw new Error(
                `Session archive extracted an unexpected top-level layout: ${topLevel.join(", ") || "<empty>"}`,
            );
        }
        const rootStat = fs.lstatSync(stagedSessionDir);
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
            throw new Error(`Session archive root is not a regular directory: ${expectedSessionId}`);
        }
        validateExtractedSessionTree(stagedSessionDir);

        if (fs.existsSync(targetSessionDir)) {
            fs.renameSync(targetSessionDir, backupSessionDir);
            movedExisting = true;
        }
        try {
            fs.renameSync(stagedSessionDir, targetSessionDir);
            installed = true;
        } catch (error) {
            if (movedExisting && !fs.existsSync(targetSessionDir) && fs.existsSync(backupSessionDir)) {
                fs.renameSync(backupSessionDir, targetSessionDir);
                movedExisting = false;
            }
            throw error;
        }
        if (movedExisting) {
            fs.rmSync(backupSessionDir, { recursive: true, force: true });
            movedExisting = false;
        }
    } finally {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        if (installed && movedExisting) {
            fs.rmSync(backupSessionDir, { recursive: true, force: true });
        }
    }
}

async function waitForPath(pathToCheck: string, timeoutMs = 5_000, pollMs = 100): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(pathToCheck)) return true;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return fs.existsSync(pathToCheck);
}

const LEGACY_SESSION_FILES = ["events.jsonl", "workspace.yaml"];
const REQUIRED_SESSION_FILES = ["workspace.yaml"];
const SESSION_LOCK_FILE = /^inuse\..+\.lock$/i;

function isIgnoredSessionEntry(relativePath: string): boolean {
    const baseName = path.basename(relativePath);
    return SESSION_LOCK_FILE.test(baseName);
}

function collectSessionSnapshotEntries(sessionDir: string): string[] {
    const entries: string[] = [];

    function walk(currentDir: string, relativeDir = ""): void {
        for (const dirent of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const relativePath = relativeDir ? path.join(relativeDir, dirent.name) : dirent.name;
            if (isIgnoredSessionEntry(relativePath)) continue;

            const absolutePath = path.join(currentDir, dirent.name);
            const stat = fs.statSync(absolutePath);

            if (dirent.isDirectory()) {
                entries.push(`dir:${relativePath}:${stat.mtimeMs}`);
                walk(absolutePath, relativePath);
                continue;
            }

            entries.push(`file:${relativePath}:${stat.size}:${stat.mtimeMs}`);
        }
    }

    walk(sessionDir);
    entries.sort();
    return entries;
}

const CURRENT_LAYOUT_SIGNAL_FILES = new Set<string>(["workspace.yaml"]);
const CURRENT_LAYOUT_SIGNAL_DIRS = new Set<string>(["checkpoints", "files", "research"]);

/**
 * Do these exact bytes contain a complete, non-empty JSONL snapshot?
 *
 * A Codex rollout is append-only JSONL. A torn write (crash, ENOSPC,
 * container kill mid-flush) leaves a file whose tail is a partial line.
 * Resuming from — or archiving — such a file silently loses the tail of
 * the conversation, and Codex rejects it at parse time.
 *
 * The check is deliberately cheap and conservative:
 *   - the file must exist, be a regular file, and be non-empty
 *   - it must be newline-terminated (an unterminated tail is by
 *     definition a partial record)
 *   - the last nonempty line must parse as JSON
 *
 * Only the LAST line is parsed: earlier lines were committed by earlier
 * appends and re-parsing a multi-megabyte rollout on every readiness
 * poll would be wasteful.
 */
function isCompleteJsonlSnapshotContent(contents: Buffer | string): boolean {
    const raw = Buffer.isBuffer(contents) ? contents.toString("utf-8") : contents;
    if (raw.length === 0 || !raw.endsWith("\n")) return false;

    const lines = raw.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (line.trim() === "") continue;
        try {
            JSON.parse(line);
            return true;
        } catch {
            return false;
        }
    }
    // Whitespace/newlines only — no records at all.
    return false;
}

/** Path-level readiness check that also rejects symlinks and non-files. */
function isCompleteJsonlSnapshot(absPath: string): boolean {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(absPath);
    } catch {
        return false;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) return false;

    let raw: Buffer;
    try {
        raw = fs.readFileSync(absPath);
    } catch {
        return false;
    }
    return isCompleteJsonlSnapshotContent(raw);
}

/**
 * Single-shot readiness check for a session-state directory.
 *
 * As of @github/copilot 1.0.36, `client.createSession` writes `workspace.yaml`
 * (plus `checkpoints/`, `files/`, `research/`) before returning, and
 * `session.disconnect()` preserves the directory intact. There is therefore
 * no race to poll for: either the SDK has placed the directory by the time
 * we get here or it never will. We retain the legacy ("events.jsonl" +
 * "workspace.yaml") fallback for snapshots produced by older SDK builds, and
 * the lock-file filter so we ignore live `inuse.<pid>.lock` churn.
 *
 * Codex-backed sessions produce a different (non-Copilot) layout: a
 * `codex-thread.json` marker plus an optional `codex-rollout.jsonl`
 * snapshot copied out of `CODEX_HOME/sessions/`. The Codex readiness
 * gate enforces:
 *   - `codex-thread.json` parses as a JSON object
 *   - `codexThreadId` is a nonempty string
 *   - if `rolloutSnapshotRelPath` is a nonempty string, it is a safe
 *     RELATIVE path fully contained under the session directory and
 *     points to an existing REGULAR non-symlink file
 *   - a zero-turn marker with no `rolloutSnapshotRelPath` is accepted
 * Auth material never lands in the session dir; the Codex runtime is
 * responsible for keeping `auth.json` local to the operator's
 * `CODEX_HOME`.
 */
function checkSessionSnapshot(
    sessionStateDir: string,
    sessionId: string,
): { ready: boolean; missing: string[] } {
    const sessionDir = path.join(sessionStateDir, sessionId);

    if (!fs.existsSync(sessionDir)) {
        return { ready: false, missing: [`${sessionId}/`] };
    }

    // Codex layout: presence of `codex-thread.json` is authoritative.
    // The marker MUST parse to a JSON object with a nonempty
    // `codexThreadId`. If it advertises a rollout snapshot, that file
    // MUST exist, be a regular non-symlink file, and be safely
    // contained under the session dir.
    const codexMarker = path.join(sessionDir, "codex-thread.json");
    if (fs.existsSync(codexMarker)) {
        let raw: string;
        try {
            raw = fs.readFileSync(codexMarker, "utf-8");
        } catch (err) {
            return { ready: false, missing: [`${sessionId}/codex-thread.json unreadable: ${(err as Error).message}`] };
        }
        let meta: unknown;
        try {
            meta = JSON.parse(raw);
        } catch {
            return { ready: false, missing: [`${sessionId}/codex-thread.json is not valid JSON`] };
        }
        if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
            return { ready: false, missing: [`${sessionId}/codex-thread.json is not a JSON object`] };
        }
        const asObj = meta as Record<string, unknown>;
        const threadId = asObj.codexThreadId;
        if (typeof threadId !== "string" || threadId.trim() === "") {
            return { ready: false, missing: [`${sessionId}/codex-thread.json missing nonempty codexThreadId`] };
        }
        const rel = asObj.rolloutSnapshotRelPath;
        if (rel != null && rel !== "") {
            if (typeof rel !== "string") {
                return { ready: false, missing: [`${sessionId}/codex-thread.json rolloutSnapshotRelPath is not a string`] };
            }
            if (path.isAbsolute(rel)) {
                return { ready: false, missing: [`${sessionId}/codex-thread.json rolloutSnapshotRelPath must be relative (got ${rel})`] };
            }
            // Resolve and confirm the target stays inside sessionDir
            // (blocks `../` traversals). Compare against a normalized
            // sessionDir with a trailing separator so a target equal to
            // sessionDir itself is still rejected.
            const absTarget = path.resolve(sessionDir, rel);
            const normalizedSessionDir = path.resolve(sessionDir) + path.sep;
            if (!(absTarget + path.sep).startsWith(normalizedSessionDir) && absTarget !== path.resolve(sessionDir)) {
                return { ready: false, missing: [`${sessionId}/${rel} escapes session directory`] };
            }
            let lstat: fs.Stats;
            try {
                lstat = fs.lstatSync(absTarget);
            } catch {
                return { ready: false, missing: [`${sessionId}/${rel} referenced by codex-thread.json (not found)`] };
            }
            if (lstat.isSymbolicLink()) {
                return { ready: false, missing: [`${sessionId}/${rel} is a symbolic link`] };
            }
            if (!lstat.isFile()) {
                return { ready: false, missing: [`${sessionId}/${rel} is not a regular file`] };
            }
            // A rollout that is empty or ends mid-record is NOT
            // resumable. Archiving it would overwrite the last good
            // snapshot with state Codex cannot parse.
            if (!isCompleteJsonlSnapshot(absTarget)) {
                return {
                    ready: false,
                    missing: [`${sessionId}/${rel} is an empty or truncated JSONL rollout`],
                };
            }
        }
        return { ready: true, missing: [] };
    }

    const missingRequired = REQUIRED_SESSION_FILES
        .filter((file) => !fs.existsSync(path.join(sessionDir, file)))
        .map((file) => `${sessionId}/${file}`);

    if (missingRequired.length === 0) {
        const snapshotEntries = collectSessionSnapshotEntries(sessionDir);
        const hasCurrentLayoutSignal = snapshotEntries.some((entry) => {
            const [kind, relPath = ""] = entry.split(":");
            if (!relPath) return false;
            if (kind === "file" && CURRENT_LAYOUT_SIGNAL_FILES.has(relPath)) return true;
            if (kind === "dir" && CURRENT_LAYOUT_SIGNAL_DIRS.has(relPath)) return true;
            const top = relPath.split(path.sep)[0];
            return CURRENT_LAYOUT_SIGNAL_DIRS.has(top);
        });
        if (hasCurrentLayoutSignal) return { ready: true, missing: [] };
        return { ready: false, missing: [`${sessionId}/workspace.yaml or layout signal or codex-thread.json`] };
    }

    const hasLegacyLayoutSignal = LEGACY_SESSION_FILES.every((file) =>
        fs.existsSync(path.join(sessionDir, file)),
    );
    if (hasLegacyLayoutSignal) return { ready: true, missing: [] };

    return { ready: false, missing: missingRequired };
}

async function waitForSessionSnapshot(
    sessionStateDir: string,
    sessionId: string,
    timeoutMs = 5_000,
    pollMs = 100,
    stablePolls = 3,
): Promise<{ ready: boolean; missing: string[] }> {
    const sessionDir = path.join(sessionStateDir, sessionId);
    let lastSignature = "";
    let stableCount = 0;
    let missing = [`${sessionId}/`];

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!fs.existsSync(sessionDir)) {
            missing = [`${sessionId}/`];
            stableCount = 0;
            lastSignature = "";
        } else if (fs.existsSync(path.join(sessionDir, "codex-thread.json"))) {
            const codexReady = checkSessionSnapshot(sessionStateDir, sessionId);
            if (codexReady.ready) return { ready: true, missing: [] };
            missing = codexReady.missing;
            stableCount = 0;
            lastSignature = "";
        } else {
            missing = REQUIRED_SESSION_FILES
                .filter((file) => !fs.existsSync(path.join(sessionDir, file)))
                .map((file) => `${sessionId}/${file}`);

            if (missing.length === 0) {
                const snapshotEntries = collectSessionSnapshotEntries(sessionDir);

                // Support both the current Copilot session layout and older
                // layouts that included events.jsonl. We intentionally ignore
                // inuse.*.lock churn so active sessions can stabilize.
                const hasCurrentLayoutSignal = snapshotEntries.some((entry) => {
                    const relPath = entry.split(":")[1] || "";
                    return relPath === "workspace.yaml"
                        || relPath === "checkpoints"
                        || relPath.startsWith("checkpoints/")
                        || relPath === "files"
                        || relPath.startsWith("files/")
                        || relPath === "research"
                        || relPath.startsWith("research/");
                });
                const hasLegacyLayoutSignal = LEGACY_SESSION_FILES.every((file) =>
                    fs.existsSync(path.join(sessionDir, file)),
                );

                if (!hasCurrentLayoutSignal && !hasLegacyLayoutSignal) {
                    missing = [`${sessionId}/workspace.yaml or legacy session files`];
                    stableCount = 0;
                    lastSignature = "";
                    await new Promise((resolve) => setTimeout(resolve, pollMs));
                    continue;
                }

                const signature = snapshotEntries.join("|");

                if (signature === lastSignature) {
                    stableCount += 1;
                } else {
                    lastSignature = signature;
                    stableCount = 1;
                }

                if (stableCount >= stablePolls) {
                    return { ready: true, missing: [] };
                }
            } else {
                stableCount = 0;
                lastSignature = "";
            }
        }

        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (missing.length === 0) {
        missing = [`${sessionId}/snapshot still changing`];
    }
    return { ready: false, missing };
}

export class FilesystemSessionStore implements SessionStateStore {
    private storeDir: string;
    private sessionStateDir: string;

    constructor(storeDir = DEFAULT_FILESYSTEM_STORE_DIR, sessionStateDir?: string) {
        this.storeDir = storeDir;
        this.sessionStateDir = sessionStateDir ?? DEFAULT_SESSION_STATE_DIR;
        fs.mkdirSync(this.storeDir, { recursive: true });
    }

    private tarPath(sessionId: string): string {
        // Every caller (checkpoint/dehydrate/hydrate/exists/delete/…)
        // validates before invoking `tarPath`, so this is a defense-
        // in-depth check: any future call site that forgets to
        // validate first will still fail loudly before the path is
        // used to reference/rm/write anything.
        validateSessionId(sessionId);
        return path.join(this.storeDir, tarFileName(sessionId));
    }

    private metaPath(sessionId: string): string {
        validateSessionId(sessionId);
        return path.join(this.storeDir, metaFileName(sessionId));
    }

    async dehydrate(sessionId: string, meta?: Record<string, unknown>): Promise<void> {
        // Validate BEFORE any path construction or fs probe so a
        // traversal / absolute / composite id can never escape the
        // sessionStateDir or storeDir roots.
        const sessionDir = resolveContainedSessionDir(this.sessionStateDir, sessionId);
        const snapshot = await waitForSessionSnapshot(this.sessionStateDir, sessionId);
        if (!snapshot.ready) {
            throw new Error(
                `Session state directory not ready during dehydrate: ${sessionId} (${sessionDir}). ` +
                `Missing: ${snapshot.missing.join(", ") || "unknown"}`,
            );
        }

        const tarPath = this.tarPath(sessionId);
        archiveSessionDirAtomic(this.sessionStateDir, sessionId, tarPath);
        if (!fs.existsSync(tarPath)) {
            throw new Error(`Session archive was not created during dehydrate: ${sessionId} (${tarPath})`);
        }
        const metadata = buildMetadata(tarPath, sessionId, meta);
        writeMetadataAtomic(this.metaPath(sessionId), metadata);
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    async hydrate(sessionId: string): Promise<void> {
        resolveContainedSessionDir(this.sessionStateDir, sessionId);
        const tarPath = this.tarPath(sessionId);
        if (!fs.existsSync(tarPath)) {
            throw new Error(`Session archive not found: ${sessionId}`);
        }
        extractSessionArchive(this.sessionStateDir, sessionId, tarPath);
    }

    async checkpoint(sessionId: string): Promise<void> {
        const sessionDir = resolveContainedSessionDir(this.sessionStateDir, sessionId);
        if (!fs.existsSync(sessionDir)) return;

        // Share the exact readiness gate with dehydrate so a corrupt or
        // non-resumable state directory cannot overwrite a previous
        // good archive. This is the invariant that makes checkpoint
        // safe: if we cannot prove the on-disk state is resumable, we
        // refuse to commit anything and leave the last good archive
        // untouched.
        const snapshot = await waitForSessionSnapshot(this.sessionStateDir, sessionId);
        if (!snapshot.ready) {
            throw new Error(
                `Session state directory not ready during checkpoint: ${sessionId} (${sessionDir}). ` +
                `Missing: ${snapshot.missing.join(", ") || "unknown"}`,
            );
        }

        const tarPath = this.tarPath(sessionId);
        archiveSessionDirAtomic(this.sessionStateDir, sessionId, tarPath);
        const metadata = buildMetadata(tarPath, sessionId, { reason: "checkpoint" });
        writeMetadataAtomic(this.metaPath(sessionId), metadata);
    }
    async getSnapshotSizeBytes(sessionId: string): Promise<number | undefined> {
        validateSessionId(sessionId);
        try {
            const metadataPath = this.metaPath(sessionId);
            if (fs.existsSync(metadataPath)) {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as SessionMetadata;
                const sizeBytes = Number(metadata?.sizeBytes);
                if (Number.isFinite(sizeBytes)) return sizeBytes;
            }
        } catch {}

        try {
            const tarPath = this.tarPath(sessionId);
            if (fs.existsSync(tarPath)) {
                const sizeBytes = fs.statSync(tarPath).size;
                if (Number.isFinite(sizeBytes)) return sizeBytes;
            }
        } catch {}

        return undefined;
    }

    async exists(sessionId: string): Promise<boolean> {
        validateSessionId(sessionId);
        return fs.existsSync(this.tarPath(sessionId));
    }

    async delete(sessionId: string): Promise<void> {
        validateSessionId(sessionId);
        try { fs.unlinkSync(this.tarPath(sessionId)); } catch {}
        try { fs.unlinkSync(this.metaPath(sessionId)); } catch {}
    }
}

/**
 * Interface for artifact (file) storage.
 * Implemented by both SessionBlobStore (Azure Blob) and FilesystemArtifactStore (local disk).
 */
export interface ArtifactStore {
    uploadArtifact(sessionId: string, filename: string, content: string, contentType?: string): Promise<string>;
    downloadArtifact(sessionId: string, filename: string): Promise<string>;
    downloadArtifactText(sessionId: string, filename: string): Promise<string>;
    listArtifacts(sessionId: string): Promise<string[]>;
    deleteArtifact(sessionId: string, filename: string): Promise<boolean>;
    artifactExists(sessionId: string, filename: string): Promise<boolean>;
}

const DEFAULT_ARTIFACT_DIR = path.join(os.homedir(), ".copilot", "artifacts");

/**
 * Filesystem-based artifact store for local mode (no Azure Blob).
 * Stores artifacts as plain files under `<artifactDir>/<sessionId>/<filename>`.
 * @internal
 */
export class FilesystemArtifactStore implements ArtifactStore {
    private artifactDir: string;

    constructor(artifactDir = DEFAULT_ARTIFACT_DIR) {
        this.artifactDir = artifactDir;
        fs.mkdirSync(this.artifactDir, { recursive: true });
    }

    private safePath(sessionId: string, filename: string): string {
        // Resolve the per-session artifact root through the shared
        // validator so any traversal / absolute / cross-separator id
        // is rejected BEFORE we join a sanitized filename onto it.
        // Filename sanitation (`/` and `\` → `_`) is preserved as a
        // separate concern beneath the session-id guard.
        const sessionRoot = resolveContainedSessionDir(this.artifactDir, sessionId);
        const safe = filename.replace(/[/\\]/g, "_");
        return path.join(sessionRoot, safe);
    }

    async uploadArtifact(
        sessionId: string,
        filename: string,
        content: string,
        _contentType = "text/markdown",
    ): Promise<string> {
        validateSessionId(sessionId);
        const MAX_SIZE = 1_048_576; // 1MB
        if (content.length > MAX_SIZE) {
            throw new Error(`Artifact too large: ${content.length} bytes (max ${MAX_SIZE})`);
        }
        const filePath = this.safePath(sessionId, filename);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf-8");
        return filePath;
    }

    async downloadArtifact(sessionId: string, filename: string): Promise<string> {
        validateSessionId(sessionId);
        const filePath = this.safePath(sessionId, filename);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Artifact not found: ${filename} in session ${sessionId}`);
        }
        return fs.readFileSync(filePath, "utf-8");
    }

    async downloadArtifactText(sessionId: string, filename: string): Promise<string> {
        validateSessionId(sessionId);
        return this.downloadArtifact(sessionId, filename);
    }

    async listArtifacts(sessionId: string): Promise<string[]> {
        // Resolve through the shared validator so any traversal /
        // absolute / cross-separator id is rejected BEFORE we
        // enumerate a sibling directory (which would leak filenames).
        const dir = resolveContainedSessionDir(this.artifactDir, sessionId);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(f => !f.startsWith("."));
    }

    async deleteArtifact(sessionId: string, filename: string): Promise<boolean> {
        // Validate BEFORE any path construction or unlinkSync so a
        // traversal id can never delete outside the artifactDir root.
        validateSessionId(sessionId);
        const filePath = this.safePath(sessionId, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
        return false;
    }

    async artifactExists(sessionId: string, filename: string): Promise<boolean> {
        validateSessionId(sessionId);
        return fs.existsSync(this.safePath(sessionId, filename));
    }
}

export {
    DEFAULT_ARTIFACT_DIR,
    DEFAULT_FILESYSTEM_STORE_DIR,
    DEFAULT_SESSION_STATE_DIR,
    archiveSessionDir,
    archiveSessionDirAtomic,
    buildMetadata,
    createSessionWorkDir,
    extractSessionArchive,
    isCompleteJsonlSnapshot,
    isCompleteJsonlSnapshotContent,
    waitForSessionSnapshot,
};
