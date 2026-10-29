import {
  createEmittingSseResponseObservation,
  createSseResponseObservation,
} from "../../../tests/support/sse-subscription-observations.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter, getEventListeners } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  openPlainNamespacedSseStream,
  SSE_HEARTBEAT_INTERVAL_MS,
  attachSseSubscription,
  SSE_HEADERS,
  startSseHeartbeat,
  writeReadyMessage,
  writeNamespacedSseEvent,
} from "./sse.js";
import { SSE_STALLED_READER_TIMEOUT_MS } from "./sse-write.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";

describe("SSE_HEADERS", () => {
  it("disables intermediary buffering for low-latency event delivery", () => {
    expect(SSE_HEADERS).toMatchObject({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  });
});

describe("startSseHeartbeat process-liveness", () => {
  it("unrefs the heartbeat interval so it never keeps the process alive", () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(timer);
    const clearIntervalSpy = vi
      .spyOn(globalThis, "clearInterval")
      .mockImplementation(() => undefined);
    try {
      const listeners = new Map<string, () => void>();
      const res = {
        destroyed: false,
        writableEnded: false,
        write: vi.fn(),
        on: (event: string, handler: () => void) => {
          listeners.set(event, handler);
        },
      } as unknown as import("node:http").ServerResponse;

      const stop = startSseHeartbeat(res);
      // The fix: the interval is unref'd at creation (voice-realtime pattern), so
      // an open SSE stream cannot pin the event loop between heartbeat ticks.
      expect(unref).toHaveBeenCalledTimes(1);

      stop();
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
      expect(listeners.has("close")).toBe(true);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("keeps a buffered heartbeat stream open and destroys it only when the reader stalls", async () => {
    vi.useFakeTimers();
    try {
      const destroy = vi.fn();
      const write = vi.fn(() => false);
      const res = Object.assign(new EventEmitter(), {
        destroyed: false,
        writableEnded: false,
        write,
        destroy,
      }) as unknown as import("node:http").ServerResponse;
      const stop = startSseHeartbeat(res, 10);
      await vi.advanceTimersByTimeAsync(10);
      expect(write).toHaveBeenCalledWith(": keep-alive\n\n");
      expect(destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(SSE_STALLED_READER_TIMEOUT_MS);
      expect(destroy).toHaveBeenCalledOnce();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses comment-only heartbeats by default", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(() => true);
      const res = {
        destroyed: false,
        writableEnded: false,
        write,
        destroy: vi.fn(),
        on: vi.fn(),
      } as unknown as import("node:http").ServerResponse;
      const stop = startSseHeartbeat(res, 10);

      await vi.advanceTimersByTimeAsync(10);

      expect(write).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledWith(": keep-alive\n\n");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits an opt-in observable heartbeat event for browser EventSource clients", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(() => true);
      const res = {
        destroyed: false,
        writableEnded: false,
        write,
        destroy: vi.fn(),
        on: vi.fn(),
      } as unknown as import("node:http").ServerResponse;
      const stop = startSseHeartbeat(res, 10, "heartbeat");

      await vi.advanceTimersByTimeAsync(10);

      expect(write).toHaveBeenNthCalledWith(1, ": keep-alive\n\n");
      expect(write).toHaveBeenNthCalledWith(2, "event: heartbeat\ndata: {}\n\n");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// #3452 audit finding sse.ts:108: several openers wrote the ready frame with a bare `res.write`,
// bypassing `recordSseStreamFrame` entirely. `sseStreamState` (sse-write.ts) attaches its terminal
// `close` listener lazily, on the FIRST recorded frame — a stream whose only write is the ready
// frame before it closes therefore never created that state at all, and never produced a terminal
// `sse.stream.closed` line: an operator could not even tell the attempt happened.
describe("writeReadyMessage (#3452 audit finding sse.ts:108)", () => {
  afterEach(() => {
    resetServerLogger();
  });

  function listenableFakeRes(): {
    res: import("node:http").ServerResponse;
    write: ReturnType<typeof vi.fn>;
    fireClose: () => void;
  } {
    const listeners = new Map<string, () => void>();
    const write = vi.fn().mockReturnValue(true);
    const res = {
      writableEnded: false,
      write,
      destroy: vi.fn(),
      on: (event: string, handler: () => void) => {
        listeners.set(event, handler);
      },
    } as unknown as import("node:http").ServerResponse;
    return { res, write, fireClose: () => listeners.get("close")?.() };
  }

  it("records the ready frame so a stream that closes right after it still gets a terminal sse.stream.closed line, carrying the supplied correlation id", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const { res, write, fireClose } = listenableFakeRes();

    const accepted = writeReadyMessage(res, "corr-ready-1");
    fireClose();

    expect(accepted).toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith("event: ready\ndata: {}\n\n");
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      category: "http",
      op: "sse.stream.closed",
      correlationId: "corr-ready-1",
      extra: { frameCount: 1, reason: "client-disconnected" },
    });
  });
});

// #3452 audit finding sse.ts:108 (pin): every SSE opener in this package must send its ready frame
// through `writeReadyMessage`, never a bare `res.write(readyMessage())`. `recordSseStreamFrame`
// (sse-write.ts) attaches a stream's frame/byte counters and its terminal `close` listener lazily,
// on the FIRST recorded frame — a bare write skips that call entirely, so a stream that opens, sends
// only `ready`, and closes before its first real event or heartbeat tick never creates that state
// at all and is invisible to the terminal `sse.stream.closed` line: no frame count, no duration, no
// correlation id. The owning-layer helper already exists (this file); a bare write is a regression,
// not a missing feature (AGENTS.md §8 Rule 1 — every change ships its own body-free evidence, built
// through the owning layer's existing port, never a parallel path). This pin is static rather than
// behavioural because the defect is textual — which write call a route happens to use — not a
// runtime state a mock could exercise from outside the route module.
describe("bare ready-frame write pin (#3452 audit finding sse.ts:108)", () => {
  it("never bare-writes the ready frame anywhere under keiko-server/src", () => {
    const srcRoot = dirname(fileURLToPath(import.meta.url));
    const bareReadyWrite = /\.write\(\s*readyMessage\(\)\s*\)/u;
    const relativePaths = readdirSync(srcRoot, { recursive: true }) as string[];
    const offenders = relativePaths
      .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
      .filter((path) => bareReadyWrite.test(readFileSync(join(srcRoot, path), "utf8")));

    expect(offenders, `bare res.write(readyMessage()) found in:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });
});

describe("attachSseSubscription lifecycle", () => {
  afterEach(() => {
    resetServerLogger();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["abort-first", "close-first"] as const)(
    "preserves acquisition/ready/listener order and unsubscribes once for %s",
    (order) => {
      const request = new IncomingMessage(new Socket());
      const res = new ServerResponse(request);
      const controller = new AbortController();
      const trace: string[] = [];
      let forwardedStop: (() => void) | undefined;
      const write = vi.spyOn(res, "write").mockImplementation(() => {
        trace.push("ready");
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
        expect(res.listenerCount("close")).toBe(1);
        return true;
      });
      try {
        attachSseSubscription(res, controller, function (this: undefined, stop): () => void {
          expect(this).toBeUndefined();
          expect(write).not.toHaveBeenCalled();
          expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
          forwardedStop = stop;
          trace.push("subscribe");
          return function (this: undefined): void {
            expect(this).toBeUndefined();
            trace.push("unsubscribe");
            forwardedStop?.();
          };
        });
        expect(trace).toEqual(["subscribe", "ready"]);
        expect(write).toHaveBeenCalledExactlyOnceWith("event: ready\ndata: {}\n\n");
        expect(res.listenerCount("close")).toBe(2);
        if (order === "abort-first") controller.abort();
        res.emit("close");
        controller.abort();
        res.emit("close");
        expect(trace).toEqual(["subscribe", "ready", "unsubscribe"]);
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      } finally {
        res.emit("close");
        request.destroy();
      }
    },
  );

  it("propagates a subscription factory failure before writing ready", () => {
    const request = new IncomingMessage(new Socket());
    const res = new ServerResponse(request);
    const controller = new AbortController();
    const failure = new TypeError("subscription acquisition refused");
    const write = vi.spyOn(res, "write");
    try {
      let observed: unknown;
      try {
        attachSseSubscription(res, controller, (): never => {
          throw failure;
        });
      } catch (error: unknown) {
        observed = error;
      }
      expect(observed).toBe(failure);
      expect(write).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(res.listenerCount("close")).toBe(0);
    } finally {
      request.destroy();
    }
  });

  it("sets the stop flag before a bare unsubscribe throws and never retries it", () => {
    const request = new IncomingMessage(new Socket());
    const res = new ServerResponse(request);
    const failure = new TypeError("subscription release refused");
    let forwardedStop: (() => void) | undefined;
    let calls = 0;
    vi.spyOn(res, "write").mockReturnValue(true);
    try {
      attachSseSubscription(res, new AbortController(), (stop) => {
        forwardedStop = stop;
        return function (this: undefined): never {
          expect(this).toBeUndefined();
          calls += 1;
          throw failure;
        };
      });
      expect(forwardedStop).toBeTypeOf("function");
      let observed: unknown;
      try {
        forwardedStop?.();
      } catch (error: unknown) {
        observed = error;
      }
      expect(observed).toBe(failure);
      expect(() => forwardedStop?.()).not.toThrow();
      expect(() => res.emit("close")).not.toThrow();
      expect(calls).toBe(1);
    } finally {
      res.emit("close");
      request.destroy();
    }
  });

  it("uses canonical ready backpressure and records the correlated terminal loss evidence", () => {
    vi.useFakeTimers();
    const request = new IncomingMessage(new Socket());
    const res = new ServerResponse(request);
    const controller = new AbortController();
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const trace: string[] = [];
    const write = vi.spyOn(res, "write").mockReturnValue(false);
    const destroy = vi.spyOn(res, "destroy");
    try {
      attachSseSubscription(
        res,
        controller,
        () => (): void => {
          expect(res.destroyed).toBe(false);
          trace.push("unsubscribe");
        },
        (signal) => {
          expect(res.destroyed).toBe(false);
          expect(signal).toEqual({ accepted: false, frameBytes: 23 });
          trace.push("observer");
        },
        "subscription-ready-stall",
      );
      expect(write).toHaveBeenCalledExactlyOnceWith("event: ready\ndata: {}\n\n");
      vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS - 1);
      expect(trace).toEqual([]);
      expect(controller.signal.aborted).toBe(false);
      expect(destroy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(trace).toEqual(["observer", "unsubscribe"]);
      expect(controller.signal.aborted).toBe(true);
      expect(destroy).toHaveBeenCalledOnce();
      expect(res.destroyed).toBe(true);
      res.emit("close");
      res.emit("close");
      expect(trace).toEqual(["observer", "unsubscribe"]);
      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]).toMatchObject({
        op: "sse.stream.closed",
        correlationId: "subscription-ready-stall",
        extra: {
          frameCount: 1,
          bytesStreamed: 23,
          drainWaitCount: 1,
          reason: "backpressure-killed",
        },
      });
    } finally {
      res.emit("close");
      request.destroy();
    }
  });
});

describe("writeNamespacedSseEvent", () => {
  afterEach(() => {
    resetServerLogger();
    vi.restoreAllMocks();
  });

  it.each([
    ["command", 'id: 7\nevent: command:observed\ndata: {"safe":true}\n\n'],
    ["verification", 'id: 7\nevent: verification:observed\ndata: {"safe":true}\n\n'],
    ["container", 'id: 7\nevent: container:observed\ndata: {"safe":true}\n\n'],
    ["terminal", 'id: 7\nevent: terminal:observed\ndata: {"safe":true}\n\n'],
    ["browser", 'id: 7\nevent: browser:observed\ndata: {"safe":true}\n\n'],
  ] as const)(
    "writes the exact %s frame through canonical stream accounting",
    (namespace, frame): void => {
      const request = new IncomingMessage(new Socket());
      const res = new ServerResponse(request);
      const controller = new AbortController();
      const sink = createBufferedServerLogSink();
      setServerLogger(createServerLogger({ sink, level: "info" }));
      const write = vi.spyOn(res, "write").mockReturnValue(true);
      const event = { kind: "observed" };
      const redactor = vi.fn((value: unknown): unknown => {
        expect(value).toBe(event);
        return { safe: true };
      });
      try {
        writeNamespacedSseEvent(res, event, 7, namespace, redactor, controller);
        expect(write).toHaveBeenCalledExactlyOnceWith(frame);
        expect(redactor).toHaveBeenCalledTimes(1);
        expect(redactor.mock.calls[0]).toHaveLength(1);
        expect(redactor.mock.calls[0]?.[0]).toBe(event);
        expect(controller.signal.aborted).toBe(false);
        res.emit("close");
        expect(sink.events).toHaveLength(1);
        expect(sink.events[0]).toMatchObject({
          op: "sse.stream.closed",
          extra: { frameCount: 1, reason: "client-disconnected" },
        });
      } finally {
        res.emit("close");
        request.destroy();
      }
    },
  );

  it("redacts the original event before kind and reuses its cache across responses", (): void => {
    const firstRequest = new IncomingMessage(new Socket());
    const secondRequest = new IncomingMessage(new Socket());
    const first = new ServerResponse(firstRequest);
    const second = new ServerResponse(secondRequest);
    const trace: string[] = [];
    const event = {
      get kind(): string {
        trace.push("kind");
        return "observed";
      },
    };
    const redactor = vi.fn((value: unknown): unknown => {
      expect(value).toBe(event);
      trace.push("redact");
      return { safe: true };
    });
    const firstWrite = vi.spyOn(first, "write").mockImplementation(() => {
      trace.push("first-write");
      return true;
    });
    const secondWrite = vi.spyOn(second, "write").mockImplementation(() => {
      trace.push("second-write");
      return true;
    });
    try {
      writeNamespacedSseEvent(first, event, 7, "command", redactor, new AbortController());
      expect(trace).toEqual(["redact", "kind", "first-write"]);
      writeNamespacedSseEvent(second, event, 8, "command", redactor, new AbortController());
      expect(trace).toEqual(["redact", "kind", "first-write", "kind", "second-write"]);
      expect(firstWrite).toHaveBeenCalledExactlyOnceWith(
        'id: 7\nevent: command:observed\ndata: {"safe":true}\n\n',
      );
      expect(secondWrite).toHaveBeenCalledExactlyOnceWith(
        'id: 8\nevent: command:observed\ndata: {"safe":true}\n\n',
      );
      expect(redactor).toHaveBeenCalledTimes(1);
      expect(redactor.mock.calls[0]).toHaveLength(1);
      expect(redactor.mock.calls[0]?.[0]).toBe(event);
    } finally {
      first.emit("close");
      second.emit("close");
      firstRequest.destroy();
      secondRequest.destroy();
    }
  });

  it("propagates the exact kind getter failure after redaction without writing", (): void => {
    const request = new IncomingMessage(new Socket());
    const res = new ServerResponse(request);
    const controller = new AbortController();
    const failure = new TypeError("namespaced event kind refused");
    const trace: string[] = [];
    const event = {
      get kind(): string {
        trace.push("kind");
        throw failure;
      },
    };
    const redactor = vi.fn((value: unknown): unknown => {
      expect(value).toBe(event);
      trace.push("redact");
      return { safe: true };
    });
    const write = vi.spyOn(res, "write");
    try {
      let observed: unknown;
      try {
        writeNamespacedSseEvent(res, event, 7, "browser", redactor, controller);
      } catch (error: unknown) {
        observed = error;
      }
      expect(observed).toBe(failure);
      expect(trace).toEqual(["redact", "kind"]);
      expect(redactor).toHaveBeenCalledTimes(1);
      expect(redactor.mock.calls[0]).toHaveLength(1);
      expect(redactor.mock.calls[0]?.[0]).toBe(event);
      expect(write).not.toHaveBeenCalled();
      expect(res.listenerCount("close")).toBe(0);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      request.destroy();
    }
  });
});

describe("openPlainNamespacedSseStream", () => {
  afterEach(() => {
    resetServerLogger();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("sets headers and a plain heartbeat before a failing acquisition", (): void => {
    const request = new IncomingMessage(new Socket());
    const res = new ServerResponse(request);
    const failure = new TypeError("plain stream subscription refused");
    const writeHead = vi.spyOn(res, "writeHead");
    const timer = vi.spyOn(globalThis, "setInterval");
    const write = vi.spyOn(res, "write").mockReturnValue(true);
    const subscribe = vi.fn(function (this: undefined): never {
      expect(this).toBeUndefined();
      expect(writeHead).toHaveBeenCalledExactlyOnceWith(200, SSE_HEADERS);
      expect(timer).toHaveBeenCalledExactlyOnceWith(
        expect.any(Function),
        SSE_HEARTBEAT_INTERVAL_MS,
      );
      const [headerOrder] = writeHead.mock.invocationCallOrder;
      const [timerOrder] = timer.mock.invocationCallOrder;
      if (headerOrder === undefined || timerOrder === undefined) {
        throw new TypeError("plain stream setup observations missing");
      }
      expect(headerOrder).toBeLessThan(timerOrder);
      expect(res.listenerCount("close")).toBe(1);
      expect(write).not.toHaveBeenCalled();
      throw failure;
    });
    try {
      let observed: unknown;
      try {
        openPlainNamespacedSseStream(res, "command", (value): unknown => value, subscribe);
      } catch (error: unknown) {
        observed = error;
      }
      expect(observed).toBe(failure);
      expect(subscribe).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
    } finally {
      res.emit("close");
      request.destroy();
    }
  });

  it("keeps a stalled heartbeat unwired and releases only on close", (): void => {
    vi.useFakeTimers();
    const request = new IncomingMessage(new Socket());
    const res = new ServerResponse(request);
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    const trace: string[] = [];
    const release = vi.fn((): void => {
      trace.push(res.destroyed ? "release-after-destroy" : "release-before-destroy");
    });
    const observer = vi.fn((): void => undefined);
    const write = vi.spyOn(res, "write").mockReturnValueOnce(true).mockReturnValue(false);
    const destroy = vi.spyOn(res, "destroy");
    try {
      openPlainNamespacedSseStream(
        res,
        "container",
        (value): unknown => value,
        () => release,
        observer,
        "plain-heartbeat-stall",
      );
      expect(write).toHaveBeenCalledExactlyOnceWith("event: ready\ndata: {}\n\n");
      vi.advanceTimersByTime(SSE_HEARTBEAT_INTERVAL_MS);
      expect(write).toHaveBeenNthCalledWith(2, ": keep-alive\n\n");
      vi.advanceTimersByTime(SSE_STALLED_READER_TIMEOUT_MS - 1);
      expect(destroy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(destroy).toHaveBeenCalledOnce();
      expect(res.destroyed).toBe(true);
      expect(observer).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      res.emit("close");
      res.emit("close");
      expect(trace).toEqual(["release-after-destroy"]);
      expect(release).toHaveBeenCalledOnce();
      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]).toMatchObject({
        op: "sse.stream.closed",
        correlationId: "plain-heartbeat-stall",
        extra: { drainWaitCount: 1, reason: "backpressure-killed" },
      });
    } finally {
      res.emit("close");
      request.destroy();
    }
  });
});

describe("SSE response observation fixtures", (): void => {
  it("keeps fresh mutable observations and the two exact response shapes", (): void => {
    const plain = createSseResponseObservation();
    const emitting = createEmittingSseResponseObservation();
    expect(plain).not.toBe(emitting);
    expect(plain.res).not.toBe(emitting.res);
    expect(plain.writes).not.toBe(emitting.writes);
    expect(plain.destroyCount).toBe(0);
    expect(plain.destroyed).toBe(false);
    expect(plain.ended).toBe(false);
    expect(plain.writeReturns).toBe(true);
    plain.destroyed = true;
    plain.ended = true;
    expect(plain.res.destroyed).toBe(true);
    expect(plain.res.writableEnded).toBe(true);
    expect(emitting.res.destroyed).toBe(false);
    expect(emitting.res.writableEnded).toBe(false);
    expect(Object.isFrozen(plain)).toBe(false);
    expect(Object.isFrozen(plain.res)).toBe(false);
  });

  it("preserves the two exact plain response shapes and own-property order", (): void => {
    const plain = createSseResponseObservation();
    const emitting = createEmittingSseResponseObservation();
    expect(Object.keys(plain)).toEqual([
      "res",
      "writes",
      "destroyCount",
      "destroyed",
      "ended",
      "writeReturns",
      "emitClose",
      "emitDrain",
    ]);
    expect(Object.keys(plain.res)).toEqual([
      "destroyed",
      "writableEnded",
      "writeHead",
      "write",
      "end",
      "destroy",
      "on",
      "once",
      "off",
    ]);
    expect(Object.keys(emitting.res)).toEqual([
      "destroyed",
      "writableEnded",
      "writeHead",
      "write",
      "end",
      "destroy",
      "on",
      "once",
      "off",
      "emit",
    ]);
    expect(Object.hasOwn(plain.res, "emit")).toBe(false);
    expect(Object.hasOwn(emitting.res, "emit")).toBe(true);
    expect(Object.getPrototypeOf(plain.res)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(emitting.res)).toBe(Object.prototype);
  });

  it("captures every write with live acceptance and keeps end separate from close", (): void => {
    for (const fake of [createSseResponseObservation(), createEmittingSseResponseObservation()]) {
      const close = vi.fn();
      const finish = vi.fn();
      fake.res.on("close", close);
      fake.res.on("finish", finish);
      expect(fake.res.writeHead(200)).toBe(fake.res);
      expect(fake.res.write("first")).toBe(true);
      fake.writeReturns = false;
      expect(fake.res.write("queued")).toBe(false);
      expect(fake.res.end()).toBe(fake.res);
      expect(fake.ended).toBe(true);
      expect(fake.res.writableEnded).toBe(true);
      expect(fake.destroyed).toBe(false);
      expect(fake.destroyCount).toBe(0);
      expect(close).not.toHaveBeenCalled();
      expect(finish).not.toHaveBeenCalled();
      expect(fake.res.write("after-end")).toBe(false);
      fake.res.destroy();
      fake.writeReturns = true;
      expect(fake.res.write("after-destroy")).toBe(true);
      expect(fake.writes).toEqual(["first", "queued", "after-end", "after-destroy"]);
      expect(finish).not.toHaveBeenCalled();
    }
  });

  it("forwards listener registration and synchronous dispatch through one private emitter", (): void => {
    for (const fake of [createSseResponseObservation(), createEmittingSseResponseObservation()]) {
      const trace: string[] = [];
      const receivers: unknown[] = [];
      const removed = vi.fn();
      const emitDrain = vi.fn(fake.emitDrain);
      function onDrain(this: unknown): void {
        receivers.push(this);
        trace.push("on");
      }
      function onceDrain(this: unknown): void {
        receivers.push(this);
        trace.push("once");
      }
      expect(fake.res.on("drain", onDrain)).toBe(fake.res);
      expect(fake.res.once("drain", onceDrain)).toBe(fake.res);
      expect(fake.res.on("drain", removed)).toBe(fake.res);
      expect(fake.res.off("drain", removed)).toBe(fake.res);
      trace.push("before");
      emitDrain();
      expect(emitDrain).toHaveLastReturnedWith(undefined);
      trace.push("after");
      emitDrain();
      expect(emitDrain).toHaveLastReturnedWith(undefined);
      expect(trace).toEqual(["before", "on", "once", "after", "on"]);
      expect(removed).not.toHaveBeenCalled();
      expect(receivers).toHaveLength(3);
      expect(receivers[0]).toBeInstanceOf(EventEmitter);
      expect(receivers[0]).not.toBe(fake.res);
      expect(receivers[1]).toBe(receivers[0]);
      expect(receivers[2]).toBe(receivers[0]);
      expect(fake.res.off("drain", onDrain)).toBe(fake.res);
      fake.emitDrain();
      expect(trace).toEqual(["before", "on", "once", "after", "on"]);
    }
  });

  it("counts and closes synchronously on every destroy without hiding repeated calls", (): void => {
    for (const fake of [createSseResponseObservation(), createEmittingSseResponseObservation()]) {
      const observations: unknown[] = [];
      const emitClose = vi.fn(fake.emitClose);
      fake.res.on("close", (): void => {
        observations.push([fake.destroyCount, fake.destroyed, fake.res.destroyed, fake.ended]);
      });
      expect(fake.res.destroy()).toBeUndefined();
      expect(observations).toEqual([[1, true, true, false]]);
      expect(fake.res.destroy()).toBeUndefined();
      expect(observations).toEqual([
        [1, true, true, false],
        [2, true, true, false],
      ]);
      expect(fake.destroyCount).toBe(2);
      emitClose();
      expect(emitClose).toHaveLastReturnedWith(undefined);
      expect(observations).toEqual([
        [1, true, true, false],
        [2, true, true, false],
        [2, true, true, false],
      ]);
      expect(fake.res.writableEnded).toBe(false);
    }
  });

  it("retains the emitting method descriptor and forwards only its one event argument", (): void => {
    const fake = createEmittingSseResponseObservation();
    const descriptor = Object.getOwnPropertyDescriptor(fake.res, "emit");
    const emit: unknown = descriptor?.value;
    expect(typeof emit).toBe("function");
    if (typeof emit !== "function") {
      throw new TypeError("Missing fixture emit method");
    }
    expect(descriptor).toEqual({
      value: emit,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(emit.name).toBe("emit");
    expect(emit).toHaveLength(1);
    expect(Object.hasOwn(emit, "prototype")).toBe(false);
    expect((): unknown => Reflect.construct(emit, [])).toThrow(TypeError);
    expect(fake.res.emit("probe")).toBe(false);
    const listener = vi.fn();
    fake.res.on("probe", listener);
    expect(fake.res.emit("probe", "not-forwarded")).toBe(true);
    expect(listener).toHaveBeenCalledExactlyOnceWith();
  });

  it("keeps live enumerable accessors and writable own response methods", (): void => {
    const functionMatcher: unknown = expect.any(Function);
    for (const fake of [createSseResponseObservation(), createEmittingSseResponseObservation()]) {
      expect(Object.getOwnPropertyDescriptor(fake.res, "destroyed")).toMatchObject({
        get: functionMatcher,
        set: undefined,
        enumerable: true,
        configurable: true,
      });
      expect(Object.getOwnPropertyDescriptor(fake.res, "writableEnded")).toMatchObject({
        get: functionMatcher,
        set: undefined,
        enumerable: true,
        configurable: true,
      });
      expect(Object.getOwnPropertyDescriptor(fake.res, "write")).toMatchObject({
        value: functionMatcher,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      fake.destroyed = true;
      fake.ended = true;
      expect(fake.res.destroyed).toBe(true);
      expect(fake.res.writableEnded).toBe(true);
      fake.destroyed = false;
      fake.ended = false;
      expect(fake.res.destroyed).toBe(false);
      expect(fake.res.writableEnded).toBe(false);
    }
  });
});
