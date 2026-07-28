/**
 * Codex session persistence tests.
 *
 * A newly warmed CodexRuntimeSession must persist its Codex `threadId`
 * outside of `CODEX_HOME` and outside of auth material. A restart on
 * the same worker (or a different worker sharing the same
 * sessionStateDir) must be able to reconstruct the session by reading
 * that persisted mapping and issuing thread/resume.
 *
 * This test does NOT hit the real codex binary — it exercises the
 * runtime persistence layer with the fake transport.
 *
 * Run: npx vitest run test/local/codex-thread-persistence.test.js
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    CodexRuntimeClient,
    createFakeCodexTransport,
    CODEX_THREAD_STATE_FILENAME,
} from "../../src/codex-runtime.ts";

function mkHomes() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-persist-"));
    const codexHome = path.join(root, "codex-home");
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(codexHome, "auth.json"), '{"secret":"do-not-copy"}', { mode: 0o600 });
    fs.mkdirSync(sessionStateDir, { recursive: true });
    return { root, codexHome, sessionStateDir };
}

describe("Codex thread persistence", () => {
    it("persists threadId across CodexRuntimeClient restarts and resumes with thread/resume", async () => {
        const { codexHome, sessionStateDir } = mkHomes();

        // First worker instance: start a fresh thread.
        const transport1 = createFakeCodexTransport({ thread: { id: "codex-thread-persist" } });
        const client1 = new CodexRuntimeClient({
            codexHome,
            sessionStateDir,
            transportFactory: () => transport1,
        });
        await client1.createSession({ sessionId: "ps-persist-1" });
        await client1.stop();

        const stateFile = path.join(sessionStateDir, "ps-persist-1", CODEX_THREAD_STATE_FILENAME);
        expect(fs.existsSync(stateFile)).toBe(true);
        const raw = fs.readFileSync(stateFile, "utf-8");
        expect(raw).not.toContain("secret");
        expect(raw).not.toContain("do-not-copy");

        // Second worker instance: brand-new client, must resume via the
        // persisted mapping.
        const transport2 = createFakeCodexTransport({ thread: { id: "codex-thread-persist" } });
        const client2 = new CodexRuntimeClient({
            codexHome,
            sessionStateDir,
            transportFactory: () => transport2,
        });
        await client2.resumeSession("ps-persist-1", { sessionId: "ps-persist-1" });

        const resumeCalls = transport2.recordedRequests.filter((r) => r.method === "thread/resume");
        expect(resumeCalls).toHaveLength(1);
        expect(resumeCalls[0].params.threadId).toBe("codex-thread-persist");

        await client2.stop();
    });

    it("deleteSession removes the persisted mapping so a future resume rejects cleanly", async () => {
        const { codexHome, sessionStateDir } = mkHomes();
        const transport = createFakeCodexTransport({ thread: { id: "codex-thread-delete" } });
        const client = new CodexRuntimeClient({
            codexHome,
            sessionStateDir,
            transportFactory: () => transport,
        });
        await client.createSession({ sessionId: "ps-persist-delete" });

        const stateFile = path.join(sessionStateDir, "ps-persist-delete", CODEX_THREAD_STATE_FILENAME);
        expect(fs.existsSync(stateFile)).toBe(true);

        await client.deleteSession("ps-persist-delete");
        expect(fs.existsSync(stateFile)).toBe(false);

        await expect(
            client.resumeSession("ps-persist-delete", { sessionId: "ps-persist-delete" }),
        ).rejects.toThrow(/no persisted threadId/);

        await client.stop();
    });
});
