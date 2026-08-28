// User finding #2456 — the desktop wake-up replay burst. `handleAllRunEvents` used to attach every
// snapshot run with `attach(writer, -1)` (full ring-buffer replay) on EVERY connection, so a tab
// re-opening its shared stream after visibility-hidden re-downloaded up to 128 runs' buffers just
// to have the client discard nearly all of it. The route now honours an optional `resume` query
// parameter (comma-separated `runId:seq` pairs): a named run replays only `seq > cursor`, an
// unnamed run attaches live-only (the client keeps no subscriber for it at reopen time), and a
// malformed cursor fails toward FULL replay (over-delivery — the client dedupes; under-delivery
// would lose events). Absent `resume`, behaviour is byte-identical to before (full replay), pinned
// here. Kept in its own file for the same reason as `run-handlers-sse-backpressure.test.ts`: these
// tests call the handler directly against hand-built doubles and never bind a real socket, so
// sharing `run-handlers.test.ts`'s real bound HTTP server lifecycle would be a foreign,
// non-hermetic dependency.

import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";

import { buildRedactor, createRunRegistry, QueueEventSink } from "./index.js";
import { handleAllRunEvents } from "./run-handlers.js";
import type { StreamEvent } from "./sink.js";
import type { RouteContext } from "./routes.js";
import type { UiHandlerDeps } from "./deps.js";
import { createInMemoryUiStore } from "./store/index.js";
import {
  createBufferedServerLogSink,
  createServerLogger,
  resetServerLogger,
  setServerLogger,
  type BufferedServerLogSink,
} from "./observability/index.js";

// An ACCEPTING `ServerResponse` double that records every frame it is handed (the frame-recording
// of `run-handlers-sse-backpressure.test.ts`'s double, the accepting `write` of
// `run-handlers-sse-correlation.test.ts`'s), so a test can assert exactly which buffered events
// were replayed onto the wire.
function recordingFakeRes(): {
  res: RouteContext["res"];
  fireClose: () => void;
  readonly frames: readonly string[];
} {
  const emitter = new EventEmitter();
  const frames: string[] = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    write: (chunk: string): boolean => {
      frames.push(chunk);
      return true;
    },
    writeHead: (): void => undefined,
    end: (): void => undefined,
    destroy: (): void => undefined,
    on: (event: string, handler: (...args: unknown[]) => void): void => {
      emitter.on(event, handler);
    },
  } as unknown as RouteContext["res"];
  return {
    res,
    frames,
    fireClose: (): void => {
      emitter.emit("close");
    },
  };
}

function fakeReq(): RouteContext["req"] {
  return { headers: {}, on: (): void => undefined } as unknown as RouteContext["req"];
}

function minimalDeps(registry: ReturnType<typeof createRunRegistry>): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry,
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
  };
}

function captureServerLog(): BufferedServerLogSink {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  return sink;
}

const FIXED_EVENT_TS = 1_700_000_000_000;

function streamEvent(runId: string, seq: number): StreamEvent {
  return {
    schemaVersion: "1",
    runId,
    fingerprint: `fp-${runId}`,
    seq,
    ts: FIXED_EVENT_TS,
    type: "workflow:progress",
  };
}

// A registered run whose sink is pre-loaded with `seqs` — the "snapshot run with history" shape
// every test here starts from.
function registerRunWithEvents(
  registry: ReturnType<typeof createRunRegistry>,
  runId: string,
  seqs: readonly number[],
): QueueEventSink {
  const sink = new QueueEventSink();
  for (const seq of seqs) {
    sink.emit(streamEvent(runId, seq));
  }
  registry.register({
    runId,
    fingerprint: `fp-${runId}`,
    modelId: "test-model",
    sink,
    cancel: () => undefined,
  });
  return sink;
}

// Every `data:` payload that carries a runId/seq (the `ready` frame's `{}` does not), in wire order.
function deliveredEvents(frames: readonly string[]): readonly { runId: string; seq: number }[] {
  const delivered: { runId: string; seq: number }[] = [];
  for (const frame of frames) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine === undefined) continue;
    const parsed = JSON.parse(dataLine.slice("data: ".length)) as { runId?: string; seq?: number };
    if (typeof parsed.runId === "string" && typeof parsed.seq === "number") {
      delivered.push({ runId: parsed.runId, seq: parsed.seq });
    }
  }
  return delivered;
}

function seqsFor(frames: readonly string[], runId: string): readonly number[] {
  return deliveredEvents(frames)
    .filter((event) => event.runId === runId)
    .map((event) => event.seq);
}

function connect(
  registry: ReturnType<typeof createRunRegistry>,
  url: string,
): { deps: UiHandlerDeps; frames: readonly string[]; fireClose: () => void } {
  const deps = minimalDeps(registry);
  const { res, frames, fireClose } = recordingFakeRes();
  const ctx: RouteContext = {
    req: fakeReq(),
    res,
    params: {},
    url: new URL(url),
    correlationId: "corr-resume-1",
  };
  handleAllRunEvents(ctx, deps);
  return { deps, frames, fireClose };
}

afterEach(() => {
  resetServerLogger();
});

