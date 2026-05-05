import { execSync } from "node:child_process";
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

export type ArtifactEncoding = "utf-8" | "base64";
export type ArtifactSource = "agent" | "user" | "system";

export interface ArtifactUploadOptions {
    encoding?: ArtifactEncoding;
    source?: ArtifactSource;
}

export interface ArtifactMetadata {
    filename: string;
    sizeBytes: number;
    contentType: string;
    isBinary: boolean;
    uploadedAt: string;
    source: ArtifactSource;
}

export interface ArtifactDownloadResult extends ArtifactMetadata {
    body: Buffer;
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

const MAX_ARTIFACT_SIZE = 1_048_576; // 1MB
const DEFAULT_TEXT_ARTIFACT_CONTENT_TYPE = "text/markdown";
const DEFAULT_BINARY_ARTIFACT_CONTENT_TYPE = "application/octet-stream";

export function normalizeArtifactContentType(contentType?: string): string {
    const normalized = String(contentType || "").trim().toLowerCase();
    if (!normalized) return DEFAULT_TEXT_ARTIFACT_CONTENT_TYPE;
    return normalized;
}

export function isBinaryArtifactContentType(contentType?: string): boolean {
    const normalized = normalizeArtifactContentType(contentType);
    if (normalized.startsWith("text/")) return false;
    if (normalized === "application/json") return false;
    if (normalized === "application/xml") return false;
    if (normalized === "application/javascript") return false;
    if (normalized === "image/svg+xml") return false;
    return true;
}

export async function resolveArtifactUpload(
    content: string | Buffer,
    contentType?: string,
    opts: ArtifactUploadOptions = {},
): Promise<{ body: Buffer; metadata: Omit<ArtifactMetadata, "filename" | "uploadedAt"> }> {
    const encoding = opts.encoding ?? "utf-8";
    const body = Buffer.isBuffer(content)
        ? content
        : encoding === "base64"
            ? Buffer.from(content, "base64")
            : Buffer.from(content, "utf8");

    if (body.length > MAX_ARTIFACT_SIZE) {
        throw new Error(`Artifact too large: ${body.length} bytes (max ${MAX_ARTIFACT_SIZE})`);
    }

    const normalizedContentType = contentType
        ? normalizeArtifactContentType(contentType)
        : encoding === "base64"
            ? DEFAULT_BINARY_ARTIFACT_CONTENT_TYPE
            : DEFAULT_TEXT_ARTIFACT_CONTENT_TYPE;

    return {
        body,
        metadata: {
            sizeBytes: body.length,
            contentType: normalizedContentType,
            isBinary: isBinaryArtifactContentType(normalizedContentType),
            source: opts.source ?? "agent",
        },
    };
}

function archiveSessionDir(sessionStateDir: string, sessionId: string, tarPath: string): void {
    execSync(`tar czf "${tarPath}" -C "${sessionStateDir}" "${sessionId}"`);
}

function extractSessionArchive(sessionStateDir: string, tarPath: string): void {
    fs.mkdirSync(sessionStateDir, { recursive: true });
    execSync(`tar xzf "${tarPath}" -C "${sessionStateDir}"`);
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
        return path.join(this.storeDir, tarFileName(sessionId));
    }

    private metaPath(sessionId: string): string {
        return path.join(this.storeDir, metaFileName(sessionId));
    }

    async dehydrate(sessionId: string, meta?: Record<string, unknown>): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        const snapshot = await waitForSessionSnapshot(this.sessionStateDir, sessionId);
        if (!snapshot.ready) {
            throw new Error(
                `Session state directory not ready during dehydrate: ${sessionId} (${sessionDir}). ` +
                `Missing: ${snapshot.missing.join(", ") || "unknown"}`,
            );
        }

        const tarPath = this.tarPath(sessionId);
        archiveSessionDir(this.sessionStateDir, sessionId, tarPath);
        if (!fs.existsSync(tarPath)) {
            throw new Error(`Session archive was not created during dehydrate: ${sessionId} (${tarPath})`);
        }
        const metadata = buildMetadata(tarPath, sessionId, meta);
        fs.writeFileSync(this.metaPath(sessionId), JSON.stringify(metadata));
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    async hydrate(sessionId: string): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        const tarPath = this.tarPath(sessionId);
        if (!fs.existsSync(tarPath)) {
            throw new Error(`Session archive not found: ${sessionId}`);
        }
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        extractSessionArchive(this.sessionStateDir, tarPath);
    }

    async checkpoint(sessionId: string): Promise<void> {
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (!fs.existsSync(sessionDir)) return;

        const tarPath = this.tarPath(sessionId);
        archiveSessionDir(this.sessionStateDir, sessionId, tarPath);
        const metadata = buildMetadata(tarPath, sessionId, { reason: "checkpoint" });
        fs.writeFileSync(this.metaPath(sessionId), JSON.stringify(metadata));
    }
    async getSnapshotSizeBytes(sessionId: string): Promise<number | undefined> {
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
        return fs.existsSync(this.tarPath(sessionId));
    }

    async delete(sessionId: string): Promise<void> {
        try { fs.unlinkSync(this.tarPath(sessionId)); } catch {}
        try { fs.unlinkSync(this.metaPath(sessionId)); } catch {}
    }
}

/**
 * Interface for artifact (file) storage.
 * Implemented by both SessionBlobStore (Azure Blob) and FilesystemArtifactStore (local disk).
 */
