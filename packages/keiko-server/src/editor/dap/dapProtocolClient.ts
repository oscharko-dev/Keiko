import type { DebugProcessErrorCode } from "@oscharko-dev/keiko-contracts";
import { isUtf8 } from "node:buffer";
import { DapFrameRejectError, type DapByteSource } from "./dapFrameCodec.js";

export type DapRequestLane = "control" | "inspection";
export interface DapRequestOptions {
  readonly lane: DapRequestLane;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal | undefined;
}
export interface DapEvent {
  readonly seq: number;
  readonly type: "event";
  readonly event: string;
  readonly body?: unknown;
}
export type DapEventHandler = (event: DapEvent) => Promise<void> | void;
export interface DapStoppedEvent {
  readonly reason: string;
  readonly threadId: number | undefined;
  readonly allThreadsStopped: boolean;
  readonly hitBreakpointIds: readonly number[];
  readonly description?: string | undefined;
}
export type DapStoppedHandler = (event: DapStoppedEvent) => void;

export class DapProtocolError extends Error {
  public readonly code: DebugProcessErrorCode;
  public constructor(code: DebugProcessErrorCode) {
    super(code);
    this.name = "DapProtocolError";
    this.code = code;
  }
}

interface Pending {
  readonly command: string;
  readonly lane: DapRequestLane;
  readonly resolve: (body: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | undefined;
  readonly abort: () => void;
}
interface Runtime {
  readonly pending: Map<number, Pending>;
  readonly handlers: Set<DapEventHandler>;
  readonly stoppedHandlers: Set<DapStoppedHandler>;
  readonly fatalHandler: (error: DapProtocolError) => Promise<void> | void;
  readonly retired: Set<number>;
  fatalPromise: Promise<void> | undefined;
  nextSeq: number;
  lastIncomingSeq: number;
  disposed: boolean;
}
export interface DapProtocolClient {
  request<T>(command: string, args: unknown, options: DapRequestOptions): Promise<T>;
  controlRequest<T>(command: string, args: unknown, deadlineMs: number): Promise<T>;
  onEvent(handler: DapEventHandler): () => void;
  onStopped(handler: DapStoppedHandler): () => void;
  pendingCount(): number;
  dispose(): void;
}
export interface DapProtocolClientDeps {
  readonly source: DapByteSource;
  readonly sendFrame: (body: string) => void;
  readonly onFatalError?: ((error: DapProtocolError) => Promise<void> | void) | undefined;
}

const MAX_PENDING = 32;
const RESERVED_CONTROL = 4;

export function createDapProtocolClient(deps: DapProtocolClientDeps): DapProtocolClient {
  const runtime: Runtime = {
    pending: new Map(),
    handlers: new Set(),
    stoppedHandlers: new Set(),
    fatalHandler: deps.onFatalError ?? noopFatal,
    retired: new Set(),
    fatalPromise: undefined,
    nextSeq: 1,
    lastIncomingSeq: 0,
    disposed: false,
  };
  void consume(runtime, deps);
  return {
    request: <T>(command: string, args: unknown, options: DapRequestOptions): Promise<T> =>
      request<T>(runtime, deps.sendFrame, command, args, options),
    controlRequest: <T>(command: string, args: unknown, deadlineMs: number): Promise<T> =>
      request<T>(runtime, deps.sendFrame, command, args, { lane: "control", deadlineMs }),
    onEvent: (handler): (() => void) => {
      runtime.handlers.add(handler);
      return (): void => void runtime.handlers.delete(handler);
    },
    onStopped: (handler): (() => void) => {
      runtime.stoppedHandlers.add(handler);
      return (): void => void runtime.stoppedHandlers.delete(handler);
    },
    pendingCount: (): number => runtime.pending.size,
    dispose: (): void => {
      dispose(runtime);
    },
  };
}

async function request<T>(
  runtime: Runtime,
  send: (body: string) => void,
  command: string,
  args: unknown,
  options: DapRequestOptions,
): Promise<T> {
  if (runtime.disposed) return Promise.reject(new DapProtocolError("CLIENT_DISPOSED"));
  if (!hasCapacity(runtime, options.lane)) {
    return Promise.reject(new DapProtocolError("REQUEST_LIMIT"));
  }
  const seq = runtime.nextSeq++;
  let requestSequence = 0;
  const pending = new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      settleRejected(runtime, seq, "REQUEST_CANCELLED");
    };
    const timer = setTimeout(() => {
      settleRejected(runtime, seq, "REQUEST_TIMEOUT");
    }, options.deadlineMs);
    timer.unref();
    runtime.pending.set(seq, {
      command,
      lane: options.lane,
      resolve: resolve as (body: unknown) => void,
      reject,
      timer,
      signal: options.signal,
      abort,
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) abort();
    requestSequence = seq;
  });
  if (options.signal?.aborted === true) return pending;
  try {
    send(JSON.stringify({ seq: requestSequence, type: "request", command, arguments: args }));
  } catch {
    settleRejected(runtime, requestSequence, "WRITE_FAILED");
    void fatal(runtime, "WRITE_FAILED");
  }
  return pending;
}

