import { describe, expect, it } from "vitest";
import { createRecordingSink, recordingEventFor, recordingOps } from "./recording-log-sink.js";

// Generic fixture arms and an opaque marker, not registered Activity Log evidence.
// The consumer suites retain their actual normal/rejection transport and formatter proofs.
type FixtureEvent =
  | { readonly op: string; readonly outcome: "normal"; readonly value: number }
  | { readonly op: string; readonly outcome: "rejected"; readonly reason: string };

describe("recording log sink fixture", () => {
  it("keeps recorder instances independent and the same sink usable after clearing", () => {
    const first = createRecordingSink<FixtureEvent>();
    const second = createRecordingSink<FixtureEvent>();
    const event: FixtureEvent = { op: "fixture.first", outcome: "normal", value: 1 };
    const later: FixtureEvent = { op: "fixture.later", outcome: "normal", value: 2 };
    const sink = first.sink;

    sink.write(event);
    expect(first.events).toEqual([event]);
    expect(second.events).toEqual([]);
    expect(first.events).not.toBe(second.events);
    expect(first.sink).not.toBe(second.sink);
    first.events.length = 0;
    sink.write(later);
    expect(first.events).toEqual([later]);
    expect(first.events[0]).toBe(later);
    expect(second.events).toEqual([]);
  });

  it("retains both generic union arms and nonenumerable metadata by reference", () => {
    const log = createRecordingSink<FixtureEvent>();
    const normal: FixtureEvent = { op: "fixture.normal", outcome: "normal", value: 1 };
    const rejected: FixtureEvent = {
      op: "fixture.rejected",
      outcome: "rejected",
      reason: "fixture-refusal",
    };
    const marker = Symbol("opaque fixture metadata");
    const descriptor = {
      value: { registration: "fixture-only" },
      enumerable: false,
      writable: false,
      configurable: false,
    };
    Object.defineProperty(normal, marker, descriptor);
    Object.defineProperty(rejected, marker, descriptor);

    log.sink.write(normal);
    log.sink.write(rejected);

    expect(log.events[0]).toBe(normal);
    expect(log.events[1]).toBe(rejected);
    expect(
      Object.getOwnPropertyDescriptor(recordingEventFor(log.events, normal.op), marker),
    ).toEqual(descriptor);
    expect(
      Object.getOwnPropertyDescriptor(recordingEventFor(log.events, rejected.op), marker),
    ).toEqual(descriptor);
  });

  it("returns operation names in write order with repeated operations intact", () => {
    const log = createRecordingSink<FixtureEvent>();
    log.sink.write({ op: "fixture.first", outcome: "normal", value: 1 });
    log.sink.write({ op: "fixture.repeated", outcome: "normal", value: 2 });
    log.sink.write({ op: "fixture.repeated", outcome: "rejected", reason: "fixture-refusal" });
    log.sink.write({ op: "fixture.last", outcome: "normal", value: 3 });

    expect(recordingOps(log.events)).toEqual([
      "fixture.first",
      "fixture.repeated",
      "fixture.repeated",
      "fixture.last",
    ]);
  });

  it("returns the first matching object when later writes repeat its operation", () => {
    const log = createRecordingSink<FixtureEvent>();
    const first: FixtureEvent = { op: "fixture.repeated", outcome: "normal", value: 1 };
    const later: FixtureEvent = {
      op: "fixture.repeated",
      outcome: "rejected",
      reason: "fixture-refusal",
    };
    log.sink.write({ op: "fixture.other", outcome: "normal", value: 0 });
    log.sink.write(first);
    log.sink.write(later);

    expect(recordingEventFor(log.events, "fixture.repeated")).toBe(first);
    expect(recordingEventFor(log.events, "fixture.repeated")).not.toBe(later);
  });

  it("reports the exact missing-event error for an empty recorder", () => {
    const log = createRecordingSink<FixtureEvent>();
    const missing = (): FixtureEvent => recordingEventFor(log.events, "fixture.absent");

    expect(missing).toThrow(Error);
    expect(missing).toThrow(new Error("expected an event with op 'fixture.absent', saw: "));
  });

  it("reports the exact ordered operation list when a requested event is absent", () => {
    const log = createRecordingSink<FixtureEvent>();
    log.sink.write({ op: "fixture.first", outcome: "normal", value: 1 });
    log.sink.write({ op: "fixture.first", outcome: "normal", value: 2 });
    log.sink.write({ op: "fixture.last", outcome: "rejected", reason: "fixture-refusal" });
    const missing = (): FixtureEvent => recordingEventFor(log.events, "fixture.absent");

    expect(missing).toThrow(Error);
    expect(missing).toThrow(
      new Error(
        "expected an event with op 'fixture.absent', saw: fixture.first, fixture.first, fixture.last",
      ),
    );
  });
});
