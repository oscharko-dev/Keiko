// Stamps every harness event with run identity, a monotonic seq, and a clock timestamp,
// then forwards it to the sink. SENSITIVE fields (rationale, modelResponse, diff) are
// redacted before forwarding UNLESS the sink retains raw content for replay (ADR-0004 D6).

import { redact } from "../gateway/redaction.js";
import type { Clock } from "../gateway/types.js";
import type { EventSink } from "./ports.js";
import type { HarnessEvent } from "./types.js";

// The event shape minus the BaseEvent identity fields the emitter fills in. A distributive
// conditional preserves each union member's discriminant and payload (a plain Omit over a
// union would collapse to the members' common keys only).
type IdentityField = "schemaVersion" | "runId" | "fingerprint" | "seq" | "ts";
type EventBody = HarnessEvent extends infer E
  ? E extends HarnessEvent
    ? Omit<E, IdentityField>
    : never
  : never;

function redactSensitive(event: HarnessEvent): HarnessEvent {
  switch (event.type) {
    case "reasoning:trace":
      return {
        ...event,
        rationale: redact(event.rationale),
        ...(event.modelResponse === undefined
          ? {}
          : { modelResponse: redact(event.modelResponse) }),
      };
    case "patch:proposed":
      return { ...event, diff: redact(event.diff) };
    case "run:completed":
      // WHY: report and patchDiff carry full model output — non-provider-config secret patterns
      // (issue #6) are out of Wave-1 scope; we redact the known shapes here.
      return {
        ...event,
        report: redact(event.report),
        ...(event.patchDiff === undefined ? {} : { patchDiff: redact(event.patchDiff) }),
      };
    case "run:failed":
      return event.failure.detail === undefined
        ? event
        : { ...event, failure: { ...event.failure, detail: redact(event.failure.detail) } };
    default:
      return event;
  }
}

export class Emitter {
  private seq = 0;

  // Fans every event out to all sinks. Each sink receives raw SENSITIVE fields only if it
  // declares `retainsRawContent`; otherwise it receives a redacted copy.
  constructor(
    private readonly sinks: readonly EventSink[],
    private readonly clock: Clock,
    private readonly runId: string,
    private readonly fingerprint: string,
  ) {}

  emit(body: EventBody): void {
    this.seq += 1;
    const event = {
      schemaVersion: "1",
      runId: this.runId,
      fingerprint: this.fingerprint,
      seq: this.seq,
      ts: this.clock.now(),
      ...body,
    } as HarnessEvent;
    const redacted = redactSensitive(event);
    for (const sink of this.sinks) {
      sink.emit(sink.retainsRawContent === true ? event : redacted);
    }
  }
}
