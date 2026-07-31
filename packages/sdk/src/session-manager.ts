import { CopilotClient, type CopilotSession, type SectionOverride, type SystemMessageConfig, type Tool } from "@github/copilot-sdk";
import { ManagedSession } from "./managed-session.js";
import type { SessionStateStore } from "./session-store.js";
import { validateSessionId, resolveContainedSessionDir } from "./session-store.js";
import { SESSION_STATE_MISSING_PREFIX, type ManagedSessionConfig, type SerializableSessionConfig } from "./types.js";
import type { ModelProviderRegistry, ReasoningEffort } from "./model-providers.js";
import { CodexRuntimeClient, type CodexTransport } from "./codex-runtime.js";
import type { RuntimeKind } from "./runtime.js";
import { createFactTools } from "./facts-tools.js";
import { createInspectTools } from "./inspect-tools.js";
import type { SessionCatalogProvider } from "./cms.js";
import type { FactStore } from "./facts-store.js";
import { buildKnowledgePromptBlocks, loadKnowledgeIndexFromFactStore } from "./knowledge-index.js";
import { composeStructuredSystemMessage, composeSystemPrompt, extractPromptContent, mergePromptSections } from "./prompt-layering.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");
const DEHYDRATE_STORE_MAX_RETRIES = 3;
const DEHYDRATE_STORE_RETRY_BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(String(error));
}

type SessionTraceWriter = (message: string) => void;

function emitSessionManagerTrace(
    sessionId: string,
    message: string,
    options?: { trace?: SessionTraceWriter; level?: "info" | "warn" },
): void {
    const line = `[SessionManager] session=${sessionId} orch=session-${sessionId} ${message}`;
    if (typeof options?.trace === "function") {
        options.trace(line);
        return;
    }
    if (options?.level === "warn") {
        console.warn(line);
        return;
    }
    console.info(line);
}

function isMissingDehydrateSnapshotError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /Session state directory not ready during dehydrate/i.test(message);
}

const KNOWN_REASONING_EFFORTS: ReadonlySet<string> = new Set([
    "low", "medium", "high", "xhigh", "max", "ultra",
]);

/**
 * Reasoning-effort levels the Copilot SDK's `SessionConfig.reasoningEffort`
 * accepts. `max` / `ultra` are Codex-only and must never be forwarded.
 */
const COPILOT_SDK_REASONING_EFFORTS: ReadonlySet<string> = new Set([
    "low", "medium", "high", "xhigh",
]);

/** Lower-case/trim a caller-supplied reasoning effort; undefined when blank. */
function normalizeReasoningEffortValue(value: unknown): string | undefined {
    const effort = String(value ?? "").trim().toLowerCase();
    return effort ? effort : undefined;
}

// Stubs for the legacy prompt-layers subsystem that shipped in a fork
// but was removed on main. The Codex runtime path calls into these
// helpers only to emit an optional `session.prompt_layers` telemetry
// event; returning an empty layer set here is a safe no-op that keeps
// the Codex branch buildable without dragging the whole subsystem in.
type PromptLayerDescriptor = unknown;
function buildEffectivePromptLayers(_defaults: WorkerDefaults, _config: ManagedSessionConfig): PromptLayerDescriptor[] {
    return [];
}
function buildPromptLayersEventPayload(layers: PromptLayerDescriptor[]): Record<string, unknown> {
    return { layers };
}

/** Worker-level defaults — applied to every session. */
export interface WorkerDefaults {
    frameworkBasePrompt?: string;
    frameworkBaseToolNames?: string[];
    appDefaultPrompt?: string;
    appDefaultToolNames?: string[];
    /** Backward-compatible alias for older code paths/tests. */
    systemMessage?: string;
    /** Raw prompt lookup for named and system agents bound directly to sessions. */
    agentPromptLookup?: Record<string, { prompt: string; kind: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" }>;
    /** Skill directories to pass to the Copilot SDK. */
    skillDirectories?: string[];
    /** Custom agents to pass to the Copilot SDK. */
    customAgents?: Array<{ name: string; description?: string; prompt: string; tools?: string[] | null }>;
    /** MCP server configs to pass to the Copilot SDK. */
    mcpServers?: Record<string, any>;
    /**
     * Codex-native MCP server configs (safe to persist — env-var names
     * only, never resolved secret values). Passed to Codex via
     * `thread/start.config.mcp_servers` and `thread/resume.config.mcp_servers`.
     * Never handed to the Copilot SDK.
     */
    codexMcpServers?: Record<string, any>;
    /**
     * @deprecated Use `modelProviders` instead. Kept for backwards compatibility.
     * Custom LLM provider config (BYOK). Passed to every session.
     */
    provider?: {
        type?: "openai" | "azure" | "anthropic";
        baseUrl: string;
        apiKey?: string;
        azure?: { apiVersion?: string };
    };
    /** Multi-provider model registry. Takes precedence over `provider`. */
    modelProviders?: ModelProviderRegistry;
    /** Turn timeout in milliseconds. 0 or undefined = no timeout. */
    turnTimeoutMs?: number;
    /** Prompt-injection guardrails inherited by all sessions on this worker. */
    promptGuardrails?: import("./types.js").PromptGuardrailConfig;
}

/**
 * SessionManager — singleton per worker node.
 * Owns session lifecycle, wraps CopilotClient.
 *
 * Three ways a session appears:
 *   1. Brand new → createSession
 *   2. Same node, still warm → getSession returns it
 *   3. Post-hydration → local files exist → resumeSession
 *
 * @internal
 */
export class SessionManager {
    private client: CopilotClient | null = null;
    private sessions = new Map<string, ManagedSession>();
    /** Codex runtime clients, keyed by CODEX_HOME. */
    private codexClients = new Map<string, CodexRuntimeClient>();
    /** Test-only transport factory for the Codex runtime. Never used in prod. */
    private _codexTransportFactoryForTests: (() => any) | undefined = undefined;
    private sessionStore: SessionStateStore | null = null;
    /** In-memory configs with non-serializable fields (tools, hooks). */
    private sessionConfigs = new Map<string, ManagedSessionConfig>();
    /** Worker-level tool registry — shared reference from PilotSwarmWorker. */
    private toolRegistry = new Map<string, Tool<any>>();
    /** Worker-level defaults for building blocks. */
    private workerDefaults: WorkerDefaults;
    /** Base directory for local session state files. */
    private sessionStateDir: string;
    /** Shared facts store used to build always-on facts tools. */
    private factStore: FactStore | null = null;
    /** Shared CMS catalog used to build always-on inspect tools. */
    private sessionCatalog: SessionCatalogProvider | null = null;
    /** Duroxide client used by tuner-only inspect tools. */
    private _duroxideClient: any = null;
    /** Lineage lookup for ancestor/descendant facts access. */
    private _getLineageSessionIds: ((sessionId: string) => Promise<string[]>) | null = null;

    constructor(
        private githubToken?: string,
        sessionStore?: SessionStateStore | null,
        workerDefaults?: WorkerDefaults,
        sessionStateDir?: string,
    ) {
        this.sessionStore = sessionStore ?? null;
        this.workerDefaults = workerDefaults ?? {};
        this.sessionStateDir = sessionStateDir ?? DEFAULT_SESSION_STATE_DIR;
    }

    /** Store full config (with tools/hooks) for a session. Called by PilotSwarmClient. */
    setConfig(sessionId: string, config: ManagedSessionConfig): void {
        this.sessionConfigs.set(sessionId, config);
    }

    /** Get a human-readable model summary for LLM tool consumption. */
    getModelSummary(): string | undefined {
        return this.workerDefaults.modelProviders?.getModelSummaryForLLM();
    }

    getPromptGuardrails(): import("./types.js").PromptGuardrailConfig | undefined {
        return this.workerDefaults.promptGuardrails;
    }

