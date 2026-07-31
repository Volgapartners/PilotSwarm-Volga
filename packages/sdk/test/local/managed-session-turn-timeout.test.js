/**
 * ManagedSession turn-timeout semantics.
 *
 * `turnTimeoutMs` is the runtime's last-resort guard against a wedged
 * backend. Two failure modes are pinned here:
 *
 *  1. **A stalled `send()`.** The Codex runtime resolves `send()` only
 *     after the `turn/start` ack, and that ack sits behind a per-CODEX_HOME
 *     queue. If the queue never drains, `await send()` blocks forever and a
 *     timeout that is only raced against `session.idle` never fires. The
 *     timeout must race the COMPLETE operation (send + idle).
 *
 *  2. **A leaked timeout rejection.** The timeout promise must never
 *     surface as an `unhandledRejection`, and its timer must be cleared
 *     once the turn settles so the process can exit.
 *
 * Run: npx vitest run test/local/managed-session-turn-timeout.test.js
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";

class TimeoutFakeSession {
    constructor({ sendMode = "resolve", idle = true } = {}) {
        this.sendMode = sendMode;
        this.idle = idle;
        this.listeners = new Map();
        this.catchAllHandlers = [];
        this.registeredTools = [];
        this.abortCount = 0;
        this.sendCount = 0;
    }

    on(eventType, handler) {
        if (typeof eventType === "function") {
            this.catchAllHandlers.push(eventType);
            return () => {
                this.catchAllHandlers = this.catchAllHandlers.filter((c) => c !== eventType);
            };
        }
        const handlers = this.listeners.get(eventType) ?? [];
        handlers.push(handler);
        this.listeners.set(eventType, handlers);
        return () => {
            const current = this.listeners.get(eventType) ?? [];
            this.listeners.set(eventType, current.filter((c) => c !== handler));
        };
    }

    registerTools(tools) { this.registeredTools = tools; }

    emit(eventType, payload = {}) {
        for (const handler of this.catchAllHandlers) {
            handler({ type: eventType, data: payload.data ?? payload });
        }
        for (const handler of this.listeners.get(eventType) ?? []) handler(payload);
    }

    async send() {
        this.sendCount += 1;
        if (this.sendMode === "hang") {
            // Never resolves — models a queued Codex `turn/start` ack that
            // never comes back.
            return new Promise(() => {});
        }
        if (this.sendMode === "reject") {
            throw new Error("send exploded");
        }
        queueMicrotask(() => {
            this.emit("assistant.message", { data: { content: "done" } });
            if (this.idle) this.emit("session.idle", { data: {} });
        });
    }

    abort() { this.abortCount += 1; }
    async disconnect() {}
    async getMessages() { return []; }
}

function captureUnhandledRejections() {
    const seen = [];
    const handler = (reason) => { seen.push(reason); };
    process.on("unhandledRejection", handler);
    return {
        seen,
        stop() { process.off("unhandledRejection", handler); },
    };
}

/** Let the microtask + macrotask queue flush so a leaked rejection surfaces. */
async function flush() {
    for (let i = 0; i < 3; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

describe("ManagedSession turn timeout", () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it("times out a send() that never resolves", async () => {
        const fake = new TimeoutFakeSession({ sendMode: "hang" });
        const managed = new ManagedSession("ps-timeout-send", fake, { turnTimeoutMs: 60 });

        const started = Date.now();
        const result = await managed.runTurn("hello");
        const elapsed = Date.now() - started;

        expect(result.type).toBe("error");
        expect(result.message).toMatch(/taking too long/i);
        expect(elapsed).toBeLessThan(2_000);
        expect(fake.abortCount).toBe(1);
    });

    it("uses the runtime name in the timeout error for Codex sessions", async () => {
        const fake = new TimeoutFakeSession({ sendMode: "hang" });
        const managed = new ManagedSession("ps-timeout-codex", fake, { turnTimeoutMs: 40 }, {
            runtimeKind: "codex",
        });

        const result = await managed.runTurn("hello");

        expect(result).toMatchObject({
            type: "error",
            message: "Codex runtime was taking too long to process and was aborted.",
        });
    });

    it("times out when send() resolves but the turn never goes idle", async () => {
        const fake = new TimeoutFakeSession({ sendMode: "resolve", idle: false });
        const managed = new ManagedSession("ps-timeout-idle", fake, { turnTimeoutMs: 60 });

        const result = await managed.runTurn("hello");

        expect(result.type).toBe("error");
        expect(result.message).toMatch(/taking too long/i);
        expect(fake.abortCount).toBe(1);
    });

    it("does not emit an unhandledRejection when send() fails before the timeout", async () => {
        const watcher = captureUnhandledRejections();
        try {
            const fake = new TimeoutFakeSession({ sendMode: "reject" });
            const managed = new ManagedSession("ps-timeout-reject", fake, { turnTimeoutMs: 40 });

            const result = await managed.runTurn("hello");
            expect(result).toMatchObject({ type: "error", message: "send exploded" });

            await flush();
            expect(watcher.seen).toEqual([]);
        } finally {
            watcher.stop();
        }
    });

    it("does not emit an unhandledRejection after a normal completion", async () => {
        const watcher = captureUnhandledRejections();
        try {
            const fake = new TimeoutFakeSession({ sendMode: "resolve" });
            const managed = new ManagedSession("ps-timeout-ok", fake, { turnTimeoutMs: 40 });

            const result = await managed.runTurn("hello");
            expect(result.type).toBe("completed");

            await flush();
            expect(watcher.seen).toEqual([]);
            expect(fake.abortCount).toBe(0);
        } finally {
            watcher.stop();
        }
    });

    it("clears the timeout timer once the turn settles", async () => {
        const cleared = [];
        const realClearTimeout = globalThis.clearTimeout;
        const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
            cleared.push(handle);
            return realClearTimeout(handle);
        });

        const fake = new TimeoutFakeSession({ sendMode: "resolve" });
        const managed = new ManagedSession("ps-timeout-clear", fake, { turnTimeoutMs: 5_000 });

        const result = await managed.runTurn("hello");

        expect(result.type).toBe("completed");
        expect(cleared.length).toBeGreaterThan(0);
        clearSpy.mockRestore();
    });

    it("leaves turns without a configured timeout untouched", async () => {
        const fake = new TimeoutFakeSession({ sendMode: "resolve" });
        const managed = new ManagedSession("ps-no-timeout", fake, {});

        const result = await managed.runTurn("hello");

        expect(result.type).toBe("completed");
        expect(result.content).toBe("done");
        expect(fake.abortCount).toBe(0);
    });
});