function hasCapacity(runtime: Runtime, lane: DapRequestLane): boolean {
  if (runtime.pending.size >= MAX_PENDING) return false;
  if (lane === "control") return true;
  let inspections = 0;
  for (const entry of runtime.pending.values()) if (entry.lane === "inspection") inspections += 1;
  return inspections < MAX_PENDING - RESERVED_CONTROL;
}

function clearPending(entry: Pending): void {
  clearTimeout(entry.timer);
  entry.signal?.removeEventListener("abort", entry.abort);
}

function settleRejected(runtime: Runtime, seq: number, code: DebugProcessErrorCode): void {
  const entry = runtime.pending.get(seq);
  if (entry === undefined) return;
  runtime.pending.delete(seq);
  // Stryker disable next-line ConditionalExpression: write failure immediately enters fatal dispose
  // and CLIENT_DISPOSED is terminal; only timeout/cancellation leave a live client needing a tombstone.
  if (code === "REQUEST_TIMEOUT" || code === "REQUEST_CANCELLED") retainRetired(runtime, seq);
  clearPending(entry);
  entry.reject(new DapProtocolError(code));
}

function retainRetired(runtime: Runtime, seq: number): void {
  runtime.retired.add(seq);
  if (runtime.retired.size <= 64) return;
  const oldest = runtime.retired.values().next().value;
  // Stryker disable next-line ConditionalExpression: size above the Set limit proves this iterator
  // yields one value; removing the defensive guard cannot create a distinct reachable outcome.
  if (oldest === undefined) return;
  runtime.retired.delete(oldest);
}

async function consume(runtime: Runtime, deps: DapProtocolClientDeps): Promise<void> {
  try {
    for await (const body of deps.source) await dispatch(runtime, deps.sendFrame, body);
    if (!runtime.disposed) await fatal(runtime, "UNEXPECTED_EOF");
  } catch (error: unknown) {
    await fatal(runtime, fatalCode(error));
  }
}

function fatalCode(error: unknown): DebugProcessErrorCode {
  if (error instanceof DapFrameRejectError) return error.reason;
  if (error instanceof DapProtocolError) return error.code;
  return "UNEXPECTED_EOF";
}

function parse(body: Buffer): Record<string, unknown> {
  const value = parseJson(decodeBody(body));
  if (value === null) throw new DapProtocolError("MALFORMED_MESSAGE");
  return value as Record<string, unknown>;
}

function decodeBody(body: Buffer): string {
  if (!isUtf8(body)) throw new DapProtocolError("MALFORMED_MESSAGE");
  return body.toString("utf8");
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new DapProtocolError("MALFORMED_MESSAGE");
  }
}

async function dispatch(
  runtime: Runtime,
  send: (body: string) => void,
  body: Buffer,
): Promise<void> {
  const message = parse(body);
  if (!acceptIncomingSequence(runtime, message.seq)) {
    await fatal(runtime, "MALFORMED_MESSAGE");
    return;
  }
  const valid =
    message.type === "response"
      ? settleResponse(runtime, message)
      : message.type === "event"
        ? await dispatchEvent(runtime, message)
        : message.type === "request"
          ? await rejectReverse(send, runtime, message)
          : false;
  if (!valid) await fatal(runtime, "MALFORMED_MESSAGE");
}

function acceptIncomingSequence(runtime: Runtime, value: unknown): boolean {
  if (!Number.isSafeInteger(value) || (value as number) <= runtime.lastIncomingSeq) return false;
  runtime.lastIncomingSeq = value as number;
  return true;
}