    /**
     * Resolve a concrete model/provider tuple for a one-shot SDK session.
     * Used by secondary utilities such as prompt-guardrail detector turns.
     */
    resolveSessionModelOptions(model?: string): { modelName: string; sdkProvider?: any; githubToken?: string } | undefined {
        const registry = this.workerDefaults.modelProviders;
        if (registry) {
            const normalized = this.normalizeModelRef(model);
            if (!normalized) return undefined;
            const resolved = registry.resolve(normalized);
            if (!resolved) return undefined;
            return {
                modelName: resolved.modelName,
                ...(resolved.sdkProvider ? { sdkProvider: resolved.sdkProvider } : {}),
                ...(resolved.githubToken ? { githubToken: resolved.githubToken } : {}),
            };
        }
        if (model && this.githubToken) {
            return { modelName: model, githubToken: this.githubToken };
        }
        return undefined;
    }

    /**
     * Normalize a model reference against the configured registry.
     * Throws for unknown models. When `requireQualified` is true, the caller
     * must provide the exact `provider:model` string rather than a bare alias.
     */
    normalizeModelRef(model?: string, options?: { requireQualified?: boolean }): string | undefined {
        const registry = this.workerDefaults.modelProviders;
        if (!registry) return model;

        const ref = model || registry.defaultModel;
        if (!ref) {
            if (model) {
                throw new Error(
                    `Unknown model "${model}". Call list_available_models and choose an exact configured provider:model value.`,
                );
            }
            throw new Error(
                "No default model is configured. Set defaultModel in model_providers.json or specify an explicit provider:model when creating the session.",
            );
        }

        const normalized = registry.normalize(ref);
        if (!normalized) {
            throw new Error(
                `Unknown model "${ref}". Call list_available_models and choose an exact configured provider:model value.`,
            );
        }
        if (options?.requireQualified && ref !== normalized) {
            throw new Error(
                `Model "${ref}" is not allowed. Use the exact provider:model value returned by list_available_models, for example "${normalized}".`,
            );
        }
        return normalized;
    }

    /** Set the worker-level tool registry. Called by PilotSwarmWorker. */
    setToolRegistry(registry: Map<string, Tool<any>>): void {
        this.toolRegistry = registry;
    }

    /** Set the cluster facts store for always-on facts tools. */
    setFactStore(factStore: FactStore | null): void {
        this.factStore = factStore;
    }

    /** Set the CMS catalog for always-on inspect tools (e.g. read_agent_events). */
    setSessionCatalog(catalog: SessionCatalogProvider | null): void {
        this.sessionCatalog = catalog;
    }

    /** Set the duroxide client for tuner-only inspect tools. */
    setDuroxideClient(client: any): void {
        this._duroxideClient = client;
    }

    /** Set the lineage lookup for ancestor/descendant facts access. */
    setLineageSessionLookup(fn: ((sessionId: string) => Promise<string[]>) | null): void {
        this._getLineageSessionIds = fn;
    }

    /** @deprecated Use setLineageSessionLookup. */
    setDescendantSessionLookup(fn: ((sessionId: string) => Promise<string[]>) | null): void {
        this.setLineageSessionLookup(fn);
    }

    /**
     * Test-only: inject a fake Codex transport factory so `getOrCreate`
     * with a codex-typed model can be exercised without spawning the
     * real `codex app-server` process. Not part of the public API.
     * @internal
     */
    _setCodexTransportFactoryForTests(factory: () => CodexTransport): void {
        this._codexTransportFactoryForTests = factory;
        // Wipe any cached client so the next getOrCreate picks up the
        // injected transport.
        for (const [, client] of this.codexClients) {
            void client.stop();
        }
        this.codexClients.clear();
    }

    /** Get-or-create a CodexRuntimeClient for the given CODEX_HOME. */
    private _ensureCodexClient(codexHome: string, codexBinaryPath?: string): CodexRuntimeClient {
        const cached = this.codexClients.get(codexHome);
        if (cached) return cached;
        const client = new CodexRuntimeClient({
            codexHome,
            codexBinaryPath,
            sessionStateDir: this.sessionStateDir,
            transportFactory: this._codexTransportFactoryForTests,
        });
        this.codexClients.set(codexHome, client);
        return client;
    }

    /**
     * Resolve the default model's SDK provider config.
     * Used by activities (e.g. summarizeSession) that need a lightweight LLM
     * without requiring a GitHub token.
     */
    resolveDefaultProvider(): { modelName: string; sdkProvider: any } | undefined {
        const registry = this.workerDefaults.modelProviders;
        if (!registry?.defaultModel) return undefined;
        const resolved = registry.resolve(registry.defaultModel);
        if (!resolved?.sdkProvider) return undefined;
        return { modelName: resolved.modelName, sdkProvider: resolved.sdkProvider };
    }

    /**
     * Resolve the reasoning effort that the runtime should actually use for
     * `model`, validated against the model descriptor.
     *
     * Rules:
     *  - Model declares no `supportedReasoningEfforts` → pass the configured
     *    value through untouched (providers without effort metadata must
     *    keep working).
     *  - Configured effort is supported → use it.
     *  - Configured effort is unsupported → fall back to the model's
     *    `defaultReasoningEffort` (when itself supported) or the first
     *    supported value, and warn.
     *  - No configured effort → apply the model's `defaultReasoningEffort`.
     */
    private _resolveEffectiveReasoningEffort(
        sessionId: string,
        model: string,
        configured: string | undefined,
    ): string | undefined {
        const normalized = normalizeReasoningEffortValue(configured);
        const descriptor = model ? this.workerDefaults.modelProviders?.getDescriptor(model) : undefined;
        const supported = descriptor?.supportedReasoningEfforts;

        if (!supported?.length) {
            if (normalized && !KNOWN_REASONING_EFFORTS.has(normalized)) {
                console.warn(
                    `[SessionManager] session=${sessionId} ignoring unrecognized reasoningEffort ` +
                    `"${configured}" for model "${model}".`,
                );
                return undefined;
            }
            return normalized;
        }

        if (normalized && supported.includes(normalized as ReasoningEffort)) return normalized;

        const fallback = descriptor?.defaultReasoningEffort
            && supported.includes(descriptor.defaultReasoningEffort)
            ? descriptor.defaultReasoningEffort
            : supported[0];

        if (normalized) {
            console.warn(
                `[SessionManager] session=${sessionId} reasoningEffort "${configured}" is not supported by ` +
                `model "${model}" (supported: ${supported.join(", ")}); falling back to "${fallback}".`,
            );
        }
        return fallback;
    }

    /**
     * True when a warm `ManagedSession` is still bound to the runtime,
     * model, and reasoning effort the incoming config asks for. A warm
     * handle that fails this check is bound to stale backend state (an
     * old Codex thread config or an old Copilot model) and must be
     * recycled instead of reused.
     */
    private _warmBindingMatches(
        warm: ManagedSession,
        desired: { runtimeKind: RuntimeKind; model: string; reasoningEffort?: string },
    ): boolean {
        if (warm.runtimeKind !== desired.runtimeKind) return false;
        if ((warm.boundModel ?? "") !== (desired.model ?? "")) return false;
        return (warm.boundReasoningEffort ?? undefined) === (desired.reasoningEffort ?? undefined);
    }

    /**
     * Drop a warm handle whose runtime binding drifted, WITHOUT deleting
     * any persisted state. The caller then falls through to the normal
     * create/resume path so the backend picks up the new model/effort.
     */
    private async _recycleWarmSession(
        sessionId: string,
        warm: ManagedSession,
        reason: string,
        trace?: SessionTraceWriter,
    ): Promise<void> {
        emitSessionManagerTrace(sessionId, `recycling warm ${warm.runtimeKind} session: ${reason}`, { trace });
        try {
            await warm.destroy();
        } catch (error: unknown) {
            emitSessionManagerTrace(
                sessionId,
                `warm session recycle destroy failed error=${normalizeError(error).message}`,
                { trace, level: "warn" },
            );
        }
        if (this.sessions.get(sessionId) === warm) this.sessions.delete(sessionId);
    }

