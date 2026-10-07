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

// F9 (#3873): the cause of a run's last failed model call, kept apart from the lossy SSE replay so
// settlement can name it after every retained event has been demoted or evicted.
describe("CodingRuntimeEventHub model-call failure fact", () => {
  it("keeps the latest gateway failure of a run until a later model call is answered", () => {
    const hub = new CodingRuntimeEventHub({ maxEvents: 2 });
    expect(hub.lastModelCallFailure("run-a")).toBeUndefined();
    hub.publishTurnFailure("run-a", "running", 1, "provider-failed");
    hub.publishTurnFailure("run-a", "running", 1, "stream-incomplete");
    // A burst the bounded replay cannot hold still leaves the latest cause on record.
    for (let index = 0; index < 4; index += 1) {
      hub.publishTurnFailure("run-a", "running", 2, "turn-rejected");
    }
    expect(hub.lastModelCallFailure("run-a")).toBe("turn-rejected");
    expect(hub.lastModelCallFailure("run-b")).toBeUndefined();

    hub.noteModelCallAnswered("run-a");
    expect(hub.lastModelCallFailure("run-a")).toBeUndefined();
    hub.publishTurnFailure("run-a", "running", 3, "stream-incomplete");
    expect(hub.lastModelCallFailure("run-a")).toBe("stream-incomplete");
  });

  it("records nothing for a settled run and forgets a pruned one", () => {
    const hub = new CodingRuntimeEventHub();
    hub.publishTurnFailure("run-a", "running", 1, "stream-incomplete");
    hub.publish(terminal("run-a", 2));
    expect(hub.publishTurnFailure("run-a", "running", 3, "provider-failed")).toEqual({
      ok: false,
      reason: "terminal-run",
    });
    expect(hub.lastModelCallFailure("run-a")).toBe("stream-incomplete");
    hub.deleteRuns(["run-a"]);
    expect(hub.lastModelCallFailure("run-a")).toBeUndefined();
  });

  it("ignores a run id the replay itself would refuse", () => {
    const hub = new CodingRuntimeEventHub();
    expect(hub.publishTurnFailure("../run", "running", 1, "provider-failed").ok).toBe(false);
    expect(hub.lastModelCallFailure("../run")).toBeUndefined();
  });
});

