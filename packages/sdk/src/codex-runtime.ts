/**
 * Codex runtime adapter — talks to `codex app-server` over stdio using
 * JSON-RPC 2.0 line-delimited messages, and adapts it to the internal
 * `RuntimeSessionHandle` / `RuntimeClient` contract that ManagedSession
 * consumes.
 *
 * Auth model (v1): trusted single-operator subscription mode.
 *   - `CODEX_HOME` must exist on disk with mode 0700 before use.
 *   - The runtime NEVER reads, copies, or logs `auth.json`. The child
 *     `codex app-server` process is what unlocks the ChatGPT/Codex
 *     subscription session using CODEX_HOME directly.
 *   - PilotSwarm persists only the Codex `threadId` (plus the CODEX_HOME
 *     path we pointed at) inside the per-session state directory. That
 *     mapping is what makes disconnect-then-resume work across worker
 *     restarts. Snapshots must never carry auth material.
 *
 * Concurrency model (v1):
 *   - Each `CodexRuntimeClient` owns one child `codex app-server` process
 *     per unique CODEX_HOME. Requests to that process are serialized via
 *     a per-client mutex to keep app-server's turn semantics well-defined
 *     when multiple PilotSwarm sessions share the same subscription.
 *
 * Dynamic tools (v1):
 *   - `registerTools()` stores JS handlers keyed by tool name. When the
 *     `codex app-server` process pushes a `item/tool/call` ServerRequest
 *     for a given tool name and callId, this adapter dispatches to the
 *     registered handler and returns the documented
 *     `DynamicToolCallResponse` shape (`{ success, contentItems }`).
 *   - Tool SCHEMAS are declared to Codex through `thread/start.dynamicTools`
 *     (see `CodexRuntimeClient.createSession`). The full PilotSwarm tool
 *     set — including durable primitives like `wait` and `ask_user` —
 *     is passed at thread start and reused for the life of the thread.
 *     Because Codex dynamic tools are thread-start-scoped, per-turn
 *     `registerTools()` calls only refresh handlers, not schemas.
 *
 * @module
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Tool } from "@github/copilot-sdk";
import type { RuntimeClient, RuntimeSessionHandle } from "./runtime.js";
import { resolveContainedSessionDir } from "./session-store.js";

// ─── Public constants ────────────────────────────────────────────

/**
 * Filename under `<sessionStateDir>/<pilotswarmSessionId>/` that stores
 * the Codex thread id + configured CODEX_HOME. Never contains secrets.
 */
export const CODEX_THREAD_STATE_FILENAME = "codex-thread.json";

/**
 * Filename under `<sessionStateDir>/<pilotswarmSessionId>/` that holds a
 * snapshot copy of the Codex rollout JSONL. Copied out of CODEX_HOME on
 * disconnect/checkpoint so the session-store dehydrate can archive the
 * transcript without touching auth material.
 */
export const CODEX_ROLLOUT_SNAPSHOT_FILENAME = "codex-rollout.jsonl";

/** clientInfo.version reported to `codex app-server`. */
const PILOTSWARM_CLIENT_INFO_VERSION = "0.1";

// ─── Session-id / directory safety ───────────────────────────────

/**
 * Validate a PilotSwarm session id for use in any Codex durable path.
 *
 * Delegates to the shared validator in `session-store.ts` so that
 * `FilesystemSessionStore`, `SessionManager`, and the Codex runtime
 * apply IDENTICAL rules and error messages. This makes the store,
 * SessionManager, and every Codex helper independently safe against
 * traversal / absolute / cross-separator / control-character ids.
 *
 * On success returns the absolute session directory, guaranteed to
 * live under `path.resolve(sessionStateDir)`. On failure throws
 * `Invalid PilotSwarm session id: <why>` BEFORE any filesystem
 * mutation or app-server request.
 */
function resolveSafeCodexSessionDir(sessionStateDir: string, sessionId: unknown): string {
    return resolveContainedSessionDir(sessionStateDir, sessionId);
}

// ─── Transport ───────────────────────────────────────────────────

/**
 * Injected transport interface — abstracts over the real `codex
 * app-server` child process so tests can supply an in-process fake.
 * Real production uses `SpawnedCodexAppServerTransport`.
 */
export interface CodexTransport extends EventEmitter {
    /** Send a JSON-RPC 2.0 request. Resolves with the `result` object. */
    request(method: string, params: unknown): Promise<any>;
    /** Send a JSON-RPC 2.0 notification (no response). */
    notify(method: string, params: unknown): void;
    /**
     * Reply to an incoming ServerRequest previously delivered as a
     * `server-request` event. `id` is the request id received.
     */
    respond(id: string | number, result: unknown): void;
    /** Reply to an incoming ServerRequest with a JSON-RPC error. */
    respondError(id: string | number, code: number, message: string): void;
    /** Terminate the transport and release resources. */
    close(): Promise<void>;
}

// Events emitted by transports:
//   "notification" -> { method: string, params: any }
//   "server-request" -> { id: string|number, method: string, params: any }
//   "close" -> void

// ─── Codex Runtime Client ────────────────────────────────────────

export interface CodexRuntimeClientOptions {
    /** Absolute CODEX_HOME path. Must exist with mode 0700 before use. */
    codexHome: string;
    /** Absolute path to the `codex` binary. Undefined = resolve from PATH. */
    codexBinaryPath?: string;
    /** PilotSwarm session-state directory (per-session threadId lives here). */
    sessionStateDir: string;
    /**
     * Test-only injection seam. When supplied, this factory is used
     * INSTEAD of spawning `codex app-server`.
     */
    transportFactory?: () => CodexTransport;
}

/**
 * Shared Codex client — one child app-server process per CODEX_HOME.
 * All sessions created through this client multiplex over that process.
 *
 * @internal
 */
export class CodexRuntimeClient implements RuntimeClient {
    private readonly opts: CodexRuntimeClientOptions;
    private transport: CodexTransport | null = null;
    private initialized = false;
    /**
     * Monotonically-incremented on every successful `initialize`
     * (including reconnects after a transport crash). Each session
     * records the generation it started/last-resumed under, so a warm
     * session can detect that the underlying app-server was replaced
     * and issue `thread/resume` before its next `turn/start`.
     */
    private transportGeneration = 0;
    private initPromise: Promise<void> | null = null;
    private sessions = new Map<string, CodexRuntimeSession>();
    /** Per-client mutex so overlapping turn/start calls stay ordered. */
    private turnQueue: Promise<void> = Promise.resolve();

    constructor(opts: CodexRuntimeClientOptions) {
        this.opts = opts;
    }

    /** @internal */
    get generation(): number { return this.transportGeneration; }

    async createSession(config: CodexCreateSessionConfig): Promise<RuntimeSessionHandle> {
        // Validate the session id BEFORE any filesystem mutation or
        // app-server round-trip. A malformed id (`../victim`, absolute
        // path, `a/b`, etc.) would otherwise let the purge below rm an
        // arbitrary host directory.
        const sessDir = resolveSafeCodexSessionDir(this.opts.sessionStateDir, config.sessionId);
        this._ensureCodexHomeReady();
        await this._ensureInitialized();

        // Purge the PilotSwarm-owned per-session directory BEFORE
        // persisting the new marker. This is safe here because
        // `createSession` (by contract, mirrored in SessionManager) is
        // the fresh-thread entry point — never called on a hydrated
        // resume path. Without this, a leftover Copilot `workspace.yaml`,
        // an orphan `codex-rollout.jsonl` from a deleted thread, or any
        // sentinel bytes from a prior aborted run would sit inside the
        // dir when we write the new marker, and future archives would
        // ship stale content under a fresh thread. Callers coming
        // through `SessionManager` already delete the stored archive
        // for a truly fresh turn 0; the client cleanup handles the
        // local dir for BOTH direct-client callers and SessionManager.
        // `resumeSession` deliberately does not touch the dir.
        if (fs.existsSync(sessDir)) {
            try { fs.rmSync(sessDir, { recursive: true, force: true }); } catch {}
        }

        const params: Record<string, unknown> = {};
        if (config.model) params.model = config.model;
        if (config.cwd) params.cwd = config.cwd;
        if (config.developerInstructions) params.developerInstructions = config.developerInstructions;
        if (config.baseInstructions) params.baseInstructions = config.baseInstructions;
        const dynamicTools = buildDynamicToolSpecs(config.tools);
        if (dynamicTools.length > 0) params.dynamicTools = dynamicTools;

        const startResult = await this.transport!.request("thread/start", params);
        const codexThreadId = extractThreadId(startResult);
        if (!codexThreadId) {
            throw new Error(
                `Codex app-server thread/start did not return a thread id (got ${JSON.stringify(startResult)})`,
            );
        }
        this._persistThreadState(config.sessionId, codexThreadId, { model: config.model });
        const session = this._registerSession(config.sessionId, codexThreadId, {
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            cwd: config.cwd,
            developerInstructions: config.developerInstructions,
            baseInstructions: config.baseInstructions,
        });
        if (config.tools?.length) session.registerTools(config.tools);
        return session;
    }

