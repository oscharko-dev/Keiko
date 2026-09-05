import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodingSafeActivityProjection } from "../coding-runtime/codingSafeActivityProjection.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "../observability/index.js";
import { createFakeSessionPairingPort, fakePairingRequestBody } from "./_support.js";
import { openCodingAppSessionStream } from "./codingAppSessionRoutes.js";
import { createCodingAppSessionChannel } from "./sessionChannel.js";
import { createSessionRegistry } from "./sessionRegistry.js";

const CORRELATION = "session-stream-lifecycle";
const NOW = "2026-09-05T01:00:00.000Z";

class StreamResponse extends EventEmitter {
  public writableEnded = false;
  public destroyed = false;
  public reject = false;
  public failure: Error | undefined;
  public readonly frames: string[] = [];
  public writeHead(): void {
    /* Headers do not affect stream acceptance. */
  }
  public write(frame: string): boolean {
    if (this.failure !== undefined) throw this.failure;
    this.frames.push(frame);
    return !this.reject;
  }
  public end(): void {
    this.writableEnded = true;
    this.emit("close");
  }
  public destroy(): void {
    this.destroyed = true;
    // ServerResponse.destroy(error) closes its socket without a response error event.
    this.emit("close");
  }
}

const responses: StreamResponse[] = [];
let sink: BufferedServerLogSink;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
});
afterEach(() => {
  for (const response of responses.splice(0)) response.destroy();
  vi.useRealTimers();
  resetServerLogger();
});

function fixture(
  synchronousTerminal = false,
  initialFailure?: Error,
): {
  projection: ReturnType<typeof createCodingSafeActivityProjection>;
  response: StreamResponse;
  record: ReturnType<typeof vi.fn>;
  sessionId: string;
} {
  const projection = createCodingSafeActivityProjection();
  projection.open({
    runId: "run-stream",
    workspaceId: "workspace-stream",
    authorityExpiresAt: "2026-09-05T02:00:00.000Z",
    workspaceIsCurrent: () => true,
  });
  const record = vi.fn();
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
    diagnostics: { record },
    contentSource: {
      contentFor: () => projection.currentContent(),
      subscribeContent: (listener) => {
        const subscription = projection.subscribeContent(listener);
        if (synchronousTerminal) listener(null);
        return subscription;
      },
    },
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("pairing failed");
  const sessionId = channel.verifySession(paired.cookieToken)?.sessionId;
  if (sessionId === undefined) throw new Error("session missing");
  const response = new StreamResponse();
  response.failure = initialFailure;
  responses.push(response);
  openCodingAppSessionStream(
    response as unknown as ServerResponse,
    new EventEmitter() as IncomingMessage,
    channel,
    paired.cookieToken,
    CORRELATION,
    { record },
  );
  return { projection, response, record, sessionId };
}

function terminalReason(): unknown {
  const event = sink.events.find((entry) => entry.op === "sse.stream.closed");
  expect(event?.correlationId).toBe(CORRELATION);
  return event?.extra?.reason;
}

function emitContent(projection: ReturnType<typeof createCodingSafeActivityProjection>): void {
  projection.markUnavailable("run-stream");
}

