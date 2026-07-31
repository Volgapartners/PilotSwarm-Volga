/**
 * Codex live smoke test (gated).
 *
 * Only runs when both:
 *   - RUN_CODEX_LIVE=1 is set in the environment, AND
 *   - `codex --version` is resolvable on PATH (or CODEX_BINARY_PATH is set).
 *
 * Proves that our JSON-RPC transport, initialize + `initialized`
 * handshake, dynamic-tool declaration, `turn/start` with the correct
 * `UserInput` shape, and completion routing all interoperate with the
 * REAL `codex app-server`. Consumes one small subscription turn.
 *
 * Uses the default subscription model (`gpt-5.6-sol` on codex-cli 0.145.0).
 *
 * Run: RUN_CODEX_LIVE=1 npx vitest run test/local/codex-live.test.js
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineTool } from "@github/copilot-sdk";
import { CodexRuntimeClient, CODEX_THREAD_STATE_FILENAME } from "../../src/codex-runtime.ts";

const RUN_LIVE = process.env.RUN_CODEX_LIVE === "1";
const codexBinaryPath = process.env.CODEX_BINARY_PATH || "codex";
const codexModel = process.env.CODEX_LIVE_MODEL || "gpt-5.6-sol";

function detectCodex() {
    if (!RUN_LIVE) return { present: false, reason: "RUN_CODEX_LIVE unset" };
    try {
        const res = spawnSync(codexBinaryPath, ["--version"], { encoding: "utf-8" });
        if (res.status !== 0) return { present: false, reason: `codex --version exit=${res.status}` };
        return { present: true, version: (res.stdout || "").trim() };
    } catch (err) {
        return { present: false, reason: err && err.message ? err.message : String(err) };
    }
}

const detection = detectCodex();
const shouldRun = detection.present;
const describeLive = shouldRun ? describe : describe.skip;
const codexHome = process.env.CODEX_HOME_TEST || (RUN_LIVE ? (process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) : "/tmp/codex-live-skipped");

describeLive("Codex live smoke (gated by RUN_CODEX_LIVE=1)", () => {
    it("initializes app-server, starts a thread, runs a real turn, and returns CODEX_OK", async () => {
        expect(fs.existsSync(codexHome)).toBe(true);
        // Belt-and-braces: sanity-check CODEX_HOME permissions ourselves
        // so a wrong-mode CODEX_HOME fails here loudly rather than deep
        // inside the runtime.
        const stat = fs.statSync(codexHome);
        const mode = stat.mode & 0o777;
        expect(mode & 0o077).toBe(0);

        const sessionStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-live-state-"));
        const client = new CodexRuntimeClient({
            codexHome,
            codexBinaryPath,
            sessionStateDir,
        });
        try {
            const sessionId = "ps-live-smoke-" + Date.now();
            const session = await client.createSession({
                sessionId,
                model: codexModel,
                developerInstructions: "You are being smoke-tested by PilotSwarm. Follow the user's exact instruction. Do not call any tools. Do not add commentary.",
            });
            expect(session).toBeTruthy();
            const state = JSON.parse(fs.readFileSync(
                path.join(sessionStateDir, sessionId, CODEX_THREAD_STATE_FILENAME),
                "utf-8",
            ).toString());
            expect(typeof state.codexThreadId).toBe("string");

            let finalText = "";
            let sawIdle = false;
            const idle = new Promise((resolve) => {
                session.on((ev) => {
                    if (ev.type === "assistant.message" && typeof ev.data?.content === "string") {
                        finalText = ev.data.content;
                    }
                    if (ev.type === "session.idle") {
                        sawIdle = true;
                        resolve();
                    }
                });
            });
            const send = session.send({ prompt: "Reply with exactly CODEX_OK and do not use tools." });
            await Promise.race([
                Promise.all([send, idle]),
                new Promise((_, r) => setTimeout(() => r(new Error("codex live turn timeout")), 90_000)),
            ]);

            expect(sawIdle).toBe(true);
            // Model output may include punctuation; assert CODEX_OK appears.
            expect(finalText).toMatch(/CODEX_OK/);

            await session.disconnect();
        } finally {
            await client.stop();
        }
    }, 120_000);

    it("real Codex turn invokes a registered dynamic tool and surfaces its result to the assistant", async () => {
        // This test proves the whole tool loop against real
        // `codex app-server`: thread/start.dynamicTools declares a
        // unique tool, Codex sees the schema, calls it via
        // `item/tool/call`, our JS handler runs, the response goes
        // back, and the assistant's final message reflects the tool
        // output. Consumes one small subscription turn.
        expect(fs.existsSync(codexHome)).toBe(true);
        const sessionStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-live-tool-"));
        const client = new CodexRuntimeClient({
            codexHome,
            codexBinaryPath,
            sessionStateDir,
        });
        try {
            const sessionId = "ps-live-tool-" + Date.now();
            // Give the tool a unique name so Codex can't confuse it with
            // any built-in. Return a sentinel the assistant is asked to
            // repeat back verbatim.
            const SENTINEL = "PILOTSWARM_TOOL_OK_" + Math.random().toString(36).slice(2, 8).toUpperCase();
            let handlerCalls = 0;
            let handlerArgs = null;
            const tool = defineTool("ps_live_probe", {
                description: "Ask this probe tool for the current PilotSwarm probe sentinel. It takes no meaningful arguments and returns a short opaque string. You MUST call it before answering.",
                parameters: {
                    type: "object",
                    properties: {
                        reason: { type: "string", description: "Free-text reason you're calling the probe." },
                    },
                    required: [],
                },
                handler: async (args) => {
                    handlerCalls += 1;
                    handlerArgs = args;
                    return SENTINEL;
                },
            });

            const session = await client.createSession({
                sessionId,
                model: codexModel,
                developerInstructions:
                    "You are being smoke-tested by PilotSwarm. When asked for the PilotSwarm probe sentinel, " +
                    "you MUST call the `ps_live_probe` tool exactly once, then reply with the tool's " +
                    "returned string verbatim and NOTHING ELSE. Do not add commentary or code fences.",
                tools: [tool],
            });

            let finalText = "";
            const idle = new Promise((resolve) => {
                session.on((ev) => {
                    if (ev.type === "assistant.message" && typeof ev.data?.content === "string") {
                        finalText = ev.data.content;
                    }
                    if (ev.type === "session.idle") resolve();
                });
            });
            const send = session.send({ prompt: "Give me the current PilotSwarm probe sentinel." });
            await Promise.race([
                Promise.all([send, idle]),
                new Promise((_, r) => setTimeout(() => r(new Error("codex live tool turn timeout")), 90_000)),
            ]);

            expect(handlerCalls).toBeGreaterThanOrEqual(1);
            expect(handlerArgs).toBeTruthy();
            expect(finalText).toContain(SENTINEL);

            await session.disconnect();
        } finally {
            await client.stop();
        }
    }, 120_000);
});