describe("GET /api/runs/events resume cursors (user finding #2456)", () => {
  it("falls back to full replay when resume is present but carries no usable pair", () => {
    // A present-but-empty `resume=` (or one made only of empty entries, e.g. `resume=,,`) must
    // fail toward the SAME safe default as an absent parameter — full replay for every run — not
    // toward the "unnamed run" live-only branch. An empty (but defined) cursors Map would make
    // every snapshot run look "unnamed" to resumeAfterSeq and silently drop its replay.
    const registry = createRunRegistry();
    registerRunWithEvents(registry, "run-a", [0, 1, 2]);
    const { deps, frames, fireClose } = connect(
      registry,
      "http://localhost/api/runs/events?resume=",
    );

    expect(seqsFor(frames, "run-a")).toEqual([0, 1, 2]);
    fireClose();
    deps.store.close();
  });

  it("pin: without a resume parameter every snapshot run gets its full buffer replayed", () => {
    const registry = createRunRegistry();
    registerRunWithEvents(registry, "run-a", [0, 1, 2]);
    const { deps, frames, fireClose } = connect(registry, "http://localhost/api/runs/events");

    expect(seqsFor(frames, "run-a")).toEqual([0, 1, 2]);
    fireClose();
    deps.store.close();
  });

  it("replays only events past the cursor for a named run, then still delivers live events", () => {
    const registry = createRunRegistry();
    const sink = registerRunWithEvents(registry, "run-a", [0, 1, 2]);
    const { deps, frames, fireClose } = connect(
      registry,
      "http://localhost/api/runs/events?resume=run-a:1",
    );

    expect(seqsFor(frames, "run-a")).toEqual([2]);
    sink.emit(streamEvent("run-a", 3));
    expect(seqsFor(frames, "run-a")).toEqual([2, 3]);
    fireClose();
    deps.store.close();
  });

  it("attaches a run NOT named by a present resume parameter live-only (no replay)", () => {
    const registry = createRunRegistry();
    registerRunWithEvents(registry, "run-a", [0, 1, 2]);
    const sinkB = registerRunWithEvents(registry, "run-b", [0, 1]);
    const { deps, frames, fireClose } = connect(
      registry,
      "http://localhost/api/runs/events?resume=run-a:2",
    );

    expect(seqsFor(frames, "run-b")).toEqual([]);
    sinkB.emit(streamEvent("run-b", 2));
    expect(seqsFor(frames, "run-b")).toEqual([2]);
    fireClose();
    deps.store.close();
  });

  it("fails a malformed cursor toward FULL replay while honoring valid entries beside it", () => {
    const registry = createRunRegistry();
    registerRunWithEvents(registry, "run-a", [0, 1, 2]);
    registerRunWithEvents(registry, "run-b", [0, 1, 2]);
    const { deps, frames, fireClose } = connect(
      registry,
      "http://localhost/api/runs/events?resume=run-a:oops,run-b:1",
    );

    expect(seqsFor(frames, "run-a")).toEqual([0, 1, 2]);
    expect(seqsFor(frames, "run-b")).toEqual([2]);
    fireClose();
    deps.store.close();
  });

  it("replays a run named with the '*' full-replay marker in full", () => {
    // The client names a SUBSCRIBED run it has not observed yet with `*`: it needs the whole
    // buffer. Only an unnamed run — one the client no longer follows — may attach live-only.
    const registry = createRunRegistry();
    registerRunWithEvents(registry, "run-a", [0, 1, 2]);
    registerRunWithEvents(registry, "run-b", [0, 1, 2]);
    const { deps, frames, fireClose } = connect(
      registry,
      "http://localhost/api/runs/events?resume=run-a:1,run-b:*",
    );

    expect(seqsFor(frames, "run-a")).toEqual([2]);
    expect(seqsFor(frames, "run-b")).toEqual([0, 1, 2]);
    fireClose();
    deps.store.close();
  });

  it("gives a run registered AFTER connect full replay even when the resume parameter names it", () => {
    const registry = createRunRegistry();
    const { deps, frames, fireClose } = connect(
      registry,
      "http://localhost/api/runs/events?resume=late-run:5",
    );

    registerRunWithEvents(registry, "late-run", [0, 1, 2]);
    expect(seqsFor(frames, "late-run")).toEqual([0, 1, 2]);
    fireClose();
    deps.store.close();
  });

  it("decodes percent-encoded runIds so a resumed run with reserved characters still matches", () => {
    const registry = createRunRegistry();
    registerRunWithEvents(registry, "run a:b", [0, 1, 2]);
    const { deps, frames, fireClose } = connect(
      registry,
      "http://localhost/api/runs/events?resume=run%20a%3Ab:1",
    );

    expect(seqsFor(frames, "run a:b")).toEqual([2]);
    fireClose();
    deps.store.close();
  });

  it("emits one body-free sse.run-events.resume line counting each attach decision", () => {
    const logSink = captureServerLog();
    const registry = createRunRegistry();
    registerRunWithEvents(registry, "run-resumed", [0, 1]);
    registerRunWithEvents(registry, "run-unnamed", [0]);
    registerRunWithEvents(registry, "run-malformed", [0]);
    const { deps, fireClose } = connect(
      registry,
      "http://localhost/api/runs/events?resume=run-resumed:0,run-malformed:bad",
    );

    const line = logSink.events.find((event) => event.op === "sse.run-events.resume");
    expect(line).toBeDefined();
    expect(line?.category).toBe("http");
    expect(line?.correlationId).toBe("corr-resume-1");
    expect(line?.extra).toEqual({ resumedRuns: 1, liveOnlyRuns: 1, fullReplayRuns: 1 });
    fireClose();
    deps.store.close();
  });

  it("emits no resume line when the parameter is absent (behaviour unchanged)", () => {
    const logSink = captureServerLog();
    const registry = createRunRegistry();
    registerRunWithEvents(registry, "run-a", [0]);
    const { deps, fireClose } = connect(registry, "http://localhost/api/runs/events");

    expect(logSink.events.some((event) => event.op === "sse.run-events.resume")).toBe(false);
    fireClose();
    deps.store.close();
  });
});