    /**
     * Test-only accessor for the stored per-session config.
     * @internal
     */
    getSessionConfigForTests(sessionId: string): ManagedSessionConfig | undefined {
        return this.sessionConfigs.get(sessionId);
    }

    /** Ensure the CopilotClient is started. */
    private async ensureClient(): Promise<CopilotClient> {
        if (!this.client) {
            // Resolve githubToken: explicit > registry (github provider) > none.
            // The token is optional — BYOK providers work without it.
            let token = this.githubToken;
            if (!token && this.workerDefaults.modelProviders) {
                for (const p of this.workerDefaults.modelProviders.allProviders) {
                    if (p.type === "github" && p.models.length > 0) {
                        const firstModel = typeof p.models[0] === "string" ? p.models[0] : p.models[0].name;
                        const resolved = this.workerDefaults.modelProviders.resolve(`${p.id}:${firstModel}`);
                        token = resolved?.githubToken;
                        break;
                    }
                }
            }
            this.client = new CopilotClient({
                ...(token ? { githubToken: token } : {}),
                logLevel: "error",
            });
        }
        return this.client;
    }

    private _missingSessionStateError(sessionId: string, turnIndex: number, detail?: string): Error {
        const suffix = detail ? ` ${detail}` : "";
        return new Error(
            `${SESSION_STATE_MISSING_PREFIX} turn ${turnIndex} expected resumable Copilot session state for ${sessionId}, ` +
            `but none was found in memory, on disk, or in the session store.${suffix}`,
        );
    }

    private async _resetSessionState(
        sessionId: string,
        options?: { runtimeKind?: RuntimeKind },
    ): Promise<void> {
        // Validate the session id at the FIRST statement so a malformed
        // `../victim` id can never reach the map, the CopilotClient,
        // the sessionStore, or the recursive `fs.rmSync` below. Using
        // `resolveContainedSessionDir` both validates AND returns the
        // safe absolute session directory used by the rm at the end,
        // so we compute the containment guarantee exactly once.
        const sessionDir = resolveContainedSessionDir(this.sessionStateDir, sessionId);
        const existing = this.sessions.get(sessionId);
        const runtimeKind: RuntimeKind = options?.runtimeKind ?? existing?.runtimeKind ?? "copilot";
        if (existing) {
            try {
                await existing.destroy();
            } catch {}
            this.sessions.delete(sessionId);
        }

        if (runtimeKind === "codex") {
            // Codex state is owned by the Codex runtime clients. Routing a
            // Codex reset through the Copilot client would spin up a
            // CopilotClient (and demand a GitHub token) for a session that
            // never used it.
            for (const [, codexClient] of this.codexClients) {
                try { await codexClient.deleteSession(sessionId); } catch {}
            }
        } else {
            try {
                const client = await this.ensureClient();
                await client.deleteSession(sessionId);
            } catch {}
        }

        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        if (this.sessionStore) {
            try {
                await this.sessionStore.delete(sessionId);
            } catch {}
        }
    }

