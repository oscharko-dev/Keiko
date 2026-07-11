// Minimal JSON-RPC 2.0 client over the LSP base protocol (Issue #1381, Epic #1491, ADR-0069 D3/D4).
// It correlates outbound requests to inbound responses by numeric id, dispatches server-initiated
// notifications to a registered handler, and enforces a per-request deadline plus AbortSignal
// cancellation by mirroring the `createDeadlineCancellation` clock+signal model natively. We do NOT
// import `languageCancellation` here: it pulls in the TypeScript compiler for its HostCancellationToken,
// which this transport layer must not depend on.
//
// On deadline expiry the client sends `$/cancelRequest` and rejects with LspRpcTimeoutError (the
// process is not killed — a slow request is not a crash, ADR-0069 D4). On abort it sends
// `$/cancelRequest` and rejects with LspRpcCancelledError. On dispose every pending request rejects
// with LspRpcDisposedError. All three carry only a class name, never request/response content.

import type { LspByteSource, LspBytes } from "./lspFrameCodec.js";

export class LspRpcTimeoutError extends Error {
  public constructor() {
    super("LSP request timed out");
    this.name = "LspRpcTimeoutError";
  }
}

export class LspRpcCancelledError extends Error {
  public constructor() {
    super("LSP request cancelled");
    this.name = "LspRpcCancelledError";
  }
}

export class LspRpcDisposedError extends Error {
  public constructor() {
    super("LSP client disposed");
    this.name = "LspRpcDisposedError";
  }
}

export type LspServerRequestErrorCode = -32601 | -32602 | -32603 | -32000;

export class LspServerRequestError extends Error {
  public readonly code: LspServerRequestErrorCode;

  public constructor(code: LspServerRequestErrorCode, message: string) {
    super(message);
    this.name = "LspServerRequestError";
    this.code = code;
  }
}

export type LspNotificationHandler = (method: string, params: unknown) => void;
export type LspServerRequestHandler = (method: string, params: unknown) => unknown;

export interface LspRequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly deadlineMs: number;
  readonly now?: (() => number) | undefined;
}

export interface LspJsonRpcClient {
  request<T>(method: string, params: unknown, options: LspRequestOptions): Promise<T>;
  notify(method: string, params: unknown): void;
  onNotification(handler: LspNotificationHandler): () => void;
  onRequest(handler: LspServerRequestHandler): void;
  pendingCount(): number;
  activeServerRequestCount(): number;
  dispose(): void;
}

