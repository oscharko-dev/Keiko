// Stamps every harness event with run identity, a monotonic seq, and a clock timestamp,
// then forwards it to the sink. SENSITIVE fields (rationale, modelResponse, diff) are
// redacted before forwarding UNLESS the sink retains raw content for replay (ADR-0004 D6).

import { redact, type Clock } from "@oscharko-dev/keiko-model-gateway";
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

function redactReasoningTrace(
  event: Extract<HarnessEvent, { type: "reasoning:trace" }>,
): HarnessEvent {
  return {
    ...event,
    rationale: redact(event.rationale),
    ...(event.modelResponse === undefined ? {} : { modelResponse: redact(event.modelResponse) }),
  };
}

function redactRunCompleted(event: Extract<HarnessEvent, { type: "run:completed" }>): HarnessEvent {
  // WHY: report and patchDiff carry full model output; keep known secret formats out of every
  // sink that does not explicitly retain raw content for replay.
  return {
    ...event,
    report: redact(event.report),
    ...(event.patchDiff === undefined ? {} : { patchDiff: redact(event.patchDiff) }),
  };
}

function redactRunFailed(event: Extract<HarnessEvent, { type: "run:failed" }>): HarnessEvent {
  const failure = {
    ...event.failure,
    message: redact(event.failure.message),
    ...(event.failure.detail === undefined ? {} : { detail: redact(event.failure.detail) }),
  };
  return { ...event, failure };
}

const REDACTORS: {
  readonly [K in HarnessEvent["type"]]?: (
    event: Extract<HarnessEvent, { type: K }>,
  ) => HarnessEvent;
} = {
  "reasoning:trace": redactReasoningTrace,
  "patch:proposed": (event) => ({ ...event, diff: redact(event.diff) }),
  "model:call:failed": (event) => ({ ...event, message: redact(event.message) }),
  "tool:call:failed": (event) => ({ ...event, message: redact(event.message) }),
  "verification:result": (event) => ({ ...event, detail: redact(event.detail) }),
  "run:completed": redactRunCompleted,
  "run:cancelled": (event) =>
    event.reason === undefined ? event : { ...event, reason: redact(event.reason) },
  "run:failed": redactRunFailed,
};

function redactSensitive(event: HarnessEvent): HarnessEvent {
  const redactor = REDACTORS[event.type] as ((e: HarnessEvent) => HarnessEvent) | undefined;
  return redactor === undefined ? event : redactor(event);
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