    async resumeSession(sessionId: string, config: CodexCreateSessionConfig): Promise<RuntimeSessionHandle> {
        // Validate the session id BEFORE any read of durable state or
        // app-server round-trip.
        resolveSafeCodexSessionDir(this.opts.sessionStateDir, sessionId);
        this._ensureCodexHomeReady();
        await this._ensureInitialized();

        const state = this._readThreadState(sessionId);
        if (!state?.codexThreadId) {
            throw new Error(
                `Codex runtime cannot resume session ${sessionId}: no persisted threadId in ${this.opts.sessionStateDir}`,
            );
        }
        const session = this._registerSession(sessionId, state.codexThreadId, {
            model: config?.model,
            reasoningEffort: config?.reasoningEffort,
            cwd: config?.cwd,
            developerInstructions: config?.developerInstructions,
            baseInstructions: config?.baseInstructions,
        });
        await session._issueThreadResume();
        if (config?.tools?.length) session.registerTools(config.tools);
        return session;
    }

    async deleteSession(sessionId: string): Promise<void> {
        // Validate the session id BEFORE any app-server round-trip or
        // recursive fs.rm. A malformed id would let deleteSession escape
        // sessionStateDir and rm arbitrary host directories.
        const stateDir = resolveSafeCodexSessionDir(this.opts.sessionStateDir, sessionId);
        const active = this.sessions.get(sessionId);
        const codexThreadId = active?.codexThreadId ?? this._readThreadState(sessionId)?.codexThreadId;
        if (this.transport && codexThreadId) {
            try {
                await this.transport.request("thread/delete", { threadId: codexThreadId });
            } catch {
                // Best-effort — treat as advisory.
            }
        }
        if (active) {
            active._teardown();
            this.sessions.delete(sessionId);
        }
        // Purge the ENTIRE per-session state directory. This includes the
        // Codex thread marker, any rollout snapshot copied out of
        // CODEX_HOME, and any other artifacts the runtime may have
        // written. This directory lives under `sessionStateDir` and is
        // fully owned by PilotSwarm — CODEX_HOME (which holds
        // `auth.json`) is a completely separate tree that we never touch.
        // Turn 0 relies on this to avoid archiving a previous thread's
        // rollout under a fresh thread's marker.
        if (fs.existsSync(stateDir)) {
            try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
        }
    }

    async stop(): Promise<void> {
        for (const session of this.sessions.values()) session._teardown();
        this.sessions.clear();
        if (this.transport) {
            try { await this.transport.close(); } catch {}
            this.transport = null;
        }
        this.initialized = false;
        this.initPromise = null;
    }

