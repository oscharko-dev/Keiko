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
}

function attachRequestBodyListeners(req: IncomingMessage, listeners: RequestBodyListeners): void {
  req.on("data", listeners.onData);
  req.once("end", listeners.onEnd);
  req.once("error", listeners.onError);
}

function retainTerminalErrorSink(req: IncomingMessage): void {
  // The primary bounded-body failure already owns the response. A secondary stream error carries no
  // additional safe diagnostic value, but leaving it unhandled would let a malformed request crash
  // the process. Retain this body-free sink only until the request reaches a terminal stream event.
  const absorbLateError = (error: Error): void => {
    void error;
  };
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

export function readBoundedRequestBody(
  req: IncomingMessage,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onRequestError);
      signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: Error, drain = false, retainErrorSink = false): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      cleanup();
      if (retainErrorSink) retainTerminalErrorSink(req);
      reject(error);
      if (drain) req.resume();
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        rejectOnce(new RequestBodyTooLargeError(), true, true);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onAbort = (): void => {
      rejectOnce(new RequestBodyCancelledError(), true, true);
    };
    const onRequestError = (error: Error): void => {
      rejectOnce(error, false, true);
    };
    attachRequestBodyListeners(req, { onData, onEnd, onError: onRequestError });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}