describe("app-session stream transport and completion remain distinct", () => {
  it("contains a thrown heartbeat, reports it and releases the stream", () => {
    const { projection, response, record } = fixture();
    response.failure = new TypeError("private-heartbeat-body");
    expect(() => vi.advanceTimersByTime(15_000)).not.toThrow();
    expect(record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operation: "coding-app-session.channel.subscribe",
        correlationId: CORRELATION,
        source: "coding-app-session.session-channel.heartbeat",
        message: "sse-listener-failed",
        errorClass: "TypeError",
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain("private-heartbeat-body");
    expect(response.destroyed).toBe(true);
    projection.purge("run-stream", "stop");
    expect(vi.getTimerCount()).toBe(0);
    expect(terminalReason()).toBe("server-error");
  });

  it("contains an initial snapshot write failure before a live subscription exists", () => {
    const state = fixture(false, new TypeError("private-initial-body"));
    expect(state.record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operation: "coding-app-session.channel.subscribe",
        correlationId: CORRELATION,
        source: "coding-app-session.session-channel.initial",
        message: "sse-listener-failed",
        errorClass: "TypeError",
      }),
    );
    expect(JSON.stringify(state.record.mock.calls)).not.toContain("private-initial-body");
    state.projection.purge("run-stream", "stop");
    expect(state.record).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(terminalReason()).toBe("server-error");
  });

  it("contains a content-free initial write failure without a composed channel", () => {
    const response = new StreamResponse();
    response.failure = new TypeError("private-no-channel-body");
    responses.push(response);
    const record = vi.fn();
    expect(() => {
      openCodingAppSessionStream(
        response as unknown as ServerResponse,
        new EventEmitter() as IncomingMessage,
        undefined,
        undefined,
        CORRELATION,
        { record },
      );
    }).not.toThrow();
    expect(record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: "coding-app-session.session-channel.initial",
        errorClass: "TypeError",
        correlationId: CORRELATION,
      }),
    );
    expect(response.destroyed).toBe(true);
    expect(terminalReason()).toBe("server-error");
  });

  it.each(["stop", "workspace-switch"] as const)(
    "finishes %s without false backpressure",
    async (reason) => {
      const { projection, response, record } = fixture();
      projection.purge("run-stream", reason);
      vi.runAllTicks();
      await Promise.resolve();
      expect(response.frames.at(-1)).toContain('"content":null');
      expect(record).not.toHaveBeenCalled();
      expect(response.writableEnded).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(terminalReason()).toBe("completed");
    },
  );

  it("never replays initial content after a synchronous terminal subscription frame", async () => {
    const { projection, response, record } = fixture(true);
    await Promise.resolve();
    expect(response.frames).toHaveLength(1);
    expect(response.frames[0]).toContain('"content":null');
    expect(response.writableEnded).toBe(true);
    projection.purge("run-stream", "stop");
    expect(record).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(terminalReason()).toBe("completed");
  });

  it.each([false, true])(
    "retains genuine rejected-write diagnostics, terminal=%s",
    async (terminal) => {
      const { projection, response, record, sessionId } = fixture();
      response.reject = true;
      if (terminal) projection.purge("run-stream", "stop");
      else emitContent(projection);
      vi.runAllTicks();
      await Promise.resolve();
      expect(record).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          operation: "coding-app-session.channel.subscribe",
          correlationId: sessionId,
          source: "coding-app-session.session-channel.publish",
          message: "sse-backpressure",
          errorClass: "Error",
        }),
      );
      expect(terminalReason()).toBe("backpressure-killed");
      projection.purge("run-stream", "stop");
      expect(record).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retains a body-free listener failure and releases the HTTP lifecycle", async () => {
    const { projection, response, record, sessionId } = fixture();
    response.failure = new TypeError("private body /private/workspace token=secret");
    emitContent(projection);
    vi.runAllTicks();
    await Promise.resolve();
    expect(record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        operation: "coding-app-session.channel.subscribe",
        correlationId: sessionId,
        source: "coding-app-session.session-channel.publish",
        message: "sse-listener-failed",
        errorClass: "TypeError",
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toMatch(/private|secret/u);
    expect(response.destroyed).toBe(true);
    expect(terminalReason()).toBe("server-error");
    projection.purge("run-stream", "stop");
    expect(record).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["destroyed", "writableEnded"] as const)(
    "does not write after %s before its close event arrives",
    async (state) => {
      const { projection, response, record } = fixture();
      response[state] = true;
      response.reject = true;
      emitContent(projection);
      vi.runAllTicks();
      await Promise.resolve();
      expect(response.frames).toHaveLength(1);
      projection.purge("run-stream", "stop");
      expect(record).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