    /** Serialize app-server calls that must not overlap across sessions. */
    _enqueueTurn<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.turnQueue.then(fn, fn);
        // Swallow errors so a rejected turn does not poison the chain.
        this.turnQueue = next.then(() => undefined, () => undefined);
        return next;
    }

    private _ensureCodexHomeReady(): void {
        const home = this.opts.codexHome;
        if (!home || !fs.existsSync(home)) {
            throw new Error(
                `CODEX_HOME "${home}" does not exist. Log in with \`codex login\` first ` +
                `(or point the provider at an existing CODEX_HOME with mode 0700).`,
            );
        }
        let stat: fs.Stats;
        try {
            stat = fs.statSync(home);
        } catch (err) {
            throw new Error(`CODEX_HOME "${home}" is not readable: ${(err as Error).message}`);
        }
        if (!stat.isDirectory()) {
            throw new Error(`CODEX_HOME "${home}" is not a directory.`);
        }
        // POSIX permission check: CODEX_HOME must be 0700 or stricter
        // because `auth.json` inside it holds the ChatGPT session token.
        // We never open auth.json ourselves — but a group/world-readable
        // directory means anyone on the host can. On Windows the mode
        // bits do not carry POSIX semantics, so skip the check there.
        if (process.platform !== "win32") {
            const mode = stat.mode & 0o777;
            if (mode & 0o077) {
                throw new Error(
                    `CODEX_HOME "${home}" has insecure permissions ${mode.toString(8).padStart(3, "0")}. ` +
                    `Codex auth.json lives here; run \`chmod 0700 "${home}"\` before using it.`,
                );
            }
        }
    }

    private async _ensureInitialized(): Promise<void> {
        if (this.initialized && this.transport) return;
        // If a handshake is already in flight, both callers must await
        // the same promise. Do NOT clear it just because
        // `this.initialized` is still false — the promise is what will
        // set it. Stale-init detection happens exclusively inside the
        // transport-close handler (which nulls both `initPromise` and
        // `transport`) and in the catch below.
        if (!this.initPromise) {
            this.initPromise = (async () => {
                try {
                    if (!this.transport) {
                        this.transport = this.opts.transportFactory
                            ? this.opts.transportFactory()
                            : this._spawnRealTransport();
                        this._wireTransportEvents();
                    }
                    // Initialize handshake. `experimentalApi: true` is required
                    // for `ThreadStartParams.dynamicTools` to survive the
                    // experimental-field filter in codex 0.145.0; without it,
                    // Codex silently ignores our tool declarations.
                    await this.transport.request("initialize", {
                        clientInfo: { name: "pilotswarm", version: PILOTSWARM_CLIENT_INFO_VERSION },
                        capabilities: {
                            experimentalApi: true,
                            requestAttestation: false,
                        },
                    });
                    // Spec-required client `initialized` notification. Codex
                    // does not send subsequent responses to some requests until
                    // this arrives.
                    this.transport.notify("initialized", {});
                    this.initialized = true;
                    this.transportGeneration += 1;
                } catch (err) {
                    // Failed handshake: release the memoized promise so the
                    // next caller retries against a fresh transport rather
                    // than replaying our already-rejected attempt.
                    this.initialized = false;
                    this.initPromise = null;
                    if (this.transport) {
                        try { await this.transport.close(); } catch {}
                        this.transport = null;
                    }
                    throw err;
                }
            })();
        }
        await this.initPromise;
    }

    private _wireTransportEvents(): void {
        if (!this.transport) return;
        // Capture THIS wiring's transport in a local. Callbacks close
        // over the local, not the mutable `this.transport`, so a stale
        // event from a torn-down transport can never respond through,
        // null, or fire notifications on a subsequent transport.
        const wiredTransport = this.transport;

        wiredTransport.on("notification", (msg: { method: string; params: any }) => {
            if (this.transport !== wiredTransport) return;
            this._routeNotification(msg.method, msg.params);
        });
        wiredTransport.on("server-request", (req: { id: string | number; method: string; params: any }) => {
            if (this.transport !== wiredTransport) return;
            const target = this._routeServerRequest(req);
            if (!target) {
                wiredTransport.respondError(
                    req.id,
                    -32601,
                    `PilotSwarm cannot route server-request ${req.method}: no matching session`,
                );
                return;
            }
            void target._handleServerRequest(wiredTransport, req.id, req.method, req.params).catch((err) => {
                try { wiredTransport.respondError(req.id, -32000, `handler failure: ${(err as Error).message}`); } catch {}
            });
        });
        wiredTransport.on("close", () => {
            // Only tear down state if THIS wiring's transport is still
            // the client's active one. A stale close from a prior
            // transport is a no-op.
            if (this.transport !== wiredTransport) return;
            this.initialized = false;
            this.initPromise = null;
            this.transport = null;
            for (const session of this.sessions.values()) session._handleTransportClosed();
        });
    }

    /**
     * Route a session-scoped notification to at most one session.
     *
     * Codex 0.145.0 has been observed to omit `threadId` from a subset
     * of runtime notifications (matching the tool-call behavior). We
     * NEVER broadcast `turn/*`, `item/*`, or `error` — leaking those
     * to a sibling session would surface someone else's assistant text
     * and mark them idle. Routing order mirrors `_routeServerRequest`:
     *   1. exact `threadId` match
     *   2. `turnId` / `turn.id` matches an active session's live turn
     *   3. sole session with a live turn
     *   4. otherwise: drop.
     * @internal
     */
    private _routeNotification(method: string, params: any): void {
        const threadId = params?.threadId;
        if (typeof threadId === "string" && threadId) {
            for (const session of this.sessions.values()) {
                if (session.codexThreadId === threadId) {
                    session._handleNotification(method, params);
                    return;
                }
            }
            return;
        }
        const turnId = params?.turnId ?? params?.turn?.id;
        if (typeof turnId === "string" && turnId) {
            for (const session of this.sessions.values()) {
                if (session.getActiveTurnIdForTests() === turnId) {
                    session._handleNotification(method, params);
                    return;
                }
            }
            return;
        }
        const active: CodexRuntimeSession[] = [];
        for (const session of this.sessions.values()) {
            if (session.getActiveTurnIdForTests() != null) active.push(session);
        }
        if (active.length === 1) {
            active[0]._handleNotification(method, params);
        }
        // Otherwise drop — never broadcast session-scoped events.
    }

    /**
     * Route a server-initiated JSON-RPC request to the session that
     * owns it. Codex 0.145.0 has been observed to emit
     * `DynamicToolCallParams` both WITH and WITHOUT a `threadId` field
     * (the generated TypeScript type says it is required, but the
     * runtime sometimes omits it). Resolution order:
     *
     *   1. Nonempty `threadId` present → exact match or NOTHING.
     *      A nonempty threadId is authoritative. A stale/foreign/bogus
     *      threadId MUST NOT fall through to the turnId or "sole active
     *      session" heuristic and execute a tool against an innocent
     *      bystander. This mirrors `_routeNotification`.
     *   2. No threadId → match a session whose `activeTurnId` equals
     *      the request's `turnId`. Codex allocates turn ids per thread,
     *      so a matching turn id uniquely identifies a session.
     *   3. Neither threadId nor a matching turn id → if EXACTLY one
     *      session currently has a live turn (`activeTurnId != null`),
     *      that session is the only reasonable target. This mirrors the
     *      per-CODEX_HOME serialization: at most one live turn at a
     *      time under normal operation.
     *   4. Otherwise, return undefined and let the caller respond with
     *      a JSON-RPC error. Never route to an arbitrary idle session.
     *
     * @internal
     */
    private _routeServerRequest(req: { params: any }): CodexRuntimeSession | undefined {
        const threadId = req?.params?.threadId;
        const turnId = req?.params?.turnId;
        if (typeof threadId === "string" && threadId) {
            for (const session of this.sessions.values()) {
                if (session.codexThreadId === threadId) return session;
            }
            // Nonempty threadId is authoritative — never fall through
            // to turnId / sole-active. See _routeNotification for the
            // identical rule on notifications.
            return undefined;
        }
        if (typeof turnId === "string" && turnId) {
            for (const session of this.sessions.values()) {
                if (session.getActiveTurnIdForTests() === turnId) return session;
            }
        }
        const active: CodexRuntimeSession[] = [];
        for (const session of this.sessions.values()) {
            if (session.getActiveTurnIdForTests() != null) active.push(session);
        }
        if (active.length === 1) return active[0];
        return undefined;
    }

    private _spawnRealTransport(): CodexTransport {
        const bin = this.opts.codexBinaryPath || "codex";
        const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.opts.codexHome };
        const proc = spawn(bin, ["app-server", "--stdio"], {
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        return new SpawnedCodexAppServerTransport(proc);
    }

        /**
     * Persist the Codex↔PilotSwarm mapping for this session. May be called
     * more than once per session; later calls merge (they preserve any
     * pre-existing rolloutSnapshotRelPath so a subsequent write does not
     * blow away hydration state).
     */
    _persistThreadState(
        sessionId: string,
        codexThreadId: string,
        options?: { model?: string; rolloutSnapshotRelPath?: string | null },
    ): void {
        const dir = resolveSafeCodexSessionDir(this.opts.sessionStateDir, sessionId);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, CODEX_THREAD_STATE_FILENAME);
        let previous: Record<string, unknown> = {};
        if (fs.existsSync(file)) {
            try { previous = JSON.parse(fs.readFileSync(file, "utf-8")); } catch {}
        }
        const payload: Record<string, unknown> = {
            ...previous,
            codexThreadId,
            codexHome: this.opts.codexHome,
            ...(options?.model ? { model: options.model } : {}),
            savedAt: new Date().toISOString(),
        };
        if (options && Object.prototype.hasOwnProperty.call(options, "rolloutSnapshotRelPath")) {
            if (options.rolloutSnapshotRelPath) {
                payload.rolloutSnapshotRelPath = options.rolloutSnapshotRelPath;
            } else {
                delete payload.rolloutSnapshotRelPath;
            }
        }
        fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
    }

    _readThreadState(sessionId: string): {
        codexThreadId?: string;
        codexHome?: string;
        model?: string;
        rolloutSnapshotRelPath?: string;
    } | null {
        const dir = resolveSafeCodexSessionDir(this.opts.sessionStateDir, sessionId);
        const file = path.join(dir, CODEX_THREAD_STATE_FILENAME);
        if (!fs.existsSync(file)) return null;
        try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
    }

    private _registerSession(
        sessionId: string,
        codexThreadId: string,
        opts?: {
            model?: string;
            reasoningEffort?: string;
            cwd?: string;
            developerInstructions?: string;
            baseInstructions?: string;
        },
    ): CodexRuntimeSession {
        const session = new CodexRuntimeSession(this, sessionId, codexThreadId, opts);
        this.sessions.set(sessionId, session);
        return session;
    }

    /**
     * Unregister a session from the routing map — but only if the map
     * still points at THIS exact handle. If the session id has already
     * been re-registered (e.g. a resume raced ahead of an old handle's
     * disconnect cleanup) the replacement is preserved. Repeated calls
     * for the same handle are safe no-ops.
     * @internal
     */
    _unregisterSession(sessionId: string, handle: CodexRuntimeSession): void {
        const current = this.sessions.get(sessionId);
        if (current === handle) {
            this.sessions.delete(sessionId);
        }
    }

    /**
     * Exact-reference check: is `handle` still the currently-registered
     * session for `sessionId`? Used by disconnect() to decide whether a
     * stale handle may mutate the PilotSwarm per-session state
     * directory. A stale handle whose id was re-registered under a
     * fresh handle MUST NOT overwrite the replacement's marker/rollout.
     * @internal
     */
    _isCurrentSession(sessionId: string, handle: CodexRuntimeSession): boolean {
        return this.sessions.get(sessionId) === handle;
    }

    /**
     * Locate the rollout JSONL for the given codex threadId under
     * `<CODEX_HOME>/sessions/<yyyy>/<mm>/<dd>/rollout-*-<threadId>.jsonl`
     * and copy it into `<sessionStateDir>/<sessionId>/codex-rollout.jsonl`
     * so the FilesystemSessionStore snapshot can archive it as part of the
     * session-state tarball. `auth.json` (or anything else under
     * CODEX_HOME) is never inspected or copied.
     *
     * Persists the relative snapshot path back into codex-thread.json so
     * a subsequent resume knows to hand the path to `thread/resume`.
     *
     * No-op when no rollout is found — this is a best-effort snapshot,
     * not a hard requirement (Codex can re-locate the rollout inside
     * CODEX_HOME on same-node resume).
     *
     * @internal
     */
    _snapshotRolloutIfPresent(sessionId: string, codexThreadId: string): boolean {
        // Validate the session id BEFORE any filesystem write so a
        // malicious/malformed id cannot escape sessionStateDir.
        const sessionDir = resolveSafeCodexSessionDir(this.opts.sessionStateDir, sessionId);
        const rolloutPath = findCodexRolloutPath(this.opts.codexHome, codexThreadId);
        if (!rolloutPath) return false;
        fs.mkdirSync(sessionDir, { recursive: true });
        const dest = path.join(sessionDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME);
        try {
            // Read the raw bytes rather than fs.copyFileSync because
            // copyFileSync will happily traverse a symlink at the source
            // (findCodexRolloutPath already rejected those, but this is a
            // belt-and-braces safeguard so future refactors stay safe).
            const contents = fs.readFileSync(rolloutPath);
            fs.writeFileSync(dest, contents, { mode: 0o600 });
        } catch {
            return false;
        }
        this._persistThreadState(sessionId, codexThreadId, {
            rolloutSnapshotRelPath: CODEX_ROLLOUT_SNAPSHOT_FILENAME,
        });
        return true;
    }
}

