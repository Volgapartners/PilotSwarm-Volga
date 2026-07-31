/**
 * Real transport / SpawnedCodexAppServerTransport tests.
 *
 * The real `codex app-server` process emits JSON-RPC responses that OMIT
 * the `jsonrpc` field. It also emits errors and notifications without
 * that field. Our parser must accept them; requiring `jsonrpc === "2.0"`
 * on the response path is what caused the live smoke to time out — every
 * response was silently dropped.
 *
 * Uses a fake ChildProcess (a Readable/Writable pair on the stdin/stdout
 * fields) so we exercise the real transport code path end-to-end without
 * launching the real binary.
 *
 * Run: npx vitest run test/local/codex-transport.test.js
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SpawnedCodexAppServerTransport } from "../../src/codex-runtime.ts";

function createFakeChildProcess() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const proc = new EventEmitter();
    proc.stdin = stdin;
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.killSignals = [];
    proc.kill = (signal) => {
        proc.killSignals.push(signal);
        return true;
    };
    return proc;
}

function readWritten(stdin) {
    return new Promise((resolve) => {
        let buf = "";
        stdin.on("data", (chunk) => {
            buf += chunk.toString();
        });
        setTimeout(() => resolve(buf), 10);
    });
}

describe("SpawnedCodexAppServerTransport", () => {
    it("resolves requests when the server response has no jsonrpc field", async () => {
        const proc = createFakeChildProcess();
        const transport = new SpawnedCodexAppServerTransport(proc);

        const p = transport.request("initialize", { clientInfo: { name: "t", version: "0" }, capabilities: {} });

        // Real app-server response shape: no `jsonrpc` field.
        proc.stdout.write(JSON.stringify({ id: 1, result: { serverInfo: { name: "codex", version: "0.145.0" } } }) + "\n");

        const result = await p;
        expect(result?.serverInfo?.name).toBe("codex");

        await transport.close();
    }, 3_000);

    it("rejects requests when the server error response has no jsonrpc field", async () => {
        const proc = createFakeChildProcess();
        const transport = new SpawnedCodexAppServerTransport(proc);

        const p = transport.request("thread/start", { model: "gpt-5.6-sol" });
        proc.stdout.write(JSON.stringify({ id: 1, error: { code: -32601, message: "unknown thread option" } }) + "\n");

        await expect(p).rejects.toThrow(/unknown thread option/);
        await transport.close();
    }, 3_000);

    it("emits notifications for {method, params} lines with no id and no jsonrpc", async () => {
        const proc = createFakeChildProcess();
        const transport = new SpawnedCodexAppServerTransport(proc);

        const notifications = [];
        transport.on("notification", (n) => notifications.push(n));

        proc.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } }) + "\n");
        await new Promise((r) => setTimeout(r, 5));

        expect(notifications).toHaveLength(1);
        expect(notifications[0].method).toBe("turn/started");
        await transport.close();
    }, 3_000);

    it("emits server-request for {id, method, params} lines with no jsonrpc", async () => {
        const proc = createFakeChildProcess();
        const transport = new SpawnedCodexAppServerTransport(proc);

        const requests = [];
        transport.on("server-request", (r) => requests.push(r));

        proc.stdout.write(JSON.stringify({ id: "srv-1", method: "item/tool/call", params: { threadId: "t", turnId: "u", callId: "c", tool: "x", arguments: {} } }) + "\n");
        await new Promise((r) => setTimeout(r, 5));

        expect(requests).toHaveLength(1);
        expect(requests[0].id).toBe("srv-1");
        expect(requests[0].method).toBe("item/tool/call");
        await transport.close();
    }, 3_000);

    it("propagates child stderr into pending-request rejections when the process exits early", async () => {
        const proc = createFakeChildProcess();
        const transport = new SpawnedCodexAppServerTransport(proc);

        const p = transport.request("initialize", {});
        proc.stderr.write("error: auth.json missing; run `codex login`\n");
        // Give the transport a tick to buffer stderr before exit fires.
        await new Promise((r) => setTimeout(r, 5));
        proc.emit("exit", 1, null);

        const err = await p.catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/codex/);
        // Include a hint of stderr content so operators can see the cause.
        expect(err.message).toMatch(/auth\.json missing|exit(ed)? 1|codex login/);

        await transport.close();
    }, 3_000);

    it("handles asynchronous stdin EPIPE, rejects pending requests, and emits close exactly once", async () => {
        const proc = createFakeChildProcess();
        const transport = new SpawnedCodexAppServerTransport(proc);
        let closeCount = 0;
        transport.on("close", () => { closeCount += 1; });

        const pending = transport.request("thread/start", {});
        const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        proc.stdin.destroy(epipe);

        await expect(pending).rejects.toThrow(/EPIPE|transport closed/i);

        // Child-process teardown can fan out through stdin error, stdout
        // close, and process exit. Consumers must see one terminal event.
        proc.stdout.emit("close");
        proc.emit("exit", 1, null);
        await new Promise((resolve) => setImmediate(resolve));
        expect(closeCount).toBe(1);
    }, 3_000);

    it("close rejects pending requests before returning even when the child ignores SIGTERM", async () => {
        const proc = createFakeChildProcess();
        const transport = new SpawnedCodexAppServerTransport(proc);
        let rejection;
        let closeCount = 0;
        transport.on("close", () => { closeCount += 1; });

        const pending = transport.request("initialize", {}).catch((error) => {
            rejection = error;
        });

        await transport.close();
        await Promise.resolve();

        expect(rejection).toBeInstanceOf(Error);
        expect(rejection.message).toMatch(/closed/i);
        expect(proc.killSignals).toEqual(["SIGTERM"]);
        expect(closeCount).toBe(1);
        await pending;
    }, 3_000);
});