    /**
     * Get existing session or create/resume one.
     * Merges: worker defaults → serializable config (from client) → in-memory config (tools/hooks).
     */
    async getOrCreate(
        sessionId: string,
        serializableConfig: SerializableSessionConfig,
        options?: { turnIndex?: number; trace?: SessionTraceWriter },
    ): Promise<ManagedSession> {
        // Validate the session id at the outermost public entry point
        // — before the session-lock table interaction and before any
        // Copilot/Codex branch runs. The Codex branch has its own
        // first-line validator too (see rounds R3/R4) so both remain
        // independently safe; this guard is what prevents a malformed
        // id from reaching the Copilot turn0 stale-reset path
        // (`_resetSessionState` → `fs.rmSync(sessionDir, { recursive })`)
        // even when `sessionStore.exists()` throws for the same id.
        validateSessionId(sessionId);
        const turnIndex = options?.turnIndex;
        const trace = options?.trace;
        const inheritedToolNames = Array.from(new Set([
            ...(this.workerDefaults.frameworkBaseToolNames ?? []),
            ...(this.workerDefaults.appDefaultToolNames ?? []),
            ...(serializableConfig.toolNames ?? []),
        ]));
        const effectiveSerializableConfig: SerializableSessionConfig = inheritedToolNames.length > 0
            ? { ...serializableConfig, toolNames: inheritedToolNames }
            : serializableConfig;
        // Resolve tools: merge per-session (setConfig) + registry (toolNames)
        const storedConfig = this.sessionConfigs.get(sessionId);
        const resolvedTools = this._resolveTools(storedConfig, effectiveSerializableConfig);

        const config: ManagedSessionConfig = {
            ...storedConfig,
            ...effectiveSerializableConfig,
            tools: resolvedTools.length > 0 ? resolvedTools : undefined,
            hooks: storedConfig?.hooks,
            turnTimeoutMs: this.workerDefaults.turnTimeoutMs,
        };
        this.sessionConfigs.set(sessionId, config);

        const sessionDir = path.join(this.sessionStateDir, sessionId);

        // Merge user tools with system tool definitions (wait, ask_user, sub-agent tools)
        // so the LLM sees them at session creation time.
        if (!this.factStore) {
            throw new Error(
                "PilotSwarm invariant violated: factStore must be initialized before creating sessions.",
            );
        }
        const userTools = config.tools ?? [];
        const systemTools = ManagedSession.systemToolDefs();
        // Tuner sessions are read-only by design — no spawn / message / cancel.
        const isTunerSession = effectiveSerializableConfig.agentIdentity === "agent-tuner";
        const subAgentTools = isTunerSession ? [] : ManagedSession.subAgentToolDefs();
        const factTools = createFactTools({
            factStore: this.factStore,
            getLineageSessionIds: this._getLineageSessionIds ?? undefined,
            agentIdentity: effectiveSerializableConfig.agentIdentity,
            recordEvent: this.sessionCatalog
                ? async (sid, eventType, data) => {
                    try {
                        await this.sessionCatalog!.recordEvents(sid, [{ eventType, data }]);
                    } catch {
                        // Best-effort — never fail a tool call on telemetry errors.
                    }
                }
                : undefined,
        });
        const inspectTools = this.sessionCatalog
            ? createInspectTools({
                catalog: this.sessionCatalog,
                agentIdentity: effectiveSerializableConfig.agentIdentity,
                duroxideClient: this._duroxideClient ?? undefined,
                factStore: this.factStore ?? undefined,
            })
            : [];
        const SYSTEM_TOOL_NAMES = new Set([
            ...systemTools, ...subAgentTools, ...factTools, ...inspectTools,
        ].map((t: any) => t.name));
        const persistentSessionTools = [
            ...userTools.filter((t: any) => !SYSTEM_TOOL_NAMES.has(t.name)),
            ...factTools,
            ...inspectTools,
        ];
        const allTools = [
            ...persistentSessionTools.filter((t: any) => !SYSTEM_TOOL_NAMES.has(t.name)),
            ...systemTools,
            ...subAgentTools,
            ...factTools,
            ...inspectTools,
        ];
        config.tools = persistentSessionTools;

        // Build system message once so both Copilot and Codex branches see
        // the same effective prompt. Copilot takes the structured
        // SystemMessageConfig; Codex takes the flat-text equivalent via
        // `developerInstructions`. Content must be identical.
        const systemMessage = this._buildSystemMessage(sessionId, config);
        const developerInstructionsText = this._buildFlatSystemPrompt(sessionId, config);

        // Resolve model & provider up-front. Both the Codex and Copilot
        // branches need this — Codex branches on `resolvedProvider.type`,
        // Copilot needs `sdkModelName` and `resolvedProviderConfig`.
        const registry = this.workerDefaults.modelProviders;
        const effectiveModel = this.normalizeModelRef(config.model) || "";
        const resolvedProvider = registry?.resolve(effectiveModel);
        let sdkModelName = effectiveModel;
        if (registry && effectiveModel) {
            const desc = registry.getDescriptor(effectiveModel);
            if (desc) sdkModelName = desc.modelName;
        }

        // Reasoning effort is model-scoped. Validate the configured value
        // against the model descriptor and write the resolved value back
        // into the stored config so the UI, CMS, and the runtime all agree
        // on the effort that actually reaches the backend.
        const desiredRuntimeKind: RuntimeKind = resolvedProvider?.type === "codex" ? "codex" : "copilot";
        const effectiveReasoningEffort = this._resolveEffectiveReasoningEffort(
            sessionId,
            effectiveModel,
            config.reasoningEffort,
        );
        if (effectiveReasoningEffort !== undefined) {
            config.reasoningEffort = effectiveReasoningEffort;
        } else {
            delete config.reasoningEffort;
        }

        // A warm ManagedSession is bound to the runtime kind, model, and
        // reasoning effort its underlying handle was created with. Reusing
        // it after any of those drift (set_model, cross-provider switch,
        // effort change) would silently keep running the old backend
        // configuration, so recycle it here — BEFORE either branch's warm
        // reuse path — and let the normal create/resume path rebuild it.
        //
        // turnIndex 0 is left alone: both branches already discard warm
        // state for a fresh turn 0.
        let forceFreshRuntimeSession = false;
        const warmBeforeBranch = turnIndex === 0 ? undefined : this.sessions.get(sessionId);
        if (warmBeforeBranch && !this._warmBindingMatches(warmBeforeBranch, {
            runtimeKind: desiredRuntimeKind,
            model: effectiveModel,
            reasoningEffort: effectiveReasoningEffort,
        })) {
            const previousKind = warmBeforeBranch.runtimeKind;
            forceFreshRuntimeSession = previousKind !== desiredRuntimeKind;
            await this._recycleWarmSession(
                sessionId,
                warmBeforeBranch,
                `runtime=${previousKind}->${desiredRuntimeKind} ` +
                `model=${warmBeforeBranch.boundModel ?? "none"}->${effectiveModel || "none"} ` +
                `effort=${warmBeforeBranch.boundReasoningEffort ?? "none"}->${effectiveReasoningEffort ?? "none"}`,
                trace,
            );
            if (forceFreshRuntimeSession) {
                // The persisted state belongs to the PREVIOUS runtime; the
                // new runtime has nothing it can resume from, so purge it
                // (through the previous runtime's own teardown path) and
                // start a fresh session on the new backend.
                await this._resetSessionState(sessionId, { runtimeKind: previousKind });
            }
        }

        // ── Codex runtime routing ─────────────────────────
        // Codex subscription sessions do NOT use the Copilot SDK client
        // at all — they talk to a locally running `codex app-server`
        // through the CodexRuntimeClient. We branch here (after the
        // shared tool assembly and system-prompt build) so ManagedSession
        // still receives the same tool set and prompt layers, and we
        // skip every Copilot-specific piece of session config below.
        if (resolvedProvider?.type === "codex") {
            // Validate the session id BEFORE any FS probe, sessionStore
            // call, or Codex runtime call. Without this, a malformed
            // `../victim` id could reach `sessionStore.exists()` /
            // `.delete()` / `.hydrate()` and escape the store /
            // sessionStateDir roots before the Codex runtime's own
            // validation ever ran.
            validateSessionId(sessionId);
            const runtime = resolvedProvider.codexRuntime;
            if (!runtime?.codexHome) {
                throw new Error(
                    `Codex provider "${resolvedProvider.providerId}" is missing a resolved CODEX_HOME. ` +
                    `Set codexHome in the provider config.`,
                );
            }
            const codexClient = this._ensureCodexClient(runtime.codexHome, runtime.codexBinaryPath);

            const warmCodex = this.sessions.get(sessionId);
            if (warmCodex) {
                if (turnIndex === 0) {
                    try { await warmCodex.destroy(); } catch {}
                    this.sessions.delete(sessionId);
                    try { await codexClient.deleteSession(sessionId); } catch {}
                } else {
                    warmCodex.updateConfig(config);
                    return warmCodex;
                }
            }

            const codexStateFile = path.join(sessionDir, "codex-thread.json");
            const codexLocalExists = fs.existsSync(codexStateFile);
            const codexLocalUsable = codexClient.hasUsableThreadState(sessionId);
            let codexStoredExists = false;
            if (this.sessionStore) {
                try {
                    codexStoredExists = await this.sessionStore.exists(sessionId);
                } catch (error: unknown) {
                    emitSessionManagerTrace(
                        sessionId,
                        `codex session-store exists probe failed turnIndex=${turnIndex ?? "unknown"} error=${normalizeError(error).message}`,
                        { trace, level: "warn" },
                    );
                    codexStoredExists = false;
                }
            }
            emitSessionManagerTrace(
                sessionId,
                `codex resume probe turnIndex=${turnIndex ?? "unknown"} localExists=${codexLocalExists} ` +
                `localUsable=${codexLocalUsable} storedExists=${codexStoredExists}`,
                { trace },
            );

            const codexMcpServers = this.workerDefaults.codexMcpServers;
            const hasCodexMcp = codexMcpServers && Object.keys(codexMcpServers).length > 0;
            const codexAppServerConfig: Record<string, unknown> | undefined = hasCodexMcp
                ? { mcp_servers: codexMcpServers }
                : undefined;

            const codexCreateConfig = {
                sessionId,
                model: sdkModelName || undefined,
                cwd: config.workingDirectory || undefined,
                developerInstructions: developerInstructionsText || undefined,
                reasoningEffort: config.reasoningEffort || undefined,
                tools: allTools,
                ...(codexAppServerConfig ? { config: codexAppServerConfig } : {}),
            };

            /** Verifies hydration actually restored a usable codex-thread.json marker. */
            const ensureCodexMarker = () => {
                if (codexClient.hasUsableThreadState(sessionId)) return;
                throw this._missingSessionStateError(
                    sessionId, turnIndex ?? 0,
                    ` Hydration completed but ${codexStateFile} is missing or invalid.`,
                );
            };

            let codexSessionHandle;
            if (turnIndex === 0 || forceFreshRuntimeSession) {
                if (codexLocalExists || codexStoredExists) {
                    // Fresh turn 0 — discard stale local + stored state so
                    // we begin a genuinely fresh Codex thread.
                    try { await codexClient.deleteSession(sessionId); } catch {}
                    if (this.sessionStore && codexStoredExists) {
                        try { await this.sessionStore.delete(sessionId); } catch {}
                    }
                }
                codexSessionHandle = await codexClient.createSession(codexCreateConfig);
            } else if (turnIndex != null && turnIndex > 0) {
                if (codexLocalUsable) {
                    emitSessionManagerTrace(sessionId, "codex turn>0 resuming from local session directory", { trace });
                    codexSessionHandle = await codexClient.resumeSession(sessionId, codexCreateConfig);
                } else if (this.sessionStore && codexStoredExists) {
                    emitSessionManagerTrace(sessionId, "codex turn>0 hydrating from session store before resume", { trace });
                    try {
                        await this.sessionStore.hydrate(sessionId);
                    } catch (error: unknown) {
                        emitSessionManagerTrace(
                            sessionId,
                            `codex turn>0 hydrate before resume failed error=${normalizeError(error).message}`,
                            { trace, level: "warn" },
                        );
                        throw error;
                    }
                    ensureCodexMarker();
                    emitSessionManagerTrace(sessionId, "codex turn>0 hydrate restored session directory; resuming session", { trace });
                    codexSessionHandle = await codexClient.resumeSession(sessionId, codexCreateConfig);
                } else {
                    emitSessionManagerTrace(
                        sessionId,
                        `codex turn>0 missing resumable state localExists=${codexLocalExists} ` +
                        `localUsable=${codexLocalUsable} storedExists=${codexStoredExists}`,
                        { trace, level: "warn" },
                    );
                    throw this._missingSessionStateError(
                        sessionId, turnIndex,
                        ` No persisted Codex thread mapping was found at ${codexStateFile}.`,
                    );
                }
            } else {
                // Backward-compatible permissive path.
                if (codexLocalUsable) {
                    codexSessionHandle = await codexClient.resumeSession(sessionId, codexCreateConfig);
                } else if (this.sessionStore && codexStoredExists) {
                    try {
                        await this.sessionStore.hydrate(sessionId);
                        if (codexClient.hasUsableThreadState(sessionId)) {
                            codexSessionHandle = await codexClient.resumeSession(sessionId, codexCreateConfig);
                        } else {
                            codexSessionHandle = await codexClient.createSession(codexCreateConfig);
                        }
                    } catch {
                        codexSessionHandle = await codexClient.createSession(codexCreateConfig);
                    }
                } else {
                    codexSessionHandle = await codexClient.createSession(codexCreateConfig);
                }
            }

            if (allTools.length) codexSessionHandle.registerTools(allTools as any);

            const managedCodex = new ManagedSession(sessionId, codexSessionHandle as any, config, {
                runtimeKind: "codex",
                boundModel: effectiveModel,
                boundReasoningEffort: effectiveReasoningEffort,
            });
            this.sessions.set(sessionId, managedCodex);
            const codexPromptLayers = buildEffectivePromptLayers(this.workerDefaults, config);
            if (codexPromptLayers.length > 0 && this.sessionCatalog) {
                void this.sessionCatalog.recordEvents(sessionId, [{
                    eventType: "session.prompt_layers",
                    data: buildPromptLayersEventPayload(codexPromptLayers),
                }]).catch(() => {});
            }
            return managedCodex;
        }

        if (resolvedProvider?.type === "github" && !this.githubToken && !resolvedProvider.githubToken) {
            throw new Error(
                `GitHub Copilot key not configured for provider "${resolvedProvider.providerId}". ` +
                "Set githubToken in the provider configuration or pass a GitHub Copilot key to the worker.",
            );
        }

        const client = await this.ensureClient();

        // Resolve model: config.model may be qualified (provider:model) or bare.
        // The SDK needs the bare model name; the provider config is separate.
        // (Model + provider already resolved above; only need provider-config here.)
        const resolvedProviderConfig = this._resolveProviderConfig(effectiveModel);

        const sessionConfig: any = {
            sessionId,
            tools: allTools,
            model: sdkModelName,
            // Only forward efforts the Copilot SDK understands. Codex-only
            // levels (max/ultra) never reach here because
            // `_resolveEffectiveReasoningEffort` already mapped them to a
            // supported value for models that declare metadata; models with
            // no metadata simply pass through whatever the caller set.
            ...(effectiveReasoningEffort && COPILOT_SDK_REASONING_EFFORTS.has(effectiveReasoningEffort)
                ? { reasoningEffort: effectiveReasoningEffort }
                : {}),
            systemMessage: systemMessage
                ? (typeof systemMessage === "string" ? { content: systemMessage } : systemMessage)
                : undefined,
            configDir: path.dirname(this.sessionStateDir),
            workingDirectory: config.workingDirectory,
            hooks: config.hooks,
            onPermissionRequest: (config as any).onPermissionRequest ?? (async () => ({ kind: "approved" as const })),
            infiniteSessions: { enabled: true },
            // Exclude the Copilot SDK's built-in "task" tool — PilotSwarm provides
            // its own durable sub-agent mechanism via spawn_agent / check_agents.
            // The native "task" tool spawns in-process sub-agents that bypass the
            // durable orchestration layer, causing the LLM to use the wrong mechanism.
            excludedTools: ["task"],
            // Custom LLM provider — resolve from registry or legacy single provider
            ...resolvedProviderConfig,
            // Pass loaded skills, agents, and MCP from worker defaults
            ...(this.workerDefaults.skillDirectories?.length && { skillDirectories: this.workerDefaults.skillDirectories }),
            ...(this.workerDefaults.customAgents?.length && { customAgents: this.workerDefaults.customAgents }),
            ...(this.workerDefaults.mcpServers && Object.keys(this.workerDefaults.mcpServers).length > 0 && { mcpServers: this.workerDefaults.mcpServers }),
        };

        let copilotSession: CopilotSession;

        // 1. Check if already in memory (warm) — update config in case
        //    tools were registered after the session was first created.
        const existing = this.sessions.get(sessionId);
        if (existing) {
            if (turnIndex === 0) {
                console.warn(
                    `[SessionManager] stale in-memory Copilot session found for turn 0 (${sessionId}); ` +
                    `discarding it and creating a fresh session.`,
                );
                await this._resetSessionState(sessionId);
            } else {
                existing.updateConfig(config);
                return existing;
            }
        }

        const localExists = fs.existsSync(sessionDir);
        let storedExists = false;
        if (this.sessionStore) {
            try {
                storedExists = await this.sessionStore.exists(sessionId);
            } catch (error: unknown) {
                emitSessionManagerTrace(
                    sessionId,
                    `session-store exists probe failed turnIndex=${turnIndex ?? "unknown"} error=${normalizeError(error).message}`,
                    { trace, level: "warn" },
                );
                storedExists = false;
            }
        }
        emitSessionManagerTrace(
            sessionId,
            `resume probe turnIndex=${turnIndex ?? "unknown"} localExists=${localExists} storedExists=${storedExists} inMemory=${this.sessions.has(sessionId)}`,
            { trace },
        );

        if (turnIndex === 0 || forceFreshRuntimeSession) {
            if (localExists || storedExists) {
                console.warn(
                    `[SessionManager] stale persisted Copilot session found for turn 0 (${sessionId}); ` +
                    `discarding it and creating a fresh session.`,
                );
                await this._resetSessionState(sessionId);
            }

            copilotSession = await client.createSession(sessionConfig);
        } else if (turnIndex != null && turnIndex > 0) {
            if (fs.existsSync(sessionDir)) {
                emitSessionManagerTrace(sessionId, "turn>0 resuming from local session directory", { trace });
                copilotSession = await client.resumeSession(sessionId, sessionConfig);
            } else if (this.sessionStore && storedExists) {
                emitSessionManagerTrace(sessionId, "turn>0 hydrating from session store before resume", { trace });
                try {
                    await this.sessionStore.hydrate(sessionId);
                } catch (error: unknown) {
                    emitSessionManagerTrace(
                        sessionId,
                        `turn>0 hydrate before resume failed error=${normalizeError(error).message}`,
                        { trace, level: "warn" },
                    );
                    throw error;
                }
                if (!fs.existsSync(sessionDir)) {
                    emitSessionManagerTrace(
                        sessionId,
                        "turn>0 hydrate reported success but no local session directory was restored",
                        { trace, level: "warn" },
                    );
                    throw this._missingSessionStateError(sessionId, turnIndex, " Hydration completed but no local session directory was restored.");
                }
                emitSessionManagerTrace(sessionId, "turn>0 hydrate restored local session directory; resuming session", { trace });
                copilotSession = await client.resumeSession(sessionId, sessionConfig);
            } else {
                emitSessionManagerTrace(
                    sessionId,
                    `turn>0 missing resumable state localExists=${localExists} storedExists=${storedExists}`,
                    { trace, level: "warn" },
                );
                throw this._missingSessionStateError(sessionId, turnIndex);
            }
        } else {
            // Backward-compatible permissive path for older orchestration versions.
            if (fs.existsSync(sessionDir)) {
                copilotSession = await client.resumeSession(sessionId, sessionConfig);
            } else if (this.sessionStore) {
                try {
                    await this.sessionStore.hydrate(sessionId);
                    if (fs.existsSync(sessionDir)) {
                        copilotSession = await client.resumeSession(sessionId, sessionConfig);
                    } else {
                        copilotSession = await client.createSession(sessionConfig);
                    }
                } catch {
                    copilotSession = await client.createSession(sessionConfig);
                }
            } else {
                copilotSession = await client.createSession(sessionConfig);
            }
        }

        const managed = new ManagedSession(sessionId, copilotSession, config, {
            runtimeKind: "copilot",
            boundModel: effectiveModel,
            boundReasoningEffort: effectiveReasoningEffort,
        });
        this.sessions.set(sessionId, managed);
        return managed;
    }

