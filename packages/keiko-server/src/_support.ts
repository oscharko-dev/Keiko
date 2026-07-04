// Shared HTTP req/res test builders for the BFF server suites (GEN-DX-002).
//
// Before this helper, every keiko-server route test hand-rolled its own `as unknown as
// ServerResponse` / `as unknown as IncomingMessage` cast, and each cast captured a DIFFERENT subset
// of the http surface: some tests only needed `setHeader` into a Map (headers.test), some needed a
// real writable stream to pipe file bytes into (static.test), some needed a real Readable body the
// handler consumes via `req.on("data"/"end")` (grounded-qa-hybrid.test), and some needed an
// EventEmitter that can `emit("close")` while `writableEnded` stays false so the disconnect guard
// fires (grounded-qa-hybrid.test again).
//
// `mockRequest` and `mockResponse` are a SUPERSET of those idioms:
//   - the request is a genuine Readable-backed IncomingMessage (the body stream is real, so handlers
//     that consume it via events or `for await` behave exactly as in production);
//   - the response is a genuine PassThrough (Writable + EventEmitter), so `.pipe(res)`, `.write`,
//     `.end`, `.on("close")` / `.emit("close")` and the real `writableEnded` getter all work — while
//     `setHeader` / `writeHead` / (opt-in) `write` / `end` are captured for assertions.
//
// Capture is opt-in per-method (via the returned handle) so no test loses a method it relies on: the
// underlying stream still functions even when a test only reads captured headers.
//
// This file is excluded from the build tsconfig (see tsconfig.json `exclude: ["**/_support.ts"]`) so
// it never ships in dist/.

import { Readable, PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Options for {@link mockRequest}. All fields are optional. */
export interface MockRequestOptions {
  /** Raw request body. A string is UTF-8 encoded; omit for an empty body. */
  readonly body?: string | Buffer;
  /** HTTP method (defaults to "GET" when a body is absent, "POST" when a body is present). */
  readonly method?: string;
  /** Request URL path (defaults to "/"). */
  readonly url?: string;
  /** Request headers; keys are lower-cased to match Node's IncomingMessage.headers. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Build a genuine {@link Readable}-backed {@link IncomingMessage}. The body stream is real, so a
 * handler that consumes it via `req.on("data"/"end"/"error")` or `for await (const c of req)` sees
 * exactly the production behaviour. `method`, `url` and (lower-cased) `headers` are attached.
 */
export function mockRequest(options: MockRequestOptions = {}): IncomingMessage {
  const { body, method, url = "/", headers = {} } = options;
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  const readable = Readable.from(chunks) as unknown as IncomingMessage & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  readable.method = method ?? (body === undefined ? "GET" : "POST");
  readable.url = url;
  readable.headers = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return readable;
}

/** A single `res.writeHead(...)` invocation captured by {@link mockResponse}. */
export interface WriteHeadCall {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string | number | readonly string[]>> | undefined;
}

/** Handle returned by {@link mockResponse}: the fake response plus its captured state. */
export interface MockResponse {
  /** The fake response, typed as a real {@link ServerResponse}. */
  readonly res: ServerResponse;
  /** Current `res.statusCode` (also updated by `writeHead`). */
  readonly statusCode: () => number;
  /** Lower-cased header name → value captured from `setHeader` / `writeHead`. */
  readonly headers: Map<string, string>;
  /** Concatenated bytes written via `write` / `end` (opt-in; see {@link MockResponseOptions}). */
  readonly body: () => string;
  /** Every `writeHead(...)` invocation, in order. */
  readonly writeHeadCalls: readonly WriteHeadCall[];
}

/** Options for {@link mockResponse}. */
export interface MockResponseOptions {
  /**
   * When true, drain the underlying stream so bytes written via `write`/`end`/`pipe` are captured
   * into {@link MockResponse.body}. Default false keeps the stream flowing (via `resume`) so a
   * `createReadStream(...).pipe(res)` in the code under test never stalls on backpressure, without a
   * test having to remember to drain it.
   */
  readonly captureBody?: boolean;
}

/**
 * Build a genuine {@link PassThrough} typed as a {@link ServerResponse}. It is a real writable stream
 * (so `.pipe(res)`, `.write`, `.end` work) AND a real EventEmitter (so `.on("close")` /
 * `.emit("close")` and the real `writableEnded` getter work). `setHeader` and `writeHead` are
 * wrapped to capture headers into a Map; the underlying stream keeps functioning.
 */
export function mockResponse(options: MockResponseOptions = {}): MockResponse {
  const { captureBody = false } = options;
  const stream = new PassThrough();
  const headers = new Map<string, string>();
  const writeHeadCalls: WriteHeadCall[] = [];
  const bodyChunks: Buffer[] = [];

  const res = stream as unknown as ServerResponse;
  res.statusCode = 0;

  res.setHeader = (name: string, value: string | number | readonly string[]): ServerResponse => {
    headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
    return res;
  };

  res.writeHead = ((
    statusCode: number,
    maybeHeaders?: Record<string, string | number | readonly string[]>,
  ): ServerResponse => {
    res.statusCode = statusCode;
    if (maybeHeaders) {
      for (const [name, value] of Object.entries(maybeHeaders)) {
        headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
      }
    }
    writeHeadCalls.push({ statusCode, headers: maybeHeaders });
    return res;
  }) as ServerResponse["writeHead"];

  if (captureBody) {
    stream.on("data", (chunk: Buffer) => {
      bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
  } else {
    // Keep the writable side draining so a piped createReadStream never stalls on backpressure.
    stream.resume();
  }

  return {
    res,
    statusCode: () => res.statusCode,
    headers,
    body: () => Buffer.concat(bodyChunks).toString("utf8"),
    writeHeadCalls,
  };
}