export interface ArtifactStore {
    uploadArtifact(
        sessionId: string,
        filename: string,
        content: string | Buffer,
        contentType?: string,
        opts?: ArtifactUploadOptions,
    ): Promise<ArtifactMetadata>;
    downloadArtifact(sessionId: string, filename: string): Promise<ArtifactDownloadResult>;
    downloadArtifactText(sessionId: string, filename: string): Promise<string>;
    listArtifacts(sessionId: string): Promise<ArtifactMetadata[]>;
    artifactExists(sessionId: string, filename: string): Promise<boolean>;
    deleteArtifact?(sessionId: string, filename: string): Promise<boolean>;
    deleteArtifacts?(sessionId: string): Promise<number>;
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
        const safe = filename.replace(/[/\\]/g, "_");
        return path.join(this.artifactDir, sessionId, safe);
    }

    private metadataPath(sessionId: string, filename: string): string {
        return `${this.safePath(sessionId, filename)}.meta.json`;
    }

    private readMetadata(sessionId: string, filename: string): ArtifactMetadata | null {
        const metadataPath = this.metadataPath(sessionId, filename);
        if (!fs.existsSync(metadataPath)) return null;
        try {
            const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
            return {
                filename: path.basename(filename),
                sizeBytes: Number(parsed?.sizeBytes) || 0,
                contentType: normalizeArtifactContentType(parsed?.contentType),
                isBinary: parsed?.isBinary === true,
                uploadedAt: typeof parsed?.uploadedAt === "string" ? parsed.uploadedAt : "",
                source: parsed?.source === "user" || parsed?.source === "system" ? parsed.source : "agent",
            };
        } catch {
            return null;
        }
    }

    async uploadArtifact(
        sessionId: string,
        filename: string,
        content: string | Buffer,
        contentType?: string,
        opts: ArtifactUploadOptions = {},
    ): Promise<ArtifactMetadata> {
        const safeFilename = path.basename(String(filename || "").trim());
        const { body, metadata } = await resolveArtifactUpload(content, contentType, opts);
        const filePath = this.safePath(sessionId, filename);
        const uploadedAt = new Date().toISOString();
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, body);
        fs.writeFileSync(this.metadataPath(sessionId, filename), JSON.stringify({
            ...metadata,
            uploadedAt,
        }), "utf-8");
        return {
            filename: safeFilename,
            uploadedAt,
            ...metadata,
        };
    }

    async downloadArtifact(sessionId: string, filename: string): Promise<ArtifactDownloadResult> {
        const filePath = this.safePath(sessionId, filename);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Artifact not found: ${filename} in session ${sessionId}`);
        }
        const body = fs.readFileSync(filePath);
        const existingMetadata = this.readMetadata(sessionId, filename);
        const stat = fs.statSync(filePath);
        const contentType = existingMetadata?.contentType || normalizeArtifactContentType(undefined);
        return {
            filename: path.basename(filename),
            sizeBytes: body.length,
            contentType,
            isBinary: existingMetadata?.isBinary ?? isBinaryArtifactContentType(contentType),
            uploadedAt: existingMetadata?.uploadedAt || stat.mtime.toISOString(),
            source: existingMetadata?.source || "agent",
            body,
        };
    }

    async downloadArtifactText(sessionId: string, filename: string): Promise<string> {
        const result = await this.downloadArtifact(sessionId, filename);
        if (result.isBinary) {
            const error = new Error(`Artifact '${filename}' is binary and cannot be read as text.`) as Error & Record<string, unknown>;
            error.code = "ARTIFACT_IS_BINARY";
            error.contentType = result.contentType;
            error.sizeBytes = result.sizeBytes;
            throw error;
        }
        return result.body.toString("utf8");
    }

    async listArtifacts(sessionId: string): Promise<ArtifactMetadata[]> {
        const dir = path.join(this.artifactDir, sessionId);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter((filename) => !filename.startsWith(".") && !filename.endsWith(".meta.json"))
            .map((filename) => this.readMetadata(sessionId, filename) || {
                filename,
                sizeBytes: fs.statSync(this.safePath(sessionId, filename)).size,
                contentType: DEFAULT_TEXT_ARTIFACT_CONTENT_TYPE,
                isBinary: false,
                uploadedAt: fs.statSync(this.safePath(sessionId, filename)).mtime.toISOString(),
                source: "agent" as const,
            });
    }

    async artifactExists(sessionId: string, filename: string): Promise<boolean> {
        return fs.existsSync(this.safePath(sessionId, filename));
    }

    async deleteArtifact(sessionId: string, filename: string): Promise<boolean> {
        const filePath = this.safePath(sessionId, filename);
        const metadataPath = this.metadataPath(sessionId, filename);
        const existed = fs.existsSync(filePath);
        try { fs.unlinkSync(filePath); } catch {}
        try { fs.unlinkSync(metadataPath); } catch {}
        return existed;
    }

    async deleteArtifacts(sessionId: string): Promise<number> {
        const dir = path.join(this.artifactDir, sessionId);
        if (!fs.existsSync(dir)) return 0;
        const files = fs.readdirSync(dir).filter((filename) => !filename.endsWith(".meta.json"));
        fs.rmSync(dir, { recursive: true, force: true });
        return files.length;
    }
}

export {
    DEFAULT_ARTIFACT_DIR,
    DEFAULT_FILESYSTEM_STORE_DIR,
    DEFAULT_SESSION_STATE_DIR,
    archiveSessionDir,
    buildMetadata,
    extractSessionArchive,
    waitForSessionSnapshot,
};
