/**
 * Codex runtime adapter — fake app-server transport tests.
 *
 * Exercises `CodexRuntimeClient` / `CodexRuntimeSession` end-to-end via
 * an in-process fake JSON-RPC transport that replays what the real
 * `codex app-server` process would emit. Tests here MUST NOT spawn the
 * real codex binary, contact ChatGPT, or read auth.json.
 *
 * Coverage:
 *   - initialize handshake happens exactly once per transport
 *   - thread/start returns a codex thread id, which is persisted
 *   - resumeSession replays the persisted thread id via thread/resume
 *   - turn/start user input, item deltas, and turn/completed synthesize
 *     the PilotSwarm assistant.* event names
 *   - dynamic tool round-trip: `item/tool/call` ServerRequest is routed
 *     to the registered JS handler and the DynamicToolCallResponse is
 *     sent back
 *   - abort() sends turn/interrupt
 *   - disconnect() closes the session without deleting the persisted
 *     thread metadata (so the next resume works)
 *   - snapshot state directory NEVER contains auth.json
 *
 * Run: npx vitest run test/local/codex-runtime.test.js
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { defineTool } from "@github/copilot-sdk";
import {
    CodexRuntimeClient,
    createFakeCodexTransport,
    CODEX_THREAD_STATE_FILENAME,
    CODEX_ROLLOUT_SNAPSHOT_FILENAME,
} from "../../src/codex-runtime.ts";

function mkTmpHomes() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-test-"));
    const codexHome = path.join(root, "codex-home");
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionStateDir, { recursive: true });
    // Real auth would be at codexHome/auth.json — leave a marker so we
    // can prove the runtime never reads or copies it.
    fs.writeFileSync(path.join(codexHome, "auth.json"), '{"private":"nope"}', { mode: 0o600 });
    return { root, codexHome, sessionStateDir };
}

async function collectEvents(session, types) {
    const events = [];
    const wanted = new Set(types);
    session.on((event) => {
        if (wanted.has(event.type)) events.push(event);
    });
    return events;
}

describe("Codex runtime adapter (fake transport)", () => {
    it("initializes exactly once and starts a thread on createSession", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-alpha" },
        });
        const client = new CodexRuntimeClient({
            codexHome,
            sessionStateDir,
            transportFactory: () => transport,
        });

        const session = await client.createSession({ sessionId: "ps-session-1" });
        expect(session).toBeTruthy();

        // initialize sent exactly once, with experimentalApi=true so
        // ThreadStartParams.dynamicTools is not filtered out by the
        // experimental gating in codex 0.145.0.
        const inits = transport.recordedRequests.filter((r) => r.method === "initialize");
        expect(inits).toHaveLength(1);
        expect(inits[0].params?.capabilities?.experimentalApi).toBe(true);

        // Client MUST send the `initialized` notification after the
        // initialize response completes; ClientNotification schema
        // requires it.
        const notifs = transport.recordedRequests.filter((r) => r.method === "initialized" && r.kind === "notification");
        expect(notifs).toHaveLength(1);

        // thread/start sent
        expect(transport.recordedRequests.some((r) => r.method === "thread/start")).toBe(true);

        // persisted mapping written outside codexHome
        const stateFile = path.join(sessionStateDir, "ps-session-1", CODEX_THREAD_STATE_FILENAME);
        expect(fs.existsSync(stateFile)).toBe(true);
        const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        expect(state.codexThreadId).toBe("codex-thread-alpha");
        expect(state.codexHome).toBe(codexHome);
        // MUST NOT contain auth material
        const raw = fs.readFileSync(stateFile, "utf-8");
        expect(raw).not.toContain("nope");
        expect(raw).not.toContain("private");
        // snapshot dir must not have a stray auth.json
        const snapshotDir = path.dirname(stateFile);
        expect(fs.readdirSync(snapshotDir)).not.toContain("auth.json");

        await client.stop();
    });

    it("resumeSession reads the persisted thread id and sends thread/resume", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        // Seed the persisted metadata as if a prior worker wrote it.
        const sid = "ps-session-resume";
        const sessDir = path.join(sessionStateDir, sid);
        fs.mkdirSync(sessDir, { recursive: true });
        fs.writeFileSync(
            path.join(sessDir, CODEX_THREAD_STATE_FILENAME),
            JSON.stringify({ codexThreadId: "codex-thread-preexisting", codexHome, model: "gpt-5.6-sol" }),
        );

        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-preexisting" } });
        const client = new CodexRuntimeClient({
            codexHome,
            sessionStateDir,
            transportFactory: () => transport,
        });

        await client.resumeSession(sid, { sessionId: sid });

        const resumes = transport.recordedRequests.filter((r) => r.method === "thread/resume");
        expect(resumes).toHaveLength(1);
        expect(resumes[0].params.threadId).toBe("codex-thread-preexisting");

        await client.stop();
    });

    it("send() fires turn/start and synthesizes assistant.turn_start/message/turn_end/session.idle", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-turn" },
            turnScript: [
                { emit: "notification", method: "turn/started", params: { threadId: "codex-thread-turn", turn: { id: "turn-1" } } },
                { emit: "notification", method: "item/agentMessage/delta", params: { itemId: "i1", threadId: "codex-thread-turn", turnId: "turn-1", delta: "Hello " } },
                { emit: "notification", method: "item/agentMessage/delta", params: { itemId: "i1", threadId: "codex-thread-turn", turnId: "turn-1", delta: "world." } },
                { emit: "notification", method: "item/completed", params: { threadId: "codex-thread-turn", turnId: "turn-1", completedAtMs: Date.now(), item: { id: "i1", type: "agentMessage", text: "Hello world." } } },
                { emit: "notification", method: "turn/completed", params: { threadId: "codex-thread-turn", turn: { id: "turn-1", status: "completed", tokenUsage: { input: 5, output: 3 } } } },
            ],
        });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const session = await client.createSession({ sessionId: "ps-turn-session" });

        const captured = [];
        session.on((ev) => captured.push(ev));

        await session.send({ prompt: "Hi there" });
        // Wait until session.idle event lands in the captured list (poll).
        for (let i = 0; i < 50; i += 1) {
            if (captured.some((c) => c.type === "session.idle")) break;
            await new Promise((r) => setTimeout(r, 5));
        }

        const types = captured.map((c) => c.type);
        expect(types).toContain("assistant.turn_start");
        expect(types.filter((t) => t === "assistant.message_delta").length).toBeGreaterThanOrEqual(1);
        expect(types).toContain("assistant.message");
        expect(types).toContain("assistant.turn_end");
        expect(types).toContain("session.idle");

        const finalMessage = captured.find((c) => c.type === "assistant.message");
        expect(finalMessage.data.content).toBe("Hello world.");

        // token usage attached to turn_end
        const turnEnd = captured.find((c) => c.type === "assistant.turn_end");
        expect(turnEnd.data.tokenUsage).toEqual({ input: 5, output: 3 });

        await client.stop();
    });

    it("routes a server-side item/tool/call to the registered JS handler and sends DynamicToolCallResponse", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-tools" },
            turnId: "t1",
            turnScript: [
                { emit: "notification", method: "turn/started", params: { threadId: "codex-thread-tools", turn: { id: "t1" } } },
                {
                    emit: "server-request",
                    method: "item/tool/call",
                    // Mirror the observed real 0.145.0 shape: threadId
                    // may be absent. Router must fall back to turnId.
                    params: { turnId: "t1", callId: "call-abc", tool: "test_echo", arguments: { text: "ping" } },
                },
                {
                    emit: "notification",
                    method: "item/completed",
                    params: { threadId: "codex-thread-tools", turnId: "t1", completedAtMs: Date.now(), item: { id: "m1", type: "agentMessage", text: "done" } },
                },
                { emit: "notification", method: "turn/completed", params: { threadId: "codex-thread-tools", turn: { id: "t1", status: "completed" } } },
            ],
        });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const session = await client.createSession({ sessionId: "ps-tools-session" });

        let handlerArgs = null;
        const echoTool = defineTool("test_echo", {
            description: "Echo test tool",
            parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            handler: async (args) => {
                handlerArgs = args;
                return `echo:${args.text}`;
            },
        });
        session.registerTools([echoTool]);

        const captured = [];
        session.on((ev) => captured.push(ev));

        await session.send({ prompt: "run tool" });
        await new Promise((r) => setTimeout(r, 30));

        expect(handlerArgs).toEqual({ text: "ping" });

        // A DynamicToolCallResponse must have been sent back for callId call-abc
        const resp = transport.recordedResponses.find((r) => r.type === "server-request-response" && r.id != null);
        expect(resp).toBeTruthy();
        expect(resp.result).toBeTruthy();
        expect(resp.result.success).toBe(true);
        expect(resp.result.contentItems).toEqual([
            { type: "inputText", text: "echo:ping" },
        ]);

        const toolStart = captured.find((c) => c.type === "tool.execution_start");
        const toolDone = captured.find((c) => c.type === "tool.execution_complete");
        expect(toolStart).toBeTruthy();
        expect(toolStart.data.toolName).toBe("test_echo");
        expect(toolDone).toBeTruthy();
        expect(toolDone.data.toolName).toBe("test_echo");

        await client.stop();
    });

    it("rejects an item/tool/call with neither threadId nor a matchable turnId (ambiguous route)", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-ambig" },
            turnScript: [{
                emit: "server-request",
                method: "item/tool/call",
                params: { callId: "ambig-1", tool: "no_such", arguments: {} },
            }],
        });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        // TWO sessions, neither in an active turn. Nothing to route to.
        // We never call send() so no session is active.
        await client.createSession({ sessionId: "ps-ambig-1" });
        await client.createSession({ sessionId: "ps-ambig-2" });

        // Manually inject the ambiguous server-request (bypass turnScript
        // since we never called send() to trigger it).
        transport.emit("server-request", {
            id: "srv-ambig",
            method: "item/tool/call",
            params: { callId: "ambig-1", tool: "no_such", arguments: {} },
        });
        await new Promise((r) => setTimeout(r, 10));

        // Router must have responded with a JSON-RPC error, not silently
        // picked one of the sessions.
        const resps = transport.recordedResponses;
        expect(resps).toHaveLength(1);
        expect(resps[0].error).toBeTruthy();
        expect(resps[0].result).toBeUndefined();

        await client.stop();
    });

    it("abort() sends turn/interrupt on the active turn", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-abort" },
            turnId: "turn-abort",
            turnScript: [
                { emit: "notification", method: "turn/started", params: { threadId: "codex-thread-abort", turn: { id: "turn-abort" } } },
                { emit: "hold" }, // never completes on its own; abort must unblock
            ],
        });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const session = await client.createSession({ sessionId: "ps-abort-session" });

        session.on(() => {});
        // Do NOT await send(): it now waits for turn/completed which never
        // arrives from the script. The abort path is what synthesizes the
        // terminator, unblocking the promise below.
        const sendPromise = session.send({ prompt: "long" });
        await new Promise((r) => setTimeout(r, 10));

        session.abort();
        await sendPromise;

        // turn/interrupt is a REQUEST, not a notification.
        const interrupts = transport.recordedRequests.filter((r) => r.method === "turn/interrupt");
        expect(interrupts).toHaveLength(1);
        expect(interrupts[0].kind).toBe("request");
        expect(interrupts[0].params.threadId).toBe("codex-thread-abort");
        expect(interrupts[0].params.turnId).toBe("turn-abort");

        await client.stop();
    }, 3_000);

    it("thread/start declares dynamicTools schemas for every tool passed to createSession", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-dyn" } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        const echoTool = defineTool("test_echo", {
            description: "Echo test tool",
            parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            handler: async () => "ok",
        });

        await client.createSession({
            sessionId: "ps-dyn-1",
            model: "gpt-5.6-sol",
            developerInstructions: "You are a codex test.",
            cwd: sessionStateDir,
            reasoningEffort: "medium",
            tools: [echoTool],
        });

        const start = transport.recordedRequests.find((r) => r.method === "thread/start");
        expect(start).toBeTruthy();
        expect(start.params.model).toBe("gpt-5.6-sol");
        expect(start.params.cwd).toBe(sessionStateDir);
        expect(start.params.developerInstructions).toBe("You are a codex test.");
        expect(Array.isArray(start.params.dynamicTools)).toBe(true);
        const echoSpec = start.params.dynamicTools.find((t) => t.name === "test_echo");
        expect(echoSpec).toBeTruthy();
        expect(echoSpec.type).toBe("function");
        expect(echoSpec.description).toBe("Echo test tool");
        expect(echoSpec.inputSchema).toEqual({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });

        await client.stop();
    });

    it("thread/resume forwards a rollout path when one was persisted", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const sid = "ps-resume-path";
        const sessDir = path.join(sessionStateDir, sid);
        fs.mkdirSync(sessDir, { recursive: true });
        const rolloutPath = path.join(sessDir, "codex-rollout.jsonl");
        fs.writeFileSync(rolloutPath, '{"type":"session_meta","payload":{"id":"codex-thread-restored"}}\n');
        fs.writeFileSync(path.join(sessDir, CODEX_THREAD_STATE_FILENAME), JSON.stringify({
            codexThreadId: "codex-thread-restored",
            codexHome,
            rolloutSnapshotRelPath: "codex-rollout.jsonl",
        }));

        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-restored" } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        await client.resumeSession(sid, { sessionId: sid });

        const resume = transport.recordedRequests.find((r) => r.method === "thread/resume");
        expect(resume).toBeTruthy();
        expect(resume.params.threadId).toBe("codex-thread-restored");
        expect(resume.params.path).toBe(rolloutPath);

        await client.stop();
    });

    it("send() uses UserInput shape with text_elements=[] and captures the turn id from turn/start response", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-ui" },
            // Hold the turn open so we can observe the turn id latch
            // BEFORE turn/completed nulls it. Under D3(c) the runtime
            // deliberately does NOT re-latch a stale respTurnId after
            // the turn has already reached a terminal state, so using
            // an empty turnScript here (which auto-terminates) would
            // race the terminator ahead of the ack path.
            turnScript: [{ emit: "hold" }],
        });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const session = await client.createSession({ sessionId: "ps-ui-session" });

        await session.send({ prompt: "hello" });

        const start = transport.recordedRequests.find((r) => r.method === "turn/start");
        expect(start).toBeTruthy();
        expect(start.params.input).toEqual([{ type: "text", text: "hello", text_elements: [] }]);

        // The session must have latched the turn id from the response so
        // abort() can build a valid turn/interrupt without waiting for the
        // turn/started notification.
        expect(session.getActiveTurnIdForTests()).toMatch(/^fake-turn-/);

        // Release the held turn so the client can shut down cleanly.
        session.abort();
        await new Promise((r) => setTimeout(r, 10));
        await client.stop();
    }, 3_000);

    it("send() resolves after turn/start ack; queue holds until turn/completed", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        // Craft a scenario where turn/completed does NOT fire on its own,
        // so we can prove send() resolved before turn/completed.
        let resolveFirstCompletion;
        const firstCompletion = new Promise((r) => { resolveFirstCompletion = r; });
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-nonblocking" },
            turnId: "turn-nb-1",
            turnScript: [
                { emit: "notification", method: "turn/started", params: { threadId: "codex-thread-nonblocking", turn: { id: "turn-nb-1" } } },
                { emit: "hold" }, // no auto-completion
            ],
        });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const session = await client.createSession({ sessionId: "ps-nb-1" });
        session.on(() => {});

        const start = Date.now();
        const sendPromise = session.send({ prompt: "hello" });
        const settled = await Promise.race([
            sendPromise.then(() => "resolved"),
            new Promise((r) => setTimeout(() => r("timeout"), 200)),
        ]);
        expect(settled).toBe("resolved");
        expect(Date.now() - start).toBeLessThan(200);
        // turn/start was recorded but turn/completed has not yet fired.
        const starts = transport.recordedRequests.filter((r) => r.method === "turn/start");
        expect(starts).toHaveLength(1);

        // Prove the client-level queue is still held: create a second
        // session on the same client and try to start a turn — it must
        // NOT be sent until the first turn completes.
        const s2 = await client.createSession({ sessionId: "ps-nb-2" });
        s2.on(() => {});
        const p2 = s2.send({ prompt: "second" });
        await new Promise((r) => setTimeout(r, 30));
        const starts2 = transport.recordedRequests.filter((r) => r.method === "turn/start");
        expect(starts2).toHaveLength(1);
        // Release the first turn by emitting turn/completed.
        transport.emit("notification", { method: "turn/completed", params: { threadId: "codex-thread-nonblocking", turn: { id: "turn-nb-1", status: "completed" } } });
        await p2;
        expect(transport.recordedRequests.filter((r) => r.method === "turn/start").length).toBe(2);

        resolveFirstCompletion();
        await client.stop();
        await client.stop();
    }, 3_000);
    it("stop settles a held active turn while listeners are live and releases the shared turn queue", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-stop-held" },
            turnId: "turn-stop-held",
            turnScript: [
                {
                    emit: "notification",
                    method: "turn/started",
                    params: { threadId: "codex-thread-stop-held", turn: { id: "turn-stop-held" } },
                },
                { emit: "hold" },
            ],
        });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const active = await client.createSession({ sessionId: "ps-stop-held-active" });
        const queued = await client.createSession({ sessionId: "ps-stop-held-queued" });

        const activeEvents = [];
        const queuedEvents = [];
        active.on((event) => activeEvents.push(event));
        queued.on((event) => queuedEvents.push(event));
        await active.send({ prompt: "hold this turn" });

        const queuedSend = queued.send({ prompt: "must not wedge behind shutdown" }).then(
            () => "resolved",
            () => "rejected",
        );

        await client.stop();
        const queuedOutcome = await queuedSend;

        expect(activeEvents.some((event) => event.type === "session.idle")).toBe(true);
        expect(queuedOutcome).toBe("rejected");
        expect(queuedEvents.filter((event) => event.type === "session.idle")).toHaveLength(1);
        expect(client["sessions"].size).toBe(0);
        expect(client["turnQueue"]).toBeInstanceOf(Promise);
        await expect(client["turnQueue"]).resolves.toBeUndefined();
    }, 3_000);

    it("send() returns synchronously enough that ManagedSession can await it before racing its own timeout", async () => {
        // Regression guard: ManagedSession.runTurn does `await session.send(...)`
        // BEFORE it wires the timeout race. Codex.send() must therefore
        // resolve after turn/start ack (not after turn/completed), otherwise
        // a hung turn keeps the timeout race from ever starting.
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-timeout" },
            turnId: "turn-t",
            turnScript: [{ emit: "hold" }],
        });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const session = await client.createSession({ sessionId: "ps-timeout" });

        // Simulate the ManagedSession race: await send() first, THEN wait
        // for session.idle with a short timeout, then interrupt.
        const sawIdle = new Promise((resolve) => {
            session.on("session.idle", () => resolve(true));
        });
        await session.send({ prompt: "hang" }); // must resolve
        session.abort();
        const idled = await Promise.race([sawIdle, new Promise((r) => setTimeout(() => r(false), 500))]);
        expect(idled).toBe(true);

        await client.stop();
    }, 3_000);

    it("second-turn abort before the queued lambda starts still emits exactly one new idle", async () => {
        // Regression: `send()` resets the per-turn suppression flags
        // (`turnEndFired`) only AFTER the queued lambda has cleared the
        // abort short-circuit. On a SECOND turn, `turnEndFired` is still
        // `true` from the first turn's `turn/completed`, so the abort
        // short-circuit's `_markTurnTerminal({ emitIdle: true })` was
        // suppressed as a duplicate. `send()` resolved via `ackResolve()`
        // but no `session.idle` ever arrived, so `ManagedSession.runTurn()`
        // hung on its idle race until the turn timeout.
        const { codexHome, sessionStateDir } = mkTmpHomes();

        // A blocker session holds the client-wide turn queue so the second
        // turn on the session under test is aborted BEFORE its queued
        // lambda begins.
        let releaseBlocker;
        const blockerDone = new Promise((r) => { releaseBlocker = r; });
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-second-abort" } });
        const origRequest = transport.request.bind(transport);
        let startSeq = 0;
        transport.request = async function (method, params) {
            if (method === "turn/start") {
                startSeq += 1;
                transport.recordedRequests.push({ kind: "request", method, params });
                const id = `sa-turn-${startSeq}`;
                const threadId = params?.threadId;
                if (startSeq === 1) {
                    // Turn 1 on the session under test completes normally.
                    queueMicrotask(() => transport.emit("notification", {
                        method: "turn/completed",
                        params: { threadId, turn: { id, status: "completed" } },
                    }));
                } else {
                    // The blocker's turn hangs until we release it.
                    blockerDone.then(() => transport.emit("notification", {
                        method: "turn/completed",
                        params: { threadId, turn: { id, status: "completed" } },
                    }));
                }
                return { turn: { id } };
            }
            return origRequest(method, params);
        };

        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const session = await client.createSession({ sessionId: "ps-second-abort" });
        const blocker = await client.createSession({ sessionId: "ps-second-abort-blocker" });
        blocker.on(() => {});

        const idleEvents = [];
        const turnEndEvents = [];
        session.on("session.idle", (e) => idleEvents.push(e));
        session.on("assistant.turn_end", (e) => turnEndEvents.push(e));

        // ── Turn 1: normal completion ────────────────────────────
        await session.send({ prompt: "first turn" });
        await new Promise((r) => setTimeout(r, 20));
        expect(idleEvents).toHaveLength(1);
        expect(turnEndEvents).toHaveLength(1);

        // ── Blocker occupies the queue ───────────────────────────
        await blocker.send({ prompt: "hold the queue" });

        // ── Turn 2: aborted while still queued ───────────────────
        const secondSend = session.send({ prompt: "second turn" });
        session.abort();

        releaseBlocker();
        await secondSend; // must resolve, not hang
        await new Promise((r) => setTimeout(r, 20));

        // Exactly one NEW terminal signal for the aborted second turn.
        expect(idleEvents).toHaveLength(2);
        // The aborted-before-start path never ran the model, so it must
        // not synthesize a second assistant.turn_end.
        expect(turnEndEvents).toHaveLength(1);

        // The aborted turn never consumed a Codex turn: only turn 1 and
        // the blocker's turn reached turn/start.
        const starts = transport.recordedRequests.filter((r) => r.method === "turn/start");
        expect(starts).toHaveLength(2);
        const interrupts = transport.recordedRequests.filter((r) => r.method === "turn/interrupt");
        expect(interrupts).toHaveLength(0);

        await client.stop();
    }, 5_000);

    it("abort while queued behind another session prevents turn/start entirely", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        // First session's turn hangs until we release it, blocking the
        // client-wide queue. Second session's send() must never actually
        // reach turn/start if aborted while queued.
        let releaseFirst;
        const firstDone = new Promise((r) => { releaseFirst = r; });
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-queued-abort" } });
        const origRequest = transport.request.bind(transport);
        let seq = 0;
        transport.request = async function (method, params) {
            if (method === "turn/start") {
                seq += 1;
                transport.recordedRequests.push({ kind: "request", method, params });
                const id = `q-abort-${seq}`;
                if (seq === 1) {
                    queueMicrotask(() => transport.emit("notification", { method: "turn/started", params: { threadId: "codex-thread-queued-abort", turn: { id } } }));
                    firstDone.then(() => transport.emit("notification", { method: "turn/completed", params: { threadId: "codex-thread-queued-abort", turn: { id, status: "completed" } } }));
                }
                return { turn: { id } };
            }
            return origRequest(method, params);
        };
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        const s1 = await client.createSession({ sessionId: "ps-qa-1" });
        const s2 = await client.createSession({ sessionId: "ps-qa-2" });
        s1.on(() => {}); s2.on(() => {});

        await s1.send({ prompt: "first" }); // holds the queue
        const p2 = s2.send({ prompt: "second" });
        // p2 is now waiting on the queue behind s1. Abort BEFORE it runs.
        s2.abort();

        // p2 must resolve (queue lambda short-circuits) and never invoke
        // a second turn/start. Release s1 to unblock the queue.
        releaseFirst();
        await p2;
        const starts = transport.recordedRequests.filter((r) => r.method === "turn/start");
        expect(starts).toHaveLength(1);
        // Aborted queued session never consumes a Codex turn.
        const interrupts = transport.recordedRequests.filter((r) => r.method === "turn/interrupt");
        expect(interrupts).toHaveLength(0);

        await client.stop();
    }, 3_000);

    it("abort during turn/start round-trip latches interrupt for the returned turn id", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        // Delay the turn/start response so we can invoke abort() while it
        // is in flight. Then assert turn/interrupt is fired with the
        // response's id.
        let resolveStart;
        const startArrival = new Promise((r) => { resolveStart = r; });
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-inflight" } });
        const origRequest = transport.request.bind(transport);
        transport.request = async function (method, params) {
            if (method === "turn/start") {
                transport.recordedRequests.push({ kind: "request", method, params });
                await startArrival;
                const id = "delayed-turn-1";
                queueMicrotask(() => transport.emit("notification", { method: "turn/completed", params: { threadId: "codex-thread-inflight", turn: { id, status: "interrupted" } } }));
                return { turn: { id } };
            }
            return origRequest(method, params);
        };
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const session = await client.createSession({ sessionId: "ps-inflight" });
        session.on(() => {});

        const p = session.send({ prompt: "abort me mid-flight" });
        // Give the queued lambda a microtask so it enters `await
        // transport.request("turn/start")` — otherwise abort() fires
        // before turn/start was even attempted (that path is the
        // "abort while queued" test).
        await new Promise((r) => setTimeout(r, 5));
        // Abort while turn/start is still awaiting the response.
        session.abort();
        // Now let turn/start resolve.
        resolveStart();
        await p;
        // A tick for the follow-up microtask that fires the interrupt.
        await new Promise((r) => setTimeout(r, 20));

        const interrupts = transport.recordedRequests.filter((r) => r.method === "turn/interrupt");
        expect(interrupts).toHaveLength(1);
        expect(interrupts[0].params.turnId).toBe("delayed-turn-1");

        await client.stop();
    }, 3_000);

    it("warm session survives transport close and issues thread/resume before next turn/start", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        let transportCount = 0;
        const transports = [];
        const factory = () => {
            transportCount += 1;
            const t = createFakeCodexTransport({ thread: { id: "codex-thread-reconnect" } });
            transports.push(t);
            return t;
        };
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: factory });
        const session = await client.createSession({ sessionId: "ps-reconnect", model: "gpt-5.6-sol", cwd: sessionStateDir, developerInstructions: "hi" });
        session.on(() => {});
        // Rip the transport out from under the warm session.
        await transports[0].close();
        await new Promise((r) => setTimeout(r, 10));

        // Same warm session sends again. Must NOT throw; must re-init and
        // thread/resume the SAME threadId before turn/start on the new
        // transport.
        await session.send({ prompt: "next" });
        // Give completion notification a tick.
        await new Promise((r) => setTimeout(r, 20));

        expect(transportCount).toBe(2);
        const t2 = transports[1];
        const methods = t2.recordedRequests.map((r) => `${r.kind}:${r.method}`);
        const initIdx = methods.indexOf("request:initialize");
        const initedIdx = methods.indexOf("notification:initialized");
        const resumeIdx = methods.indexOf("request:thread/resume");
        const startIdx = methods.indexOf("request:turn/start");
        expect(initIdx).toBeGreaterThanOrEqual(0);
        expect(initedIdx).toBeGreaterThan(initIdx);
        expect(resumeIdx).toBeGreaterThan(initedIdx);
        expect(startIdx).toBeGreaterThan(resumeIdx);
        // The resume must carry the SAME threadId, plus the model /
        // cwd / developerInstructions we originally configured, and the
        // restored rollout path (there is no rollout snapshot in this
        // scenario, so `path` may be absent — but resume MUST happen).
        const resume = t2.recordedRequests[resumeIdx];
        expect(resume.params.threadId).toBe("codex-thread-reconnect");
        expect(resume.params.model).toBe("gpt-5.6-sol");
        expect(resume.params.cwd).toBe(sessionStateDir);
        expect(resume.params.developerInstructions).toBe("hi");

        await client.stop();
    }, 3_000);

    it("session-scoped notifications never leak across sibling sessions", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        // Craft a transport whose scripted turn/started fires and then
        // holds so we can manually deliver missing-threadId
        // notifications and observe routing.
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-leak" },
            turnId: "turn-leak-1",
            turnScript: [
                { emit: "notification", method: "turn/started", params: { threadId: "codex-thread-leak", turn: { id: "turn-leak-1" } } },
                { emit: "hold" },
            ],
        });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const s1 = await client.createSession({ sessionId: "ps-leak-1" });
        const s2 = await client.createSession({ sessionId: "ps-leak-2" });

        const s1Events = [];
        const s2Events = [];
        s1.on((ev) => s1Events.push(ev));
        s2.on((ev) => s2Events.push(ev));

        void s1.send({ prompt: "go" });
        // Wait until s1 latches its active turn id.
        for (let i = 0; i < 20 && s1.getActiveTurnIdForTests() == null; i += 1) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(s1.getActiveTurnIdForTests()).toBe("turn-leak-1");
        expect(s2.getActiveTurnIdForTests()).toBeNull();

        // A production-shaped item/completed WITHOUT threadId, only
        // turnId, must route to s1 only. Broadcasting would leak s1's
        // assistant text into s2.
        transport.emit("notification", { method: "item/completed", params: { turnId: "turn-leak-1", item: { id: "m", type: "agentMessage", text: "secret-from-s1" } } });
        // And a turn/completed with only turn.id must also target s1.
        transport.emit("notification", { method: "turn/completed", params: { turn: { id: "turn-leak-1", status: "completed" } } });
        await new Promise((r) => setTimeout(r, 10));

        // s1 sees them; s2 sees nothing.
        expect(s1Events.some((e) => e.type === "assistant.message" && String(e.data?.content || "").includes("secret-from-s1"))).toBe(true);
        expect(s1Events.some((e) => e.type === "session.idle")).toBe(true);
        expect(s2Events.some((e) => e.type === "assistant.message")).toBe(false);
        expect(s2Events.some((e) => e.type === "session.idle")).toBe(false);

        await client.stop();
    }, 3_000);

    it("drops missing-threadId session notifications when no session is active", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-drop" } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const s1 = await client.createSession({ sessionId: "ps-drop-1" });
        const s2 = await client.createSession({ sessionId: "ps-drop-2" });
        const events1 = [], events2 = [];
        s1.on((e) => events1.push(e));
        s2.on((e) => events2.push(e));

        // No active turn on either session. Emit item/completed with
        // NEITHER threadId NOR turnId — router must drop.
        transport.emit("notification", { method: "item/completed", params: { item: { id: "x", type: "agentMessage", text: "orphan" } } });
        await new Promise((r) => setTimeout(r, 5));
        expect(events1).toHaveLength(0);
        expect(events2).toHaveLength(0);

        await client.stop();
    }, 3_000);

    it("stale transport events never mutate or reply through a subsequent transport", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transports = [];
        const factory = () => {
            const t = createFakeCodexTransport({ thread: { id: `codex-stale-${transports.length + 1}` } });
            transports.push(t);
            return t;
        };
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: factory });

        // Boot transport #1.
        await client.createSession({ sessionId: "ps-stale-1" });
        expect(transports.length).toBe(1);
        const tOld = transports[0];

        // Close #1; a fresh createSession spins up #2.
        await tOld.close();
        await new Promise((r) => setTimeout(r, 5));
        await client.createSession({ sessionId: "ps-stale-2" });
        expect(transports.length).toBe(2);
        const tNew = transports[1];
        const clientAny = client;

        // Now the OLD transport misbehaves: a delayed second close,
        // then a stray notification, then a stray server-request. None
        // of these must be able to null the live transport, deliver
        // events to the new session, or send a response back through
        // the NEW transport.
        tOld.emit("close");
        tOld.emit("notification", { method: "turn/started", params: { threadId: "codex-stale-1", turn: { id: "ghost" } } });
        tOld.emit("server-request", { id: "ghost-req", method: "item/tool/call", params: { turnId: "ghost", callId: "c", tool: "no_such", arguments: {} } });
        await new Promise((r) => setTimeout(r, 10));

        expect(clientAny.transport).toBe(tNew);
        // No response for the ghost request should have gone through tNew.
        expect(tNew.recordedResponses.find((r) => r.id === "ghost-req")).toBeUndefined();
        // And the stray notification must not have caused tNew-side
        // state to change either — the newest session's active turn id
        // should stay null.
        expect(clientAny.sessions.get("ps-stale-2").getActiveTurnIdForTests()).toBeNull();

        await client.stop();
    }, 3_000);

    it("initializes exactly once even when two createSession calls race", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        // Delay the initialize response so the two createSession calls
        // enter the queue while `_ensureInitialized()` is still in flight.
        let resolveInit;
        const initGate = new Promise((r) => { resolveInit = r; });
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-race" } });
        const origRequest = transport.request.bind(transport);
        transport.request = async function (method, params) {
            transport.recordedRequests.push({ kind: "request", method, params });
            if (method === "initialize") {
                await initGate;
                return { serverInfo: { name: "fake-codex", version: "0.0" }, capabilities: {} };
            }
            // Delegate everything else to the base fake — the wrapper
            // already recorded the request so we skip origRequest's
            // duplicate recording.
            return origRequest.call({ ...transport, recordedRequests: { push: () => {} } }, method, params);
        };
        // The delegation trick above is fragile; instead, use a cleaner
        // pass-through by removing the pre-recorded entry for non-init
        // methods and letting origRequest record fresh.
        transport.request = async function (method, params) {
            if (method === "initialize") {
                transport.recordedRequests.push({ kind: "request", method, params });
                await initGate;
                return { serverInfo: { name: "fake-codex", version: "0.0" }, capabilities: {} };
            }
            return origRequest(method, params);
        };
        let transportSpawns = 0;
        const client = new CodexRuntimeClient({
            codexHome, sessionStateDir,
            transportFactory: () => { transportSpawns += 1; return transport; },
        });

        const p1 = client.createSession({ sessionId: "ps-race-1" });
        const p2 = client.createSession({ sessionId: "ps-race-2" });
        // Both are now blocked on `_ensureInitialized()`. Release init.
        await new Promise((r) => setTimeout(r, 10));
        resolveInit();
        await Promise.all([p1, p2]);

        const inits = transport.recordedRequests.filter((r) => r.method === "initialize");
        const initedNotifs = transport.recordedRequests.filter((r) => r.method === "initialized" && r.kind === "notification");
        const starts = transport.recordedRequests.filter((r) => r.method === "thread/start");
        expect(inits).toHaveLength(1);
        expect(initedNotifs).toHaveLength(1);
        expect(starts).toHaveLength(2);
        expect(transportSpawns).toBe(1);

        await client.stop();
    }, 3_000);

    it("recovers after the transport closes: next createSession spawns a fresh transport and re-initializes", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transports = [];
        const factory = () => {
            const t = createFakeCodexTransport({ thread: { id: `codex-thread-recover-${transports.length + 1}` } });
            transports.push(t);
            return t;
        };
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: factory });

        // First session boots transport #1 and does the initialize handshake.
        await client.createSession({ sessionId: "ps-recover-1" });
        expect(transports.length).toBe(1);
        expect(transports[0].recordedRequests.some((r) => r.method === "initialize")).toBe(true);

        // Simulate the codex app-server crashing.
        await transports[0].close();
        // Give the close event a tick to reach the client.
        await new Promise((r) => setTimeout(r, 5));

        // A second createSession MUST NOT dereference a null transport;
        // it must spawn a fresh one and re-do initialize.
        await client.createSession({ sessionId: "ps-recover-2" });
        expect(transports.length).toBe(2);
        expect(transports[1].recordedRequests.some((r) => r.method === "initialize")).toBe(true);
        expect(transports[1].recordedRequests.some((r) => r.method === "thread/start")).toBe(true);

        await client.stop();
    });

    it("rejects createSession cleanly when CODEX_HOME does not exist", async () => {
        const client = new CodexRuntimeClient({
            codexHome: "/nonexistent/does/not/exist/codex-xyz",
            sessionStateDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-nohome-")),
            transportFactory: () => createFakeCodexTransport({ thread: { id: "irrelevant" } }),
        });

        await expect(
            client.createSession({ sessionId: "ps-nohome" }),
        ).rejects.toThrow(/CODEX_HOME/);
    });

    it("rejects createSession when CODEX_HOME has group/world permissions", async () => {
        if (process.platform === "win32") return; // POSIX-only guard
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-perm-"));
        const codexHome = path.join(root, "codex-home");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.chmodSync(codexHome, 0o755); // group/world readable — must fail
        const client = new CodexRuntimeClient({
            codexHome,
            sessionStateDir: path.join(root, "state"),
            transportFactory: () => createFakeCodexTransport({ thread: { id: "irrelevant" } }),
        });

        await expect(
            client.createSession({ sessionId: "ps-perm" }),
        ).rejects.toThrow(/permission|mode|0700/i);
    });

    it("routes a server-request with a nonempty unknown threadId to nobody (never falls through to sole-active/turnId)", async () => {
        // Regression: if Codex ever emits an item/tool/call whose threadId
        // is nonempty but does not match any live session (stale, foreign,
        // or a bug on Codex's side), the router MUST NOT fall through to
        // the turnId or "sole session with an active turn" heuristic and
        // execute a tool against an innocent bystander session. It must
        // respond with a JSON-RPC error and leave every session untouched.
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-mismatch-primary" },
            turnId: "turn-active-s1",
            turnScript: [
                { emit: "notification", method: "turn/started", params: { threadId: "codex-thread-mismatch-primary", turn: { id: "turn-active-s1" } } },
                { emit: "hold" },
            ],
        });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        // s1 is the ONLY session with an active turn — the old buggy
        // fallback would happily hand a foreign-threadId tool call to
        // s1 as the "sole active session".
        const s1 = await client.createSession({ sessionId: "ps-authz-s1" });
        const s2 = await client.createSession({ sessionId: "ps-authz-s2" });
        const s1Events = [];
        const s2Events = [];
        s1.on((ev) => s1Events.push(ev));
        s2.on((ev) => s2Events.push(ev));

        let handlerCalls = 0;
        const echoTool = defineTool("test_echo", {
            description: "Echo test tool",
            parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            handler: async () => { handlerCalls += 1; return "should-not-run"; },
        });
        s1.registerTools([echoTool]);
        s2.registerTools([echoTool]);

        void s1.send({ prompt: "long" });
        for (let i = 0; i < 40 && s1.getActiveTurnIdForTests() == null; i += 1) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(s1.getActiveTurnIdForTests()).toBe("turn-active-s1");

        // Baseline count of prior responses (turn/interrupt etc.) so we
        // can isolate the response written for this foreign-threadId
        // request.
        const baselineResponses = transport.recordedResponses.length;

        // Inject item/tool/call with a NONEMPTY threadId that does not
        // match either session. The buggy fallback used turnId (a
        // matching s1 turn id) OR "sole active session" to still route.
        transport.emit("server-request", {
            id: "srv-foreign",
            method: "item/tool/call",
            params: {
                threadId: "codex-thread-does-not-exist",
                // Also include s1's live turnId; a correct router still
                // refuses because the nonempty threadId is authoritative.
                turnId: "turn-active-s1",
                callId: "call-foreign-1",
                tool: "test_echo",
                arguments: { text: "should-never-run" },
            },
        });
        await new Promise((r) => setTimeout(r, 20));

        // 1. Handler must NOT have run.
        expect(handlerCalls).toBe(0);

        // 2. Neither session should have emitted a tool.execution_start
        //    or tool.execution_complete for callId call-foreign-1.
        expect(s1Events.some((e) => (e.type === "tool.execution_start" || e.type === "tool.execution_complete") && e.data?.callId === "call-foreign-1")).toBe(false);
        expect(s2Events.some((e) => (e.type === "tool.execution_start" || e.type === "tool.execution_complete") && e.data?.callId === "call-foreign-1")).toBe(false);

        // 3. The originating transport must have received a respondError
        //    (JSON-RPC error) for id srv-foreign, not a respond().
        const newResponses = transport.recordedResponses.slice(baselineResponses);
        const foreignResp = newResponses.find((r) => r.id === "srv-foreign");
        expect(foreignResp).toBeTruthy();
        expect(foreignResp.error).toBeTruthy();
        expect(foreignResp.result).toBeUndefined();

        // Release s1's held turn so the client can shut down cleanly.
        s1.abort();
        await new Promise((r) => setTimeout(r, 20));
        await client.stop();
    }, 3_000);

    it("(D3a) close during an active turn clears activeTurnId; missing-threadId routing later does not target the crashed session", async () => {
        // Regression: after transport close, the session's activeTurnId
        // stayed set. That made the crashed session look "active" to
        // _routeServerRequest's sole-active fallback and let a stray
        // missing-threadId tool call execute a handler on the corpse.
        const { codexHome, sessionStateDir } = mkTmpHomes();
        // Two independent transports so we can crash the first while
        // still asserting on router behavior on the second.
        const transports = [];
        const factory = () => {
            const t = createFakeCodexTransport({
                thread: { id: `codex-thread-d3a-${transports.length + 1}` },
                turnId: `t-d3a-${transports.length + 1}`,
                turnScript: transports.length === 0
                    // First transport's turn HOLDS so we can crash it mid-turn.
                    ? [
                        { emit: "notification", method: "turn/started", params: { threadId: "codex-thread-d3a-1", turn: { id: "t-d3a-1" } } },
                        { emit: "hold" },
                    ]
                    // Second transport is idle after createSession — no auto-turn.
                    : [],
            });
            transports.push(t);
            return t;
        };
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: factory });
        const s1 = await client.createSession({ sessionId: "ps-d3a-s1" });

        let handlerCalls = 0;
        const echoTool = defineTool("test_echo", {
            description: "Echo test tool",
            parameters: { type: "object", properties: {}, required: [] },
            handler: async () => { handlerCalls += 1; return "should-not-run"; },
        });
        s1.registerTools([echoTool]);

        void s1.send({ prompt: "hang" });
        for (let i = 0; i < 40 && s1.getActiveTurnIdForTests() == null; i += 1) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(s1.getActiveTurnIdForTests()).toBe("t-d3a-1");

        // Crash transport #1 mid-turn.
        await transports[0].close();
        await new Promise((r) => setTimeout(r, 10));

        // (i) activeTurnId must be cleared post-close.
        expect(s1.getActiveTurnIdForTests()).toBeNull();

        // (ii) Bring up a fresh transport by creating a second session.
        //     After the crash, s1 is a "corpse" (still in the sessions map,
        //     no active turn). If s1.activeTurnId were still set, the
        //     router would count it as sole-active and route a
        //     missing-threadId item/tool/call to its handler.
        await client.createSession({ sessionId: "ps-d3a-s2" });
        expect(transports.length).toBe(2);
        const tNew = transports[1];

        // Register a spy handler on s2 too so we can prove nothing runs
        // on s1 in particular — and nothing routes to s2 either since
        // neither session is in an active turn.
        const s2 = client["sessions"].get("ps-d3a-s2");
        s2.registerTools([echoTool]);

        const baselineResp = tNew.recordedResponses.length;
        tNew.emit("server-request", {
            id: "d3a-stray",
            method: "item/tool/call",
            params: { callId: "d3a-1", tool: "test_echo", arguments: {} },
        });
        await new Promise((r) => setTimeout(r, 15));

        expect(handlerCalls).toBe(0);
        const newResps = tNew.recordedResponses.slice(baselineResp);
        const stray = newResps.find((r) => r.id === "d3a-stray");
        expect(stray).toBeTruthy();
        expect(stray.error).toBeTruthy();

        await client.stop();
    }, 3_000);

    it("(D3b) `error` notification during an active turn clears activeTurnId", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-d3b" },
            turnId: "t-d3b",
            turnScript: [
                { emit: "notification", method: "turn/started", params: { threadId: "codex-thread-d3b", turn: { id: "t-d3b" } } },
                { emit: "hold" },
            ],
        });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const s1 = await client.createSession({ sessionId: "ps-d3b" });
        s1.on(() => {});

        void s1.send({ prompt: "err" });
        for (let i = 0; i < 40 && s1.getActiveTurnIdForTests() == null; i += 1) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(s1.getActiveTurnIdForTests()).toBe("t-d3b");

        transport.emit("notification", {
            method: "error",
            params: { threadId: "codex-thread-d3b", message: "boom" },
        });
        await new Promise((r) => setTimeout(r, 10));

        expect(s1.getActiveTurnIdForTests()).toBeNull();

        await client.stop();
    }, 3_000);

    it("(D3c) turn/completed arriving before delayed turn/start response does not re-latch turn id; ack settles and queue releases once", async () => {
        // Regression: turn/completed fires first (with the real turn id).
        // The delayed turn/start response then returns with the same
        // (or another) turn id. The buggy code unconditionally set
        // `this.activeTurnId = respTurnId` after ack, re-latching a
        // turn id on a session that is already terminal for this turn.
        // A second symptom: if the queue lambda ran the resolver twice
        // (once from completion, once from ack path), subsequent turns
        // could double-release the per-CODEX_HOME queue.
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-d3c" } });
        const origRequest = transport.request.bind(transport);
        let releaseStart;
        const startGate = new Promise((r) => { releaseStart = r; });
        let capturedTurnStartRequests = 0;
        transport.request = async function (method, params) {
            if (method === "turn/start") {
                transport.recordedRequests.push({ kind: "request", method, params });
                capturedTurnStartRequests += 1;
                if (capturedTurnStartRequests === 1) {
                    // Do NOT auto-play the scripted terminator; the test
                    // will emit turn/completed manually BEFORE releasing
                    // this response.
                    await startGate;
                    return { turn: { id: "t-d3c-real" } };
                }
                // Subsequent turns: pass through to fake behavior.
                return origRequest(method, params);
            }
            return origRequest(method, params);
        };

        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const s1 = await client.createSession({ sessionId: "ps-d3c-s1" });
        const idleEvents = [];
        s1.on("session.idle", (e) => idleEvents.push(e));

        const sendPromise = s1.send({ prompt: "race" });
        // Wait for the turn/start request to have been sent.
        for (let i = 0; i < 40 && capturedTurnStartRequests === 0; i += 1) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(capturedTurnStartRequests).toBe(1);

        // Emit turn/completed BEFORE turn/start response returns. The
        // real Codex has never actually done this to us — but the
        // present code's ordering guarantees it must remain safe if it
        // does. Match by turnId so the notification router locks onto
        // s1.
        // s1 has no activeTurnId latched yet — routing by
        // turnId/threadId won't hit it. Since s1 is the only session
        // with a live send() in flight, we can safely target it via
        // threadId (which _routeNotification uses first).
        transport.emit("notification", {
            method: "turn/completed",
            params: { threadId: "codex-thread-d3c", turn: { id: "t-d3c-real", status: "completed" } },
        });
        await new Promise((r) => setTimeout(r, 5));

        // Now release the delayed turn/start response.
        releaseStart();
        await sendPromise; // ack must still resolve exactly once

        // A subsequent send on s1 must go through (the queue must have
        // released exactly once, not zero times).
        const idleCountAfterFirst = idleEvents.length;
        const p2 = s1.send({ prompt: "second" });
        // Second turn is scripted (default synthetic terminator).
        await p2;

        // Post-conditions:
        // (i) session is not stuck in a stale active-turn state.
        expect(s1.getActiveTurnIdForTests()).toBeNull();
        // (ii) session.idle for the racy first turn fired exactly once.
        expect(idleCountAfterFirst).toBe(1);
        // (iii) both turns eventually completed (one idle each).
        expect(idleEvents.length).toBeGreaterThanOrEqual(2);

        await client.stop();
    }, 3_000);

    it("(D3d) close after a completed turn emits no duplicate session.idle / assistant.turn_end", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({
            thread: { id: "codex-thread-d3d" },
            turnId: "t-d3d",
            turnScript: [
                { emit: "notification", method: "turn/started", params: { threadId: "codex-thread-d3d", turn: { id: "t-d3d" } } },
                { emit: "notification", method: "turn/completed", params: { threadId: "codex-thread-d3d", turn: { id: "t-d3d", status: "completed" } } },
            ],
        });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const s1 = await client.createSession({ sessionId: "ps-d3d" });
        const events = [];
        s1.on((e) => events.push(e));

        await s1.send({ prompt: "one" });
        for (let i = 0; i < 40 && !events.some((e) => e.type === "session.idle"); i += 1) {
            await new Promise((r) => setTimeout(r, 5));
        }
        const idleBeforeClose = events.filter((e) => e.type === "session.idle").length;
        const endBeforeClose = events.filter((e) => e.type === "assistant.turn_end").length;
        expect(idleBeforeClose).toBe(1);
        expect(endBeforeClose).toBe(1);

        await transport.close();
        await new Promise((r) => setTimeout(r, 15));

        const idleAfterClose = events.filter((e) => e.type === "session.idle").length;
        const endAfterClose = events.filter((e) => e.type === "assistant.turn_end").length;
        // No new session.idle or assistant.turn_end after the turn had
        // already completed. It is fine (and even expected) that a
        // session.error is emitted informing about the transport close.
        expect(idleAfterClose).toBe(idleBeforeClose);
        expect(endAfterClose).toBe(endBeforeClose);

        await client.stop();
    }, 3_000);

    // ─── R2-D1: createSession must purge the dirty local session dir ──

    it("(R2-D1a) createSession purges any pre-existing local per-session dir before writing the fresh marker", async () => {
        // Regression: if a previous run left orphan files under
        // `<sessionStateDir>/<sessionId>` (old Copilot `workspace.yaml`,
        // an orphan `codex-rollout.jsonl` from a deleted thread, or any
        // sentinel bytes at all), a subsequent createSession used to
        // write the fresh Codex marker INTO that dirty directory. Later
        // archives would then ship stale, unrelated content under a
        // fresh thread. The fix purges the entire PilotSwarm-owned
        // per-session dir before persisting the new marker.
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const sid = "ps-r2-d1a-purge";
        const dirtyDir = path.join(sessionStateDir, sid);
        fs.mkdirSync(dirtyDir, { recursive: true });
        fs.writeFileSync(path.join(dirtyDir, "workspace.yaml"), "cwd: /old\n");
        fs.writeFileSync(path.join(dirtyDir, "codex-rollout.jsonl"), "STALE-ROLLOUT-SENTINEL\n");
        fs.writeFileSync(path.join(dirtyDir, "sentinel.txt"), "R2-D1A-SENTINEL");
        fs.mkdirSync(path.join(dirtyDir, "junk"), { recursive: true });
        fs.writeFileSync(path.join(dirtyDir, "junk", "old.bin"), "junk");

        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-r2-d1a" } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        await client.createSession({ sessionId: sid });

        const remaining = fs.readdirSync(dirtyDir).sort();
        // Only the fresh marker is expected; the runtime doesn't write
        // anything else at createSession time. Nothing that was seeded
        // must survive.
        expect(remaining).toContain(CODEX_THREAD_STATE_FILENAME);
        expect(remaining).not.toContain("workspace.yaml");
        expect(remaining).not.toContain("codex-rollout.jsonl");
        expect(remaining).not.toContain("sentinel.txt");
        expect(remaining).not.toContain("junk");
        // Belt-and-braces: confirm no descendant file carries the sentinel.
        for (const entry of remaining) {
            const abs = path.join(dirtyDir, entry);
            if (fs.statSync(abs).isFile()) {
                expect(fs.readFileSync(abs, "utf-8")).not.toContain("R2-D1A-SENTINEL");
                expect(fs.readFileSync(abs, "utf-8")).not.toContain("STALE-ROLLOUT-SENTINEL");
            }
        }
        // Fresh marker is a valid Codex thread mapping.
        const meta = JSON.parse(fs.readFileSync(path.join(dirtyDir, CODEX_THREAD_STATE_FILENAME), "utf-8"));
        expect(meta.codexThreadId).toBe("codex-thread-r2-d1a");

        await client.stop();
    });

    it("(R2-D1c) createSession never touches sibling per-session directories", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const target = "ps-r2-d1c-target";
        const sibling = "ps-r2-d1c-sibling";
        const targetDir = path.join(sessionStateDir, target);
        const siblingDir = path.join(sessionStateDir, sibling);
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, "old-junk.txt"), "target-junk");
        fs.mkdirSync(siblingDir, { recursive: true });
        fs.writeFileSync(path.join(siblingDir, "codex-thread.json"), JSON.stringify({ codexThreadId: "sibling-thread" }));
        fs.writeFileSync(path.join(siblingDir, "sibling-sentinel.txt"), "R2-D1C-SIBLING-KEEP");

        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-r2-d1c" } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        await client.createSession({ sessionId: target });

        // Sibling dir intact byte-for-byte.
        expect(fs.readFileSync(path.join(siblingDir, "sibling-sentinel.txt"), "utf-8")).toBe("R2-D1C-SIBLING-KEEP");
        const siblingMeta = JSON.parse(fs.readFileSync(path.join(siblingDir, "codex-thread.json"), "utf-8"));
        expect(siblingMeta.codexThreadId).toBe("sibling-thread");
        // Target purge happened.
        expect(fs.existsSync(path.join(targetDir, "old-junk.txt"))).toBe(false);

        await client.stop();
    });

    it("(R2-D1) resumeSession must NOT purge freshly hydrated state", async () => {
        // The purge belongs to createSession only. A resume that lands
        // after `sessionStore.hydrate()` restored the marker + rollout
        // must find them intact — deleting them here would defeat the
        // whole hydrate/resume flow.
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const sid = "ps-r2-d1-resume-preserve";
        const sessDir = path.join(sessionStateDir, sid);
        fs.mkdirSync(sessDir, { recursive: true });
        const rolloutRel = "codex-rollout.jsonl";
        fs.writeFileSync(path.join(sessDir, rolloutRel), '{"type":"session_meta","payload":{"id":"codex-thread-r2-d1-resume"}}\n');
        fs.writeFileSync(path.join(sessDir, CODEX_THREAD_STATE_FILENAME), JSON.stringify({
            codexThreadId: "codex-thread-r2-d1-resume",
            codexHome,
            rolloutSnapshotRelPath: rolloutRel,
        }));

        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-r2-d1-resume" } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        await client.resumeSession(sid, { sessionId: sid });

        // Marker and rollout still present with the same threadId.
        expect(fs.existsSync(path.join(sessDir, CODEX_THREAD_STATE_FILENAME))).toBe(true);
        expect(fs.existsSync(path.join(sessDir, rolloutRel))).toBe(true);
        const meta = JSON.parse(fs.readFileSync(path.join(sessDir, CODEX_THREAD_STATE_FILENAME), "utf-8"));
        expect(meta.codexThreadId).toBe("codex-thread-r2-d1-resume");
        expect(meta.rolloutSnapshotRelPath).toBe(rolloutRel);

        await client.stop();
    });

    // ─── R2-D2: disconnect must unregister and prevent stale route ──

    function seedRolloutOnDisk(codexHome, threadId) {
        const dir = path.join(codexHome, "sessions", "2026", "07", "27");
        fs.mkdirSync(dir, { recursive: true });
        const rollout = path.join(dir, `rollout-2026-07-27T00-00-00-${threadId}.jsonl`);
        fs.writeFileSync(rollout, `{"type":"session_meta","payload":{"id":"${threadId}"}}\n`, { mode: 0o600 });
        return rollout;
    }

    it("(R2-D2a) disconnect unregisters the session from the client; later stale threadId server-request responds error and never invokes the tool handler", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const threadId = "codex-thread-r2-d2a";
        const transport = createFakeCodexTransport({ thread: { id: threadId } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        const session = await client.createSession({ sessionId: "ps-r2-d2a" });
        let handlerCalls = 0;
        const echoTool = defineTool("test_echo", {
            description: "Echo test tool",
            parameters: { type: "object", properties: {}, required: [] },
            handler: async () => { handlerCalls += 1; return "should-not-run-after-disconnect"; },
        });
        session.registerTools([echoTool]);

        // Before disconnect the client owns the handle.
        const clientAny = client;
        expect(clientAny.sessions.size).toBe(1);
        expect(clientAny.sessions.get("ps-r2-d2a")).toBe(session);

        await session.disconnect();

        // After disconnect the client must no longer own the handle.
        expect(clientAny.sessions.size).toBe(0);
        expect(clientAny.sessions.get("ps-r2-d2a")).toBeUndefined();

        // A late server-request that still carries the old threadId
        // must respond with a JSON-RPC error (no session to route to)
        // and MUST NOT execute the registered handler.
        const baseline = transport.recordedResponses.length;
        transport.emit("server-request", {
            id: "r2-d2a-late",
            method: "item/tool/call",
            params: { threadId, callId: "r2-d2a-1", tool: "test_echo", arguments: {} },
        });
        await new Promise((r) => setTimeout(r, 10));

        expect(handlerCalls).toBe(0);
        const newResps = transport.recordedResponses.slice(baseline);
        const late = newResps.find((r) => r.id === "r2-d2a-late");
        expect(late).toBeTruthy();
        expect(late.error).toBeTruthy();
        expect(late.result).toBeUndefined();

        await client.stop();
    }, 3_000);

    it("(R2-D2b) disconnect after the transport is already closed still snapshots the rollout AND unregisters", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const threadId = "codex-thread-r2-d2b";
        seedRolloutOnDisk(codexHome, threadId);
        const transport = createFakeCodexTransport({ thread: { id: threadId } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const session = await client.createSession({ sessionId: "ps-r2-d2b" });
        expect(client["sessions"].size).toBe(1);

        // Tear the transport down BEFORE disconnect.
        await transport.close();
        await new Promise((r) => setTimeout(r, 5));

        // disconnect() must still complete: snapshot the rollout AND
        // unregister the session. This is the crash-then-graceful-close
        // shape the SessionManager depends on for durability.
        await session.disconnect();

        const sessDir = path.join(sessionStateDir, "ps-r2-d2b");
        expect(fs.existsSync(path.join(sessDir, CODEX_ROLLOUT_SNAPSHOT_FILENAME))).toBe(true);
        expect(client["sessions"].size).toBe(0);
        expect(client["sessions"].get("ps-r2-d2b")).toBeUndefined();

        await client.stop();
    }, 3_000);

    it("(R2-D2c) old handle disconnect after a replacement was registered for the same session id does NOT remove the replacement (exact-handle guard)", async () => {
        // If a session id gets re-created between the moment an old
        // handle's disconnect() started and the moment its cleanup ran,
        // the client must not evict the new handle. Otherwise stale
        // teardown promises would kick freshly resumed sessions out of
        // the client's routing map.
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-r2-d2c-1" } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const sid = "ps-r2-d2c";

        const first = await client.createSession({ sessionId: sid });
        // Simulate a replacement without going through the runtime
        // client's full recreate: manually register a distinct handle
        // for the same id. This models a hydrate/resume that raced
        // ahead of an old handle's disconnect cleanup.
        const replacement = new (Object.getPrototypeOf(first).constructor)(
            client,
            sid,
            "codex-thread-r2-d2c-2",
            {},
        );
        client["sessions"].set(sid, replacement);
        expect(client["sessions"].get(sid)).toBe(replacement);

        await first.disconnect();

        // The replacement must still be registered.
        expect(client["sessions"].get(sid)).toBe(replacement);

        await client.stop();
    }, 3_000);

    it("(R2-D2d) repeated disconnect on the same session is a safe no-op", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-r2-d2d" } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const session = await client.createSession({ sessionId: "ps-r2-d2d" });
        expect(client["sessions"].size).toBe(1);

        await session.disconnect();
        expect(client["sessions"].size).toBe(0);
        // Second disconnect must not throw and must leave the map
        // unchanged. This mirrors ManagedSession.destroy() retry
        // semantics.
        await expect(session.disconnect()).resolves.toBeUndefined();
        expect(client["sessions"].size).toBe(0);

        await client.stop();
    }, 3_000);

    // ─── R3-D1: stale old handle disconnect MUST NOT overwrite replacement durable state ──

    it("(R3-D1a) stale old handle disconnect never overwrites the replacement's persisted marker (with transport present)", async () => {
        // Regression: the exact-handle guard on _unregisterSession only
        // protected map deletion. `oldHandle.disconnect()` still ran
        // `_snapshotRolloutIfPresent()` (and any resulting
        // `_persistThreadState()`) BEFORE the unregister — so a stale
        // handle could rewrite `<sessionDir>/codex-thread.json` back to
        // the OLD codexThreadId + OLD rollout ref, corrupting the
        // replacement's durable metadata.
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const oldThreadId = "codex-thread-r3-d1a-old";
        const newThreadId = "codex-thread-r3-d1a-new";
        // Seed rollouts on disk under CODEX_HOME for BOTH threads so
        // _snapshotRolloutIfPresent has something to copy if it runs.
        const seedRollout = (tid) => {
            const dir = path.join(codexHome, "sessions", "2026", "07", "27");
            fs.mkdirSync(dir, { recursive: true });
            const rollout = path.join(dir, `rollout-2026-07-27T00-00-00-${tid}.jsonl`);
            fs.writeFileSync(rollout, `{"type":"session_meta","payload":{"id":"${tid}"}}\n`, { mode: 0o600 });
        };
        seedRollout(oldThreadId);
        seedRollout(newThreadId);

        const transport = createFakeCodexTransport({ thread: { id: oldThreadId } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const sid = "ps-r3-d1a";

        // Old handle is registered by createSession.
        const oldHandle = await client.createSession({ sessionId: sid });
        // Replacement handle mirrors what a resume flow would do:
        // register a NEW handle for the same sessionId AND write the
        // replacement marker into the durable file BEFORE the stale
        // handle's disconnect runs.
        const CodexRuntimeSession = Object.getPrototypeOf(oldHandle).constructor;
        const replacement = new CodexRuntimeSession(client, sid, newThreadId, {});
        client["sessions"].set(sid, replacement);
        client._persistThreadState(sid, newThreadId, { rolloutSnapshotRelPath: "codex-rollout.jsonl" });
        // Also drop a NEW rollout file so we can see it isn't clobbered.
        fs.writeFileSync(
            path.join(sessionStateDir, sid, "codex-rollout.jsonl"),
            'NEW-REPLACEMENT-ROLLOUT-SENTINEL\n',
            { mode: 0o600 },
        );

        // Now the stale old handle's disconnect fires. It MUST NOT
        // overwrite either the marker or the on-disk rollout.
        await oldHandle.disconnect();

        // Marker still points at the REPLACEMENT thread.
        const meta = JSON.parse(fs.readFileSync(path.join(sessionStateDir, sid, "codex-thread.json"), "utf-8"));
        expect(meta.codexThreadId).toBe(newThreadId);
        expect(meta.rolloutSnapshotRelPath).toBe("codex-rollout.jsonl");
        // Rollout file still contains the REPLACEMENT bytes, not a
        // freshly copied OLD rollout.
        const rolloutContents = fs.readFileSync(
            path.join(sessionStateDir, sid, "codex-rollout.jsonl"),
            "utf-8",
        );
        expect(rolloutContents).toBe("NEW-REPLACEMENT-ROLLOUT-SENTINEL\n");
        expect(rolloutContents).not.toContain(oldThreadId);
        // Replacement handle still owns the map slot.
        expect(client["sessions"].get(sid)).toBe(replacement);
        // Old handle's event handlers are cleared regardless.
        // (Registering after disconnect+teardown must be a no-op event-wise.)
        let stray = 0;
        // Direct access to internal sets to confirm teardown ran.
        expect(oldHandle["catchAll"].size).toBe(0);
        expect(oldHandle["typedHandlers"].size).toBe(0);

        await client.stop();
    }, 3_000);

    it("(R3-D1b) stale old handle disconnect never overwrites replacement durable state even when the transport is already closed", async () => {
        // Same defect path, but with transport already torn down — the
        // filesystem snapshot must ALSO be inhibited on the crashed
        // path, not only on the happy path.
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const oldThreadId = "codex-thread-r3-d1b-old";
        const newThreadId = "codex-thread-r3-d1b-new";
        const dir = path.join(codexHome, "sessions", "2026", "07", "27");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `rollout-2026-07-27T00-00-00-${oldThreadId}.jsonl`),
            `{"type":"session_meta","payload":{"id":"${oldThreadId}"}}\n`, { mode: 0o600 });
        fs.writeFileSync(path.join(dir, `rollout-2026-07-27T00-00-00-${newThreadId}.jsonl`),
            `{"type":"session_meta","payload":{"id":"${newThreadId}"}}\n`, { mode: 0o600 });

        const transport = createFakeCodexTransport({ thread: { id: oldThreadId } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const sid = "ps-r3-d1b";
        const oldHandle = await client.createSession({ sessionId: sid });
        const CodexRuntimeSession = Object.getPrototypeOf(oldHandle).constructor;
        const replacement = new CodexRuntimeSession(client, sid, newThreadId, {});
        client["sessions"].set(sid, replacement);
        client._persistThreadState(sid, newThreadId, { rolloutSnapshotRelPath: "codex-rollout.jsonl" });
        fs.writeFileSync(
            path.join(sessionStateDir, sid, "codex-rollout.jsonl"),
            'NEW-REPLACEMENT-ROLLOUT-SENTINEL-B\n',
            { mode: 0o600 },
        );

        // Kill the transport before disconnect runs.
        await transport.close();
        await new Promise((r) => setTimeout(r, 5));

        await oldHandle.disconnect();

        const meta = JSON.parse(fs.readFileSync(path.join(sessionStateDir, sid, "codex-thread.json"), "utf-8"));
        expect(meta.codexThreadId).toBe(newThreadId);
        expect(meta.rolloutSnapshotRelPath).toBe("codex-rollout.jsonl");
        const rolloutContents = fs.readFileSync(
            path.join(sessionStateDir, sid, "codex-rollout.jsonl"),
            "utf-8",
        );
        expect(rolloutContents).toBe("NEW-REPLACEMENT-ROLLOUT-SENTINEL-B\n");
        expect(rolloutContents).not.toContain(oldThreadId);
        expect(client["sessions"].get(sid)).toBe(replacement);

        await client.stop();
    }, 3_000);

    // ─── R3-D2: sessionId traversal must never escape sessionStateDir ──

    function makeVictim(rootDir, filename = "victim-sentinel") {
        const dir = fs.mkdtempSync(path.join(rootDir, "victim-"));
        const file = path.join(dir, filename);
        fs.writeFileSync(file, "R3-D2-VICTIM-KEEP");
        return { dir, file };
    }

    const R3_D2_BAD_IDS = [
        "../victim",
        "..\\victim",
        "a/b",
        "a\\b",
        ".",
        "..",
        "",
    ];

    it("(R3-D2a) createSession rejects traversal/absolute/composite session ids before any FS mutation or thread/start", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const parent = path.dirname(sessionStateDir);
        const victim = makeVictim(parent, "createSession-victim");

        const badIds = [
            ...R3_D2_BAD_IDS,
            path.join(parent, "absolute-victim-does-not-exist"), // absolute
        ];

        for (const bad of badIds) {
            const transport = createFakeCodexTransport({ thread: { id: "codex-thread-bad" } });
            const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
            await expect(
                client.createSession({ sessionId: bad }),
            ).rejects.toThrow(/Invalid PilotSwarm session id/);
            // No thread/start request must have been sent.
            expect(transport.recordedRequests.some((r) => r.method === "thread/start")).toBe(false);
            // Victim sentinel outside sessionStateDir remains intact.
            expect(fs.readFileSync(victim.file, "utf-8")).toBe("R3-D2-VICTIM-KEEP");
            await client.stop();
        }

        fs.rmSync(victim.dir, { recursive: true, force: true });
    }, 5_000);

    it("(R3-D2b) deleteSession rejects traversal/absolute/composite session ids and never rms outside the state dir", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const parent = path.dirname(sessionStateDir);
        const victim = makeVictim(parent, "deleteSession-victim");

        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-del" } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        for (const bad of R3_D2_BAD_IDS.concat([path.join(parent, "delete-absolute")])) {
            await expect(client.deleteSession(bad)).rejects.toThrow(/Invalid PilotSwarm session id/);
            expect(fs.readFileSync(victim.file, "utf-8")).toBe("R3-D2-VICTIM-KEEP");
            // No thread/delete either.
            expect(transport.recordedRequests.some((r) => r.method === "thread/delete")).toBe(false);
        }

        fs.rmSync(victim.dir, { recursive: true, force: true });
        await client.stop();
    }, 5_000);

    it("(R3-D2c) resumeSession rejects traversal/absolute/composite session ids before any read or thread/resume", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-res" } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });

        for (const bad of R3_D2_BAD_IDS) {
            await expect(
                client.resumeSession(bad, { sessionId: bad }),
            ).rejects.toThrow(/Invalid PilotSwarm session id/);
        }
        expect(transport.recordedRequests.some((r) => r.method === "thread/resume")).toBe(false);
        await client.stop();
    }, 5_000);

    it("(R3-D2d) ordinary UUID-ish session id still works end-to-end after the safe-id guard", async () => {
        const { codexHome, sessionStateDir } = mkTmpHomes();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-good" } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const goodId = "019dcfc8-cafe-7133-a002-45ec3742e999";
        const session = await client.createSession({ sessionId: goodId });
        expect(session).toBeTruthy();
        expect(fs.existsSync(path.join(sessionStateDir, goodId, "codex-thread.json"))).toBe(true);
        // Delete flow also works cleanly for a normal id.
        await client.deleteSession(goodId);
        expect(fs.existsSync(path.join(sessionStateDir, goodId))).toBe(false);
        await client.stop();
    });
});