/**
 * Walk `<codexHome>/sessions/**` for a rollout file whose UUID matches
 * `codexThreadId`. The Codex CLI writes them under `yyyy/mm/dd/`. We
 * bound the walk to at most 5 levels to avoid runaway traversal.
 *
 * Security constraints:
 *   - Symlinks (both directories and files) are IGNORED. `auth.json` sits
 *     next to `sessions/` under `CODEX_HOME`, and a malicious/misconfigured
 *     symlink named like a rollout would otherwise smuggle it into the
 *     durable archive.
 *   - Matches are also containment-checked against the real, resolved
 *     `sessions/` root so any accepted rollout must physically live
 *     underneath it.
 */
function findCodexRolloutPath(codexHome: string, codexThreadId: string): string | undefined {
    const suffix = `-${codexThreadId}.jsonl`;
    const root = path.join(codexHome, "sessions");
    if (!fs.existsSync(root)) return undefined;
    let realRoot: string;
    try {
        realRoot = fs.realpathSync(root);
    } catch {
        return undefined;
    }
    const stack: Array<{ dir: string; depth: number }> = [{ dir: realRoot, depth: 0 }];
    while (stack.length) {
        const { dir, depth } = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const dirent of entries) {
            const abs = path.join(dir, dirent.name);
            // lstat so we can positively identify symlinks and skip them.
            let st: fs.Stats;
            try { st = fs.lstatSync(abs); } catch { continue; }
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) {
                if (depth < 5) stack.push({ dir: abs, depth: depth + 1 });
                continue;
            }
            if (!st.isFile()) continue;
            if (!dirent.name.endsWith(suffix)) continue;
            // Containment check: the resolved path must still be under
            // realRoot. This defends against odd fs shapes where a
            // matching non-symlink entry could still traverse a mount
            // point outside of `sessions/`.
            let resolvedFile: string;
            try { resolvedFile = fs.realpathSync(abs); } catch { continue; }
            const rel = path.relative(realRoot, resolvedFile);
            if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
            return resolvedFile;
        }
    }
    return undefined;
}

// ─── Public config type ──────────────────────────────────────────

export interface CodexCreateSessionConfig {
    sessionId: string;
    /** Model, e.g. `gpt-5.6-sol`. Omit to use Codex default. */
    model?: string;
    /** Working directory the model should assume. */
    cwd?: string;
    /**
     * Developer instructions (system prompt) that layer on top of the
     * built-in Codex base instructions.
     */
    developerInstructions?: string;
    /** Full replacement for the built-in Codex base instructions. Rare. */
    baseInstructions?: string;
    /** Reasoning effort hint for turn/start. */
    reasoningEffort?: string;
    /** Dynamic tool set declared at thread/start and refreshed each turn. */
    tools?: Tool<any>[];
    /** Anything else the caller wants passed through. */
    [key: string]: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────

function buildDynamicToolSpecs(tools?: Tool<any>[]): Array<{ type: "function"; name: string; description: string; inputSchema: unknown }> {
    if (!tools?.length) return [];
    const specs: Array<{ type: "function"; name: string; description: string; inputSchema: unknown }> = [];
    const seen = new Set<string>();
    for (const t of tools) {
        const tool = t as any;
        const name = typeof tool?.name === "string" ? tool.name : "";
        if (!name || seen.has(name)) continue;
        seen.add(name);
        specs.push({
            type: "function",
            name,
            description: typeof tool.description === "string" ? tool.description : "",
            inputSchema: toJsonSchema(tool.parameters),
        });
    }
    return specs;
}

/**
 * Convert a Copilot SDK `Tool.parameters` value into the JSON Schema
 * the Codex `dynamicTools` array expects.
 *   - Objects that carry a callable `toJSONSchema()` (Zod v3+) are
 *     converted via that method — matches Copilot SDK contract.
 *   - Plain object schemas pass through unchanged.
 *   - `undefined` / `null` map to an empty object schema so Codex has
 *     a well-formed inputSchema.
 * @internal
 */
export function toJsonSchema(parameters: unknown): Record<string, unknown> {
    if (parameters == null) return { type: "object", properties: {} };
    if (typeof parameters === "object") {
        const asAny = parameters as any;
        if (typeof asAny.toJSONSchema === "function") {
            try {
                const out = asAny.toJSONSchema();
                if (out && typeof out === "object") return out;
            } catch {
                return { type: "object", properties: {} };
            }
        }
        return parameters as Record<string, unknown>;
    }
    return { type: "object", properties: {} };
}

/**
 * Copilot SDK's public `ToolResultObject` contract, normalized down to
 * what Codex's `DynamicToolCallResponse` needs.
 *   - `null` / `undefined`      → `{text:"", success:true}`
 *   - `string`                  → `{text, success:true}`
 *   - `{textResultForLlm,...}`  → text passed through; `success` true
 *                                 iff `resultType === "success"`
 *   - anything else             → `JSON.stringify` (fall back to `""`
 *                                 if `stringify` returns `undefined`,
 *                                 e.g. `stringify(undefined)`)
 * The `text` field is ALWAYS a string so Codex's DynamicToolCallResponse
 * shape is well-formed.
 * @internal
 */
export function normalizeToolResult(raw: unknown): { text: string; success: boolean; resultType?: string; error?: string } {
    if (raw == null) return { text: "", success: true };
    if (typeof raw === "string") return { text: raw, success: true };
    if (typeof raw === "object") {
        const asAny = raw as any;
        if (typeof asAny.textResultForLlm === "string") {
            const resultType = typeof asAny.resultType === "string" ? asAny.resultType : undefined;
            const success = resultType === "success";
            const error = typeof asAny.error === "string" ? asAny.error : undefined;
            const out: { text: string; success: boolean; resultType?: string; error?: string } = {
                text: asAny.textResultForLlm,
                success,
            };
            if (resultType) out.resultType = resultType;
            if (error) out.error = error;
            return out;
        }
    }
    let text: string;
    try {
        const stringified = JSON.stringify(raw);
        text = typeof stringified === "string" ? stringified : "";
    } catch {
        text = "";
    }
    return { text, success: true };
}

function extractThreadId(startResult: unknown): string | undefined {
    if (!startResult || typeof startResult !== "object") return undefined;
    const r = startResult as any;
    if (typeof r.threadId === "string") return r.threadId;
    if (r.thread && typeof r.thread.id === "string") return r.thread.id;
    return undefined;
}

// ─── Codex Runtime Session ───────────────────────────────────────

type EventHandler = (event: any) => void;

/**
 * Per-in-flight-turn state used to coordinate abort() with the async
 * turn/start ↔ turn/completed lifecycle. Reset on every `send()`.
 *
 * `terminal` flips true the first time the turn reaches an ending
 * (`turn/completed`, `error`, transport close, or turn/start request
 * failure). After that:
 *   - the queued lambda's post-ack respTurnId latch is skipped so a
 *     late turn/start response cannot re-latch a stale turn id on a
 *     session that is already idle.
 *   - subsequent terminal paths (e.g. transport close after a normal
 *     completion) skip emitting `session.idle` / `assistant.turn_end`
 *     to avoid duplicate lifecycle events on a single turn.
 * @internal
 */
interface PerTurnState {
    aborted: boolean;
    terminal: boolean;
    respTurnId: string | null;
}

/** @internal */
export class CodexRuntimeSession implements RuntimeSessionHandle {
    readonly codexThreadId: string;
    readonly sessionId: string;
    private readonly client: CodexRuntimeClient;
    private tools = new Map<string, Tool<any>>();
    private catchAll = new Set<EventHandler>();
    private typedHandlers = new Map<string, Set<EventHandler>>();
    private activeTurnId: string | null = null;
    private turnResolver: (() => void) | null = null;
    private turnEndFired = false;
    private turnAccumulatedText = "";
    private turnTokenUsage: unknown = null;
    private latestMessagesByItem = new Map<string, string>();
    private defaultModel: string | undefined;
    private defaultReasoningEffort: string | undefined;
    private defaultCwd: string | undefined;
    private defaultDeveloperInstructions: string | undefined;
    private defaultBaseInstructions: string | undefined;
    /** The in-flight send() invocation, if any. @internal */
    private _currentTurn: PerTurnState | null = null;
    /**
     * Transport generation this session was last successfully attached to
     * (via createSession or a subsequent `thread/resume`). If the client's
     * generation moves past this, `send()` transparently re-inits and
     * resumes the thread before it fires `turn/start`.
     */
    private attachedGeneration = 0;

