import { EventEmitter } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
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
import {
  CODING_APP_SESSION_STREAM_DRAIN_TIMEOUT_MS,
  openCodingAppSessionStream,
} from "./codingAppSessionRoutes.js";
import {
  CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS,
  type CodingAppSessionChannelContent,
} from "./channelContract.js";
import {
  CODING_APP_SESSION_MAX_LIVE_STREAMS,
  createCodingAppSessionChannel,
  type CodingAppSessionContentSource,
} from "./sessionChannel.js";
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

class NonDrainingTransport extends Duplex {
  public constructor() {
    super({ readableHighWaterMark: 1_024, writableHighWaterMark: 1_024 });
  }
  public override _read(): void {
    // The transport deliberately never produces inbound bytes.
  }
  public override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    _callback: (error?: Error | null) => void,
  ): void {
    // Holding the callback makes this a deterministic slow peer with a bounded writable buffer.
  }
}

function liveContentSource(): {
  readonly source: CodingAppSessionContentSource;
  readonly emit: (content: CodingAppSessionChannelContent) => void;
} {
  const listeners = new Set<(content: CodingAppSessionChannelContent | null) => void>();
  return {
    source: {
      contentFor: () => ({ kind: "probe", body: "initial" }),
      subscribeContent: (
        listener,
      ): ReturnType<NonNullable<CodingAppSessionContentSource["subscribeContent"]>> => {
        listeners.add(listener);
        return { admitted: true, detach: (): void => void listeners.delete(listener) };
      },
    },
    emit: (content): void => {
      for (const listener of [...listeners]) listener(content);
    },
  };
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
      // A rejected `write` has already placed this one bounded frame in Node's buffer. The
      // app-session stream stops publishing and ends the response so that frame can flush; an
      // abrupt socket destroy would turn ordinary pressure into a client-visible offline error.
      expect(response.writableEnded).toBe(true);
      expect(response.destroyed).toBe(false);
      expect(terminalReason()).toBe("backpressure-killed");
      projection.purge("run-stream", "stop");
      expect(record).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds a real non-draining response and retains admission until transport close", async () => {
    const live = liveContentSource();
    const record = vi.fn();
    const channel = createCodingAppSessionChannel({
      registry: createSessionRegistry(),
      pairingPort: createFakeSessionPairingPort(),
      diagnostics: { record },
      contentSource: live.source,
    });
    const paired = channel.pair(fakePairingRequestBody());
    if (!paired.paired) throw new Error("pairing failed");
    const transport = new NonDrainingTransport();
    const socket = transport as unknown as Socket;
    const request = new IncomingMessage(socket);
    const response = new ServerResponse(request);
    response.assignSocket(socket);
    openCodingAppSessionStream(response, request, channel, paired.cookieToken, CORRELATION, {
      record,
    });

    live.emit({ kind: "probe", body: "x".repeat(CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS) });
    vi.runAllTicks();
    await Promise.resolve();

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ message: "sse-backpressure" }));
    expect(response.writableEnded).toBe(true);
    expect(response.writableFinished).toBe(false);
    expect(response.destroyed).toBe(false);
    const admitted = Array.from({ length: CODING_APP_SESSION_MAX_LIVE_STREAMS - 1 }, () =>
      channel.subscribe(paired.cookieToken, () => true),
    );
    expect(channel.subscribe(paired.cookieToken, () => true).live).toBe(false);

    await vi.advanceTimersByTimeAsync(CODING_APP_SESSION_STREAM_DRAIN_TIMEOUT_MS);
    expect(response.destroyed).toBe(true);
    const afterClose = channel.subscribe(paired.cookieToken, () => true);
    expect(afterClose.live).toBe(true);

    afterClose.detach();
    for (const subscription of admitted) subscription.detach();
    transport.destroy();
  });

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
      if (state === "writableEnded") {
        expect(vi.getTimerCount()).toBe(1);
        response.emit("close");
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
