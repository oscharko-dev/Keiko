import type { IncomingMessage } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readBoundedRequestBody,
  RequestBodyCancelledError,
  RequestBodyTooLargeError,
} from "./bounded-request-body.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
  type ServerLogThreshold,
} from "./observability/index.js";

function asRequest(stream: PassThrough | Readable): IncomingMessage {
  return stream as unknown as IncomingMessage;
}

function expectNoBodyListeners(req: IncomingMessage): void {
  expect(req.listenerCount("data")).toBe(0);
  expect(req.listenerCount("end")).toBe(0);
  expect(req.listenerCount("error")).toBe(0);
  expect(req.listenerCount("aborted")).toBe(0);
  expect(req.listenerCount("close")).toBe(0);
}

function expectTerminalErrorSink(req: IncomingMessage): void {
  expect(req.listenerCount("data")).toBe(0);
  expect(req.listenerCount("end")).toBe(1);
  expect(req.listenerCount("error")).toBe(1);
  expect(req.listenerCount("aborted")).toBe(0);
  expect(req.listenerCount("close")).toBe(1);
}

// Installs a buffered process logger at `level` and returns its sink. `resetServerLogger` in
// `afterEach` puts the process-wide slot back so no suite shares it.
function captureServerLog(level: ServerLogThreshold): BufferedServerLogSink {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level }));
  return sink;
}

async function rejectionAfterMicrotask(outcome: Promise<string>): Promise<unknown> {
  const observed = outcome.then<unknown, unknown>(
    () => undefined,
    (error: unknown) => error,
  );
  const stillPending = Promise.resolve().then((): undefined => undefined);
  return Promise.race([observed, stillPending]);
}