    constructor(
        client: CodexRuntimeClient,
        sessionId: string,
        codexThreadId: string,
        opts?: {
            model?: string;
            reasoningEffort?: string;
            cwd?: string;
            developerInstructions?: string;
            baseInstructions?: string;
        },
    ) {
        this.client = client;
        this.sessionId = sessionId;
        this.codexThreadId = codexThreadId;
        this.defaultModel = opts?.model;
        this.defaultReasoningEffort = opts?.reasoningEffort;
        this.defaultCwd = opts?.cwd;
        this.defaultDeveloperInstructions = opts?.developerInstructions;
        this.defaultBaseInstructions = opts?.baseInstructions;
        this.attachedGeneration = client.generation;
    }

    /**
     * Refresh the tool handler map. Codex `dynamicTools` are thread-start
     * scoped, so re-registration cannot introduce a brand-new schema
     * mid-thread — this only swaps handlers that back names Codex already
     * knows about. Call it every turn to keep handlers aligned with the
     * managed session's current tool set.
     */
    registerTools(tools: Tool<any>[]): void {
        this.tools.clear();
        for (const t of tools) {
            const name = (t as any)?.name;
            if (!name) continue;
            this.tools.set(name, t);
        }
    }

    on(catchAllOrType: EventHandler | string, handler?: EventHandler): () => void {
        if (typeof catchAllOrType === "function") {
            this.catchAll.add(catchAllOrType);
            return () => { this.catchAll.delete(catchAllOrType); };
        }
        const key = catchAllOrType;
        if (!this.typedHandlers.has(key)) this.typedHandlers.set(key, new Set());
        this.typedHandlers.get(key)!.add(handler!);
        return () => { this.typedHandlers.get(key)?.delete(handler!); };
    }

    async send(params: { prompt: string; [key: string]: unknown }): Promise<void> {
        // Codex.send() mirrors Copilot.send() semantics: resolve after the
        // runtime has accepted the prompt (turn/start ack), NOT after
        // turn/completed. ManagedSession.runTurn() does
        //   await session.send(...)   // wire ack
        //   await race(sessionIdle, timeout)
        // Blocking send() on completion would make the outer timeout race
        // impossible to start against a hung turn.
        //
        // Per-CODEX_HOME serialization is separately preserved: the queue
        // lambda holds a completion promise until turn/completed / error
        // / transport close, so a second session's turn/start cannot fire
        // until the first turn actually finishes on the server.
        const perTurn: PerTurnState = {
            aborted: false,
            terminal: false,
            respTurnId: null,
        };
        this._currentTurn = perTurn;

        // `ack` resolves after turn/start returns; `rejectAck` propagates
        // request failures back to the caller instead of only becoming a
        // session.error event.
        let ackResolve!: () => void;
        let ackReject!: (err: Error) => void;
        const ack = new Promise<void>((resolve, reject) => {
            ackResolve = resolve;
            ackReject = reject;
        });

        const queued = this.client._enqueueTurn(async () => {
            // If abort() ran before this lambda even started, do not
            // consume a Codex turn. Route through the terminal helper
            // so the queue release is bookkept the same way as every
            // other end-of-turn path.
            if (perTurn.aborted) {
                this._markTurnTerminal({ emitEnd: false, emitIdle: true });
                ackResolve();
                return;
            }

            // Reconnect gate: if the transport has been torn down (crash,
            // stop, initial-connect timeout) since this session was last
            // attached, re-init and re-resume THIS thread before firing
            // turn/start. Otherwise we'd send turn/start to a fresh
            // app-server that has never heard of the thread.
            try {
                await this._ensureAttachedToCurrentTransport();
            } catch (err) {
                const message = (err as Error).message || "codex reconnect failed";
                this._emit({ type: "session.error", data: { message } });
                this._markTurnTerminal({ emitEnd: false, emitIdle: true });
                ackReject(err as Error);
                return;
            }

            this.turnEndFired = false;
            this.turnAccumulatedText = "";
            this.turnTokenUsage = null;
            this.latestMessagesByItem.clear();
            const transport = (this.client as any).transport as CodexTransport | null;
            if (!transport) {
                const message = "Codex transport is not connected";
                this._emit({ type: "session.error", data: { message } });
                this._markTurnTerminal({ emitEnd: false, emitIdle: true });
                ackReject(new Error(message));
                return;
            }

            const completion = new Promise<void>((resolve) => {
                this.turnResolver = resolve;
            });

            const turnParams: Record<string, unknown> = {
                threadId: this.codexThreadId,
                input: [{ type: "text", text: params.prompt, text_elements: [] }],
            };
            if (this.defaultModel) turnParams.model = this.defaultModel;
            if (this.defaultReasoningEffort) turnParams.effort = this.defaultReasoningEffort;
            const requiredTool = params.requiredTool;
            if (typeof requiredTool === "string" && requiredTool) {
                turnParams.responsesapiClientMetadata = { pilotswarmRequiredTool: requiredTool };
            }

            let startResp: any;
            try {
                startResp = await transport.request("turn/start", turnParams);
            } catch (err) {
                this._emit({ type: "session.error", data: { message: (err as Error).message } });
                this._markTurnTerminal({ emitEnd: false, emitIdle: true });
                ackReject(err as Error);
                return;
            }
            // Latch the turn id from the response so abort() can build a
            // valid turn/interrupt even before turn/started notification.
            //
            // Skip the SESSION-WIDE `activeTurnId` latch when the per-
            // turn state is already terminal (a turn/completed / error /
            // transport-close raced ahead of the delayed turn/start
            // response) or when the session has moved on to a different
            // in-flight turn. Either case would leave a stale
            // `activeTurnId` behind that `_routeServerRequest` and
            // `_routeNotification` would interpret as "still active".
            //
            // We still record `perTurn.respTurnId` unconditionally so
            // the abort/interrupt path can address the turn we actually
            // sent even if the per-turn was aborted while turn/start
            // was in flight.
            const respTurnId = startResp?.turn?.id;
            const stillCurrent = this._currentTurn === perTurn;
            if (typeof respTurnId === "string" && respTurnId) {
                perTurn.respTurnId = respTurnId;
                if (stillCurrent && !perTurn.terminal && !perTurn.aborted) {
                    this.activeTurnId = respTurnId;
                }
            }
            // send() returns here — the caller can now start its own idle
            // race. The queue stays held below on `await completion`.
            ackResolve();
            // Late abort: caller invoked abort() between the moment we
            // sent turn/start and the moment the response came back. Now
            // that we know the turn id we can interrupt. Use
            // perTurn.respTurnId (not this.activeTurnId) because the
            // aborted-late guard above intentionally suppressed the
            // session-wide latch.
            if (perTurn.aborted && perTurn.respTurnId) {
                void transport.request("turn/interrupt", {
                    threadId: this.codexThreadId,
                    turnId: perTurn.respTurnId,
                }).catch(() => {});
            }
            try {
                await completion;
            } finally {
                if (this._currentTurn === perTurn) this._currentTurn = null;
            }
        });
        // The queued function's rejection is already surfaced via
        // session.error / ackReject — swallow the raw promise rejection so
        // it does not become an unhandled rejection.
        queued.catch(() => {});
        return ack;
    }

    /** Test hook — snapshots the latched active turn id. */
    getActiveTurnIdForTests(): string | null {
        return this.activeTurnId;
    }

