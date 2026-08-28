import { describe, expect, it } from "vitest";

import {
  CODING_RUNTIME_EVENT_HUB_MAX_BYTES,
  CodingRuntimeEventHub,
  type CodingRuntimeEventHubInput,
} from "./codingRuntimeEventHub.js";

const status = (runId: string, revision: number): CodingRuntimeEventHubInput => ({
  schemaVersion: "1",
  kind: "status",
  runId,
  state: "running",
  revision,
});

const approval = (runId: string, revision: number): CodingRuntimeEventHubInput => ({
  schemaVersion: "1",
  kind: "runtime-event",
  runId,
  state: "awaiting-approval",
  revision,
  eventKind: "permission-requested",
});

const terminal = (runId: string, revision: number): CodingRuntimeEventHubInput => ({
  schemaVersion: "1",
  kind: "runtime-event",
  runId,
  state: "succeeded",
  revision,
  eventKind: "runtime-stopped",
});

const recovery = (runId: string, revision: number): CodingRuntimeEventHubInput => ({
  schemaVersion: "1",
  kind: "status",
  runId,
  state: "recovery-required",
  revision,
  failureCode: "recovery-required",
});

describe("CodingRuntimeEventHub", () => {
  it("replays approval and terminal facts exactly once across three forced reconnects", () => {
    const hub = new CodingRuntimeEventHub();
    const first = hub.publish(approval("run-a", 1));
    const end = hub.publish(terminal("run-a", 2));
    expect(first.ok && end.ok).toBe(true);
    if (!first.ok || !end.ok) return;

    let cursor: string | undefined;
    const received: string[] = [];
    for (let reconnect = 0; reconnect < 3; reconnect += 1) {
      const replay = hub.replay("run-a", cursor);
      expect(replay.ok).toBe(true);
      if (!replay.ok) return;
      received.push(...replay.events.map((event) => event.cursor));
      cursor = replay.events.at(-1)?.cursor ?? cursor;
    }
    expect(received).toEqual([first.event.cursor, end.event.cursor]);
  });

  it("admits the content-free auxiliary facts produced by research, skill, and child events", () => {
    const hub = new CodingRuntimeEventHub();
    const inputs: readonly CodingRuntimeEventHubInput[] = [
      {
        schemaVersion: "1",
        kind: "runtime-event",
        runId: "run-a",
        state: "running",
        revision: 1,
        eventKind: "research-performed",
        auxiliaryOutcome: "accepted",
        contentTrust: "untrusted",
      },
      {
        schemaVersion: "1",
        kind: "runtime-event",
        runId: "run-a",
        state: "running",
        revision: 1,
        eventKind: "skill-invoked",
        auxiliaryOutcome: "accepted",
      },
      {
        schemaVersion: "1",
        kind: "runtime-event",
        runId: "run-a",
        state: "running",
        revision: 1,
        eventKind: "child-run-completed",
        auxiliaryOutcome: "accepted",
      },
    ];

    const results = inputs.map((input) => hub.publish(input));

    expect(results.every(({ ok }) => ok)).toBe(true);
    const replay = hub.replay("run-a");
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.events).toMatchObject(inputs);
  });

  it("rejects auxiliary facts that violate their event-specific provenance contract", () => {
    const hub = new CodingRuntimeEventHub();

    expect(
      hub.publish({
        schemaVersion: "1",
        kind: "runtime-event",
        runId: "run-a",
        state: "running",
        revision: 1,
        eventKind: "skill-invoked",
        auxiliaryOutcome: "accepted",
        contentTrust: "untrusted",
      }),
    ).toEqual({ ok: false, reason: "invalid-event" });
  });

  it("keeps a 1,000-event burst inside both replay bounds", () => {
    const hub = new CodingRuntimeEventHub();
    for (let index = 0; index < 1_000; index += 1)
      expect(hub.publish(status("run-a", index)).ok).toBe(true);
    const replay = hub.replay("run-a");
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.events).toHaveLength(256);
    expect(Buffer.byteLength(JSON.stringify(replay.events), "utf8")).toBeLessThanOrEqual(
      CODING_RUNTIME_EVENT_HUB_MAX_BYTES,
    );
  });

  it("returns deterministic reset results for malformed, future, evicted, and foreign cursors", () => {
    const hub = new CodingRuntimeEventHub({ maxEvents: 2 });
    const one = hub.publish(status("run-a", 1));
    hub.publish(status("run-a", 2));
    hub.publish(status("run-a", 3));
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(hub.replay("run-a", "not-a-cursor")).toMatchObject({
      ok: false,
      reason: "cursor-malformed",
      snapshotNeeded: true,
    });
    expect(hub.replay("run-a", "run-a:99")).toMatchObject({ ok: false, reason: "cursor-future" });
    expect(hub.replay("run-a", one.event.cursor)).toMatchObject({
      ok: false,
      reason: "cursor-evicted",
    });
    expect(hub.replay("run-b", one.event.cursor)).toMatchObject({
      ok: false,
      reason: "cursor-foreign",
    });
  });

  it("closes slow subscribers and reserves critical capacity for the terminal fact", () => {
    const hub = new CodingRuntimeEventHub({ maxEvents: 2 });
    let closes = 0;
    expect(
      hub.subscribe("run-a", undefined, {
        write: () => false,
        close: () => {
          closes += 1;
        },
      }).ok,
    ).toBe(true);
    hub.publish(status("run-a", 1));
    expect(closes).toBe(1);
    expect(hub.publish(approval("run-a", 2)).ok).toBe(true);
    expect(
      hub.publish({ ...approval("run-a", 3), failureCode: "recovery-required" }),
    ).toMatchObject({
      ok: false,
      reason: "capacity-pressure",
    });
    expect(hub.publish(terminal("run-a", 4)).ok).toBe(true);
    const replay = hub.replay("run-a");
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.events.some((event) => event.state === "succeeded")).toBe(true);
  });

  it("admits recovery-required containment after critical capacity saturation", () => {
    const hub = new CodingRuntimeEventHub({ maxEvents: 2 });
    expect(hub.publish(approval("run-a", 1)).ok).toBe(true);
    expect(hub.publish(approval("run-a", 2))).toMatchObject({
      ok: false,
      reason: "capacity-pressure",
    });
    expect(hub.publish(recovery("run-a", 3)).ok).toBe(true);
    const replay = hub.replay("run-a");
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(
      replay.events.some(
        (event) => event.state === "recovery-required" && event.failureCode === "recovery-required",
      ),
    ).toBe(true);
  });

  // KEIKO-0796: makeCapacity()'s reservation heuristic (`sum(existing critical bytes) +
  // incoming.bytes * 2 > maxBytes`) is exact only when critical events are comparably sized. This
  // pins the boundary the heuristic is exact for: two same-sized critical (non-containment) events
  // that saturate the reservation exactly, followed by a same-class containment fact (the terminal
  // event serializes a few bytes smaller than the approval events here, not byte-identical) that
  // must still be admitted because containment events bypass the ×2 reservation check entirely.
  it("admits a same-class containment fact even though critical events have saturated the byte reservation", () => {
    const now = (): Date => new Date("2024-01-01T00:00:00.000Z");

    // Derive the reservation boundary from the hub's own accounting instead of restating its byte
    // formula: measure one critical event's serialized size the same way makeCapacity() does.
    const probe = new CodingRuntimeEventHub({ now });
    expect(probe.publish(approval("run-a", 1)).ok).toBe(true);
    const probeInternals = probe as unknown as {
      runs: Map<string, { events: readonly { bytes: number }[] }>;
    };
    const criticalEventBytes = probeInternals.runs.get("run-a")?.events[0]?.bytes;
    if (criticalEventBytes === undefined)
      throw new Error("test setup failed to measure event size");

    // Two same-sized critical (non-containment) events exactly saturate the reservation
    // (sum(existing) + incoming.bytes * 2 === maxBytes); a third of the same size is rejected.
    const maxBytes = criticalEventBytes * 3;
    const hub = new CodingRuntimeEventHub({ maxEvents: 10, maxBytes, now });
    expect(hub.publish(approval("run-a", 1)).ok).toBe(true);
    expect(hub.publish(approval("run-a", 2)).ok).toBe(true);
    expect(hub.publish(approval("run-a", 3))).toMatchObject({
      ok: false,
      reason: "capacity-pressure",
    });

    // The terminal containment fact must still be admitted at the exact same saturation point: it
    // is never subject to the ×2 reservation heuristic that guards non-containment critical events.
    expect(hub.publish(terminal("run-a", 4)).ok).toBe(true);
    const replay = hub.replay("run-a");
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.events.some((event) => event.state === "succeeded")).toBe(true);
  });

  it("fails closed before sequence overflow and isolates cursors by run", () => {
    const hub = new CodingRuntimeEventHub();
    const event = hub.publish(status("run-a", 1));
    expect(event.ok).toBe(true);
    if (!event.ok) return;
    expect(hub.replay("run-b", event.event.cursor)).toMatchObject({
      ok: false,
      reason: "cursor-foreign",
    });
    const internals = hub as unknown as { runs: Map<string, { nextSequence: number }> };
    const run = internals.runs.get("run-a");
    if (run === undefined) throw new Error("test setup failed to create run");
    run.nextSequence = Number.MAX_SAFE_INTEGER;
    expect(hub.publish(status("run-a", 2))).toMatchObject({
      ok: false,
      reason: "sequence-exhausted",
    });
  });

  it("deletes pruned run replay buffers and closes their subscribers", () => {
    const hub = new CodingRuntimeEventHub();
    hub.publish(status("run-a", 1));
    let closed = false;
    hub.subscribe("run-a", undefined, {
      write: () => true,
      close: () => {
        closed = true;
      },
    });

    hub.deleteRuns(["run-a"]);

    expect(closed).toBe(true);
    expect(hub.replay("run-a")).toEqual({ ok: true, events: [] });
  });

  // Regression: KEIKO-0225. Previously the bare `catch { close(subscriber); return false; }`
  // in write() swallowed both a throwing subscriber and a `false`-returning subscriber (SSE
  // backpressure) with zero diagnostic — the operator saw a dropped stream with nothing to
  // trace. With `diagnostics` wired, both paths emit one redacted, correlationId-bearing record.
  it("records a redacted diagnostic when a subscriber's write throws", () => {
    const records: unknown[] = [];
    const hub = new CodingRuntimeEventHub({
      diagnostics: { record: (record): void => void records.push(record) },
    });
    hub.subscribe("run-diag", undefined, {
      write: (): boolean => {
        throw new Error("STREAM_SECRET_UPSTREAM_FAILURE");
      },
      close: (): void => undefined,
    });
    hub.publish(status("run-diag", 1));
    expect(records).toEqual([
      expect.objectContaining({
        correlationId: "run-diag",
        operation: "coding-runtime.sse-fanout",
        source: "coding-runtime-event-hub.write",
        errorClass: "Error",
        message: "sse-subscriber-write-failed",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("STREAM_SECRET");
  });

  it("records a redacted diagnostic when a subscriber returns false for backpressure", () => {
    const records: unknown[] = [];
    const hub = new CodingRuntimeEventHub({
      diagnostics: { record: (record): void => void records.push(record) },
    });
    hub.subscribe("run-back", undefined, {
      write: (): boolean => false,
      close: (): void => undefined,
    });
    hub.publish(status("run-back", 1));
    expect(records).toEqual([
      expect.objectContaining({
        correlationId: "run-back",
        source: "coding-runtime-event-hub.write",
        message: "sse-backpressure",
      }),
    ]);
  });
});