    /** Get a session by ID (null if not in memory on this node). */
    get(sessionId: string): ManagedSession | null {
        return this.sessions.get(sessionId) ?? null;
    }

    /**
     * Dehydrate a session: destroy in memory, then persist state to the configured session store.
     *
     * The Copilot SDK's disconnect path preserves session state on disk, so we
     * first release the in-memory session and then archive the resulting local
     * session files into the configured session store.
     *
     * If destroy() fails (e.g., Copilot connection already disposed), we retry
     * by re-creating the session from local files and destroying again.
     * After destroy retries, we still attempt the session-store write. That
     * write is retried separately so transient archive/blob failures can
     * recover before we bubble a terminal error back to the orchestration.
     */
    async dehydrate(sessionId: string, reason: string, options?: { trace?: SessionTraceWriter }): Promise<void> {
        // Validate BEFORE the destroy/rm/store pipeline. `sessionDir`
        // is computed from the same id and later used in
        // `fs.rmSync(sessionDir, { recursive })` — a traversal here
        // would follow through to the outer filesystem.
        validateSessionId(sessionId);
        const DESTROY_MAX_RETRIES = 3;
        const trace = options?.trace;
        let lastDestroyError: Error | undefined;
        const sessionDir = path.join(this.sessionStateDir, sessionId);
        let checkpointPrepared = false;

        emitSessionManagerTrace(sessionId, `dehydrate start reason=${reason}`, { trace });

        if (this.sessionStore && fs.existsSync(sessionDir)) {
            // Give runtime backends (Codex) a chance to copy their
            // durable state into the session directory before we
            // snapshot it. No-op for Copilot.
            const warmForCheckpoint = this.sessions.get(sessionId);
            if (warmForCheckpoint) {
                try { warmForCheckpoint.snapshotForCheckpoint(); } catch {}
            }
            try {
                emitSessionManagerTrace(sessionId, "pre-dehydrate checkpoint start", { trace });
                await this.sessionStore.checkpoint(sessionId);
                checkpointPrepared = true;
                emitSessionManagerTrace(sessionId, "pre-dehydrate checkpoint complete", { trace });
            } catch (err: any) {
                const checkpointError = normalizeError(err);
                emitSessionManagerTrace(
                    sessionId,
                    `pre-dehydrate checkpoint failed error=${checkpointError.message}`,
                    { trace, level: "warn" },
                );
                console.warn(
                    `[SessionManager] pre-dehydrate checkpoint failed for ${sessionId}: ${checkpointError.message}`,
                );
            }
        }

        // Phase 1: Destroy the in-memory session (with retries)
        for (let attempt = 1; attempt <= DESTROY_MAX_RETRIES; attempt++) {
            const session = this.sessions.get(sessionId);
            if (!session) break; // No in-memory session — nothing to destroy

            try {
                emitSessionManagerTrace(sessionId, `destroy attempt ${attempt}/${DESTROY_MAX_RETRIES}`, { trace });
                await session.destroy();
                this.sessions.delete(sessionId);
                emitSessionManagerTrace(sessionId, `destroy complete on attempt ${attempt}/${DESTROY_MAX_RETRIES}`, { trace });
                break; // Success
            } catch (err: any) {
                lastDestroyError = normalizeError(err);
                this.sessions.delete(sessionId); // Remove broken session from map
                emitSessionManagerTrace(
                    sessionId,
                    `destroy failed on attempt ${attempt}/${DESTROY_MAX_RETRIES} error=${lastDestroyError.message}`,
                    { trace, level: "warn" },
                );

                if (attempt < DESTROY_MAX_RETRIES) {
                    // Re-create the session from local files so we can try destroy again.
                    // Only the Copilot runtime supports this recovery: a
                    // Codex-backed session must NEVER be resumed through the
                    // Copilot client (wrong backend, and it would force a
                    // CopilotClient/GitHub token onto a Codex-only worker).
                    if (session.runtimeKind !== "copilot") {
                        emitSessionManagerTrace(
                            sessionId,
                            `destroy retry skipped for runtime=${session.runtimeKind}; no Copilot resume fallback`,
                            { trace, level: "warn" },
                        );
                        break;
                    }
                    if (fs.existsSync(sessionDir)) {
                        try {
                            const client = await this.ensureClient();
                            const copilotSession = await client.resumeSession(sessionId, {
                                tools: [...ManagedSession.systemToolDefs(), ...ManagedSession.subAgentToolDefs()],
                                onPermissionRequest: async () => ({ kind: "approved" as const }),
                            });
                            const config = this.sessionConfigs.get(sessionId) ?? {};
                            const managed = new ManagedSession(sessionId, copilotSession, config);
                            this.sessions.set(sessionId, managed);
                            // Brief pause before retry
                            await sleep(500 * attempt);
                        } catch {
                            // Can't resume — session files may be corrupt. Fall through.
                            break;
                        }
                    } else {
                        break; // No local files — can't retry
                    }
                }
            }
        }

        // Phase 2: Persist to the session store (always attempt, even if destroy failed)
        if (this.sessionStore) {
            let lastStoreError: Error | undefined;
            let sessionStoreAttemptCount = 0;

            for (let attempt = 1; attempt <= DEHYDRATE_STORE_MAX_RETRIES; attempt++) {
                sessionStoreAttemptCount = attempt;
                try {
                    emitSessionManagerTrace(
                        sessionId,
                        `session-store dehydrate attempt ${attempt}/${DEHYDRATE_STORE_MAX_RETRIES} reason=${reason}`,
                        { trace },
                    );
                    await this.sessionStore.dehydrate(sessionId, { reason });
                    lastStoreError = undefined;
                    emitSessionManagerTrace(
                        sessionId,
                        `session-store dehydrate complete on attempt ${attempt}/${DEHYDRATE_STORE_MAX_RETRIES}`,
                        { trace },
                    );
                    break;
                } catch (storeErr: any) {
                    lastStoreError = normalizeError(storeErr);
                    emitSessionManagerTrace(
                        sessionId,
                        `session-store dehydrate failed on attempt ${attempt}/${DEHYDRATE_STORE_MAX_RETRIES} error=${lastStoreError.message}`,
                        { trace, level: "warn" },
                    );
                    if (attempt < DEHYDRATE_STORE_MAX_RETRIES) {
                        console.warn(
                            `[SessionManager] session-store dehydrate failed for ${sessionId} ` +
                            `(attempt ${attempt}/${DEHYDRATE_STORE_MAX_RETRIES}): ${lastStoreError.message}`,
                        );
                        await sleep(DEHYDRATE_STORE_RETRY_BASE_DELAY_MS * attempt);
                    }
                }
            }

            if (lastStoreError) {
                if (!lastDestroyError && checkpointPrepared && isMissingDehydrateSnapshotError(lastStoreError)) {
                    emitSessionManagerTrace(
                        sessionId,
                        "session-store dehydrate falling back to pre-destroy checkpoint after snapshot-missing error",
                        { trace, level: "warn" },
                    );
                    console.warn(
                        `[SessionManager] session-store dehydrate snapshot missing after destroy for ${sessionId}; ` +
                        `using the pre-destroy checkpoint as the durable fallback.`,
                    );
                    try {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    } catch {}
                } else {
                    const message = lastDestroyError
                        ? `Session ${sessionId} is not dehydratable (reason=${reason}): ` +
                            `destroy failed (${lastDestroyError.message}), ` +
                            `session-store persistence failed after ${sessionStoreAttemptCount} attempts (${lastStoreError.message}). ` +
                            `Session state may be lost on worker recycle.`
                        : `Session-store persistence failed after ${sessionStoreAttemptCount} attempts ` +
                            `during dehydrate for ${sessionId} (reason=${reason}): ${lastStoreError.message}`;
                    const error = new Error(message);
                    (error as any).sessionStoreAttemptCount = sessionStoreAttemptCount;
                    (error as any).sessionStoreError = lastStoreError.message;
                    (error as any).dehydrateReason = reason;
                    (error as any).sessionId = sessionId;
                    throw error;
                }
            }
        }

        if (lastDestroyError) {
            emitSessionManagerTrace(
                sessionId,
                `destroy exhausted retries but session-store persistence succeeded error=${lastDestroyError.message}`,
                { trace, level: "warn" },
            );
            console.warn(
                `[SessionManager] destroy() failed for ${sessionId} after ${DESTROY_MAX_RETRIES} attempts ` +
                `(${lastDestroyError.message}), but session-store persistence succeeded. Session state is preserved.`
            );
        } else {
            emitSessionManagerTrace(sessionId, `dehydrate complete reason=${reason}`, { trace });
        }
    }

