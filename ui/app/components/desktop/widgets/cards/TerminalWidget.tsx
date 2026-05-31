"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal as XTerm } from "@xterm/xterm";
import {
  type CreateTerminalSessionInput,
  createTerminalSession,
  deleteTerminalSession,
} from "../../../../../lib/api";
import type { TerminalSessionMeta } from "../../../../../lib/types";

interface TerminalWidgetProps {
  readonly cwd?: string;
  readonly shell?: string;
}

type TerminalServerMessage =
  | { readonly type: "ready"; readonly session: TerminalSessionMeta }
  | { readonly type: "output"; readonly data: string }
  | { readonly type: "exit"; readonly exitCode: number; readonly signal?: number }
  | { readonly type: "error"; readonly message: string };

function wsUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}

function parseServerMessage(raw: string): TerminalServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const msg = parsed as Record<string, unknown>;
  if (msg.type === "ready" && typeof msg.session === "object" && msg.session !== null) {
    return { type: "ready", session: msg.session as TerminalSessionMeta };
  }
  if (msg.type === "output" && typeof msg.data === "string") {
    return { type: "output", data: msg.data };
  }
  if (msg.type === "exit" && typeof msg.exitCode === "number") {
    const exit: { type: "exit"; exitCode: number; signal?: number } = {
      type: "exit",
      exitCode: msg.exitCode,
    };
    if (typeof msg.signal === "number") exit.signal = msg.signal;
    return exit;
  }
  if (msg.type === "error" && typeof msg.message === "string") {
    return { type: "error", message: msg.message };
  }
  return null;
}

function sendInput(socket: WebSocket | null, data: string): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "input", data }));
}

function sendResize(socket: WebSocket | null, term: XTerm): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
}

function terminalTheme(): ITheme {
  return {
    background: "#111512",
    foreground: "#c8d2cb",
    cursor: "#4EBA87",
    selectionBackground: "#4EBA8740",
    black: "#101311",
    red: "#ef7b68",
    green: "#4EBA87",
    yellow: "#d9b15f",
    blue: "#7aa7ff",
    magenta: "#c78cff",
    cyan: "#70d6c7",
    white: "#d7ded9",
    brightBlack: "#6f7a73",
    brightRed: "#ff937f",
    brightGreen: "#72dca6",
    brightYellow: "#f0ca79",
    brightBlue: "#9bbdff",
    brightMagenta: "#ddb0ff",
    brightCyan: "#91eee0",
    brightWhite: "#f4f8f5",
  };
}

export function TerminalWidget({ cwd, shell }: TerminalWidgetProps): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<"starting" | "connected" | "exited" | "failed">("starting");
  const [meta, setMeta] = useState<TerminalSessionMeta | null>(null);
  const [restartKey, setRestartKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let cleanupStarted = false;
    let dataDisposable: { dispose: () => void } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeFrame = 0;

    async function cleanupSession(): Promise<void> {
      if (cleanupStarted) return;
      cleanupStarted = true;
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId !== null) {
        try {
          await deleteTerminalSession(sessionId);
        } catch {
          // Session cleanup is best-effort; the server also has an idle TTL.
        }
      }
    }

    async function start(): Promise<void> {
      const host = hostRef.current;
      if (host === null) return;
      setStatus("starting");
      setError(null);
      host.textContent = "";
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled) return;
      const term = new Terminal({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: true,
        cursorStyle: "block",
        fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.25,
        scrollback: 8_000,
        theme: terminalTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;
      const optionalInput: Pick<CreateTerminalSessionInput, "cwd" | "shellId"> = {
        ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
        ...(shell !== undefined && shell.length > 0 ? { shellId: shell } : {}),
      };
      const sessionInput: CreateTerminalSessionInput = {
        ...optionalInput,
        cols: term.cols,
        rows: term.rows,
      };
      const created = await createTerminalSession(sessionInput);
      if (cancelled) {
        await deleteTerminalSession(created.session.id);
        return;
      }
      sessionIdRef.current = created.session.id;
      setMeta(created.session);
      const socket = new WebSocket(wsUrl(created.webSocketPath));
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        setStatus("connected");
        sendResize(socket, term);
        term.focus();
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        const message = parseServerMessage(event.data);
        if (message === null) return;
        if (message.type === "ready") {
          setMeta(message.session);
          return;
        }
        if (message.type === "output") {
          term.write(message.data);
          return;
        }
        if (message.type === "exit") {
          setStatus("exited");
          term.write(`\r\n[process exited with code ${String(message.exitCode)}]\r\n`);
          return;
        }
        setError(message.message);
        term.write(`\r\n${message.message}\r\n`);
      });
      socket.addEventListener("close", () => {
        setStatus((current) => (current === "failed" ? current : "exited"));
      });
      socket.addEventListener("error", () => {
        setStatus("failed");
        setError("Terminal WebSocket connection failed.");
      });
      dataDisposable = term.onData((data) => sendInput(socketRef.current, data));
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(() => {
            try {
              fit.fit();
              sendResize(socketRef.current, term);
            } catch {
              // The terminal can be mid-dispose during React unmount.
            }
          });
        });
        resizeObserver.observe(host);
      }
    }

    void start().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Terminal could not be started.";
      setStatus("failed");
      setError(message);
      termRef.current?.write(`\r\n${message}\r\n`);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(resizeFrame);
      resizeObserver?.disconnect();
      dataDisposable?.dispose();
      socketRef.current?.close(1000, "terminal widget disposed");
      socketRef.current = null;
      fitRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      void cleanupSession();
    };
  }, [cwd, shell, restartKey]);

  const label = meta === null
    ? "starting"
    : `${meta.shellLabel} · ${meta.cwd}`;

  return (
    <div className="terminal">
      <div className="tm-bar">
        <span className="tm-status" data-state={status}>{status}</span>
        <span className="tm-label mono" title={label}>{label}</span>
        <button
          type="button"
          className="tm-action"
          onClick={() => setRestartKey((current) => current + 1)}
          title="Restart terminal"
        >
          Restart
        </button>
      </div>
      <div ref={hostRef} className="tm-host" />
      {error !== null ? <div className="tm-error">{error}</div> : null}
    </div>
  );
}
