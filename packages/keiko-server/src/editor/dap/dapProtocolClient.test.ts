import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createDapProtocolClient, DapProtocolError } from "./dapProtocolClient.js";
import { DapFrameRejectError } from "./dapFrameCodec.js";

function messages(frames: string[]): Record<string, unknown>[] {
  return frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

describe("dapProtocolClient", () => {
  it("correlates responses and emits typed events", async () => {
    const source = new PassThrough({ objectMode: true });
    const sent: string[] = [];
    const client = createDapProtocolClient({ source, sendFrame: (body) => void sent.push(body) });
    const events: string[] = [];
    const stopped: unknown[] = [];
    client.onEvent((event) => void events.push(event.event));
    client.onStopped((event) => void stopped.push(event));
    const pending = client.request("threads", {}, { lane: "inspection", deadlineMs: 100 });
    const request = messages(sent)[0];
    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 2,
          type: "event",
          event: "stopped",
          body: { reason: "breakpoint", threadId: 7, hitBreakpointIds: [11, 12] },
        }),
      ),
    );
    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 3,
          type: "response",
          request_seq: request?.seq,
          success: true,
          command: "threads",
          body: { threads: [] },
        }),
      ),
    );
    await expect(pending).resolves.toStrictEqual({ threads: [] });
    expect(events).toStrictEqual(["stopped"]);
    expect(stopped).toStrictEqual([
      {
        reason: "breakpoint",
        threadId: 7,
        allThreadsStopped: false,
        hitBreakpointIds: [11, 12],
      },
    ]);
    source.write(Buffer.from(JSON.stringify({ seq: 4, type: "event", event: "continued" })));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toHaveLength(1);
  });

  it("reserves four of 32 request slots for controls", async () => {
    const source = new PassThrough({ objectMode: true });
    const client = createDapProtocolClient({ source, sendFrame: vi.fn() });
    const inspections = Array.from({ length: 28 }, () =>
      client.request("variables", {}, { lane: "inspection", deadlineMs: 10_000 }),
    );
    expect(client.pendingCount()).toBe(28);
    await expect(
      client.request("variables", {}, { lane: "inspection", deadlineMs: 10_000 }),
    ).rejects.toMatchObject({ code: "REQUEST_LIMIT" });
    const control = client.request("disconnect", {}, { lane: "control", deadlineMs: 10_000 });
    expect(client.pendingCount()).toBe(29);
    client.dispose();
    await Promise.allSettled([...inspections, control]);
  });

  it("routes the typed control helper through the reserved control lane", async () => {
    const source = new PassThrough({ objectMode: true });
    const client = createDapProtocolClient({ source, sendFrame: vi.fn() });
    const inspections = Array.from({ length: 28 }, () =>
      client.request("variables", {}, { lane: "inspection", deadlineMs: 10_000 }),
    );
    const control = client.controlRequest("initialize", {}, 10_000);
    expect(client.pendingCount()).toBe(29);
    client.dispose();
    await expect(control).rejects.toMatchObject({ code: "CLIENT_DISPOSED" });
    await Promise.allSettled(inspections);
  });

  it("rejects every reverse request including spawn-capable commands", async () => {
    const source = new PassThrough({ objectMode: true });
    const sent: string[] = [];
    createDapProtocolClient({ source, sendFrame: (body) => void sent.push(body) });
    for (const command of ["runInTerminal", "startDebugging", "unknown"]) {
      const expectedCount = sent.length + 1;
      source.write(
        Buffer.from(
          JSON.stringify({ seq: sent.length + 1, type: "request", command, arguments: {} }),
        ),
      );
      await vi.waitFor(() => {
        expect(sent).toHaveLength(expectedCount);
      });
      const response = messages(sent).at(-1);
      expect(response).toMatchObject({ type: "response", success: false, command });
    }
  });

  it("times out and aborts with content-free errors", async () => {
    vi.useFakeTimers();
    const source = new PassThrough({ objectMode: true });
    const client = createDapProtocolClient({ source, sendFrame: vi.fn() });
    const timed = client.request("stackTrace", {}, { lane: "inspection", deadlineMs: 3_000 });
    const timedAssertion = expect(timed).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(3_000);
    await timedAssertion;
    const controller = new AbortController();
    const aborted = client.request(
      "pause",
      {},
      {
        lane: "control",
        deadlineMs: 2_000,
        signal: controller.signal,
      },
    );
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    vi.useRealTimers();
  });

  it("surfaces malformed input as a typed fatal signal", async () => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    const client = createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });
    source.write(Buffer.from("{not-json", "utf8"));
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "MALFORMED_MESSAGE" }));
    });
    await expect(
      client.request("threads", {}, { lane: "inspection", deadlineMs: 100 }),
    ).rejects.toMatchObject({ code: "CLIENT_DISPOSED" });
  });

  it.each([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(JSON.stringify({ seq: 1, type: "event" })),
    Buffer.from(JSON.stringify({ seq: 1, type: "response", request_seq: 1, success: "yes" })),
  ])("fails closed on invalid UTF-8 or a structurally open handled message", async (message) => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });
    source.write(message);
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledTimes(1);
    });
    expect(fatal.mock.calls[0]?.[0]).toMatchObject({ code: "MALFORMED_MESSAGE" });
  });

  it("treats a clean unexpected EOF as fatal", async () => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn(() => Promise.resolve());
    createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });
    source.end();
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "UNEXPECTED_EOF" }));
    });
  });

  it("returns WRITE_FAILED promptly while a non-resolving fatal teardown remains started", async () => {
    const source = new PassThrough({ objectMode: true });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let terminalStarted = false;
    let terminalCode: string | undefined;
    const client = createDapProtocolClient({
      source,
      sendFrame: () => {
        throw new Error("private");
      },
      onFatalError: (error) => {
        terminalStarted = true;
        terminalCode = error.code;
        return new Promise<void>(() => undefined);
      },
    });
    await expect(
      client.request(
        "threads",
        {},
        {
          lane: "inspection",
          deadlineMs: 100,
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ code: "WRITE_FAILED" });
    expect(terminalStarted).toBe(true);
    expect(terminalCode).toBe("WRITE_FAILED");
    expect(client.pendingCount()).toBe(0);
    expect(remove).toHaveBeenCalled();
  });

  it("accepts a subsequent request after timeout and cancellation release their slots", async () => {
    vi.useFakeTimers();
    const source = new PassThrough({ objectMode: true });
    let respond = false;
    const sent: Record<string, unknown>[] = [];
    const client = createDapProtocolClient({
      source,
      sendFrame: (body) => {
        const request = JSON.parse(body) as Record<string, unknown>;
        sent.push(request);
        if (respond) {
          source.write(
            Buffer.from(
              JSON.stringify({
                seq: 100,
                type: "response",
                request_seq: request.seq,
                success: true,
                command: request.command,
                body: { ok: true },
              }),
            ),
          );
        }
      },
    });
    const timed = client.request("threads", {}, { lane: "inspection", deadlineMs: 10 });
    const timedRejection = expect(timed).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10);
    await timedRejection;
    const controller = new AbortController();
    const cancelled = client.request(
      "stackTrace",
      {},
      {
        lane: "inspection",
        deadlineMs: 100,
        signal: controller.signal,
      },
    );
    const cancelledRejection = expect(cancelled).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    });
    controller.abort();
    await cancelledRejection;
    respond = true;
    await expect(
      client.request("threads", {}, { lane: "inspection", deadlineMs: 100 }),
    ).resolves.toStrictEqual({ ok: true });
    expect(client.pendingCount()).toBe(0);
    expect(sent).toHaveLength(3);
    client.dispose();
    vi.useRealTimers();
  });

  it("keeps the reverse-request boundary structurally free of process and terminal ports", async () => {
    const source = new PassThrough({ objectMode: true });
    const sent: string[] = [];
    createDapProtocolClient({ source, sendFrame: (body) => sent.push(body) });
    for (const [index, command] of ["runInTerminal", "startDebugging"].entries()) {
      source.write(Buffer.from(JSON.stringify({ seq: index + 1, type: "request", command })));
    }
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    const production = readFileSync(
      fileURLToPath(new URL("./dapProtocolClient.ts", import.meta.url)),
      "utf8",
    );
    expect(production).not.toMatch(/node:child_process|node-pty|\.spawn\(|execFile\(/u);
  });

  it("uses monotonic request sequences and removes unsubscribed handlers", async () => {
    const source = new PassThrough({ objectMode: true });
    const sent: string[] = [];
    const client = createDapProtocolClient({ source, sendFrame: (body) => void sent.push(body) });
    const event = vi.fn();
    const stopped = vi.fn();
    const offEvent = client.onEvent(event);
    const offStopped = client.onStopped(stopped);
    offEvent();
    offStopped();
    const first = client.request("threads", {}, { lane: "inspection", deadlineMs: 100 });
    const second = client.request("pause", {}, { lane: "control", deadlineMs: 100 });
    expect(messages(sent).map((message) => message.seq)).toStrictEqual([1, 2]);
    expect(messages(sent)[0]).toStrictEqual({
      seq: 1,
      type: "request",
      command: "threads",
      arguments: {},
    });
    for (const [index, command] of ["threads", "pause"].entries()) {
      source.write(
        Buffer.from(
          JSON.stringify({
            seq: index + 10,
            type: "response",
            request_seq: index + 1,
            success: true,
            command,
            body: index,
          }),
        ),
      );
    }
    await expect(first).resolves.toBe(0);
    await expect(second).resolves.toBe(1);
    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 20,
          type: "event",
          event: "stopped",
          body: { reason: "pause", threadId: 1, hitBreakpointIds: [2] },
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(event).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
  });

  it("uses all 32 slots while preserving exactly four control slots", async () => {
    const source = new PassThrough({ objectMode: true });
    const client = createDapProtocolClient({ source, sendFrame: vi.fn() });
    const pending = Array.from({ length: 28 }, () =>
      client.request("variables", {}, { lane: "inspection", deadlineMs: 10_000 }),
    );
    for (let index = 0; index < 4; index += 1) {
      pending.push(client.request("pause", {}, { lane: "control", deadlineMs: 10_000 }));
    }
    expect(client.pendingCount()).toBe(32);
    await expect(
      client.request("pause", {}, { lane: "control", deadlineMs: 10_000 }),
    ).rejects.toMatchObject({ name: "DapProtocolError", code: "REQUEST_LIMIT" });
    client.dispose();
    await Promise.allSettled(pending);
  });

  it("does not write a pre-aborted or disposed request", async () => {
    const source = new PassThrough({ objectMode: true });
    const send = vi.fn();
    const client = createDapProtocolClient({ source, sendFrame: send });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.request("pause", {}, { lane: "control", deadlineMs: 10, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(send).not.toHaveBeenCalled();
    client.dispose();
    client.dispose();
    await expect(
      client.request("threads", {}, { lane: "inspection", deadlineMs: 10 }),
    ).rejects.toMatchObject({ code: "CLIENT_DISPOSED" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([null, [], "text", 1, true, { seq: 1, type: "unknown" }])(
    "rejects every non-record or unknown message shape",
    async (message) => {
      const source = new PassThrough({ objectMode: true });
      const fatal = vi.fn();
      createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });
      source.write(Buffer.from(JSON.stringify(message)));
      await vi.waitFor(() => {
        expect(fatal).toHaveBeenCalledTimes(1);
      });
      expect(fatal.mock.calls[0]?.[0]).toMatchObject({ code: "MALFORMED_MESSAGE" });
    },
  );

  it.each([
    { seq: "1", type: "response", request_seq: 1, success: true, command: "threads" },
    { seq: 1, type: "response", request_seq: "1", success: true, command: "threads" },
    { seq: 1, type: "response", request_seq: 1, success: "yes", command: "threads" },
    { seq: 1, type: "response", request_seq: 1, success: true, command: 2 },
    { seq: 1, type: "event", event: 2 },
    { seq: "1", type: "event", event: "continued" },
    { seq: "1", type: "request", command: "unknown" },
    { seq: 1, type: "request", command: 2 },
  ])("fails closed on malformed handled-message fields", async (message) => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });
    source.write(Buffer.from(JSON.stringify(message)));
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledTimes(1);
    });
    expect(fatal.mock.calls[0]?.[0]).toMatchObject({ code: "MALFORMED_MESSAGE" });
  });

  it("rejects an unknown response correlation as fatal", async () => {
    const source = new PassThrough({ objectMode: true });
    const sent: string[] = [];
    const fatal = vi.fn();
    const client = createDapProtocolClient({
      source,
      sendFrame: (body) => void sent.push(body),
      onFatalError: fatal,
    });
    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 1,
          type: "response",
          request_seq: 999,
          success: true,
          command: "threads",
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "MALFORMED_MESSAGE" }));
    });
    expect(client.pendingCount()).toBe(0);
  });

  it.each([
    { request_seq: "1", success: true, command: "threads" },
    { request_seq: 1, success: "true", command: "threads" },
    { request_seq: 1, success: true, command: 1 },
  ])("fails closed before correlating a malformed response field", async (response) => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    const client = createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });
    const pending = client.request("threads", {}, { lane: "inspection", deadlineMs: 100 });
    const rejection = expect(pending).rejects.toMatchObject({ code: "CLIENT_DISPOSED" });
    source.write(Buffer.from(JSON.stringify({ seq: 1, type: "response", ...response })));
    await rejection;
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "MALFORMED_MESSAGE" }));
  });

  it("rejects duplicate inbound message sequences before dispatch", async () => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });
    source.write(Buffer.from(JSON.stringify({ seq: 1, type: "event", event: "continued" })));
    source.write(Buffer.from(JSON.stringify({ seq: 1, type: "event", event: "continued" })));
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "MALFORMED_MESSAGE" }));
    });
  });

  it("accepts a late response for a cancelled request but not an ordinary rejected request", async () => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    const sent: Record<string, unknown>[] = [];
    const client = createDapProtocolClient({
      source,
      sendFrame: (body) => void sent.push(JSON.parse(body) as Record<string, unknown>),
      onFatalError: fatal,
    });
    const controller = new AbortController();
    const cancelled = client.request(
      "threads",
      {},
      { lane: "inspection", deadlineMs: 100, signal: controller.signal },
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 1,
          type: "response",
          request_seq: sent[0]?.seq,
          success: true,
          command: "threads",
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(fatal).not.toHaveBeenCalled();
  });

  it("rejects a late response after an adapter rejection", async () => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    const sent: Record<string, unknown>[] = [];
    const client = createDapProtocolClient({
      source,
      sendFrame: (body) => void sent.push(JSON.parse(body) as Record<string, unknown>),
      onFatalError: fatal,
    });
    const rejected = client.request("threads", {}, { lane: "inspection", deadlineMs: 100 });
    const requestSeq = sent[0]?.seq;
    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 1,
          type: "response",
          request_seq: requestSeq,
          success: false,
          command: "threads",
        }),
      ),
    );
    await expect(rejected).rejects.toMatchObject({ code: "ADAPTER_REJECTED" });
    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 2,
          type: "response",
          request_seq: requestSeq,
          success: true,
          command: "threads",
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "MALFORMED_MESSAGE" }));
    });
  });

  it("rejects a malformed late response before retired correlation", async () => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    const sent: Record<string, unknown>[] = [];
    const client = createDapProtocolClient({
      source,
      sendFrame: (body) => void sent.push(JSON.parse(body) as Record<string, unknown>),
      onFatalError: fatal,
    });
    const controller = new AbortController();
    const cancelled = client.request(
      "threads",
      {},
      { lane: "inspection", deadlineMs: 100, signal: controller.signal },
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 1,
          type: "response",
          request_seq: sent[0]?.seq,
          success: true,
          command: 1,
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "MALFORMED_MESSAGE" }));
    });
  });

  it("rejects failed and mismatched correlated responses", async () => {
    const source = new PassThrough({ objectMode: true });
    const sent: string[] = [];
    const fatal = vi.fn();
    const client = createDapProtocolClient({
      source,
      sendFrame: (body) => void sent.push(body),
      onFatalError: fatal,
    });
    const rejected = client.request("threads", {}, { lane: "inspection", deadlineMs: 100 });
    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 1,
          type: "response",
          request_seq: messages(sent)[0]?.seq,
          success: false,
          command: "threads",
        }),
      ),
    );
    await expect(rejected).rejects.toMatchObject({ code: "ADAPTER_REJECTED" });

    const mismatched = client.request("threads", {}, { lane: "inspection", deadlineMs: 100 });
    const mismatchedAssertion = expect(mismatched).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 2,
          type: "response",
          request_seq: messages(sent)[1]?.seq,
          success: true,
          command: "pause",
        }),
      ),
    );
    await mismatchedAssertion;
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "MALFORMED_MESSAGE" }));
  });

  it.each([
    { reason: "pause", threadId: 1, allThreadsStopped: false, hitBreakpointIds: [1, 4] },
    { reason: "entry", allThreadsStopped: true },
  ])("normalizes only safe stopped-event references", async (body) => {
    const source = new PassThrough({ objectMode: true });
    const stopped = vi.fn();
    const client = createDapProtocolClient({ source, sendFrame: vi.fn() });
    client.onStopped(stopped);
    source.write(Buffer.from(JSON.stringify({ seq: 1, type: "event", event: "stopped", body })));
    await vi.waitFor(() => {
      expect(stopped).toHaveBeenCalledTimes(1);
    });
    expect(stopped.mock.calls[0]?.[0]).toStrictEqual({
      reason: body.reason,
      threadId: "threadId" in body ? body.threadId : undefined,
      allThreadsStopped: body.allThreadsStopped,
      hitBreakpointIds: "hitBreakpointIds" in body ? body.hitBreakpointIds : [],
    });
  });

  it("preserves an optional stopped-event description only when it is text", async () => {
    const source = new PassThrough({ objectMode: true });
    const stopped = vi.fn();
    const client = createDapProtocolClient({ source, sendFrame: vi.fn() });
    client.onStopped(stopped);
    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 1,
          type: "event",
          event: "stopped",
          body: {
            reason: "exception",
            threadId: 1,
            allThreadsStopped: true,
            description: "Fixture uncaught exception",
          },
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(stopped).toHaveBeenCalledTimes(1);
    });
    expect(stopped).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Fixture uncaught exception" }),
    );

    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 2,
          type: "event",
          event: "stopped",
          body: {
            reason: "exception",
            threadId: 1,
            allThreadsStopped: true,
            description: { unsafe: true },
          },
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, [], {}, { reason: 1 }])(
    "does not deliver an invalid stopped body to the typed listener",
    async (body) => {
      const source = new PassThrough({ objectMode: true });
      const stopped = vi.fn();
      const client = createDapProtocolClient({ source, sendFrame: vi.fn() });
      client.onStopped(stopped);
      source.write(Buffer.from(JSON.stringify({ seq: 1, type: "event", event: "stopped", body })));
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).not.toHaveBeenCalled();
    },
  );

  it.each([
    { reason: "pause", threadId: 0, hitBreakpointIds: [] },
    { reason: "pause", threadId: -1, hitBreakpointIds: [] },
    { reason: "pause", threadId: 1.5, hitBreakpointIds: [] },
    { reason: "pause", threadId: 1, hitBreakpointIds: [0] },
    { reason: "pause", threadId: 1, hitBreakpointIds: [1, -1] },
    { reason: "pause", threadId: 1, hitBreakpointIds: [1, "2"] },
    { reason: "pause", threadId: 1, hitBreakpointIds: { 0: 1, length: 1 } },
    { reason: "pause", allThreadsStopped: false, hitBreakpointIds: [] },
    { reason: "pause", allThreadsStopped: true, description: { unsafe: true } },
  ])("fails closed on unsafe stopped-event fields", async (body) => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    const stopped = vi.fn();
    const client = createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });
    client.onStopped(stopped);
    source.write(Buffer.from(JSON.stringify({ seq: 1, type: "event", event: "stopped", body })));
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "MALFORMED_MESSAGE" }));
    });
    expect(stopped).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { threadId: 1, allThreadsStopped: true },
    { reason: "pause", threadId: 0, allThreadsStopped: true },
  ])("preserves malformed-message classification for rejected stopped bodies", async (body) => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });
    source.write(Buffer.from(JSON.stringify({ seq: 1, type: "event", event: "stopped", body })));
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "MALFORMED_MESSAGE" }));
    });
  });

  it("accepts only the most recent 64 cancelled or timed-out response correlations", async () => {
    vi.useFakeTimers();
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    const sent: Record<string, unknown>[] = [];
    const client = createDapProtocolClient({
      source,
      sendFrame: (body) => void sent.push(JSON.parse(body) as Record<string, unknown>),
      onFatalError: fatal,
    });

    for (let index = 0; index < 65; index += 1) {
      const timed = client.request("threads", {}, { lane: "inspection", deadlineMs: 1 });
      const assertion = expect(timed).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    }

    vi.useRealTimers();
    const oldestRetained = sent[1]?.seq;
    const retained = sent.at(-1)?.seq;
    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 1,
          type: "response",
          request_seq: oldestRetained,
          success: true,
          command: "threads",
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(fatal).not.toHaveBeenCalled();

    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 2,
          type: "response",
          request_seq: retained,
          success: true,
          command: "threads",
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(fatal).not.toHaveBeenCalled();

    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 3,
          type: "response",
          request_seq: sent[0]?.seq,
          success: true,
          command: "threads",
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "MALFORMED_MESSAGE" }));
    });
  });

  it("preserves the exact abort listener contract and ignores a late abort after settlement", async () => {
    const source = new PassThrough({ objectMode: true });
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const client = createDapProtocolClient({
      source,
      sendFrame: () => {
        source.write(
          Buffer.from(
            JSON.stringify({
              seq: 2,
              type: "response",
              request_seq: 1,
              success: true,
              command: "threads",
              body: { ok: true },
            }),
          ),
        );
      },
    });
    await expect(
      client.request(
        "threads",
        {},
        {
          lane: "inspection",
          deadlineMs: 100,
          signal: controller.signal,
        },
      ),
    ).resolves.toStrictEqual({ ok: true });
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    const listener = add.mock.calls[0]?.[1];
    expect(typeof listener).toBe("function");
    if (typeof listener === "function") {
      expect(() => {
        listener(new Event("abort"));
      }).not.toThrow();
    }
    controller.abort();
    expect(client.pendingCount()).toBe(0);
  });

  it("counts only inspections against the reserved control boundary", async () => {
    const source = new PassThrough({ objectMode: true });
    const client = createDapProtocolClient({ source, sendFrame: vi.fn() });
    const pending = [
      ...Array.from({ length: 4 }, () =>
        client.request("pause", {}, { lane: "control", deadlineMs: 10_000 }),
      ),
      ...Array.from({ length: 28 }, () =>
        client.request("variables", {}, { lane: "inspection", deadlineMs: 10_000 }),
      ),
    ];
    expect(client.pendingCount()).toBe(32);
    client.dispose();
    await Promise.allSettled(pending);
  });

  it("reports frame rejection and reverse-response write failure exactly once", async () => {
    const framed = new PassThrough({ objectMode: true });
    const frameFatal = vi.fn();
    createDapProtocolClient({ source: framed, sendFrame: vi.fn(), onFatalError: frameFatal });
    framed.destroy(new DapFrameRejectError("PAYLOAD_TOO_LARGE"));
    await vi.waitFor(() => {
      expect(frameFatal).toHaveBeenCalledTimes(1);
    });
    expect(frameFatal.mock.calls[0]?.[0]).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });

    const reverse = new PassThrough({ objectMode: true });
    const reverseFatal = vi.fn();
    const client = createDapProtocolClient({
      source: reverse,
      sendFrame: () => {
        throw new Error("private");
      },
      onFatalError: reverseFatal,
    });
    reverse.write(Buffer.from(JSON.stringify({ seq: 7, type: "request", command: "unknown" })));
    await vi.waitFor(() => {
      expect(reverseFatal).toHaveBeenCalledTimes(1);
    });
    expect(reverseFatal.mock.calls[0]?.[0]).toMatchObject({ code: "WRITE_FAILED" });
    await expect(
      client.request("threads", {}, { lane: "inspection", deadlineMs: 100 }),
    ).rejects.toMatchObject({ code: "CLIENT_DISPOSED" });
  });

  it("does not classify a non-stopped event carrying stopped-like data", async () => {
    const source = new PassThrough({ objectMode: true });
    const stopped = vi.fn();
    const generic = vi.fn();
    const client = createDapProtocolClient({ source, sendFrame: vi.fn() });
    client.onStopped(stopped);
    client.onEvent(generic);
    source.write(
      Buffer.from(
        JSON.stringify({
          seq: 1,
          type: "event",
          event: "continued",
          body: { reason: "breakpoint", threadId: 1, hitBreakpointIds: [2] },
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(generic).toHaveBeenCalledTimes(1);
    });
    expect(stopped).not.toHaveBeenCalled();
    expect(generic.mock.calls[0]?.[0]).toStrictEqual({
      seq: 1,
      type: "event",
      event: "continued",
      body: { reason: "breakpoint", threadId: 1, hitBreakpointIds: [2] },
    });
  });

  it("emits a closed reverse denial with a monotonic response sequence", async () => {
    const source = new PassThrough({ objectMode: true });
    const sent: string[] = [];
    createDapProtocolClient({ source, sendFrame: (body) => void sent.push(body) });
    source.write(Buffer.from(JSON.stringify({ seq: 9, type: "request", command: "unknown" })));
    source.write(Buffer.from(JSON.stringify({ seq: 10, type: "request", command: "other" })));
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(JSON.parse(sent[0] ?? "null")).toStrictEqual({
      seq: 1,
      type: "response",
      request_seq: 9,
      success: false,
      command: "unknown",
      message: "REVERSE_REQUEST_DENIED",
    });
    expect(JSON.parse(sent[1] ?? "null")).toMatchObject({
      seq: 2,
      request_seq: 10,
      command: "other",
    });
  });

  it("removes exactly the abort listener after settlement", async () => {
    const source = new PassThrough({ objectMode: true });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const client = createDapProtocolClient({
      source,
      sendFrame: () => {
        source.write(
          Buffer.from(
            JSON.stringify({
              seq: 2,
              type: "response",
              request_seq: 1,
              success: true,
              command: "threads",
            }),
          ),
        );
      },
    });
    await client.request(
      "threads",
      {},
      {
        lane: "inspection",
        deadlineMs: 100,
        signal: controller.signal,
      },
    );
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("does not turn deliberate disposal followed by EOF into a fatal error", async () => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    const client = createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });
    client.dispose();
    source.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fatal).not.toHaveBeenCalled();
  });

  it.each([
    [new DapProtocolError("WRITE_FAILED"), "WRITE_FAILED"],
    [new Error("private"), "UNEXPECTED_EOF"],
  ] as const)("maps a source failure to %s", async (failure, code) => {
    const source: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failure) }),
    };
    const fatal = vi.fn();
    createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code }));
    });
  });

  it("disposes after both source consumption and the fatal observer fail", async () => {
    const source: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("private source")) }),
    };
    const fatal = vi.fn(() => Promise.reject(new Error("private observer")));
    const client = createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });

    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: "UNEXPECTED_EOF" }),
      );
    });
    await vi.waitFor(async () => {
      await expect(
        client.request("threads", {}, { lane: "inspection", deadlineMs: 100 }),
      ).rejects.toMatchObject({ code: "CLIENT_DISPOSED" });
    });
  });

  it("disposes after both request writing and the fatal observer fail", async () => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn(() => Promise.reject(new Error("private observer")));
    const client = createDapProtocolClient({
      source,
      sendFrame: () => {
        throw new Error("private write");
      },
      onFatalError: fatal,
    });

    await expect(
      client.request("threads", {}, { lane: "inspection", deadlineMs: 100 }),
    ).rejects.toMatchObject({ code: "WRITE_FAILED" });
    await vi.waitFor(async () => {
      await expect(
        client.request("threads", {}, { lane: "inspection", deadlineMs: 100 }),
      ).rejects.toMatchObject({ code: "CLIENT_DISPOSED" });
    });
  });

  it("disposes after both reverse-response writing and the fatal observer fail", async () => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn(() => Promise.reject(new Error("private observer")));
    const client = createDapProtocolClient({
      source,
      sendFrame: () => {
        throw new Error("private write");
      },
      onFatalError: fatal,
    });
    source.write(Buffer.from(JSON.stringify({ seq: 1, type: "request", command: "unknown" })));

    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: "WRITE_FAILED" }),
      );
    });
    await vi.waitFor(async () => {
      await expect(
        client.request("threads", {}, { lane: "inspection", deadlineMs: 100 }),
      ).rejects.toMatchObject({ code: "CLIENT_DISPOSED" });
    });
  });

  it("rejects invalid UTF-8 even when replacement decoding would produce valid JSON", async () => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    const generic = vi.fn();
    const client = createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });
    client.onEvent(generic);
    source.write(
      Buffer.concat([
        Buffer.from('{"seq":1,"type":"event","event":"', "ascii"),
        Buffer.from([0xff]),
        Buffer.from('"}', "ascii"),
      ]),
    );
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: "MALFORMED_MESSAGE" }),
      );
    });
    expect(generic).not.toHaveBeenCalled();
  });

  it("does not reinterpret an unknown typed message as a reverse request", async () => {
    const source = new PassThrough({ objectMode: true });
    const send = vi.fn();
    const fatal = vi.fn();
    createDapProtocolClient({ source, sendFrame: send, onFatalError: fatal });
    source.write(
      Buffer.from(JSON.stringify({ seq: 1, type: "unknown", command: "runInTerminal" })),
    );
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: "MALFORMED_MESSAGE" }),
      );
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("starts only one fatal operation across concurrent write failures", async () => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn(() => new Promise<void>(() => undefined));
    const client = createDapProtocolClient({
      source,
      sendFrame: () => {
        throw new Error("private");
      },
      onFatalError: fatal,
    });
    const first = client.request("threads", {}, { lane: "inspection", deadlineMs: 100 });
    const second = client.request("pause", {}, { lane: "control", deadlineMs: 100 });
    await expect(first).rejects.toMatchObject({ code: "WRITE_FAILED" });
    await expect(second).rejects.toMatchObject({ code: "WRITE_FAILED" });
    expect(fatal).toHaveBeenCalledTimes(1);
  });

  it("disposes after fatal input even without a fatal callback", async () => {
    const source = new PassThrough({ objectMode: true });
    const client = createDapProtocolClient({ source, sendFrame: vi.fn() });
    source.end();
    await vi.waitFor(async () => {
      await expect(
        client.request("threads", {}, { lane: "inspection", deadlineMs: 100 }),
      ).rejects.toMatchObject({ code: "CLIENT_DISPOSED" });
    });
  });

  it("omits an absent event body and does not emit a typed stop", async () => {
    const source = new PassThrough({ objectMode: true });
    const generic = vi.fn();
    const stopped = vi.fn();
    const client = createDapProtocolClient({ source, sendFrame: vi.fn() });
    client.onEvent(generic);
    client.onStopped(stopped);
    source.write(Buffer.from(JSON.stringify({ seq: 1, type: "event", event: "continued" })));
    await vi.waitFor(() => {
      expect(generic).toHaveBeenCalledTimes(1);
    });
    expect(generic.mock.calls[0]?.[0]).toStrictEqual({
      seq: 1,
      type: "event",
      event: "continued",
    });
    expect(stopped).not.toHaveBeenCalled();
  });

  it("fails closed on invalid stopped bodies", async () => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    const stopped = vi.fn();
    const client = createDapProtocolClient({ source, sendFrame: vi.fn(), onFatalError: fatal });
    client.onStopped(stopped);
    for (const body of [null, "text"]) {
      source.write(Buffer.from(JSON.stringify({ seq: 1, type: "event", event: "stopped", body })));
    }
    await vi.waitFor(() => {
      expect(fatal).toHaveBeenCalledTimes(1);
    });
    expect(stopped).not.toHaveBeenCalled();
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "MALFORMED_MESSAGE" }));
  });

  it("does not report a successful reverse denial as fatal", async () => {
    const source = new PassThrough({ objectMode: true });
    const fatal = vi.fn();
    const sent: string[] = [];
    createDapProtocolClient({
      source,
      sendFrame: (body) => void sent.push(body),
      onFatalError: fatal,
    });
    source.write(Buffer.from(JSON.stringify({ seq: 1, type: "request", command: "unknown" })));
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(fatal).not.toHaveBeenCalled();
  });
});
