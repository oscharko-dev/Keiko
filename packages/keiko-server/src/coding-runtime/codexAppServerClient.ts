import {
  createCodexAppServerJsonlDecoder,
  projectCodexAppServerMessage,
  projectCodexAppServerResponse,
  projectCodexAppServerToolCallOutcome,
  validateCodexAppServerClientRequest,
  type CodexAppServerId,
  type CodexAppServerProjection,
  type CodexAppServerToolCallOutcome,
} from "./codexAppServerProtocol.js";

export interface CodexAppServerTransport {
  write(chunk: string): void | Promise<void>;
  onData(listener: (chunk: string) => void): () => void;
}
export interface CodexAppServerScheduler {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface CodexAppServerClientOptions {
  readonly transport: CodexAppServerTransport;
  readonly scheduler?: CodexAppServerScheduler;
  readonly requestDeadlineMs?: number;
  readonly maxPending?: number;
  readonly maxQueuedBytes?: number;
  readonly onProjection?: (event: CodexAppServerProjection) => void;
  readonly onFailure?: (code: CodexAppServerClientFailureCode) => void;
}
export interface CodexAppServerRequestOptions {
  readonly signal?: AbortSignal;
}
export type CodexAppServerClientErrorCode =
  | "method-denied"
  | "pending-limit"
  | "queue-limit"
  | "deadline-exceeded"
  | "request-cancelled"
  | "tool-response-denied"
  | "transport-failed";
export type CodexAppServerClientFailureCode = "protocol-invalid" | "transport-failed";
export class CodexAppServerClientError extends Error {
  constructor(readonly code: CodexAppServerClientErrorCode) {
    super(code);
    this.name = "CodexAppServerClientError";
  }
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: CodexAppServerClientError) => void;
  readonly timer: unknown;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}
const MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_DEADLINE = 30_000;
const DEFAULT_MAX_PENDING = 64;
const DEFAULT_MAX_QUEUED = 1024 * 1024;
const MAX_RECENT_COMPLETED_TOOL_REQUESTS = 256;

/** Transport-only client; process spawning and environment discovery remain outside this seam. */
export class CodexAppServerClient {
  readonly #transport: CodexAppServerTransport;
  readonly #scheduler: CodexAppServerScheduler;
  readonly #deadlineMs: number;
  readonly #maxPending: number;
  readonly #maxQueued: number;
  readonly #onProjection: ((event: CodexAppServerProjection) => void) | undefined;
  readonly #onFailure: ((code: CodexAppServerClientFailureCode) => void) | undefined;
  readonly #decoder = createCodexAppServerJsonlDecoder();
  readonly #pending = new Map<CodexAppServerId, Pending>();
  readonly #admittedToolRequests = new Set<CodexAppServerId>();
  readonly #settlingToolRequests = new Set<CodexAppServerId>();
  readonly #recentCompletedToolRequests = new Set<CodexAppServerId>();
  readonly #recentCompletedToolRequestOrder: CodexAppServerId[] = [];
  #nextId = 1;
  #queuedBytes = 0;
  #closed = false;
  #unsubscribe: (() => void) | undefined;

