/**
 * Codex runtime — tool contract tests.
 *
 * Covers the Copilot-SDK-parity surface for tools:
 *   - `tool.parameters` may be a plain JSON schema OR a Zod-style
 *     object carrying `toJSONSchema()`. In both cases Codex must
 *     receive the JSON-schema shape.
 *   - The dispatched handler is invoked with a standard invocation
 *     context (`{sessionId, toolCallId, toolName, arguments, ...}`).
 *   - Handler return values are normalized to the Codex
 *     `DynamicToolCallResponse` shape:
 *       - `null` / `undefined`        → text="", success=true
 *       - string                      → text=raw, success=true
 *       - Copilot `ToolResultObject`  → text=textResultForLlm,
 *                                       success only when
 *                                       resultType==="success"
 *       - other                       → JSON.stringify
 *       - thrown error                → success=false, text=error.message
 *   - `contentItems[0].text` is ALWAYS a string.
 *
 * Uses the fake transport; runs in-process, no real codex binary.
 *
 * Run: npx vitest run test/local/codex-tool-contract.test.js
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineTool } from "@github/copilot-sdk";
import {
    CodexRuntimeClient,
    createFakeCodexTransport,
    toJsonSchema,
    normalizeToolResult,
} from "../../src/codex-runtime.ts";

function mkHomes() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tool-contract-"));
    const codexHome = path.join(root, "codex-home");
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionStateDir, { recursive: true });
    return { codexHome, sessionStateDir };
}

/**
 * Faithful stand-in for a Zod schema: only `toJSONSchema()` is
 * relied upon. Zod's actual object shape is irrelevant to Codex, so
 * we don't need the real dependency to exercise the contract.
 */
function fakeZodObject(shape) {
    return {
        _zod: true,
        toJSONSchema: () => shape,
        // extra "shape" property to prove pass-through doesn't
        // accidentally leak Zod internals to Codex
        _def: { typeName: "ZodObject", shape: { hidden: "should-not-appear" } },
    };
}

async function runTurnWithToolCall({ toolName = "ct_probe", parameters, handler }) {
    const { codexHome, sessionStateDir } = mkHomes();
    const threadId = "codex-thread-ct";
    const transport = createFakeCodexTransport({
        thread: { id: threadId },
        turnId: "ct-turn-1",
        turnScript: [
            { emit: "notification", method: "turn/started", params: { threadId, turn: { id: "ct-turn-1" } } },
            { emit: "server-request", method: "item/tool/call", params: { turnId: "ct-turn-1", callId: "ct-call-1", tool: toolName, arguments: { foo: 42 } } },
            { emit: "notification", method: "turn/completed", params: { threadId, turn: { id: "ct-turn-1", status: "completed" } } },
        ],
    });
    const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
    const tool = defineTool(toolName, {
        description: "contract probe",
        parameters,
        handler,
    });
    const session = await client.createSession({ sessionId: "ps-ct", tools: [tool] });
    const captured = [];
    session.on((e) => captured.push(e));
    await session.send({ prompt: "run" });
    for (let i = 0; i < 40; i += 1) {
        if (captured.some((e) => e.type === "session.idle")) break;
        await new Promise((r) => setTimeout(r, 5));
    }
    await client.stop();
    return { transport, captured };
}

describe("Codex tool contract — schema conversion (Zod / plain)", () => {
    it("plain JSON-schema parameters pass through untouched", () => {
        const schema = { type: "object", properties: { x: { type: "string" } }, required: ["x"] };
        expect(toJsonSchema(schema)).toEqual(schema);
    });

    it("Zod-like object with toJSONSchema() is converted", () => {
        const zodish = fakeZodObject({ type: "object", properties: { n: { type: "integer" } }, required: ["n"] });
        expect(toJsonSchema(zodish)).toEqual({ type: "object", properties: { n: { type: "integer" } }, required: ["n"] });
    });

    it("undefined parameters yield an empty object schema", () => {
        expect(toJsonSchema(undefined)).toEqual({ type: "object", properties: {} });
    });

    it("thread/start.dynamicTools inputSchema for a Zod tool is JSON schema, no Zod internals", async () => {
        const { codexHome, sessionStateDir } = mkHomes();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-zod" } });
        const client = new CodexRuntimeClient({ codexHome, sessionStateDir, transportFactory: () => transport });
        const zodish = fakeZodObject({ type: "object", properties: { name: { type: "string" } }, required: ["name"] });
        const tool = defineTool("zod_tool", { description: "z", parameters: zodish, handler: async () => "ok" });
        await client.createSession({ sessionId: "ps-zt", tools: [tool] });
        const start = transport.recordedRequests.find((r) => r.method === "thread/start");
        expect(start).toBeTruthy();
        const spec = start.params.dynamicTools.find((t) => t.name === "zod_tool");
        expect(spec).toBeTruthy();
        expect(spec.inputSchema).toEqual({ type: "object", properties: { name: { type: "string" } }, required: ["name"] });
        // Prove Zod internals did not leak.
        expect(JSON.stringify(spec.inputSchema)).not.toContain("_zod");
        expect(JSON.stringify(spec.inputSchema)).not.toContain("should-not-appear");
        await client.stop();
    });
});