// #3873 review: the Workbench's run status could not say that the model gateway was unavailable and
// being retried. The three gateway facts are ordinary frames of the run's replay.
describe("CodingRuntimeEventHub model gateway facts", () => {
  it("publishes the retrying, recovered and retry-stopped frames that replay in order, carrying nothing else", () => {
    const hub = new CodingRuntimeEventHub();
    expect(
      hub.publishModelGatewayFact("run-a", "running", 3, "model-gateway-retrying"),
    ).toMatchObject({
      ok: true,
      event: { kind: "runtime-event", sequence: 0, state: "running", revision: 3 },
    });
    hub.publishModelGatewayFact("run-a", "running", 3, "model-gateway-recovered");
    hub.publishModelGatewayFact("run-a", "running", 3, "model-gateway-retry-stopped");
    const replayed = hub.replay("run-a");
    expect(
      replayed.ok &&
        replayed.events.map((event) => event.kind === "runtime-event" && event.eventKind),
    ).toEqual(["model-gateway-retrying", "model-gateway-recovered", "model-gateway-retry-stopped"]);
    for (const event of replayed.ok ? replayed.events : []) {
      expect(Object.keys(event).sort()).toEqual([
        "cursor",
        "eventKind",
        "kind",
        "occurredAt",
        "revision",
        "runId",
        "schemaVersion",
        "sequence",
        "state",
      ]);
    }
  });

  it("fans a gateway fact out to a connected subscriber", () => {
    const hub = new CodingRuntimeEventHub();
    const received: string[] = [];
    hub.subscribe("run-a", undefined, {
      write: (event) => {
        if (event.kind === "runtime-event") received.push(event.eventKind);
        return true;
      },
      close: () => undefined,
    });
    hub.publishModelGatewayFact("run-a", "running", 1, "model-gateway-retrying");
    expect(received).toEqual(["model-gateway-retrying"]);
  });

  it("is no failure: it leaves the run's last model-call failure and its critical frames alone", () => {
    const hub = new CodingRuntimeEventHub({ maxEvents: 3 });
    const published = [
      hub.publishTurnFailure("run-a", "running", 1, "provider-failed"),
      hub.publishModelGatewayFact("run-a", "running", 1, "model-gateway-retrying"),
    ];
    expect(hub.lastModelCallFailure("run-a")).toBe("provider-failed");
    // A burst the replay cannot hold evicts the older ordinary frames and is never refused. Were a
    // gateway fact critical, the capacity reserved for the terminal fact would refuse the frames
    // that follow the second critical one instead of evicting anything.
    for (let index = 0; index < 6; index += 1) {
      published.push(hub.publishModelGatewayFact("run-a", "running", 1, "model-gateway-retrying"));
    }
    expect(published.map(({ ok }) => ok)).toEqual(Array.from({ length: 8 }, () => true));

    const replay = hub.replay("run-a");
    if (!replay.ok) throw new Error("expected a replay");
    // The retained turn failure and the newest retrying frames only: the five older ordinary frames
    // (sequences 1 to 5) are gone, and nothing but a gateway fact took their place.
    expect(replay.events).toMatchObject([
      { sequence: 0, eventKind: "failure-redacted", failureCode: "provider-failed" },
      { sequence: 6, eventKind: "model-gateway-retrying" },
      { sequence: 7, eventKind: "model-gateway-retrying" },
    ]);
    expect(hub.lastModelCallFailure("run-a")).toBe("provider-failed");
  });

  it("refuses a gateway fact for a settled run and for a run id the replay would refuse", () => {
    const hub = new CodingRuntimeEventHub();
    hub.publish(terminal("run-a", 4));
    expect(hub.publishModelGatewayFact("run-a", "running", 5, "model-gateway-retrying")).toEqual({
      ok: false,
      reason: "terminal-run",
    });
    expect(hub.publishModelGatewayFact("../run", "running", 1, "model-gateway-retrying").ok).toBe(
      false,
    );
  });

  // The Workbench names the gateway phase only while the retrying fact is the newest frame of the
  // run, so the publisher asks the hub the same question before it publishes the fact again.
  describe("modelGatewayRetrying", () => {
    it("is true only while the newest frame of the run is the retrying fact", () => {
      const hub = new CodingRuntimeEventHub();
      expect(hub.modelGatewayRetrying("run-a")).toBe(false);

      hub.publishModelGatewayFact("run-a", "running", 1, "model-gateway-retrying");
      expect(hub.modelGatewayRetrying("run-a")).toBe(true);

      hub.publish(status("run-a", 2));
      expect(hub.modelGatewayRetrying("run-a")).toBe(false);

      hub.publishModelGatewayFact("run-a", "running", 2, "model-gateway-retrying");
      expect(hub.modelGatewayRetrying("run-a")).toBe(true);
    });

    it.each(["model-gateway-recovered", "model-gateway-retry-stopped"] as const)(
      "is false once the %s fact follows the retrying one",
      (closing) => {
        const hub = new CodingRuntimeEventHub();
        hub.publishModelGatewayFact("run-a", "running", 1, "model-gateway-retrying");
        hub.publishModelGatewayFact("run-a", "running", 1, closing);
        expect(hub.modelGatewayRetrying("run-a")).toBe(false);
      },
    );

    it("is false after a turn failure follows the retrying fact, and keeps each run apart", () => {
      const hub = new CodingRuntimeEventHub();
      hub.publishModelGatewayFact("run-a", "running", 1, "model-gateway-retrying");
      hub.publishModelGatewayFact("run-b", "running", 1, "model-gateway-retrying");
      hub.publishTurnFailure("run-a", "running", 1, "provider-failed");

      expect(hub.modelGatewayRetrying("run-a")).toBe(false);
      expect(hub.modelGatewayRetrying("run-b")).toBe(true);
    });

    it("is false for a run the replay forgot", () => {
      const hub = new CodingRuntimeEventHub();
      hub.publishModelGatewayFact("run-a", "running", 1, "model-gateway-retrying");
      hub.deleteRuns(["run-a"]);
      expect(hub.modelGatewayRetrying("run-a")).toBe(false);
    });
  });
});