describe("bounded request body", () => {
  it("reads a bounded body and releases every owned listener", async () => {
    const req = asRequest(Readable.from([Buffer.from("hello")]));

    await expect(readBoundedRequestBody(req, 5)).resolves.toBe("hello");

    expectNoBodyListeners(req);
  });

  it("settles an aborted signal, drains the body, and absorbs one late request error", async () => {
    const stream = new PassThrough();
    const req = asRequest(stream);
    const controller = new AbortController();
    const removeAbortListener = vi.spyOn(controller.signal, "removeEventListener");
    const resume = vi.spyOn(req, "resume");
    const outcome = readBoundedRequestBody(req, 128_000, controller.signal);
    const resumeCallsBeforeBody = resume.mock.calls.length;
    stream.write(Buffer.from('{"content":"partial'));

    controller.abort("client disconnected");

    await expect(outcome).rejects.toBeInstanceOf(RequestBodyCancelledError);
    expect(resume).toHaveBeenCalledTimes(resumeCallsBeforeBody + 1);
    expectTerminalErrorSink(req);
    expect(() => stream.emit("error", new Error("late request failure"))).not.toThrow();
    expectTerminalErrorSink(req);
    const ended = new Promise<void>((resolve) => {
      stream.once("end", resolve);
    });
    stream.end();
    await ended;
    expectNoBodyListeners(req);
    expect(removeAbortListener).toHaveBeenCalledOnce();
  });

  it("rejects an aborted request without an external signal and absorbs a late error", async () => {
    const stream = new PassThrough();
    const req = asRequest(stream);
    const resume = vi.spyOn(req, "resume");
    const outcome = readBoundedRequestBody(req, 128_000);
    const resumeCallsBeforeBody = resume.mock.calls.length;
    stream.write(Buffer.from('{"content":"partial'));

    stream.emit("aborted");

    expect(await rejectionAfterMicrotask(outcome)).toBeInstanceOf(RequestBodyCancelledError);
    expect(resume).toHaveBeenCalledTimes(resumeCallsBeforeBody + 1);
    expectTerminalErrorSink(req);
    expect(() => stream.emit("error", new Error("late request failure"))).not.toThrow();
    expectTerminalErrorSink(req);
    stream.emit("close");
    expectNoBodyListeners(req);
  });

  it("rejects a request that closes before its body ends and releases every listener", async () => {
    const stream = new PassThrough();
    const req = asRequest(stream);
    const outcome = readBoundedRequestBody(req, 128_000);
    const closed = new Promise<void>((resolve) => {
      stream.once("close", resolve);
    });
    stream.write(Buffer.from('{"content":"partial'));

    stream.destroy();
    await closed;

    expect(await rejectionAfterMicrotask(outcome)).toBeInstanceOf(RequestBodyCancelledError);
    expectNoBodyListeners(req);
  });

  it("rejects and drains an oversized body while absorbing one late request error", async () => {
    const stream = new PassThrough();
    const req = asRequest(stream);
    const resume = vi.spyOn(req, "resume");
    const outcome = readBoundedRequestBody(req, 4);
    const resumeCallsBeforeBody = resume.mock.calls.length;

    stream.write(Buffer.from("12345"));

    await expect(outcome).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(resume).toHaveBeenCalledTimes(resumeCallsBeforeBody + 1);
    expectTerminalErrorSink(req);
    expect(() => stream.emit("error", new Error("late request failure"))).not.toThrow();
    expectTerminalErrorSink(req);
    const ended = new Promise<void>((resolve) => {
      stream.once("end", resolve);
    });
    stream.end();
    await ended;
    expectNoBodyListeners(req);
  });

  it("retains the terminal sink after the primary request error until close", async () => {
    const stream = new PassThrough();
    const req = asRequest(stream);
    const primaryError = new Error("primary request failure");
    const outcome = readBoundedRequestBody(req, 128_000);

    stream.emit("error", primaryError);

    await expect(outcome).rejects.toBe(primaryError);
    expectTerminalErrorSink(req);
    expect(() => stream.emit("error", new Error("secondary request failure"))).not.toThrow();
    expectTerminalErrorSink(req);
    const closed = new Promise<void>((resolve) => {
      stream.once("close", resolve);
    });
    stream.destroy();
    await closed;
    expectNoBodyListeners(req);
  });

  it("releases the terminal error sink when an already-aborted stream closes", async () => {
    const stream = new PassThrough();
    const req = asRequest(stream);
    const controller = new AbortController();
    controller.abort("already disconnected");

    await expect(readBoundedRequestBody(req, 128_000, controller.signal)).rejects.toBeInstanceOf(
      RequestBodyCancelledError,
    );

    expectTerminalErrorSink(req);
    const closed = new Promise<void>((resolve) => {
      stream.once("close", resolve);
    });
    stream.destroy();
    await closed;
    expectNoBodyListeners(req);
  });

  it("retains the terminal sink while a destroyed request still has a pending error", async () => {
    const stream = new PassThrough();
    const req = asRequest(stream);
    Object.defineProperty(req, "destroyed", { configurable: true, value: true });
    Object.defineProperty(req, "closed", { configurable: true, value: false });

    const outcome = readBoundedRequestBody(req, 128_000);

    expect(await rejectionAfterMicrotask(outcome)).toBeInstanceOf(RequestBodyCancelledError);
    expectTerminalErrorSink(req);
    expect(() => stream.emit("error", new Error("pending destroy failure"))).not.toThrow();
    stream.emit("close");
    expectNoBodyListeners(req);
  });

  it("rejects an already aborted readable before receiving body data", async () => {
    const stream = new PassThrough();
    const req = asRequest(stream);
    Object.defineProperty(req, "readableAborted", { configurable: true, value: true });

    const outcome = readBoundedRequestBody(req, 128_000);

    expect(await rejectionAfterMicrotask(outcome)).toBeInstanceOf(RequestBodyCancelledError);
    expectTerminalErrorSink(req);
    stream.emit("close");
    expectNoBodyListeners(req);
  });
});

