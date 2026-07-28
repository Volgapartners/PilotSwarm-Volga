/**
 * Minimal runtime contract shared by every session backend PilotSwarm
 * supports (currently Copilot and Codex).
 *
 * `ManagedSession` only consumes a handful of methods on the underlying
 * SDK session (`registerTools`, `on`, `send`, `abort`, `disconnect`,
 * `getMessages`). Exposing them through this contract lets a new backend
 * — the Codex `app-server` runtime — plug in without leaking a new
 * discriminator into the orchestration/turn-result surface.
 *
 * The Copilot SDK's `CopilotSession` and `CopilotClient` classes satisfy
 * these contracts structurally; no adapter is required for them beyond a
 * type cast in the runtime selection call site.
 *
 * @internal
 */

import type { Tool } from "@github/copilot-sdk";

export type RuntimeEventHandler = (event: any) => void;

/**
 * Session handle exposed by every runtime.
 * Method names, argument shapes, and event names mirror `CopilotSession`.
 */
export interface RuntimeSessionHandle {
    /**
     * Refresh the tool handler map. For Copilot this also updates the
     * schemas the model sees for the next turn. For Codex (v1) the
     * dynamic tool schema set is fixed at thread/start and cannot be
     * changed mid-thread; `registerTools()` on a Codex session only
     * swaps the JS handlers backing already-declared names.
     */
    registerTools(tools: Tool<any>[]): void;
    /** Subscribe to every event fired by the runtime. */
    on(catchAll: RuntimeEventHandler): () => void;
    /** Subscribe to a specific event type. */
    on(eventType: string, handler: RuntimeEventHandler): () => void;
    /** Fire a user prompt. Resolves after the runtime accepts the turn, not after completion. */
    send(params: {
        prompt: string;
        displayPrompt?: string;
        requiredTool?: string;
        [key: string]: unknown;
    }): Promise<void>;
    /** Cooperative in-flight abort. */
    abort(): void;
    /** Release the session; the underlying process may stay warm. */
    disconnect(): Promise<void>;
    /** Return the conversation history for compaction / display. */
    getMessages(): Promise<unknown[]>;
    /**
     * Optional filesystem-only checkpoint hook.
     * Runtimes that keep their durable state outside the PilotSwarm
     * session directory (currently Codex) implement this to copy it in
     * BEFORE the outer `SessionStateStore.checkpoint()` archives the
     * directory. Callers must tolerate the method being absent (no-op
     * for Copilot).
     */
    snapshot?(): void;
}

export interface RuntimeSessionCreateConfig {
    sessionId: string;
    tools?: Tool<any>[];
    model?: string;
    reasoningEffort?: string;
    systemMessage?: string | { content: string; [key: string]: unknown };
    workingDirectory?: string;
    /** Runtime-specific extensions travel through here. */
    [key: string]: unknown;
}

/**
 * Client handle exposed by every runtime.
 * Mirrors the subset of `CopilotClient` that SessionManager calls.
 */
export interface RuntimeClient {
    createSession(config: RuntimeSessionCreateConfig): Promise<RuntimeSessionHandle>;
    resumeSession(
        sessionId: string,
        config: RuntimeSessionCreateConfig,
    ): Promise<RuntimeSessionHandle>;
    deleteSession(sessionId: string): Promise<void>;
    stop(): Promise<void>;
}

/** Which runtime backs a session. */
export type RuntimeKind = "copilot" | "codex";