    /**
     * Idempotent reconnect: if the runtime client has spawned a fresh
     * transport since this session was last attached (transport crash,
     * SessionManager.shutdown, initial-connect failure), re-run the
     * initialize handshake AND issue `thread/resume` for this session's
     * threadId before returning. Callers should invoke this before any
     * per-session RPC that assumes the app-server knows the thread
     * (currently `send()` / `turn/start`).
     *
     * `thread/resume` params include the persisted rollout snapshot
     * path (when present) plus the last-known model / cwd /
     * developerInstructions / baseInstructions so the reconnected
     * thread reflects the same configuration the session was created
     * with. Codex retains the thread's `dynamicTools` schemas across
     * resume — no re-declaration is needed there.
     *
     * A resume failure surfaces as a thrown error and (on the caller
     * path) an emitted `session.error` + `session.idle`. We DO NOT
     * silently start a new thread — that would drop the caller's
     * durable history.
     *
     * @internal
     */
    private async _ensureAttachedToCurrentTransport(): Promise<void> {
        // Force a re-init if the client has no transport, or if the
        // last successful init advanced past our attachment.
        const client: any = this.client;
        const transportPresent = client.transport != null;
        if (transportPresent && client.generation === this.attachedGeneration) return;
        await client._ensureInitialized();
        if (this.attachedGeneration === client.generation && transportPresent) return;
        // Re-issue thread/resume for THIS session on the fresh transport.
        await this._issueThreadResume();
    }

    /**
     * Send `thread/resume` for this session's Codex threadId using the
     * stored per-session config and any rollout snapshot the runtime
     * has persisted. Updates `attachedGeneration` on success.
     * @internal
     */
    async _issueThreadResume(): Promise<void> {
        const client: any = this.client;
        const transport = client.transport as CodexTransport | null;
        if (!transport) throw new Error("Codex transport is not connected");
        const state = client._readThreadState(this.sessionId);
        const params: Record<string, unknown> = { threadId: this.codexThreadId };
        const rolloutRel = state?.rolloutSnapshotRelPath;
        if (rolloutRel) {
            const abs = path.isAbsolute(rolloutRel)
                ? rolloutRel
                : path.join(client.opts.sessionStateDir, this.sessionId, rolloutRel);
            if (fs.existsSync(abs)) params.path = abs;
        }
        if (this.defaultModel) params.model = this.defaultModel;
        if (this.defaultCwd) params.cwd = this.defaultCwd;
        if (this.defaultDeveloperInstructions) params.developerInstructions = this.defaultDeveloperInstructions;
        if (this.defaultBaseInstructions) params.baseInstructions = this.defaultBaseInstructions;
        try {
            await transport.request("thread/resume", params);
        } catch (err) {
            throw new Error(
                `Codex thread/resume failed for session ${this.sessionId} thread ${this.codexThreadId}: ${(err as Error).message}`,
            );
        }
        this.attachedGeneration = client.generation;
    }

    /**
     * Cooperative abort. Handles three windows:
     *   1. queued but not yet started — sets the flag; the lambda short-circuits.
     *   2. turn/start sent but response not yet returned — sets the flag;
     *      the lambda fires turn/interrupt as soon as the response yields
     *      a turn id.
     *   3. turn active — fires turn/interrupt immediately.
     * The turn/interrupt request itself is fire-and-forget; the real
     * shutdown signal comes from the turn/completed notification with
     * status="interrupted".
     */
    abort(): void {
        const perTurn = this._currentTurn;
        if (perTurn) perTurn.aborted = true;
        const transport = (this.client as any).transport as CodexTransport | null;
        if (!transport || !this.activeTurnId) return;
        void transport.request("turn/interrupt", {
            threadId: this.codexThreadId,
            turnId: this.activeTurnId,
        }).catch(() => {});
    }

    async disconnect(): Promise<void> {
        // A stale handle (one whose PilotSwarm sessionId was already
        // re-registered under a fresh handle) MUST NOT mutate the
        // per-session state directory. The exact-reference check runs
        // BEFORE the synchronous `_snapshotRolloutIfPresent` call so
        // there is no scheduling window in which another turn could
        // swap the current handle between the check and the write:
        // Node is single-threaded and the snapshot performs only sync
        // fs operations (mkdirSync/readFileSync/writeFileSync).
        //
        // We still perform a best-effort `thread/unsubscribe` for THIS
        // handle's codex thread even when stale — that keeps the
        // app-server from streaming further notifications for a thread
        // this process no longer wants — but we never touch the
        // PilotSwarm-owned filesystem in that path.
        //
        // Cleanup (`_unregisterSession` with the exact-handle guard,
        // and `_teardown()`) always runs via try/finally so a failed
        // snapshot never leaks a routable handle in `client.sessions`.
        // Snapshot errors are NOT swallowed: they propagate so
        // operators see genuine filesystem failures.
        try {
            if (this.client._isCurrentSession(this.sessionId, this)) {
                this.client._snapshotRolloutIfPresent(this.sessionId, this.codexThreadId);
            }
            const transport = (this.client as any).transport as CodexTransport | null;
            if (transport) {
                try {
                    await transport.request("thread/unsubscribe", { threadId: this.codexThreadId });
                } catch {
                    // Best-effort — the app-server may not know this thread anymore.
                }
            }
        } finally {
            this.client._unregisterSession(this.sessionId, this);
            this._teardown();
        }
    }

    /**
     * Snapshot the rollout without disconnecting. Called by
     * SessionManager BEFORE `sessionStore.checkpoint()` so warm-session
     * checkpoints and pre-destroy safety checkpoints include the
     * rollout. Filesystem-only; safe to call at any time.
     *
     * Guarded by the same exact-reference check as `disconnect()`: a
     * stale handle whose sessionId has already been re-registered
     * MUST NOT overwrite the replacement's marker or rollout.
     */
    snapshot(): void {
        if (!this.client._isCurrentSession(this.sessionId, this)) return;
        try {
            this.client._snapshotRolloutIfPresent(this.sessionId, this.codexThreadId);
        } catch {}
    }

    async getMessages(): Promise<unknown[]> {
        const transport = (this.client as any).transport as CodexTransport | null;
        if (!transport) return [];
        try {
            const readResult: any = await transport.request("thread/read", {
                threadId: this.codexThreadId,
                includeTurns: true,
            });
            const items = readResult?.thread?.turns ?? readResult?.turns ?? [];
            return Array.isArray(items) ? items : [];
        } catch {
            return [];
        }
    }

    // ─── Notification / ServerRequest fanout ────────────────

    /**
     * Centralized end-of-turn cleanup used by every terminal path
     * (`turn/completed`, `error`, transport close, turn/start request
     * failure). Guarantees:
     *   - `activeTurnId` is cleared exactly once per terminal event.
     *   - the per-turn state (if still current) is flagged terminal so
     *     the queued send() lambda's post-ack respTurnId latch is a
     *     no-op if the turn already ended.
     *   - `session.idle` and `assistant.turn_end` are emitted at most
     *     once per turn. A second terminal (e.g. transport close after
     *     `turn/completed`) never re-fires them.
     *   - `turnResolver` is called at most once so the per-CODEX_HOME
     *     queue releases exactly once.
     * @internal
     */
    private _markTurnTerminal(reason: {
        emitEnd?: { tokenUsage?: unknown } | false;
        emitIdle: boolean;
    }): void {
        const alreadyTerminal = this.turnEndFired;
        if (this._currentTurn) this._currentTurn.terminal = true;
        if (reason.emitEnd && !alreadyTerminal) {
            this._emit({
                type: "assistant.turn_end",
                data: {
                    turnId: this.activeTurnId,
                    tokenUsage: (reason.emitEnd as { tokenUsage?: unknown }).tokenUsage ?? this.turnTokenUsage,
                },
            });
        }
        if (reason.emitIdle && !alreadyTerminal) {
            this._emit({ type: "session.idle", data: {} });
        }
        this.activeTurnId = null;
        this.turnEndFired = true;
        if (this.turnResolver) {
            const resolve = this.turnResolver;
            this.turnResolver = null;
            resolve();
        }
    }