// F10 (#3873 review): `provider-failed` names a provider that rejected a turn and one that stayed
// unavailable alike. The gateway's own fact that the provider could not serve the call is kept beside
// the cause, never in the public frame, so a run that ends on it can be named for the outage.
describe("CodingRuntimeEventHub provider-unavailable fact", () => {
  it("keeps the gateway's outage fact of the latest failed call, and replaces it with the next one", () => {
    const hub = new CodingRuntimeEventHub();
    expect(hub.lastModelCallProviderUnavailable("run-a")).toBe(false);

    hub.publishTurnFailure("run-a", "running", 1, "provider-failed", { providerUnavailable: true });
    expect(hub.lastModelCallFailure("run-a")).toBe("provider-failed");
    expect(hub.lastModelCallProviderUnavailable("run-a")).toBe(true);
    expect(hub.lastModelCallProviderUnavailable("run-b")).toBe(false);

    // The next failed call states its own: a rejection after an outage is no outage.
    hub.publishTurnFailure("run-a", "running", 2, "provider-failed", {
      providerUnavailable: false,
    });
    expect(hub.lastModelCallProviderUnavailable("run-a")).toBe(false);
    hub.publishTurnFailure("run-a", "running", 3, "provider-failed", { providerUnavailable: true });
    // A failure published without the fact (any caller that predates it) names no outage.
    hub.publishTurnFailure("run-a", "running", 4, "provider-failed");
    expect(hub.lastModelCallProviderUnavailable("run-a")).toBe(false);
  });

  it("forgets the fact once a later model call of the run is answered, and with a pruned run", () => {
    const hub = new CodingRuntimeEventHub();
    hub.publishTurnFailure("run-a", "running", 1, "provider-failed", { providerUnavailable: true });
    hub.noteModelCallAnswered("run-a");
    expect(hub.lastModelCallProviderUnavailable("run-a")).toBe(false);

    hub.publishTurnFailure("run-a", "running", 2, "provider-failed", { providerUnavailable: true });
    hub.deleteRuns(["run-a"]);
    expect(hub.lastModelCallProviderUnavailable("run-a")).toBe(false);
  });

  it("records nothing for a settled run or for a run id the replay would refuse", () => {
    const hub = new CodingRuntimeEventHub();
    hub.publishTurnFailure("run-a", "running", 1, "provider-failed", {
      providerUnavailable: false,
    });
    hub.publish(terminal("run-a", 2));
    hub.publishTurnFailure("run-a", "running", 3, "provider-failed", { providerUnavailable: true });
    expect(hub.lastModelCallProviderUnavailable("run-a")).toBe(false);

    hub.publishTurnFailure("../run", "running", 1, "provider-failed", {
      providerUnavailable: true,
    });
    expect(hub.lastModelCallProviderUnavailable("../run")).toBe(false);
  });

  it("never puts the fact in the public frame", () => {
    const hub = new CodingRuntimeEventHub();
    hub.publishTurnFailure("run-a", "running", 1, "provider-failed", { providerUnavailable: true });
    const replay = hub.replay("run-a");
    if (!replay.ok) throw new Error("expected a replay");
    expect(replay.events).toHaveLength(1);
    expect(JSON.stringify(replay.events)).not.toContain("providerUnavailable");
    expect(replay.events[0]).toMatchObject({
      eventKind: "failure-redacted",
      failureCode: "provider-failed",
    });
  });
});