    /**
     * Hydrate session state from the configured session store to local disk.
     * The next getOrCreate() will detect local files and resume.
     */
    async hydrate(sessionId: string, options?: { trace?: SessionTraceWriter }): Promise<void> {
        const trace = options?.trace;
        if (this.sessionStore) {
            emitSessionManagerTrace(sessionId, "hydrate start via session store", { trace });
            try {
                await this.sessionStore.hydrate(sessionId);
                emitSessionManagerTrace(sessionId, "hydrate complete via session store", { trace });
            } catch (error: unknown) {
                emitSessionManagerTrace(
                    sessionId,
                    `hydrate failed error=${normalizeError(error).message}`,
                    { trace, level: "warn" },
                );
                throw error;
            }
        }
    }

    /**
     * Return true when the next turn must hydrate state from the session store.
     * This supports abrupt worker loss and direct worker-side dehydration.
     */
    async needsHydration(sessionId: string, options?: { trace?: SessionTraceWriter }): Promise<boolean> {
        const trace = options?.trace;
        if (!this.sessionStore) {
            emitSessionManagerTrace(sessionId, "needsHydration=false session store disabled", { trace });
            return false;
        }
        if (this.sessions.has(sessionId)) {
            emitSessionManagerTrace(sessionId, "needsHydration=false session is still warm in memory", { trace });
            return false;
        }

        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (fs.existsSync(sessionDir)) {
            emitSessionManagerTrace(sessionId, "needsHydration=false local session directory already exists", { trace });
            return false;
        }

        try {
            const storedExists = await this.sessionStore.exists(sessionId);
            emitSessionManagerTrace(sessionId, `needsHydration result=${storedExists}`, { trace });
            return storedExists;
        } catch (error: unknown) {
            emitSessionManagerTrace(
                sessionId,
                `needsHydration probe failed error=${normalizeError(error).message}`,
                { trace, level: "warn" },
            );
            return false;
        }
    }