    /** @internal */
    _handleNotification(method: string, params: any): void {
        switch (method) {
            case "turn/started": {
                this.activeTurnId = params?.turn?.id ?? params?.turnId ?? null;
                this._emit({ type: "assistant.turn_start", data: { turnId: this.activeTurnId } });
                return;
            }
            case "turn/completed": {
                const tokenUsage = params?.turn?.tokenUsage ?? this.turnTokenUsage;
                this._markTurnTerminal({ emitEnd: { tokenUsage }, emitIdle: true });
                return;
            }
            case "thread/tokenUsage/updated": {
                this.turnTokenUsage = params?.tokenUsage ?? this.turnTokenUsage;
                return;
            }
            case "item/agentMessage/delta": {
                const delta = String(params?.delta ?? "");
                this.turnAccumulatedText += delta;
                this._emit({
                    type: "assistant.message_delta",
                    data: { deltaContent: delta, itemId: params?.itemId, turnId: params?.turnId },
                });
                return;
            }
            case "item/reasoning/textDelta":
            case "item/reasoning/summaryTextDelta": {
                const delta = String(params?.delta ?? params?.text ?? "");
                this._emit({
                    type: "assistant.reasoning_delta",
                    data: { deltaContent: delta, itemId: params?.itemId, turnId: params?.turnId },
                });
                return;
            }
            case "item/started": {
                const item = params?.item;
                if (item?.type === "agentMessage") {
                    // no separate turn-start needed
                }
                return;
            }
            case "item/completed": {
                const item = params?.item;
                if (!item) return;
                if (item.type === "agentMessage") {
                    const text = String(item.text ?? "");
                    this.latestMessagesByItem.set(item.id, text);
                    this._emit({ type: "assistant.message", data: { content: text, itemId: item.id, turnId: params?.turnId } });
                    return;
                }
                if (item.type === "reasoning") {
                    const text = String(item.text ?? item.summary ?? "");
                    this._emit({ type: "assistant.reasoning", data: { content: text, itemId: item.id, turnId: params?.turnId } });
                    return;
                }
                return;
            }
            case "error": {
                this._emit({ type: "session.error", data: params ?? {} });
                // Route through the centralized terminal path so
                // activeTurnId is cleared and no duplicate session.idle
                // can fire from a subsequent transport close on the
                // same turn.
                this._markTurnTerminal({ emitEnd: false, emitIdle: true });
                return;
            }
            default:
                return;
        }
    }

    /** @internal */
    async _handleServerRequest(
        transport: CodexTransport,
        id: string | number,
        method: string,
        params: any,
    ): Promise<void> {
        if (method === "item/tool/call") {
            const toolName: string = params?.tool ?? "";
            const rawArgs = params?.arguments ?? {};
            const tool = this.tools.get(toolName);
            const callId: string = params?.callId ?? "";
            this._emit({
                type: "tool.execution_start",
                data: { toolName, arguments: rawArgs, callId, turnId: params?.turnId },
            });
            if (!tool) {
                transport.respond(id, {
                    success: false,
                    contentItems: [{ type: "inputText", text: `Unknown tool: ${toolName}` }],
                });
                this._emit({
                    type: "tool.execution_complete",
                    data: { toolName, callId, turnId: params?.turnId, success: false, error: "unknown tool" },
                });
                return;
            }
            // Standard Copilot SDK ToolInvocation context. Handlers
            // may inspect any of these fields.
            const invocation: Record<string, unknown> = {
                sessionId: this.sessionId,
                toolCallId: callId,
                toolName,
                arguments: rawArgs,
            };
            const traceparent = params?.traceparent;
            const tracestate = params?.tracestate;
            if (typeof traceparent === "string") invocation.traceparent = traceparent;
            if (typeof tracestate === "string") invocation.tracestate = tracestate;

            let normalized: { text: string; success: boolean; resultType?: string; error?: string };
            try {
                const rawResult = await (tool as any).handler(rawArgs, invocation);
                normalized = normalizeToolResult(rawResult);
            } catch (err) {
                normalized = {
                    text: err instanceof Error ? err.message : String(err ?? "tool threw"),
                    success: false,
                    resultType: "failure",
                    error: err instanceof Error ? err.message : String(err ?? "tool threw"),
                };
            }
            transport.respond(id, {
                success: normalized.success,
                contentItems: [{ type: "inputText", text: normalized.text }],
            });
            this._emit({
                type: "tool.execution_complete",
                data: {
                    toolName,
                    callId,
                    turnId: params?.turnId,
                    success: normalized.success,
                    result: normalized.text,
                    ...(normalized.resultType ? { resultType: normalized.resultType } : {}),
                    ...(normalized.error ? { error: normalized.error } : {}),
                },
            });
            return;
        }
        // Unhandled server request — refuse politely.
        transport.respondError(id, -32601, `Method ${method} not implemented by PilotSwarm Codex runtime`);
    }

    /** @internal */
    _handleTransportClosed(): void {
        // Session-level error is always meaningful even if a normal
        // completion already fired; operators want to see the transport
        // closure. session.idle / activeTurnId cleanup routes through
        // `_markTurnTerminal` so it never double-fires after a normal
        // turn/completed and never leaves a stale activeTurnId behind
        // that would let missing-threadId server-requests target a
        // crashed session.
        this._emit({ type: "session.error", data: { message: "Codex app-server transport closed" } });
        this._markTurnTerminal({ emitEnd: false, emitIdle: true });
    }

    /** @internal */
    _teardown(): void {
        this.catchAll.clear();
        this.typedHandlers.clear();
    }

    private _emit(event: { type: string; data: any }): void {
        for (const handler of this.catchAll) {
            try { handler(event); } catch {}
        }
        const typed = this.typedHandlers.get(event.type);
        if (typed) {
            for (const handler of typed) {
                try { handler(event); } catch {}
            }
        }
    }
}

// ─── Real transport: spawned `codex app-server --stdio` ──────────

/**
 * JSON-RPC 2.0 line transport over a child process's stdio.
 * @internal
 */
export class SpawnedCodexAppServerTransport extends EventEmitter implements CodexTransport {
    private readonly proc: ChildProcess;
    private nextId = 1;
    private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private buf = "";
    private closed = false;
    /**
     * Ring buffer of the most recent stderr lines from the child process.
     * Attached to pending-request rejections so operators can see why
     * app-server tore down without leaking auth material.
     */
    private stderrTail: string[] = [];
    private static STDERR_TAIL_MAX = 40;

    constructor(proc: ChildProcess) {
        super();
        this.proc = proc;
        if (!proc.stdout || !proc.stdin) {
            throw new Error("codex app-server child process must have stdio pipes");
        }
        proc.stdout.setEncoding("utf-8");
        proc.stdout.on("data", (chunk: string) => this._onData(chunk));
        proc.stdout.on("close", () => this._handleClose());
        if (proc.stderr) {
            proc.stderr.setEncoding?.("utf-8");
            proc.stderr.on("data", (chunk: string) => this._onStderr(chunk));
        }
        proc.on("exit", (code, signal) => this._handleExit(code, signal));
        proc.on("error", (err) => {
            for (const { reject } of this.pending.values()) reject(err);
            this.pending.clear();
        });
    }

    request(method: string, params: unknown): Promise<any> {
        return new Promise((resolve, reject) => {
            if (this.closed) return reject(new Error("codex transport closed"));
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            // Real `codex app-server` does not require `jsonrpc` on requests
            // and never emits it on responses. Sending it here is harmless
            // (the server accepts it) but we could drop it — we keep it so
            // any downstream JSON-RPC middleware that wants the tag is happy.
            this._write({ jsonrpc: "2.0", id, method, params });
        });
    }

    notify(method: string, params: unknown): void {
        if (this.closed) return;
        this._write({ jsonrpc: "2.0", method, params });
    }

    respond(id: string | number, result: unknown): void {
        if (this.closed) return;
        this._write({ id, result });
    }

    respondError(id: string | number, code: number, message: string): void {
        if (this.closed) return;
        this._write({ id, error: { code, message } });
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        try { this.proc.stdin?.end(); } catch {}
        try { this.proc.kill("SIGTERM"); } catch {}
    }

    private _write(msg: unknown): void {
        try {
            this.proc.stdin!.write(JSON.stringify(msg) + "\n");
        } catch {
            // The child exited between checks — treat as closed.
            this._handleClose();
        }
    }

    private _onData(chunk: string): void {
        this.buf += chunk;
        while (true) {
            const nl = this.buf.indexOf("\n");
            if (nl < 0) break;
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (!line) continue;
            let msg: any;
            try { msg = JSON.parse(line); } catch { continue; }
            this._dispatch(msg);
        }
    }