function fatal(runtime: Runtime, code: DebugProcessErrorCode): Promise<void> {
  if (runtime.fatalPromise !== undefined) return runtime.fatalPromise;
  const operation = (async (): Promise<void> => {
    try {
      await runtime.fatalHandler(new DapProtocolError(code));
    } finally {
      dispose(runtime);
    }
  })();
  runtime.fatalPromise = operation;
  return operation;
}

function noopFatal(): void {
  // The closed protocol state is still disposed in fatal() when no observer is installed.
}

function settleResponse(runtime: Runtime, message: Record<string, unknown>): boolean {
  const requestSeq = message.request_seq;
  if (
    !Number.isSafeInteger(requestSeq) ||
    typeof message.success !== "boolean" ||
    typeof message.command !== "string"
  )
    return false;
  const entry = runtime.pending.get(requestSeq as number);
  if (entry === undefined) return runtime.retired.delete(requestSeq as number);
  if (message.command !== entry.command) return false;
  runtime.pending.delete(requestSeq as number);
  clearPending(entry);
  if (message.success) entry.resolve(message.body);
  else entry.reject(new DapProtocolError("ADAPTER_REJECTED"));
  return true;
}

async function dispatchEvent(runtime: Runtime, message: Record<string, unknown>): Promise<boolean> {
  if (typeof message.event !== "string") return false;
  const event: DapEvent = {
    seq: message.seq as number,
    type: "event",
    event: message.event,
    ...(message.body === undefined ? {} : { body: message.body }),
  };
  const stopped = parseStopped(event);
  if (event.event === "stopped" && stopped === null) return false;
  for (const handler of runtime.handlers) await handler(event);
  if (stopped !== null) {
    for (const handler of runtime.stoppedHandlers) handler(stopped);
  }
  return true;
}

function parseStopped(event: DapEvent): DapStoppedEvent | null {
  if (event.event !== "stopped") return null;
  // Stryker disable next-line ConditionalExpression: absent and null stopped bodies both reach
  // the same closed MALFORMED_MESSAGE classification through the decoder boundary.
  if (event.body === undefined || event.body === null) return null;
  const body = event.body as Record<string, unknown>;
  if (typeof body.reason !== "string") return null;
  const context = stoppedContext(body);
  if (context === undefined) return null;
  const hitBreakpointIds = positiveIntegerArray(body.hitBreakpointIds);
  if (hitBreakpointIds === undefined) return null;
  const description = stoppedDescription(body);
  if (description === null) return null;
  return {
    reason: body.reason,
    ...context,
    hitBreakpointIds,
    ...(description === undefined ? {} : { description }),
  };
}

function stoppedDescription(body: Readonly<Record<string, unknown>>): string | undefined | null {
  const description = optionalString(body.description);
  return body.description !== undefined && description === undefined ? null : description;
}

function stoppedContext(
  body: Readonly<Record<string, unknown>>,
): Pick<DapStoppedEvent, "threadId" | "allThreadsStopped"> | undefined {
  const threadId = positiveOptionalInteger(body.threadId);
  if (body.threadId !== undefined && threadId === undefined) return undefined;
  const allThreadsStopped = body.allThreadsStopped === true;
  return allThreadsStopped || threadId !== undefined ? { threadId, allThreadsStopped } : undefined;
}

function positiveOptionalInteger(value: unknown): number | undefined {
  // Stryker disable next-line ConditionalExpression: Number.isSafeInteger rejects every non-number;
  // the typeof check narrows value for TypeScript without changing the accepted input set.
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function positiveIntegerArray(value: unknown): readonly number[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => positiveOptionalInteger(entry) !== undefined)
    ? (value as readonly number[])
    : undefined;
}

function rejectReverse(
  send: (body: string) => void,
  runtime: Runtime,
  message: Record<string, unknown>,
): Promise<boolean> {
  if (!Number.isSafeInteger(message.seq) || typeof message.command !== "string") {
    return Promise.resolve(false);
  }
  try {
    send(
      JSON.stringify({
        seq: runtime.nextSeq++,
        type: "response",
        request_seq: message.seq,
        success: false,
        command: message.command,
        message: "REVERSE_REQUEST_DENIED",
      }),
    );
  } catch {
    void fatal(runtime, "WRITE_FAILED");
  }
  return Promise.resolve(true);
}

function dispose(runtime: Runtime): void {
  runtime.disposed = true;
  for (const seq of [...runtime.pending.keys()]) settleRejected(runtime, seq, "CLIENT_DISPOSED");
  runtime.handlers.clear();
  runtime.stoppedHandlers.clear();
  runtime.retired.clear();
}