    /**
     * Destroy a session and remove from tracking.
     */
    async destroySession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            await session.destroy();
            this.sessions.delete(sessionId);
        }
    }

    /**
     * Drop the warm in-memory session handle without deleting any persisted
     * local/session-store state. Used when the underlying Copilot session
     * becomes invalid and we want the next getOrCreate() to resume/hydrate it.
     */
    async invalidateWarmSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        try {
            await session.destroy();
        } catch {}
        this.sessions.delete(sessionId);
    }

    /**
     * Fully reset a session's live and persisted Copilot state.
     * Used when the stored transcript/session state becomes unusable and the
     * runtime must recreate a fresh Copilot session for lossy replay.
     */
    async resetSessionState(sessionId: string): Promise<void> {
        // Validate BEFORE _resetSessionState touches session state.
        validateSessionId(sessionId);
        await this._resetSessionState(sessionId);
    }

    /**
     * Checkpoint session state without destroying the session or
     * releasing affinity. Used for crash resilience — session stays warm.
     *
     * For runtimes that keep durable state outside the PilotSwarm
     * session directory (currently Codex), we first invoke the runtime
     * session's `snapshot()` hook so that state lands inside the
     * session directory before the store archives it.
     */
    async checkpoint(sessionId: string): Promise<void> {
        const warm = this.sessions.get(sessionId);
        if (warm) {
            try {
                warm.snapshotForCheckpoint();
            } catch {
                // Snapshot is best-effort — never block the checkpoint
                // itself on a filesystem hiccup.
            }
        }
        if (this.sessionStore) {
            await this.sessionStore.checkpoint(sessionId);
        }
    }

    /** List all in-memory session IDs on this node. */
    activeSessionIds(): string[] {
        return [...this.sessions.keys()];
    }

    /** Shutdown: destroy all sessions, stop every runtime client. */
    async shutdown(): Promise<void> {
        for (const [_, session] of this.sessions) {
            try { await session.destroy(); } catch {}
        }
        this.sessions.clear();
        if (this.client) {
            await this.client.stop();
            this.client = null;
        }
        // Codex runtime clients keep long-lived `codex app-server`
        // subprocesses (one per CODEX_HOME). Leaking them would keep
        // the worker process alive after `shutdown()` returned.
        for (const [, client] of this.codexClients) {
            try { await client.stop(); } catch {}
        }
        this.codexClients.clear();
    }

    /**
     * Test-only accessor for the number of cached Codex runtime clients.
     * Not part of the public API.
     * @internal
     */
    getCachedCodexClientCountForTests(): number {
        return this.codexClients.size;
    }

    /**
     * Resolve tools from per-session config + worker-level registry.
     * Per-session tools take precedence over registry tools with the same name.
     *
     * Also emits a diagnostic warning when explicit `toolNames` cannot
     * be resolved from the worker registry AND are not exposed by the
     * Codex-native MCP config (server name prefix or `enabled_tools`
     * membership). This is a warning — not a throw — because exact
     * cross-server tool inventory is not always available at session
     * creation time (Codex will validate at first use). See
     * `feat/codex-runtime` fix: portal embedded workers previously
     * silently dropped `teams_alert` because the tool was never
     * registered there.
     */
    private _resolveTools(
        storedConfig: ManagedSessionConfig | undefined,
        serializableConfig: SerializableSessionConfig,
    ): Tool<any>[] {
        const registryTools: Tool<any>[] = [];
        const perSessionNames = new Set<string>(
            (storedConfig?.tools ?? []).map((t: any) => (t && typeof t.name === "string") ? t.name : "").filter(Boolean),
        );
        const codexMcpExposedNames = this._codexExposedToolNamesForDiagnostic();
        if (serializableConfig.toolNames?.length) {
            for (const name of serializableConfig.toolNames) {
                const tool = this.toolRegistry.get(name);
                if (tool) {
                    registryTools.push(tool);
                    continue;
                }
                if (perSessionNames.has(name)) continue;
                if (codexMcpExposedNames.exposed.has(name)) continue;
                if (this._matchesAnyCodexServerPrefix(name, codexMcpExposedNames.wildcardServers)) continue;
                console.warn(
                    `[SessionManager] tool "${name}" listed in toolNames is not registered on this worker ` +
                    `and is not exposed by any configured Codex MCP server. ` +
                    `The session will start, but the model will not be able to call it. ` +
                    `Register it via PilotSwarmWorker.registerTools([...]) on THIS worker process.`,
                );
            }
        }

        const combined = [
            ...(storedConfig?.tools ?? []),
            ...registryTools,
        ];

        // Deduplicate by name — per-session tools take precedence
        const seen = new Set<string>();
        const deduped: Tool<any>[] = [];
        for (const tool of combined) {
            const name = (tool as any).name;
            if (!seen.has(name)) {
                seen.add(name);
                deduped.push(tool);
            }
        }
        return deduped;
    }

    /**
     * Best-effort inventory of tool names the configured Codex MCP
     * servers can expose. Used only to silence the toolName diagnostic
     * for names that a Codex native MCP will provide at runtime — never
     * fatal, never used for permission or scheduling decisions.
     *
     * `exposed` holds names known EXACTLY (from `enabled_tools`
     * allow-lists). `wildcardServers` holds the names of servers that
     * declared no allow-list; for those we suppress only names in that
     * server's plausible namespace (see `_matchesAnyCodexServerPrefix`).
     *
     * The pre-Round-3 behavior of a single global `wildcard` boolean
     * was wrong: one server with no allow-list silenced EVERY
     * unresolved worker toolName, defeating the deployment-topology
     * diagnostic that catches missing tools like `teams_alert` on
     * portal embedded workers.
     * @internal
     */
    private _codexExposedToolNamesForDiagnostic(): { exposed: Set<string>; wildcardServers: string[] } {
        const exposed = new Set<string>();
        const wildcardServers: string[] = [];
        const codexMcp = this.workerDefaults.codexMcpServers;
        if (!codexMcp || typeof codexMcp !== "object") return { exposed, wildcardServers };
        for (const [serverName, cfg] of Object.entries(codexMcp)) {
            if (!cfg || typeof cfg !== "object") continue;
            const enabled = (cfg as any).enabled_tools;
            if (Array.isArray(enabled)) {
                for (const t of enabled) {
                    if (typeof t === "string" && t) exposed.add(t);
                }
                continue;
            }
            // No allow-list -> plausible-namespace suppression only.
            wildcardServers.push(serverName);
        }
        return { exposed, wildcardServers };
    }

    /**
     * True when `name` looks like it could be an MCP tool exposed by
     * one of the wildcard-configured Codex servers. Two common
     * namespaces are matched:
     *   - `<server>_<toolName>`   (Codex's own concatenation pattern)
     *   - `mcp__<server>__<tool>` (Copilot SDK / MCP client style)
     *
     * Server names are normalized for comparison (case-insensitive;
     * hyphens and dots treated as underscores) so `signoz-prod`
     * matches `signoz_prod_query`.
     *
     * Deliberately conservative: names that do not carry any server
     * namespace still warn, which is the correct behavior for the
     * deployment-topology diagnostic.
     * @internal
     */
    private _matchesAnyCodexServerPrefix(name: string, wildcardServers: readonly string[]): boolean {
        if (!wildcardServers.length) return false;
        const lowerName = name.toLowerCase();
        for (const server of wildcardServers) {
            const normalized = server.toLowerCase().replace(/[-.]/g, "_");
            if (lowerName.startsWith(`${normalized}_`)) return true;
            if (lowerName.startsWith(`mcp__${normalized}__`)) return true;
        }
        return false;
    }

    /**
     * Resolve the provider config for a given model.
     * Prefers ModelProviderRegistry, falls back to legacy single provider.
     */
    private _resolveProviderConfig(model?: string): Record<string, any> {
        // 1. Try the multi-provider registry
        const registry = this.workerDefaults.modelProviders;
        if (registry) {
            const resolved = registry.resolve(model);
            if (resolved) {
                if (resolved.type === "github") {
                    // GitHub provider — no SDK provider needed, uses githubToken on the client
                    return {};
                }
                if (resolved.sdkProvider) {
                    return { provider: resolved.sdkProvider };
                }
            }
        }

        // 2. Fall back to legacy single provider
        const p = this.workerDefaults.provider;
        if (!p) return {};

        // For Azure, dynamically construct deployment URL
        if (p.type === "azure" && model && !p.baseUrl.includes("/deployments/")) {
            return {
                provider: {
                    ...p,
                    baseUrl: `${p.baseUrl.replace(/\/+$/, "")}/deployments/${model}`,
                },
            };
        }
        return { provider: p };
    }

    /**
     * Build the final system message from:
     * 1. embedded PilotSwarm framework base
     * 2. app-level default instructions
     * 3. bound agent prompt (for named/system sessions)
     * 4. caller/runtime context
     */
    private _buildKnowledgeToolInstructionsSection(agentIdentity?: string): SectionOverride | undefined {
        if (!this.factStore || agentIdentity === "facts-manager") return undefined;

        return {
            action: async (currentContent: string) => {
                const knowledgeIndex = await loadKnowledgeIndexFromFactStore(this.factStore!, 15);
                const { askBlock, skillBlock } = buildKnowledgePromptBlocks(knowledgeIndex);
                return mergePromptSections([currentContent, askBlock, skillBlock]) ?? currentContent;
            },
        };
    }

    private _buildLastInstructionsSection(
        sessionId: string,
        initialConfig: SerializableSessionConfig,
    ): SectionOverride {
        return {
            action: async (currentContent: string) => {
                const latest = this.sessionConfigs.get(sessionId) ?? initialConfig;
                const runtimeContext = extractPromptContent(latest.systemMessage);
                const activeAgentPrompt = latest.boundAgentName
                    ? this.workerDefaults.agentPromptLookup?.[latest.boundAgentName]?.prompt
                    : undefined;
                const overlay = mergePromptSections([
                    activeAgentPrompt,
                    runtimeContext,
                    latest.turnSystemPrompt,
                ]);
                return mergePromptSections([currentContent, overlay]) ?? currentContent;
            },
        };
    }

    private _buildSystemMessage(
        sessionId: string,
        config: SerializableSessionConfig,
    ): SystemMessageConfig | undefined {
        const frameworkBase = this.workerDefaults.frameworkBasePrompt ?? this.workerDefaults.systemMessage;
        const boundAgentName = config.boundAgentName;
        const layerKind = config.promptLayering?.kind ?? (boundAgentName ? "app-agent" : undefined);
        const knowledgeToolInstructions = this._buildKnowledgeToolInstructionsSection(config.agentIdentity);
        const lastInstructions = this._buildLastInstructionsSection(sessionId, config);
        const additionalSections = knowledgeToolInstructions
            ? { tool_instructions: knowledgeToolInstructions, last_instructions: lastInstructions }
            : { last_instructions: lastInstructions };
        return composeStructuredSystemMessage({
            frameworkBase,
            appDefault: layerKind === "pilotswarm-system-agent"
                ? undefined
                : this.workerDefaults.appDefaultPrompt,
            additionalSections,
        });
    }

    /**
     * Flat-text equivalent of the structured system message, used by
     * runtimes (currently Codex) whose protocol takes a plain
     * `developerInstructions` string instead of the Copilot SDK's
     * structured SystemMessageConfig. Composed via the same helper so
     * layer ordering and headers stay in sync.
     */
    private _buildFlatSystemPrompt(
        sessionId: string,
        config: SerializableSessionConfig,
    ): string | undefined {
        const frameworkBase = this.workerDefaults.frameworkBasePrompt ?? this.workerDefaults.systemMessage;
        const boundAgentName = config.boundAgentName;
        const layerKind = config.promptLayering?.kind ?? (boundAgentName ? "app-agent" : undefined);
        const isPilotSwarmSystemAgent = layerKind === "pilotswarm-system-agent";
        const activeAgentPrompt = boundAgentName
            ? this.workerDefaults.agentPromptLookup?.[boundAgentName]?.prompt
            : undefined;
        const runtimeContext = mergePromptSections([
            extractPromptContent(config.systemMessage),
            config.turnSystemPrompt,
        ]);
        return composeSystemPrompt({
            frameworkBase,
            appDefault: isPilotSwarmSystemAgent ? undefined : this.workerDefaults.appDefaultPrompt,
            activeAgentPrompt,
            runtimeContext,
        });
    }
}