    private _onStderr(chunk: string): void {
        const lines = String(chunk).split(/\r?\n/);
        for (const raw of lines) {
            const trimmed = raw.trim();
            if (!trimmed) continue;
            this.stderrTail.push(trimmed);
            if (this.stderrTail.length > SpawnedCodexAppServerTransport.STDERR_TAIL_MAX) {
                this.stderrTail.splice(0, this.stderrTail.length - SpawnedCodexAppServerTransport.STDERR_TAIL_MAX);
            }
        }
    }

    /**
     * The real `codex app-server` speaks JSON-RPC-shaped messages but omits
     * the `jsonrpc` field on responses, errors, notifications, and even
     * server-initiated requests. Discriminate by shape instead of by tag:
     *
     *   - `{id, result}` or `{id, error}` (no method) → response
     *   - `{id, method, params}`                     → server-request
     *   - `{method, params}` (no id)                 → notification
     */
    private _dispatch(msg: any): void {
        if (!msg || typeof msg !== "object") return;
        const hasId = msg.id !== undefined && msg.id !== null;
        const hasMethod = typeof msg.method === "string" && msg.method.length > 0;
        const hasResult = Object.prototype.hasOwnProperty.call(msg, "result");
        const hasError = Object.prototype.hasOwnProperty.call(msg, "error");

        if (hasId && !hasMethod && (hasResult || hasError)) {
            const pending = this.pending.get(msg.id);
            if (!pending) return;
            this.pending.delete(msg.id);
            if (hasError) {
                const code = msg.error?.code ?? -32000;
                const message = msg.error?.message ?? "codex error";
                pending.reject(new Error(`${code}: ${message}`));
            } else {
                pending.resolve(msg.result);
            }
            return;
        }
        if (hasMethod) {
            if (hasId) {
                this.emit("server-request", { id: msg.id, method: msg.method, params: msg.params });
            } else {
                this.emit("notification", { method: msg.method, params: msg.params });
            }
        }
    }

    private _handleExit(code: number | null, signal: NodeJS.Signals | null): void {
        if (this.closed && this.pending.size === 0) {
            this.emit("close");
            return;
        }
        this.closed = true;
        const tail = this.stderrTail.slice(-8).join(" | ");
        const desc = signal
            ? `codex app-server exited via signal ${signal}`
            : `codex app-server exited with code ${code ?? "unknown"}`;
        const message = tail ? `${desc}: ${tail}` : desc;
        for (const { reject } of this.pending.values()) {
            reject(new Error(message));
        }
        this.pending.clear();
        this.emit("close");
    }

    private _handleClose(): void {
        if (this.closed) return;
        this.closed = true;
        const tail = this.stderrTail.slice(-8).join(" | ");
        const message = tail
            ? `codex transport closed: ${tail}`
            : "codex transport closed";
        for (const { reject } of this.pending.values()) {
            reject(new Error(message));
        }
        this.pending.clear();
        this.emit("close");
    }
}

// ─── Fake transport (test injection) ─────────────────────────────

export interface FakeCodexTransportScenario {
    thread: { id: string };
    /** Optional deterministic turn id to return from `turn/start`. Defaults to `fake-turn-N`. */
    turnId?: string;
    /** Sequence of events to emit for the next `turn/start`. */
    turnScript?: Array<
        | { emit: "notification"; method: string; params: any }
        | { emit: "server-request"; method: string; params: any }
        | { emit: "hold" }
    >;
}

export interface FakeCodexTransport extends CodexTransport {
    /**
     * Every message sent by the runtime. `kind` distinguishes requests
     * from notifications so tests can assert on either without
     * ambiguity. Server-request-responses are recorded separately in
     * `recordedResponses`.
     */
    recordedRequests: Array<{ kind: "request" | "notification"; method: string; params: any }>;
    /** Every response (server-request-response) written back by the runtime. */
    recordedResponses: Array<{ type: "server-request-response"; id: string | number; result?: any; error?: any }>;
}

class InMemoryFakeCodexTransport extends EventEmitter implements FakeCodexTransport {
    recordedRequests: Array<{ kind: "request" | "notification"; method: string; params: any }> = [];
    recordedResponses: Array<{ type: "server-request-response"; id: string | number; result?: any; error?: any }> = [];
    private scenario: FakeCodexTransportScenario;
    private nextServerReqId = 1;
    private threadStartCount = 0;
    private closed = false;
    /** Populated by the runtime just before it fires `turn/interrupt`. */
    private activeTurnId: string | null = null;
    /** Pending completion resolvers for turn/start, one per in-flight turn. */
    private pendingTurnCompletion: Array<() => void> = [];

    constructor(scenario: FakeCodexTransportScenario) {
        super();
        this.scenario = scenario;
    }

    async request(method: string, params: unknown): Promise<any> {
        this.recordedRequests.push({ kind: "request", method, params });
        switch (method) {
            case "initialize":
                return { serverInfo: { name: "fake-codex", version: "0.0" }, capabilities: {} };
            case "thread/start": {
                // Real Codex allocates a unique threadId per thread/start.
                // The first call returns scenario.thread.id verbatim so
                // hand-authored notification scripts still line up; later
                // calls get a suffixed id so cross-session tests don't
                // accidentally cross-wire their state.
                const id = this.threadStartCount === 0
                    ? this.scenario.thread.id
                    : `${this.scenario.thread.id}-${this.threadStartCount}`;
                this.threadStartCount += 1;
                return { thread: { id } };
            }
            case "thread/resume":
                return { thread: { id: (params as any)?.threadId ?? this.scenario.thread.id } };
            case "thread/read":
                return { thread: { id: (params as any)?.threadId ?? this.scenario.thread.id, turns: [] } };
            case "thread/unsubscribe":
            case "thread/delete":
                return {};
            case "turn/start": {
                const id = this.scenario.turnId ?? `fake-turn-${this.nextServerReqId++}`;
                this.activeTurnId = id;
                queueMicrotask(() => this._playTurnScript(id));
                return { turn: { id, status: "inProgress", items: [], itemsView: { pageInfo: null }, startedAt: null, completedAt: null, error: null, durationMs: null } };
            }
            case "turn/interrupt": {
                // Real codex responds to interrupt then delivers turn/completed
                // with status="interrupted". Mirror that so the send() awaiter
                // unblocks in tests without a hand-authored script step.
                queueMicrotask(() => {
                    this.emit("notification", {
                        method: "turn/completed",
                        params: { threadId: this.scenario.thread.id, turn: { id: this.activeTurnId ?? "fake-turn-interrupted", status: "interrupted" } },
                    });
                });
                return {};
            }
            default:
                return {};
        }
    }

    notify(method: string, params: unknown): void {
        this.recordedRequests.push({ kind: "notification", method, params });
    }

    respond(id: string | number, result: unknown): void {
        this.recordedResponses.push({ type: "server-request-response", id, result });
    }

    respondError(id: string | number, code: number, message: string): void {
        this.recordedResponses.push({ type: "server-request-response", id, error: { code, message } });
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.emit("close");
    }

    private _playTurnScript(turnId: string): void {
        const script = this.scenario.turnScript ?? [];
        let hasTerminal = false;
        let hitHold = false;
        for (const step of script) {
            if ((step as any).emit === "hold") { hitHold = true; break; }
            if ((step as any).emit === "notification") {
                const n = step as { method: string; params: any };
                if (n.method === "turn/completed" || n.method === "error") hasTerminal = true;
                this.emit("notification", { method: n.method, params: n.params });
            } else if ((step as any).emit === "server-request") {
                const s = step as { method: string; params: any };
                const id = `fake-req-${this.nextServerReqId++}`;
                this.emit("server-request", { id, method: s.method, params: s.params });
            }
        }
        if (!hitHold && !hasTerminal) {
            // Synthetic terminator so tests that only care about turn/start
            // do not have to hand-author a turn/completed step. This mirrors
            // real Codex, which always concludes a turn with turn/completed.
            this.emit("notification", {
                method: "turn/completed",
                params: { threadId: this.scenario.thread.id, turn: { id: turnId, status: "completed" } },
            });
        }
    }
}

/** Build a fake transport suitable for tests. Never touches the real codex binary. */
export function createFakeCodexTransport(scenario: FakeCodexTransportScenario): FakeCodexTransport {
    return new InMemoryFakeCodexTransport(scenario);
}