  constructor(options: CodexAppServerClientOptions) {
    this.#transport = options.transport;
    this.#scheduler = options.scheduler ?? { setTimeout, clearTimeout };
    this.#deadlineMs = options.requestDeadlineMs ?? DEFAULT_DEADLINE;
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.#maxQueued = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED;
    this.#onProjection = options.onProjection;
    this.#onFailure = options.onFailure;
    this.#unsubscribe = this.#transport.onData((chunk) => {
      this.#receive(chunk);
    });
  }

  request(
    method: string,
    params: unknown,
    options: CodexAppServerRequestOptions = {},
  ): Promise<unknown> {
    if (method === "initialized") return Promise.reject(error("method-denied"));
    const valid = validateCodexAppServerClientRequest(method, params);
    if (!valid.ok) return Promise.reject(error("method-denied"));
    if (this.#closed) return Promise.reject(error("transport-failed"));
    if (options.signal?.aborted === true) return Promise.reject(error("request-cancelled"));
    if (this.#pending.size >= this.#maxPending) return Promise.reject(error("pending-limit"));
    const id = this.#nextId++;
    const frame = JSON.stringify({ id, method, params }) + "\n";
    const frameBytes = bytes(frame);
    const admitted = this.#admitWrite(frameBytes);
    if (admitted !== undefined) return Promise.reject(admitted);
    return new Promise((resolve, reject) => {
      const timer = this.#scheduler.setTimeout(() => {
        this.#expire(id);
      }, this.#deadlineMs);
      const abort =
        options.signal === undefined
          ? undefined
          : (): void => {
              this.#cancel(id);
            };
      const pending: Pending = { method, resolve, reject, timer, signal: options.signal, abort };
      this.#pending.set(id, pending);
      if (abort !== undefined) options.signal?.addEventListener("abort", abort, { once: true });
      void this.#write(frame, frameBytes).catch(() => {
        // #write already failed the client and rejected pending requests.
      });
    });
  }

  notify(method: "initialized"): Promise<void> {
    const valid = validateCodexAppServerClientRequest(method, undefined);
    if (!valid.ok) return Promise.reject(error("method-denied"));
    if (this.#closed) return Promise.reject(error("transport-failed"));
    const frame = JSON.stringify({ method }) + "\n";
    const frameBytes = bytes(frame);
    const admitted = this.#admitWrite(frameBytes);
    if (admitted !== undefined) return Promise.reject(admitted);
    return this.#write(frame, frameBytes);
  }

  respondToolCall(id: CodexAppServerId, outcome: CodexAppServerToolCallOutcome): Promise<void> {
    if (this.#closed || !this.#admittedToolRequests.has(id) || this.#settlingToolRequests.has(id))
      return Promise.reject(error("tool-response-denied"));
    const projected = projectCodexAppServerToolCallOutcome(outcome);
    if (!projected.ok) return Promise.reject(error("tool-response-denied"));
    const frame = JSON.stringify({ id, result: projected.value }) + "\n";
    const frameBytes = bytes(frame);
    const admitted = this.#admitWrite(frameBytes);
    if (admitted !== undefined) return Promise.reject(admitted);
    this.#settlingToolRequests.add(id);
    return this.#write(frame, frameBytes).then(() => {
      this.#completeToolRequest(id);
    });
  }

  abandonToolCall(id: CodexAppServerId): boolean {
    if (!this.#admittedToolRequests.has(id) && !this.#settlingToolRequests.has(id)) return false;
    this.#completeToolRequest(id);
    return true;
  }

  close(): void {
    this.#fail();
  }

  #admitWrite(frameBytes: number): CodexAppServerClientError | undefined {
    if (
      frameBytes > MAX_FRAME_BYTES ||
      frameBytes > this.#maxQueued ||
      this.#queuedBytes + frameBytes > this.#maxQueued
    )
      return error("queue-limit");
    this.#queuedBytes += frameBytes;
    return undefined;
  }
  #write(frame: string, frameBytes: number): Promise<void> {
    try {
      const written = this.#transport.write(frame);
      if (!isPromiseLike(written)) {
        this.#dequeue(frameBytes);
        return Promise.resolve();
      }
      return Promise.resolve(written).then(
        () => {
          this.#dequeue(frameBytes);
        },
        () => {
          this.#fail("transport-failed");
          throw error("transport-failed");
        },
      );
    } catch {
      this.#fail("transport-failed");
      return Promise.reject(error("transport-failed"));
    }
  }
  #expire(id: CodexAppServerId): void {
    const pending = this.#take(id);
    pending?.reject(error("deadline-exceeded"));
  }
  #cancel(id: CodexAppServerId): void {
    const pending = this.#take(id);
    pending?.reject(error("request-cancelled"));
  }
  #take(id: CodexAppServerId): Pending | undefined {
    const pending = this.#pending.get(id);
    if (pending === undefined) return undefined;
    this.#pending.delete(id);
    this.#scheduler.clearTimeout(pending.timer);
    if (pending.abort !== undefined) pending.signal?.removeEventListener("abort", pending.abort);
    return pending;
  }
  #dequeue(frameBytes: number): void {
    this.#queuedBytes = Math.max(0, this.#queuedBytes - frameBytes);
  }
  #completeToolRequest(id: CodexAppServerId): void {
    if (!this.#admittedToolRequests.has(id) && !this.#settlingToolRequests.has(id)) return;
    this.#settlingToolRequests.delete(id);
    this.#admittedToolRequests.delete(id);
    this.#recentCompletedToolRequests.add(id);
    this.#recentCompletedToolRequestOrder.push(id);
    if (this.#recentCompletedToolRequestOrder.length <= MAX_RECENT_COMPLETED_TOOL_REQUESTS) return;
    const oldest = this.#recentCompletedToolRequestOrder.shift();
    if (oldest !== undefined) this.#recentCompletedToolRequests.delete(oldest);
  }
  // eslint-disable-next-line complexity -- response, notification, and server-request envelopes fail closed independently.
  #receive(chunk: string): void {
    if (this.#closed) return;
    const parsed = this.#decoder.push(chunk);
    if (!parsed.ok) {
      this.#fail("protocol-invalid");
      return;
    }
    for (const message of parsed.value) {
      const isResponse =
        Object.prototype.hasOwnProperty.call(message, "id") &&
        (Object.prototype.hasOwnProperty.call(message, "result") ||
          Object.prototype.hasOwnProperty.call(message, "error"));
      if (isResponse) {
        if (!this.#response(message)) {
          this.#fail("protocol-invalid");
          return;
        }
      } else {
        const projection = projectCodexAppServerMessage(message);
        if (!projection.ok) {
          this.#fail("protocol-invalid");
          return;
        }
        if (projection.value === undefined) continue;
        if (projection.value.kind === "tool-call") {
          if (
            this.#admittedToolRequests.has(projection.value.id) ||
            this.#recentCompletedToolRequests.has(projection.value.id) ||
            this.#admittedToolRequests.size >= DEFAULT_MAX_PENDING
          ) {
            this.#fail("protocol-invalid");
            return;
          }
          this.#admittedToolRequests.add(projection.value.id);
        }
        this.#onProjection?.(projection.value);
      }
    }
  }
  #response(message: Readonly<Record<string, unknown>>): boolean {
    const id = message.id;
    if (!validId(id)) return false;
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");
    if (hasResult === hasError || Object.keys(message).length !== 2) return false;
    const pending = this.#take(id);
    if (pending === undefined) return false;
    if (hasError) {
      pending.reject(error("transport-failed"));
      return true;
    }
    const projected = projectCodexAppServerResponse(pending.method, message.result);
    if (!projected.ok) {
      pending.reject(error("transport-failed"));
      return false;
    }
    pending.resolve(projected.value);
    return true;
  }
  #fail(failureCode?: CodexAppServerClientFailureCode): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const id of [...this.#pending.keys()]) {
      this.#take(id)?.reject(error("transport-failed"));
    }
    this.#admittedToolRequests.clear();
    this.#settlingToolRequests.clear();
    this.#recentCompletedToolRequests.clear();
    this.#recentCompletedToolRequestOrder.length = 0;
    this.#queuedBytes = 0;
    if (failureCode !== undefined) {
      try {
        this.#onFailure?.(failureCode);
      } catch {
        // Observer failures must not escape the already-closed protocol boundary.
      }
    }
  }
}

function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return typeof value === "object" && typeof value.then === "function";
}
function validId(value: unknown): value is CodexAppServerId {
  return (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}
function error(code: CodexAppServerClientErrorCode): CodexAppServerClientError {
  return new CodexAppServerClientError(code);
}
function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
