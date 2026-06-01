// Thin CDP JSON-RPC client over the existing `ws` runtime dep (ADR-0017 D1, D4). NOT a
// general-purpose CDP library: a hard-coded permit list gates `send` so a server bug cannot send
// `Runtime.evaluate` or any cookie-reading method. Pending requests are correlated by an
// incrementing integer `id`; the in-process id allocator is private so a CDP response cannot spoof
// the id of a request it didn't trigger.

import { WebSocket, type RawData } from "ws";
import { BrowserToolError } from "./errors.js";

// ADR-0017 D4 — exact permit list. New methods require an ADR amendment, not a code-only patch.
export const PERMITTED_CDP_METHODS: ReadonlySet<string> = new Set([
  "Target.createTarget",
  "Target.attachToTarget",
  "Target.closeTarget",
  "Page.enable",
  "Page.navigate",
  "Page.stopLoading",
  "Page.captureScreenshot",
  "DOM.getDocument",
  "DOM.getOuterHTML",
  "Browser.getVersion",
]);

const DEFAULT_CDP_TIMEOUT_MS = 10_000;

export interface CdpClientOptions {
  readonly timeoutMs?: number;
  readonly socketFactory?: (url: string) => WebSocket;
}

export type CdpEventListener = (event: {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId?: string;
}) => void;
export type CdpCloseListener = (reason: string) => void;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

type CdpFrame =
  | {
      readonly id: number;
      readonly result?: unknown;
      readonly error?: { code?: number; message?: string };
    }
  | { readonly method: string; readonly params?: unknown; readonly sessionId?: string };

function isCdpFrame(value: unknown): value is CdpFrame {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.id === "number" || typeof rec.method === "string";
}

function parseCdpText(text: string): CdpFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isCdpFrame(parsed) ? parsed : undefined;
}

function rawDataToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export class CdpClient {
  private readonly socket: WebSocket;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<CdpEventListener>();
  private readonly closeListeners = new Set<CdpCloseListener>();
  private nextId = 1;
  private connectPromise: Promise<void> | undefined;
  private closed = false;
  private closeReason: string | undefined;

  public constructor(url: string, options: CdpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    const factory = options.socketFactory ?? ((target: string): WebSocket => new WebSocket(target));
    this.socket = factory(url);
    this.socket.on("message", (data, isBinary) => {
      this.handleMessage(data, isBinary);
    });
    this.socket.on("close", () => {
      this.handleSocketClosed("chrome-disconnected");
    });
    this.socket.on("error", () => {
      this.handleSocketClosed("chrome-disconnected");
    });
  }

  public connect(): Promise<void> {
    if (this.connectPromise !== undefined) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      if (this.socket.readyState === this.socket.OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        reject(new BrowserToolError("CDP_TIMEOUT", "CDP connection did not open in time."));
      }, this.timeoutMs);
      this.socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(new BrowserToolError("CHROME_UNREACHABLE", `CDP connection failed: ${err.message}`));
      });
    });
    return this.connectPromise;
  }

  public onEvent(listener: CdpEventListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public onClose(listener: CdpCloseListener): () => void {
    this.closeListeners.add(listener);
    return (): void => {
      this.closeListeners.delete(listener);
    };
  }

  public async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (!PERMITTED_CDP_METHODS.has(method)) {
      throw new BrowserToolError(
        "CDP_METHOD_FORBIDDEN",
        "The requested CDP method is not permitted.",
      );
    }
    if (this.closed) {
      throw new BrowserToolError("TARGET_CLOSED", "CDP connection is closed.");
    }
    await this.connect();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserToolError("CDP_TIMEOUT", "CDP response did not arrive in time."));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value: unknown): void => {
          resolve(value as T);
        },
        reject,
        timer,
      });
      const frame =
        sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
      try {
        this.socket.send(JSON.stringify(frame));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        const message = err instanceof Error ? err.message : "send failed";
        reject(new BrowserToolError("CHROME_UNREACHABLE", `CDP send failed: ${message}`));
      }
    });
  }

  public close(): void {
    if (this.closed) return;
    this.handleSocketClosed("explicit");
    try {
      this.socket.close();
    } catch {
      // The underlying socket may already be torn down; treat as idempotent.
    }
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public closeCause(): string | undefined {
    return this.closeReason;
  }

  private handleMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) return;
    const parsed = parseCdpText(rawDataToText(data));
    if (parsed === undefined) return;
    if ("id" in parsed && typeof parsed.id === "number") {
      this.resolvePending(parsed);
      return;
    }
    if ("method" in parsed && typeof parsed.method === "string") {
      this.dispatchEvent(parsed);
    }
  }

  private dispatchEvent(frame: Extract<CdpFrame, { method: string }>): void {
    const listenerEvent = {
      method: frame.method,
      params: frame.params ?? {},
      ...(typeof frame.sessionId === "string" ? { sessionId: frame.sessionId } : {}),
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(listenerEvent);
      } catch {
        // A listener throwing must not stop event dispatch to other subscribers.
      }
    }
  }

  private resolvePending(frame: Extract<CdpFrame, { id: number }>): void {
    const pending = this.pending.get(frame.id);
    if (pending === undefined) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error !== undefined) {
      pending.reject(
        new BrowserToolError(
          "CDP_METHOD_FORBIDDEN",
          // Static message — the raw Chrome error may contain paths or session IDs.
          "Chrome rejected a CDP method.",
        ),
      );
      return;
    }
    pending.resolve(frame.result ?? {});
  }

  private handleSocketClosed(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new BrowserToolError("TARGET_CLOSED", "CDP connection closed."));
    }
    this.pending.clear();
    for (const listener of [...this.closeListeners]) {
      try {
        listener(reason);
      } catch {
        // A close listener throwing must not stop cleanup notifications.
      }
    }
  }
}
