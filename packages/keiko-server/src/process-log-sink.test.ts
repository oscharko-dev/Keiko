// The adapter every BFF composition site hands to a domain package. Two properties are
// load-bearing and both are invisible at the call sites that depend on them: the sink must reach
// whichever logger is installed AT WRITE TIME, and its level predicate must answer from that same
// logger rather than from a value frozen at import.

import { afterEach, describe, expect, it } from "vitest";

import {
  createBufferedServerLogSink,
  createServerLogger,
  nullServerLogSink,
  resetServerLogger,
  setServerLogger,
} from "./observability/index.js";
import { processServerLogSink } from "./process-log-sink.js";

afterEach(() => {
  resetServerLogger();
});

describe("processServerLogSink", () => {
  it("delivers a written event to the logger installed at write time", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));

    processServerLogSink().write({ category: "indexing", op: "indexing.job.started" });

    expect(sink.events).toEqual([
      {
        level: "info",
        category: "indexing",
        op: "indexing.job.started",
        correlationId: undefined,
        durationMs: undefined,
        status: undefined,
        errorKind: undefined,
        extra: undefined,
      },
    ]);
  });

  // The composition sites below call `processServerLogSink()` while the module graph is loading —
  // before the CLI has resolved the state directory and installed the real logger. A sink that
  // captured the logger at that moment would hold the null one forever and every line from a
  // six-minute indexing wall would be discarded with nothing to show for it.
  it("follows a logger replaced after the sink was already handed out", () => {
    setServerLogger(createServerLogger({ sink: nullServerLogSink(), level: "debug" }));
    const held = processServerLogSink();
    const later = createBufferedServerLogSink();

    setServerLogger(createServerLogger({ sink: later, level: "debug" }));
    held.write({ category: "embedding", op: "embedding.batch.grouped" });

    expect(later.events.map((event) => event.op)).toEqual(["embedding.batch.grouped"]);
  });

  it("carries the event's own level rather than defaulting every line to info", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const held = processServerLogSink();

    held.write({ level: "warn", category: "gateway", op: "gateway.route.rejected" });
    held.write({ level: "debug", category: "http", op: "http.gateway.fetch.completed" });

    expect(sink.events.map((event) => event.level)).toEqual(["warn", "debug"]);
  });

  it("answers the level predicate from the live logger threshold", () => {
    setServerLogger(createServerLogger({ sink: nullServerLogSink(), level: "warn" }));
    const held = processServerLogSink();

    expect(held.enabled("debug")).toBe(false);
    expect(held.enabled("warn")).toBe(true);

    setServerLogger(createServerLogger({ sink: nullServerLogSink(), level: "debug" }));

    expect(held.enabled("debug")).toBe(true);
  });

  it("drops a below-threshold event instead of writing it", () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "warn" }));

    processServerLogSink().write({ level: "debug", category: "search", op: "search.noisy" });

    expect(sink.events).toEqual([]);
  });
});