describe("Codex tool contract — invocation context", () => {
    it("handler receives (args, invocation) with sessionId/toolCallId/toolName/arguments", async () => {
        let capturedInvocation = null;
        const { transport } = await runTurnWithToolCall({
            toolName: "ct_ctx",
            parameters: { type: "object", properties: {}, additionalProperties: true },
            handler: async (args, invocation) => {
                capturedInvocation = invocation;
                return "ok";
            },
        });
        expect(capturedInvocation).toBeTruthy();
        expect(capturedInvocation.sessionId).toBe("ps-ct");
        expect(capturedInvocation.toolCallId).toBe("ct-call-1");
        expect(capturedInvocation.toolName).toBe("ct_ctx");
        expect(capturedInvocation.arguments).toEqual({ foo: 42 });

        // Response sent back OK.
        const resp = transport.recordedResponses[0];
        expect(resp.result).toBeTruthy();
        expect(resp.result.contentItems[0].type).toBe("inputText");
        expect(resp.result.contentItems[0].text).toBe("ok");
        expect(resp.result.success).toBe(true);
    });
});

describe("Codex tool contract — result normalization", () => {
    it("undefined result → success=true, text=''", () => {
        const out = normalizeToolResult(undefined);
        expect(out).toEqual({ text: "", success: true });
    });

    it("null result → success=true, text=''", () => {
        expect(normalizeToolResult(null)).toEqual({ text: "", success: true });
    });

    it("string result → success=true, text=raw", () => {
        expect(normalizeToolResult("hi there")).toEqual({ text: "hi there", success: true });
    });

    it("ToolResultObject with resultType='success' → success=true, text=textResultForLlm", () => {
        const out = normalizeToolResult({ textResultForLlm: "done!", resultType: "success" });
        expect(out).toEqual({ text: "done!", success: true, resultType: "success" });
    });

    it("ToolResultObject with resultType='failure' → success=false, error retained", () => {
        const out = normalizeToolResult({ textResultForLlm: "nope", resultType: "failure", error: "bad-thing" });
        expect(out).toEqual({ text: "nope", success: false, resultType: "failure", error: "bad-thing" });
    });

    it("ToolResultObject with resultType='rejected' → success=false", () => {
        const out = normalizeToolResult({ textResultForLlm: "denied", resultType: "rejected" });
        expect(out.success).toBe(false);
        expect(out.text).toBe("denied");
        expect(out.resultType).toBe("rejected");
    });

    it("plain object → JSON.stringify", () => {
        const out = normalizeToolResult({ x: 1 });
        expect(out.text).toBe(JSON.stringify({ x: 1 }));
        expect(out.success).toBe(true);
    });

    it("weird value that stringifies to undefined → text=''", () => {
        expect(normalizeToolResult(() => 1)).toEqual({ text: "", success: true });
    });
});

describe("Codex tool contract — dispatch end-to-end", () => {
    it("thrown handler error → success=false, text=error.message; response text is a string", async () => {
        const { transport, captured } = await runTurnWithToolCall({
            toolName: "ct_throw",
            parameters: { type: "object", properties: {}, additionalProperties: true },
            handler: async () => { throw new Error("boom"); },
        });
        const resp = transport.recordedResponses[0];
        expect(resp.result).toBeTruthy();
        expect(resp.result.success).toBe(false);
        expect(resp.result.contentItems[0].text).toBe("boom");
        const done = captured.find((e) => e.type === "tool.execution_complete");
        expect(done.data.success).toBe(false);
        expect(done.data.error).toBe("boom");
    });

    it("undefined handler return → response text is empty string, success=true", async () => {
        const { transport } = await runTurnWithToolCall({
            toolName: "ct_undef",
            parameters: { type: "object", properties: {}, additionalProperties: true },
            handler: async () => undefined,
        });
        const resp = transport.recordedResponses[0];
        expect(resp.result.success).toBe(true);
        expect(resp.result.contentItems[0].text).toBe("");
        expect(typeof resp.result.contentItems[0].text).toBe("string");
    });

    it("ToolResultObject failure → success=false and text is textResultForLlm", async () => {
        const { transport, captured } = await runTurnWithToolCall({
            toolName: "ct_fail",
            parameters: { type: "object", properties: {}, additionalProperties: true },
            handler: async () => ({ textResultForLlm: "guardrails triggered", resultType: "denied", error: "guard-x" }),
        });
        const resp = transport.recordedResponses[0];
        expect(resp.result.success).toBe(false);
        expect(resp.result.contentItems[0].text).toBe("guardrails triggered");
        const done = captured.find((e) => e.type === "tool.execution_complete");
        expect(done.data.resultType).toBe("denied");
        expect(done.data.error).toBe("guard-x");
    });
});
