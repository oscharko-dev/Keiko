import type { IncomingMessage } from "node:http";

import { errorKindOf, getServerLogger } from "./observability/index.js";

// A raw Node header value: absent, a single value, or (for a repeated header) several. Shared by
// every helper below that reads `Content-Type` off a request, so the union is spelled once.
type ContentTypeHeaderValue = string | string[] | undefined;

export class RequestBodyTooLargeError extends Error {
  public constructor() {
    super("request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

export class RequestBodyCancelledError extends Error {
  public constructor() {
    super("request body cancelled");
    this.name = "RequestBodyCancelledError";
  }
}

interface RequestBodyListeners {
  readonly onData: (chunk: Buffer | string) => void;
  readonly onEnd: () => void;
  readonly onError: (error: Error) => void;
  readonly onAborted: () => void;
  readonly onClose: () => void;
}

function attachRequestBodyListeners(req: IncomingMessage, listeners: RequestBodyListeners): void {
  req.once("end", listeners.onEnd);
  req.once("error", listeners.onError);
  req.once("aborted", listeners.onAborted);
  req.once("close", listeners.onClose);
  req.on("data", listeners.onData);
}

function retainTerminalErrorSink(req: IncomingMessage): void {
  // The primary bounded-body failure already owns the response. A secondary stream error carries no
  // additional safe diagnostic value, but leaving it unhandled would let a malformed request crash
  // the process. Retain this body-free sink only until the request reaches a terminal stream event.
  const absorbLateError = (): void => undefined;
  const release = (): void => {
    req.off("end", release);
    req.off("close", release);
    req.off("error", absorbLateError);
  };
  req.once("end", release);
  req.once("close", release);
  req.on("error", absorbLateError);
  // `destroyed` becomes true before a destroy(error) emits its queued `error`; releasing on that
  // flag re-opens a process-crash race. `closed` is the terminal event boundary after which Node
  // will not emit another stream error for this request.
  if (req.closed) release();
}

function requestAlreadyTerminated(req: IncomingMessage): boolean {
  return req.readableAborted || req.destroyed || req.closed;
}

// The three outcomes this reader can reach, as an operator sees them. Only counts and a
// classification cross the boundary: `receivedBytes` is the number of bytes observed before the
// decision, never a byte of the body itself, and the error is reduced through `errorKindOf`, which
// reads `code`/`name` and never a message.
interface BoundedBodyOutcomeFields {
  readonly maxBytes: number;
  readonly receivedBytes: number;
}

function logBodyRejected(
  correlationId: string | undefined,
  fields: BoundedBodyOutcomeFields,
): void {
  getServerLogger().warn({
    category: "http",
    op: "http.request.body.rejected",
    ...(correlationId === undefined ? {} : { correlationId }),
    errorKind: "RequestBodyTooLargeError",
    extra: { ...fields, reason: "limit-exceeded" },
  });
}

function logBodyCancelled(
  correlationId: string | undefined,
  fields: BoundedBodyOutcomeFields,
): void {
  // A client that disconnects mid-upload is routine, not a fault: it stays at debug so a busy
  // server does not fill the log with it, while still being available when a stall is investigated.
  getServerLogger().debug(() => ({
    category: "http" as const,
    op: "http.request.body.cancelled",
    ...(correlationId === undefined ? {} : { correlationId }),
    errorKind: "RequestBodyCancelledError",
    extra: { ...fields },
  }));
}

function logBodyFailed(
  correlationId: string | undefined,
  fields: BoundedBodyOutcomeFields,
  error: unknown,
): void {
  getServerLogger().warn({
    category: "http",
    op: "http.request.body.failed",
    ...(correlationId === undefined ? {} : { correlationId }),
    errorKind: errorKindOf(error),
    extra: { ...fields },
  });
}

// `IncomingMessage.headers` is typed as always present, but several test doubles across the
// codebase construct a stream cast to `IncomingMessage` without setting it — read defensively so a
// caller that never populated it does not crash the very read it is trying to observe.
function safeContentTypeHeader(req: IncomingMessage): ContentTypeHeaderValue {
  const headers = req as { headers?: IncomingMessage["headers"] };
  return headers.headers?.["content-type"];
}

// Every media type this server's body readers are ever legitimately reached with: `server.ts`'s
// `isJsonRequest` gate already rejects any state-changing request whose Content-Type is not
// exactly `application/json` with a 415 before a handler can read its body. Allowlisted rather
// than left open, because stripping `; charset=...` parameters does not make an arbitrary
// subtype safe to log — a client fully controls the whole header and can place sensitive data in
// a syntactically valid subtype (e.g. `Content-Type: application/<secret>`) that never reaches
// this gate at all.
const KNOWN_REQUEST_MEDIA_TYPES = new Set<string>(["application/json"]);

// Reduces a `Content-Type` header to its media type, discarding parameters (`; charset=utf-8`,
// `; boundary=...`) that can carry caller-chosen, unbounded text, then maps it through the
// allowlist above. A subtype this reader has no reason to ever see collapses to the fixed label
// `"other"` rather than being retained verbatim in the diagnostic sink.
function mediaTypeOf(header: ContentTypeHeaderValue): string {
  const value = typeof header === "string" ? header : header?.[0];
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === undefined || mediaType.length === 0) return "unspecified";
  return KNOWN_REQUEST_MEDIA_TYPES.has(mediaType) ? mediaType : "other";
}

// The one success line this reader emits, at debug: per-request volume makes it unfit for info,
// but it is what closes the loop for `keiko log:analyze` — the rejected/cancelled/failed paths
// above already say what went wrong; this says what a body that just worked actually looked like.
function logBodyReceived(
  correlationId: string | undefined,
  contentType: ContentTypeHeaderValue,
  receivedBytes: number,
): void {
  getServerLogger().debug(() => ({
    category: "http" as const,
    op: "http.request.body.received",
    ...(correlationId === undefined ? {} : { correlationId }),
    extra: { contentType: mediaTypeOf(contentType), receivedBytes },
  }));
}

class BoundedRequestBodyReader {
  private readonly chunks: Buffer[] = [];
  private total = 0;
  private settled = false;

  public constructor(
    private readonly req: IncomingMessage,
    private readonly maxBytes: number,
    private readonly signal: AbortSignal | undefined,
    private readonly correlationId: string | undefined,
    private readonly resolve: (body: string) => void,
    private readonly reject: (error: Error) => void,
  ) {}

  private get outcomeFields(): BoundedBodyOutcomeFields {
    return { maxBytes: this.maxBytes, receivedBytes: this.total };
  }

  public start(): void {
    this.signal?.addEventListener("abort", this.onCancellation, { once: true });
    attachRequestBodyListeners(this.req, {
      onData: this.onData,
      onEnd: this.onEnd,
      onError: this.onRequestError,
      onAborted: this.onCancellation,
      onClose: this.onCancellation,
    });
    if (this.signal?.aborted === true || requestAlreadyTerminated(this.req)) this.onCancellation();
  }

  private readonly cleanup = (): void => {
    this.req.off("data", this.onData);
    this.req.off("end", this.onEnd);
    this.req.off("error", this.onRequestError);
    this.req.off("aborted", this.onCancellation);
    this.req.off("close", this.onCancellation);
    this.signal?.removeEventListener("abort", this.onCancellation);
  };

  private readonly rejectOnce = (error: Error, drain: boolean, retainErrorSink: boolean): void => {
    if (this.settled) return;
    this.settled = true;
    this.chunks.length = 0;
    this.cleanup();
    if (retainErrorSink) retainTerminalErrorSink(this.req);
    this.reject(error);
    if (drain) this.req.resume();
  };

  private readonly onData = (chunk: Buffer | string): void => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.total += buffer.length;
    if (this.total > this.maxBytes) {
      // Fail closed on the size boundary. The line is emitted before `rejectOnce` clears the
      // accumulated chunks so `receivedBytes` still reports what was actually observed, and only
      // when this call is the one that settles the read — a late queued event must not log twice.
      if (!this.settled) logBodyRejected(this.correlationId, this.outcomeFields);
      this.rejectOnce(new RequestBodyTooLargeError(), true, true);
      return;
    }
    this.chunks.push(buffer);
  };

  private readonly onEnd = (): void => {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    logBodyReceived(this.correlationId, safeContentTypeHeader(this.req), this.total);
    this.resolve(Buffer.concat(this.chunks).toString("utf8"));
  };

  private readonly onCancellation = (): void => {
    if (!this.settled) logBodyCancelled(this.correlationId, this.outcomeFields);
    this.rejectOnce(new RequestBodyCancelledError(), true, true);
  };

  private readonly onRequestError = (error: Error): void => {
    if (!this.settled) logBodyFailed(this.correlationId, this.outcomeFields, error);
    this.rejectOnce(error, false, true);
  };
}

export function readBoundedRequestBody(
  req: IncomingMessage,
  maxBytes: number,
  signal?: AbortSignal,
  // RB-6 continuity: when the caller already holds the request-scoped correlation id, the
  // fail-closed rejection below is traceable to the same request as the 4xx the caller returns.
  // Optional because most callers read the body from a helper that never received the RouteContext.
  correlationId?: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    new BoundedRequestBodyReader(req, maxBytes, signal, correlationId, resolve, reject).start();
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// #2902 audit finding 3: memory-handlers.ts, memory-conv-handlers.ts and memory-consolidation-
// handlers.ts each hand-rolled a byte-identical "read a bounded body, then parse+validate it as a
// JSON object" wrapper on top of `readBoundedRequestBody` — differing only in a catch-variable
// name and which (identically-valued, 64_000) max-bytes constant they read. This is the ONE owner
// for that wrapper layer; callers keep their own max-bytes constant (there is no reason to force
// them to share one, only the logic), pass it in, and get back either the parsed JSON object or the
// RouteResult (413/400) their handler should return as-is.
export async function readJsonRequestBody(
  req: IncomingMessage,
  maxBytes: number,
  correlationId?: string,
): Promise<Record<string, unknown> | { readonly status: number; readonly body: unknown }> {
  let raw: string;
  try {
    raw = await readBoundedRequestBody(req, maxBytes, undefined, correlationId);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return {
        status: 413,
        body: { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large." } },
      };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return {
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "Request body is not valid JSON." } },
    };
  }
  if (!isPlainRecord(parsed)) {
    return {
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "Request body must be a JSON object." } },
    };
  }
  return parsed;
}
