import { createContext, useContext, useEffect, useState, useRef, useCallback, type ReactNode } from "react";
import type { WSMessage } from "../lib/api";

interface PortalContextValue {
  connected: boolean;
  sessions: SessionInfo[];
  messages: Map<string, ChatMessage[]>;
  thinking: Set<string>;
  send: (msg: WSMessage) => void;
  on: (type: string, handler: (data: any) => void) => () => void;
  createSession: (agentId?: string | null, model?: string) => void;
  sendMessage: (sessionId: string, text: string) => void;
}

export interface SessionInfo {
  id: string;
  title: string;
  status: string;
  agentId?: string;
  parentId?: string;
  isSystem?: boolean;
  model?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  toolCalls?: { name: string; args: string; status: string; result?: string; durationMs?: number }[];
}

const PortalContext = createContext<PortalContextValue | null>(null);

export function usePortal() {
  const ctx = useContext(PortalContext);
  if (!ctx) throw new Error("usePortal must be used within PortalProvider");
  return ctx;
}

export function PortalProvider({ children }: { children: ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [messages, setMessages] = useState<Map<string, ChatMessage[]>>(new Map());
  const [thinking, setThinking] = useState<Set<string>>(new Set());
  const listenersRef = useRef<Map<string, Set<(data: any) => void>>>(new Map());

  function upsertSessionList(list: SessionInfo[], nextSession: SessionInfo): SessionInfo[] {
    const idx = list.findIndex((session) => session.id === nextSession.id);
    if (idx === -1) return [...list, nextSession];
    const next = [...list];
    next[idx] = { ...next[idx], ...nextSession };
    return next;
  }

  function dedupeSessions(list: SessionInfo[]): SessionInfo[] {
    const byId = new Map<string, SessionInfo>();
    for (const session of list) {
      const existing = byId.get(session.id);
      byId.set(session.id, existing ? { ...existing, ...session } : session);
    }
    return Array.from(byId.values());
  }

  // ── WebSocket lifecycle ───────────────────────────────────────
  useEffect(() => {
    const wsHost = location.host;  // Always same-origin; Vite proxies /portal-ws in dev
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${wsHost}/portal-ws`;

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      console.log("[portal] connecting to", wsUrl);
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[portal] WS connected");
        setMessages(new Map());
        setThinking(new Set());
        setConnected(true);
        ws!.send(JSON.stringify({ type: "listSessions" }));
      };

      ws.onclose = () => {
        console.log("[portal] WS closed, reconnecting in 2s...");
        setConnected(false);
        if (!cancelled) reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = (e) => {
        console.error("[portal] WS error:", e);
      };

      ws.onmessage = (ev) => {
        try {
          const msg: WSMessage = JSON.parse(ev.data);
          listenersRef.current.get(msg.type)?.forEach((fn) => fn(msg.data));
          handleServerEvent(msg);
        } catch {
          // ignore malformed
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  // ── Handle events from server ─────────────────────────────────
  function handleServerEvent(msg: WSMessage) {
    switch (msg.type) {
      case "sessionCreated": {
        const d = msg.data as { sessionId: string; title: string; agentId?: string; model?: string };
        setSessions((prev) => upsertSessionList(prev, {
          id: d.sessionId,
          title: d.title || d.sessionId.slice(0, 8),
          status: "idle",
          agentId: d.agentId,
          model: d.model,
        }));
        break;
      }
      case "sessionList": {
        const d = msg.data as { sessions: SessionInfo[] };
        const nextSessions = dedupeSessions(d.sessions);
        setSessions(nextSessions);
        setThinking((prev) => {
          const next = new Set(prev);
          for (const session of nextSessions) {
            if (session.status !== "running") {
              next.delete(session.id);
            }
          }
          return next;
        });
        break;
      }
      case "message": {
        const d = msg.data as { sessionId: string; role: "user" | "assistant"; content: string; timestamp: string };
        setMessages((prev) => {
          const next = new Map(prev);
          const arr = [...(next.get(d.sessionId) || [])];
          arr.push({ role: d.role, content: d.content, timestamp: d.timestamp });
          next.set(d.sessionId, arr);
          return next;
        });
        if (d.role === "assistant") {
          setThinking((prev) => { const s = new Set(prev); s.delete(d.sessionId); return s; });
        }
        break;
      }
      case "error": {
        const d = msg.data as { message?: string };
        console.error("[portal] server error:", d?.message ?? "unknown error");
        break;
      }
      case "thinking": {
        const d = msg.data as { sessionId: string; active: boolean };
        setThinking((prev) => {
          const s = new Set(prev);
          if (d.active) s.add(d.sessionId); else s.delete(d.sessionId);
          return s;
        });
        break;
      }
      case "statusUpdate": {
        const d = msg.data as { sessionId: string; status: string };
        setSessions((prev) => prev.map((s) => s.id === d.sessionId ? { ...s, status: d.status } : s));
        if (d.status !== "running") {
          setThinking((prev) => {
            const next = new Set(prev);
            next.delete(d.sessionId);
            return next;
          });
        }
        break;
      }
      case "toolCall": {
        const d = msg.data as { sessionId: string; name: string; args: string; status: string; result?: string; durationMs?: number };
        // Append tool call info to the last assistant message for that session
        setMessages((prev) => {
          const next = new Map(prev);
          const arr = [...(next.get(d.sessionId) || [])];
          // Find last assistant message, or create a placeholder
          let last = arr.findLast((m) => m.role === "assistant");
          if (!last) {
            last = { role: "assistant", content: "", timestamp: new Date().toISOString(), toolCalls: [] };
            arr.push(last);
          }
          if (!last.toolCalls) last.toolCalls = [];
          const existing = last.toolCalls.find((tc) => tc.name === d.name && tc.status === "started");
          if (existing && d.status !== "started") {
            existing.status = d.status;
            existing.result = d.result;
            existing.durationMs = d.durationMs;
          } else {
            last.toolCalls.push({ name: d.name, args: d.args, status: d.status, result: d.result, durationMs: d.durationMs });
          }
          next.set(d.sessionId, arr);
          return next;
        });
        break;
      }
    }
  }

  // ── Outgoing actions ──────────────────────────────────────────
  const send = useCallback((msg: WSMessage) => {
    wsRef.current?.send(JSON.stringify(msg));
  }, []);

  const on = useCallback((type: string, handler: (data: any) => void) => {
    if (!listenersRef.current.has(type)) listenersRef.current.set(type, new Set());
    listenersRef.current.get(type)!.add(handler);
    return () => { listenersRef.current.get(type)?.delete(handler); };
  }, []);

  const createSession = useCallback((agentId?: string | null, model?: string) => {
    send({ type: "createSession", data: { agentId: agentId ?? undefined, model } });
  }, [send]);

  const sendMessage = useCallback((sessionId: string, text: string) => {
    // Let the backend replay the persisted user.message event so browser
    // state stays consistent after reconnects and refreshes.
    setThinking((prev) => { const s = new Set(prev); s.add(sessionId); return s; });
    send({ type: "send", data: { sessionId, message: text } });
  }, [send]);

  return (
    <PortalContext.Provider value={{ connected, sessions, messages, thinking, send, on, createSession, sendMessage }}>
      {children}
    </PortalContext.Provider>
  );
}