// Injectable so deadline expiry is deterministically testable without wall-clock waits. Defaults to
// the global timer functions. `setTimer` returns an opaque handle that `clearTimer` cancels.
export interface LspRpcScheduler {
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface LspJsonRpcClientDeps {
  readonly source: LspByteSource;
  readonly sendFrame: (body: string) => void;
  readonly scheduler?: LspRpcScheduler | undefined;
  readonly maxConcurrentServerRequests?: number | undefined;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  settle(): void;
}

interface RpcRuntimeState {
  readonly notificationHandlers: Set<LspNotificationHandler>;
  serverRequestHandler: LspServerRequestHandler | undefined;
  nextId: number;
  disposed: boolean;
  activeServerRequests: number;
}

const defaultScheduler: LspRpcScheduler = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function createLspJsonRpcClient(deps: LspJsonRpcClientDeps): LspJsonRpcClient {
  const scheduler = deps.scheduler ?? defaultScheduler;
  const pending = new Map<number, PendingRequest>();
  const state: RpcRuntimeState = {
    notificationHandlers: new Set(),
    serverRequestHandler: undefined,
    nextId: 1,
    disposed: false,
    activeServerRequests: 0,
  };

  const send = (payload: Record<string, unknown>): void => {
    deps.sendFrame(JSON.stringify(payload));
  };

  const maxServerRequests = boundedServerRequestLimit(deps.maxConcurrentServerRequests);
  void consume(deps.source, (body) => {
    dispatchIncoming(body, pending, state, send, maxServerRequests);
  });
  return clientApi(state, pending, scheduler, send);
}

function clientApi(
  state: RpcRuntimeState,
  pending: Map<number, PendingRequest>,
  scheduler: LspRpcScheduler,
  send: (payload: Record<string, unknown>) => void,
): LspJsonRpcClient {
  return {
    request: <T>(method: string, params: unknown, options: LspRequestOptions): Promise<T> =>
      requestFromRuntime(state, pending, scheduler, send, method, params, options),
    notify: (method, params): void => {
      if (!state.disposed) send({ jsonrpc: "2.0", method, params });
    },
    onNotification: (handler): (() => void) => {
      state.notificationHandlers.add(handler);
      return (): void => {
        state.notificationHandlers.delete(handler);
      };
    },
    onRequest: (handler): void => {
      state.serverRequestHandler = handler;
    },
    pendingCount: (): number => pending.size,
    activeServerRequestCount: (): number => state.activeServerRequests,
    dispose: (): void => {
      if (state.disposed) return;
      state.disposed = true;
      rejectAll(pending, new LspRpcDisposedError());
    },
  };
}

function requestFromRuntime<T>(
  state: RpcRuntimeState,
  pending: Map<number, PendingRequest>,
  scheduler: LspRpcScheduler,
  send: (payload: Record<string, unknown>) => void,
  method: string,
  params: unknown,
  options: LspRequestOptions,
): Promise<T> {
  if (state.disposed) return Promise.reject(new LspRpcDisposedError());
  const id = state.nextId++;
  return new Promise<T>((resolve, reject) => {
    registerPending(id, pending, scheduler, send, options, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function dispatchIncoming(
  body: LspBytes,
  pending: Map<number, PendingRequest>,
  state: RpcRuntimeState,
  send: (payload: Record<string, unknown>) => void,
  maximum: number,
): void {
  dispatch(
    body,
    pending,
    (method, params) => {
      for (const handler of state.notificationHandlers) handler(method, params);
    },
    (id, method, params) => {
      handleInboundRequest(state, send, maximum, id, method, params);
    },
  );
}

function handleInboundRequest(
  state: RpcRuntimeState,
  send: (payload: Record<string, unknown>) => void,
  maximum: number,
  id: ServerRequestId,
  method: string,
  params: unknown,
): void {
  if (state.disposed) return;
  if (state.activeServerRequests >= maximum) {
    sendServerError(send, id, -32000, "Server request limit exceeded");
    return;
  }
  state.activeServerRequests += 1;
  void answerServerRequest(
    state.serverRequestHandler,
    id,
    method,
    params,
    send,
    () => state.disposed,
  ).finally(() => {
    state.activeServerRequests -= 1;
  });
}

function boundedServerRequestLimit(value: number | undefined): number {
  return value === undefined || !Number.isSafeInteger(value) || value < 1 || value > 64
    ? 16
    : value;
}

type ServerRequestId = number | string;

async function answerServerRequest(
  handler: LspServerRequestHandler | undefined,
  id: ServerRequestId,
  method: string,
  params: unknown,
  send: (payload: Record<string, unknown>) => void,
  disposed: () => boolean,
): Promise<void> {
  try {
    if (handler === undefined) throw new LspServerRequestError(-32601, "Server request denied");
    const result = await handler(method, params);
    if (!disposed()) send({ jsonrpc: "2.0", id, result });
  } catch (error: unknown) {
    if (disposed()) return;
    const safe = safeServerRequestError(error);
    sendServerError(send, id, safe.code, safe.message);
  }
}

function safeServerRequestError(error: unknown): LspServerRequestError {
  return error instanceof LspServerRequestError
    ? error
    : new LspServerRequestError(-32603, "Server request failed");
}

function sendServerError(
  send: (payload: Record<string, unknown>) => void,
  id: ServerRequestId,
  code: LspServerRequestErrorCode,
  message: string,
): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

interface ResolveReject {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

// Wires the deadline timer and abort listener for one in-flight request and records it in the pending
// map. The shared `settle()` tears down both the timer and the abort listener exactly once, on any
// terminal outcome (response, timeout, abort, dispose), so no handle leaks.
function registerPending(
  id: number,
  pending: Map<number, PendingRequest>,
  scheduler: LspRpcScheduler,
  send: (payload: Record<string, unknown>) => void,
  options: LspRequestOptions,
  handlers: ResolveReject,
): void {
  const cancel = (): void => {
    send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
  };
  const timer = scheduler.setTimer(() => {
    if (!pending.has(id)) return;
    pending.delete(id);
    settle();
    cancel();
    handlers.reject(new LspRpcTimeoutError());
  }, options.deadlineMs);
  const onAbort = (): void => {
    if (!pending.has(id)) return;
    pending.delete(id);
    settle();
    cancel();
    handlers.reject(new LspRpcCancelledError());
  };
  const settle = (): void => {
    scheduler.clearTimer(timer);
    options.signal?.removeEventListener("abort", onAbort);
  };
  if (options.signal?.aborted === true) {
    pending.delete(id);
    settle();
    cancel();
    handlers.reject(new LspRpcCancelledError());
    return;
  }
  options.signal?.addEventListener("abort", onAbort);
  pending.set(id, { resolve: handlers.resolve, reject: handlers.reject, settle });
}

// Parses one frame body and routes it: a response (has numeric `id`) resolves or rejects its pending
// entry; anything else is treated as a server-initiated notification. Malformed JSON or an unknown id
// is ignored — a misbehaving server cannot crash the client (fail-safe, ADR-0069 D4).
function dispatch(
  body: LspBytes,
  pending: Map<number, PendingRequest>,
  notify: (method: string, params: unknown) => void,
  request: (id: ServerRequestId, method: string, params: unknown) => void,
): void {
  const message = parseMessage(body);
  if (message === null) return;
  const id = message.id;
  if ((typeof id === "number" || typeof id === "string") && typeof message.method === "string") {
    request(id, message.method, message.params);
    return;
  }
  if (typeof id === "number") {
    settleResponse(id, message, pending);
    return;
  }
  if (typeof message.method === "string") {
    notify(message.method, message.params);
  }
}

function settleResponse(
  id: number,
  message: Record<string, unknown>,
  pending: Map<number, PendingRequest>,
): void {
  const entry = pending.get(id);
  if (entry === undefined) return;
  pending.delete(id);
  entry.settle();
  const error = message.error;
  if (isRpcError(error)) {
    entry.reject(new Error(typeof error.message === "string" ? error.message : "LSP error"));
    return;
  }
  entry.resolve(message.result);
}

function isRpcError(value: unknown): value is { message?: unknown } {
  return typeof value === "object" && value !== null;
}

function parseMessage(body: LspBytes): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function rejectAll(pending: Map<number, PendingRequest>, error: Error): void {
  for (const entry of pending.values()) {
    entry.settle();
    entry.reject(error);
  }
  pending.clear();
}

// Drains the frame source until it ends. Reader-loop errors (e.g. a frame-reject thrown by the codec)
// terminate the loop; the transport owns surfacing that as a process-level failure, so it is swallowed
// here to avoid an unhandled rejection on the detached consume promise.
async function consume(source: LspByteSource, onBody: (body: LspBytes) => void): Promise<void> {
  try {
    for await (const body of source) {
      onBody(body);
    }
  } catch {
    // Intentionally ignored: frame-level failures are surfaced by the transport via the reader, not
    // by this detached drain loop. See lspTransport.ts.
  }
}
