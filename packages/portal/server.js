/**
 * Portal server — Hosts the React portal backend.
 *
 * Architecture:
 *   Browser (React + Vite / built app)
 *     ↕ WebSocket JSON events
 *   Express + ws backend
 *     ↕ PilotSwarm public SDK APIs
 *   PostgreSQL + workers
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer } from "ws";
import {
  PilotSwarmClient,
  PilotSwarmManagementClient,
  PilotSwarmWorker,
} from "pilotswarm-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const DIST_DIR = path.join(__dirname, "dist");

function loadPluginDirs() {
  if (process.env.PLUGIN_DIRS) {
    return process.env.PLUGIN_DIRS.split(",").map((dir) => dir.trim()).filter(Boolean);
  }

  const defaultPluginDir = path.resolve(REPO_ROOT, "packages/sdk/plugin");
  return fs.existsSync(path.join(defaultPluginDir, "plugin.json")) ? [defaultPluginDir] : [];
}

function titleCaseAgent(agentId) {
  return agentId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function fallbackSessionTitle(session) {
  if (session.title) return session.title;
  if (session.agentId) return `${titleCaseAgent(session.agentId)}: ${session.sessionId.slice(0, 8)}`;
  return `Session: ${session.sessionId.slice(0, 8)}`;
}

function mapSessionView(session) {
  return {
    id: session.sessionId,
    title: fallbackSessionTitle(session),
    status: session.status,
    parentId: session.parentSessionId ?? undefined,
    agentId: session.agentId ?? undefined,
    isSystem: session.isSystem ?? false,
    model: session.model ?? undefined,
  };
}

function wsSend(ws, type, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function createDevLandingPage(port) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PilotSwarm Portal Backend</title>
    <style>
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, sans-serif;
        background: #0d0d1a;
        color: #e5e7eb;
        min-height: 100vh;
        display: grid;
        place-items: center;
      }
      main {
        width: min(720px, calc(100vw - 32px));
        background: #16213e;
        border: 1px solid #334155;
        border-radius: 16px;
        padding: 24px;
      }
      code {
        background: #0f172a;
        padding: 2px 6px;
        border-radius: 6px;
      }
      a { color: #22d3ee; }
    </style>
  </head>
  <body>
    <main>
      <h1>PilotSwarm portal backend is running</h1>
      <p>No production frontend build was found in <code>packages/portal/dist</code>.</p>
      <p>For local development, run the React app separately with <code>npm run dev --workspace=packages/portal</code> and open <a href="http://localhost:5173">http://localhost:5173</a>.</p>
      <p>The backend API/WebSocket server is listening on <code>http://localhost:${port}</code>.</p>
    </main>
  </body>
</html>`;
}

function mapSessionEventToPortalMessages(sessionId, event) {
  const timestamp = event.createdAt instanceof Date
    ? event.createdAt.toISOString()
    : new Date().toISOString();
  const data = event.data ?? {};

  switch (event.eventType) {
    case "user.message":
      return [{
        type: "message",
        data: {
          sessionId,
          role: "user",
          content: data.content ?? "",
          timestamp,
        },
      }];
    case "assistant.message":
      return [
        {
          type: "message",
          data: {
            sessionId,
            role: "assistant",
            content: data.content ?? "",
            timestamp,
          },
        },
        {
          type: "thinking",
          data: { sessionId, active: false },
        },
      ];
    case "tool.execution_start":
      return [{
        type: "toolCall",
        data: {
          sessionId,
          name: data.toolName ?? data.name ?? "unknown",
          args: typeof data.arguments === "string"
            ? data.arguments
            : JSON.stringify(data.arguments ?? data.args ?? {}, null, 2),
          status: "started",
          durationMs: data.durationMs,
        },
      }];
    case "tool.execution_complete":
      return [{
        type: "toolCall",
        data: {
          sessionId,
          name: data.toolName ?? data.name ?? "unknown",
          args: typeof data.arguments === "string"
            ? data.arguments
            : JSON.stringify(data.arguments ?? data.args ?? {}, null, 2),
          status: data.error ? "failed" : "completed",
          result: typeof data.result === "string"
            ? data.result
            : JSON.stringify(data.result ?? data.output ?? data.error ?? "", null, 2),
          durationMs: data.durationMs,
        },
      }];
    case "session.idle":
      return [{
        type: "thinking",
        data: { sessionId, active: false },
      }];
    case "session.error":
      return [
        {
          type: "thinking",
          data: { sessionId, active: false },
        },
        {
          type: "error",
          data: { message: data.message ?? "Session error" },
        },
      ];
    default:
      return [];
  }
}

function getPortalWorkerCount(explicitWorkers) {
  if (typeof explicitWorkers === "number" && Number.isFinite(explicitWorkers)) {
    return explicitWorkers;
  }

  if (process.env.PORTAL_TUI_MODE === "remote") return 0;
  return 1;
}

async function startRuntime(workersRequested) {
  const store = process.env.DATABASE_URL;
  if (!store) {
    throw new Error("Missing DATABASE_URL. The portal backend requires PostgreSQL.");
  }

  const workerCount = getPortalWorkerCount(workersRequested);
  const pluginDirs = loadPluginDirs();
  const workers = [];

  for (let i = 0; i < workerCount; i++) {
    const worker = new PilotSwarmWorker({
      store,
      githubToken: process.env.GITHUB_TOKEN,
      logLevel: process.env.LOG_LEVEL || "info",
      awsS3BucketName: process.env.AWS_S3_BUCKET_NAME,
      awsS3Region: process.env.AWS_S3_REGION,
      awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
      awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      awsS3Endpoint: process.env.AWS_S3_ENDPOINT,
      workerNodeId: `portal-${os.hostname()}-${i}`,
      pluginDirs,
    });
    await worker.start();
    workers.push(worker);
  }

  const primaryWorker = workers[0] ?? null;
  const client = new PilotSwarmClient({
    store,
    blobEnabled: true,
    ...(primaryWorker?.sessionPolicy ? { sessionPolicy: primaryWorker.sessionPolicy } : {}),
    ...(primaryWorker?.allowedAgentNames?.length ? { allowedAgentNames: primaryWorker.allowedAgentNames } : {}),
  });
  await client.start();

  const management = new PilotSwarmManagementClient({ store });
  await management.start();

  return {
    allowedAgentNames: primaryWorker?.allowedAgentNames ?? [],
    client,
    management,
    workers,
    workerCount,
  };
}

export async function startServer(opts = {}) {
  const { port = 3001, workers } = opts;
  const runtime = await startRuntime(workers);

  const app = express();
  const server = http.createServer(app);
  const hasDist = fs.existsSync(path.join(DIST_DIR, "index.html"));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      embeddedWorkers: runtime.workerCount,
    });
  });

  app.get("/api/models", (_req, res) => {
    res.json({
      models: runtime.management.listModels(),
    });
  });

  if (hasDist) {
    app.use(express.static(DIST_DIR));
  } else {
    app.get("/", (_req, res) => {
      res.status(200).send(createDevLandingPage(port));
    });
  }

  const wss = new WebSocketServer({ server, path: "/portal-ws" });

  wss.on("connection", (ws) => {
    const unsubscribers = new Map();
    const sessionHandles = new Map();
    let listTimer = null;
    let closed = false;

    async function getSessionHandle(sessionId) {
      if (sessionHandles.has(sessionId)) return sessionHandles.get(sessionId);
      const session = await runtime.client.resumeSession(sessionId);
      sessionHandles.set(sessionId, session);
      return session;
    }

    async function subscribeToSession(sessionId) {
      if (unsubscribers.has(sessionId) || closed) return;
      const session = await getSessionHandle(sessionId);
      const unsubscribe = session.on((event) => {
        for (const msg of mapSessionEventToPortalMessages(sessionId, event)) {
          wsSend(ws, msg.type, msg.data);
        }
      });
      unsubscribers.set(sessionId, unsubscribe);
    }

    async function pushSessionList() {
      const sessions = await runtime.management.listSessions();
      wsSend(ws, "sessionList", {
        sessions: sessions.map(mapSessionView),
      });

      for (const session of sessions) {
        if (session.status !== "pending") {
          await subscribeToSession(session.sessionId);
        }
      }
    }

    async function handleCreateSession(data = {}) {
      const agentId = data.agentId ?? undefined;
      const model = data.model ?? undefined;

      let session;
      if (agentId && runtime.allowedAgentNames.includes(agentId)) {
        session = await runtime.client.createSessionForAgent(agentId, { model });
      } else {
        session = await runtime.client.createSession({
          model,
          ...(agentId
            ? {
                agentId,
                boundAgentName: agentId,
                promptLayering: { kind: "app-agent" },
              }
            : {}),
        });
      }

      sessionHandles.set(session.sessionId, session);
      const view = await runtime.management.getSession(session.sessionId);
      wsSend(ws, "sessionCreated", {
        sessionId: session.sessionId,
        title: fallbackSessionTitle(view ?? {
          sessionId: session.sessionId,
          title: null,
          agentId,
        }),
        agentId,
        model,
      });
      await pushSessionList();
    }

    async function handleSendMessage(data = {}) {
      const { sessionId, message } = data;
      if (!sessionId || !message) return;

      const session = await getSessionHandle(sessionId);
      wsSend(ws, "thinking", { sessionId, active: true });
      await session.send(message);
      await subscribeToSession(sessionId);
      await pushSessionList();
    }

    async function handleRenameSession(data = {}) {
      const { sessionId, title } = data;
      if (!sessionId || !title) return;
      await runtime.management.renameSession(sessionId, title);
      await pushSessionList();
    }

    async function handleCancelSession(data = {}) {
      const { sessionId } = data;
      if (!sessionId) return;
      await runtime.management.cancelSession(sessionId, "Cancelled from portal");
      wsSend(ws, "thinking", { sessionId, active: false });
      await pushSessionList();
    }

    async function handleDeleteSession(data = {}) {
      const { sessionId } = data;
      if (!sessionId) return;
      await runtime.management.deleteSession(sessionId, "Deleted from portal");
      const unsubscribe = unsubscribers.get(sessionId);
      if (unsubscribe) unsubscribe();
      unsubscribers.delete(sessionId);
      sessionHandles.delete(sessionId);
      wsSend(ws, "thinking", { sessionId, active: false });
      await pushSessionList();
    }

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        switch (msg.type) {
          case "listSessions":
            await pushSessionList();
            break;
          case "listModels":
            wsSend(ws, "models", { models: runtime.management.listModels() });
            break;
          case "createSession":
            await handleCreateSession(msg.data);
            break;
          case "send":
            await handleSendMessage(msg.data);
            break;
          case "renameSession":
            await handleRenameSession(msg.data);
            break;
          case "cancelSession":
            await handleCancelSession(msg.data);
            break;
          case "deleteSession":
            await handleDeleteSession(msg.data);
            break;
          default:
            wsSend(ws, "error", { message: `Unknown portal message type: ${msg.type}` });
        }
      } catch (error) {
        wsSend(ws, "error", { message: error.message || "Portal request failed" });
      }
    });

    listTimer = setInterval(() => {
      pushSessionList().catch((error) => {
        wsSend(ws, "error", { message: error.message || "Failed to refresh sessions" });
      });
    }, 3_000);

    pushSessionList().catch((error) => {
      wsSend(ws, "error", { message: error.message || "Failed to load sessions" });
    });

    ws.on("close", () => {
      closed = true;
      if (listTimer) clearInterval(listTimer);
      for (const unsubscribe of unsubscribers.values()) unsubscribe();
      unsubscribers.clear();
      sessionHandles.clear();
    });
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[portal] Shutting down...");
    wss.clients.forEach((client) => client.close());
    await Promise.allSettled(runtime.workers.map((worker) => worker.stop()));
    await Promise.allSettled([
      runtime.management.stop(),
      runtime.client.stop(),
      new Promise((resolve) => server.close(resolve)),
    ]);
  }

  process.on("SIGINT", () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    shutdown().finally(() => process.exit(0));
  });

  if (hasDist) {
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(DIST_DIR, "index.html"));
    });
  }

  await new Promise((resolve) => {
    server.listen(port, resolve);
  });

  console.log(`[portal] PilotSwarm Web backend at http://localhost:${port}`);
  console.log(`[portal] Embedded workers: ${runtime.workerCount}`);

  return server;
}

if (process.argv[1]?.endsWith("server.js") || import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}
