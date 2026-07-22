import type { IncomingMessage } from "node:http";

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

class BoundedRequestBodyReader {
  private readonly chunks: Buffer[] = [];
  private total = 0;
  private settled = false;

  public constructor(
    private readonly req: IncomingMessage,
    private readonly maxBytes: number,
    private readonly signal: AbortSignal | undefined,
    private readonly resolve: (body: string) => void,
    private readonly reject: (error: Error) => void,
  ) {}

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
      this.rejectOnce(new RequestBodyTooLargeError(), true, true);
      return;
    }
    this.chunks.push(buffer);
  };

  private readonly onEnd = (): void => {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.resolve(Buffer.concat(this.chunks).toString("utf8"));
  };

  private readonly onCancellation = (): void => {
    this.rejectOnce(new RequestBodyCancelledError(), true, true);
  };

  private readonly onRequestError = (error: Error): void => {
    this.rejectOnce(error, false, true);
  };
}

export function readBoundedRequestBody(
  req: IncomingMessage,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    new BoundedRequestBodyReader(req, maxBytes, signal, resolve, reject).start();
  });
}