// The bounded reader is the server's size fail-closed. Its rejection is mapped to a 413 several
// layers up, so the log line is the only place the limit and the observed size appear together.
describe("bounded request body activity log", () => {
  afterEach(() => {
    resetServerLogger();
  });

  it("logs the fail-closed rejection with the limit, the observed bytes and the correlation id", async () => {
    const sink = captureServerLog("info");
    const stream = new PassThrough();
    const req = asRequest(stream);
    const outcome = readBoundedRequestBody(req, 4, undefined, "req-correlation-01");

    stream.write(Buffer.from("12345"));

    await expect(outcome).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(sink.events).toEqual([
      {
        level: "warn",
        category: "http",
        op: "http.request.body.rejected",
        correlationId: "req-correlation-01",
        durationMs: undefined,
        status: undefined,
        errorKind: "RequestBodyTooLargeError",
        extra: { maxBytes: 4, receivedBytes: 5, reason: "limit-exceeded" },
      },
    ]);
    stream.end();
  });

  it("omits the correlation id when the caller could not supply one", async () => {
    const sink = captureServerLog("info");
    const stream = new PassThrough();
    const outcome = readBoundedRequestBody(asRequest(stream), 2);

    stream.write(Buffer.from("abc"));

    await expect(outcome).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(sink.events[0]?.correlationId).toBeUndefined();
    expect(sink.events[0]?.op).toBe("http.request.body.rejected");
    stream.end();
  });

  it("classifies a stream failure without reading its message", async () => {
    const sink = captureServerLog("info");
    const stream = new PassThrough();
    const failure = Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
    const outcome = readBoundedRequestBody(asRequest(stream), 128_000, undefined, "req-corr-02");

    stream.emit("error", failure);

    await expect(outcome).rejects.toBe(failure);
    const [event] = sink.events;
    expect(event?.op).toBe("http.request.body.failed");
    expect(event?.level).toBe("warn");
    expect(event?.errorKind).toBe("ECONNRESET");
    expect(JSON.stringify(sink.events)).not.toContain("connection reset");
    stream.destroy();
  });

  it("keeps a client disconnect at debug so a busy server does not warn on every abort", async () => {
    const atInfo = captureServerLog("info");
    const controller = new AbortController();
    controller.abort("client disconnected");

    await expect(
      readBoundedRequestBody(asRequest(new PassThrough()), 128_000, controller.signal, "req-c-03"),
    ).rejects.toBeInstanceOf(RequestBodyCancelledError);

    expect(atInfo.events).toEqual([]);

    const atDebug = captureServerLog("debug");
    const second = new AbortController();
    second.abort("client disconnected");

    await expect(
      readBoundedRequestBody(asRequest(new PassThrough()), 128_000, second.signal, "req-c-03"),
    ).rejects.toBeInstanceOf(RequestBodyCancelledError);

    expect(atDebug.events).toEqual([
      {
        level: "debug",
        category: "http",
        op: "http.request.body.cancelled",
        correlationId: "req-c-03",
        durationMs: undefined,
        status: undefined,
        errorKind: "RequestBodyCancelledError",
        extra: { maxBytes: 128_000, receivedBytes: 0 },
      },
    ]);
  });

  it("writes nothing at info when the body stays inside the limit", async () => {
    const sink = captureServerLog("info");

    await expect(
      readBoundedRequestBody(asRequest(Readable.from([Buffer.from("hello")])), 5),
    ).resolves.toBe("hello");

    expect(sink.events).toEqual([]);
  });

  it("logs one debug success line with the reduced media type and byte count", async () => {
    const sink = captureServerLog("debug");
    const stream = new PassThrough();
    const req = asRequest(stream);
    Object.defineProperty(req, "headers", {
      configurable: true,
      value: { "content-type": "application/json; charset=utf-8" },
    });
    const outcome = readBoundedRequestBody(req, 128_000, undefined, "req-ok-01");

    stream.end(Buffer.from("hello"));

    await expect(outcome).resolves.toBe("hello");
    expect(sink.events).toEqual([
      {
        level: "debug",
        category: "http",
        op: "http.request.body.received",
        correlationId: "req-ok-01",
        durationMs: undefined,
        status: undefined,
        errorKind: undefined,
        extra: { contentType: "application/json", receivedBytes: 5 },
      },
    ]);
  });

  it("falls back to the closed 'unspecified' label when no Content-Type header was sent", async () => {
    const sink = captureServerLog("debug");
    const req = asRequest(Readable.from([Buffer.from("hi")]));
    Object.defineProperty(req, "headers", { configurable: true, value: {} });

    await expect(readBoundedRequestBody(req, 128_000)).resolves.toBe("hi");

    expect(sink.events[0]?.extra).toEqual({ contentType: "unspecified", receivedBytes: 2 });
  });

  it("logs one rejection even when a late data event arrives after the read settled", async () => {
    const sink = captureServerLog("info");
    const stream = new PassThrough();
    const req = asRequest(stream);
    const outcome = readBoundedRequestBody(req, 1);

    stream.write(Buffer.from("ab"));
    await expect(outcome).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    // The reader detached its own listener, so re-entering it is the only way to reach the settled
    // branch: a duplicate line here would double-count the rejection in every operator query.
    req.emit("data", Buffer.from("cd"));

    expect(sink.events).toHaveLength(1);
    stream.end();
  });
});