describe("CodingRuntimeEventHub", () => {
  it("retains every redacted gateway failure when separate turns share a task revision", () => {
    const hub = new CodingRuntimeEventHub({ maxEvents: 3 });
    expect(hub.publishTurnFailure("run-a", "running", 1, "provider-failed")).toMatchObject({
      ok: true,
    });
    expect(hub.publishTurnFailure("run-a", "running", 1, "stream-incomplete")).toMatchObject({
      ok: true,
    });
    const replay = hub.replay("run-a");
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.events).toMatchObject([
      {
        kind: "runtime-event",
        eventKind: "failure-redacted",
        failureCode: "provider-failed",
      },
      {
        kind: "runtime-event",
        eventKind: "failure-redacted",
        failureCode: "stream-incomplete",
      },
    ]);
  });

  it("distinguishes terminal and capacity rejection of a turn failure", () => {
    const capacity = new CodingRuntimeEventHub({ maxEvents: 1 });
    expect(capacity.publishTurnFailure("run-a", "running", 1, "provider-failed")).toEqual({
      ok: false,
      reason: "capacity-pressure",
    });
    const terminalHub = new CodingRuntimeEventHub();
    terminalHub.publish(terminal("run-a", 1));
    expect(terminalHub.publishTurnFailure("run-a", "running", 2, "provider-failed")).toEqual({
      ok: false,
      reason: "terminal-run",
    });
  });

  it("retains a later approval after a burst of turn failures", () => {
    const hub = new CodingRuntimeEventHub({ maxEvents: 4 });
    const received: CodingRuntimeEventHubInput[] = [];
    const subscribed = hub.subscribe("run-a", undefined, {
      write: (event): boolean => {
        received.push(event);
        return true;
      },
      close: (): void => undefined,
    });
    expect(subscribed.ok).toBe(true);
    for (let index = 0; index < 10; index += 1) {
      expect(hub.publishTurnFailure("run-a", "running", 1, "provider-failed").ok).toBe(true);
    }
    expect(hub.publish(approval("run-a", 2)).ok).toBe(true);
    const replay = hub.replay("run-a");
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(
      replay.events.some(
        (event) => event.kind === "runtime-event" && event.eventKind === "permission-requested",
      ),
    ).toBe(true);
    expect(
      received.some(
        (event) => event.kind === "runtime-event" && event.eventKind === "permission-requested",
      ),
    ).toBe(true);
  });

  // #3593: an approval published while no browser is connected is not lost. The hub retains it, and
  // the first subscriber that connects afterwards receives it once, ahead of the live events.
  it("delivers an approval published with no subscriber to the next one that connects", () => {
    const hub = new CodingRuntimeEventHub();
    expect(hub.publish(approval("run-a", 1)).ok).toBe(true);
    const received: CodingRuntimeEventHubInput[] = [];
    const subscribed = hub.subscribe("run-a", undefined, {
      write: (event): boolean => {
        received.push(event);
        return true;
      },
      close: (): void => undefined,
    });
    expect(subscribed.ok).toBe(true);
    expect(hub.publish(status("run-a", 2)).ok).toBe(true);
    expect(
      received.map((event) => (event.kind === "runtime-event" ? event.eventKind : event.state)),
    ).toEqual(["permission-requested", "running"]);
  });

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

describe("CodingRuntimeEventHub safe verifier facts", () => {
  it("retains measured verifier checks in bounded replay and rejects content-bearing metadata", () => {
    const hub = new CodingRuntimeEventHub();
    const verificationSummary = {
      verifierId: "targeted-test" as const,
      status: "failed" as const,
      passedCount: 0,
      failedCount: 1,
      skippedCount: 0,
      durationMs: 1240.5,
    };
    const input: CodingRuntimeEventHubInput = {
      ...status("run-verifier", 1),
      kind: "runtime-event",
      eventKind: "verification-summarized",
      verificationSummary,
    };
    expect(hub.publish(input)).toMatchObject({ ok: true, event: { verificationSummary } });
    expect(hub.replay("run-verifier")).toMatchObject({
      ok: true,
      events: [{ verificationSummary }],
    });
    const contentBearing = {
      ...input,
      verificationSummary: { ...verificationSummary, stdout: "private verifier output" },
    };
    expect(hub.publish(contentBearing)).toMatchObject({ ok: false });
  });
});

describe("CodingRuntimeEventHub verifier metadata ownership", () => {
  it("owns a validated snapshot instead of retaining mutable input or replay metadata", () => {
    const hub = new CodingRuntimeEventHub();
    const verificationSummary = {
      verifierId: "targeted-test" as const,
      status: "failed" as const,
      passedCount: 0,
      failedCount: 1,
      skippedCount: 0,
      durationMs: 1240.5,
    };
    const published = hub.publish({
      ...status("run-1986", 1),
      kind: "runtime-event",
      eventKind: "verification-summarized",
      verificationSummary,
    });
    if (!published.ok || published.event.kind !== "runtime-event") {
      throw new Error("expected a published verifier event");
    }
    const encoded = JSON.stringify(published.event);
    const encodedBytes = Buffer.byteLength(encoded, "utf8");
    verificationSummary.failedCount = 99;
    verificationSummary.durationMs = Number.NaN;
    Object.assign(verificationSummary, { stdout: "UNVALIDATED_PRIVATE_CANARY" });
    expect(published.event.verificationSummary).toEqual({
      verifierId: "targeted-test",
      status: "failed",
      passedCount: 0,
      failedCount: 1,
      skippedCount: 0,
      durationMs: 1240.5,
    });
    expect(hub.replay("run-1986")).toMatchObject({
      ok: true,
      events: [{ verificationSummary: { failedCount: 1, durationMs: 1240.5 } }],
    });
    expect(JSON.stringify(published.event)).toBe(encoded);
    expect(Buffer.byteLength(JSON.stringify(published.event), "utf8")).toBe(encodedBytes);
    expect(JSON.stringify(hub.replay("run-1986"))).not.toContain("UNVALIDATED_PRIVATE_CANARY");
    const ownedSummary = published.event.verificationSummary;
    if (ownedSummary === undefined) throw new Error("expected verifier metadata");
    expect(Reflect.set(ownedSummary, "stdout", "UNVALIDATED_PRIVATE_CANARY")).toBe(false);
    expect(Reflect.set(published.event, "revision", 99)).toBe(false);
  });
});
