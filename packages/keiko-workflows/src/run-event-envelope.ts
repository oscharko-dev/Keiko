// The run event envelope shared by the unit-test (ADR-0008 D4) and bug-investigation (ADR-0009 D5)
// workflows. The emitter owns the monotonic seq counter and stamps every event with
// { schemaVersion, runId, fingerprint, seq, ts }. Sensitive fields are redacted by the CALLER before
// the body reaches the emitter; the emitter does not inspect payloads.

import { createHash } from "node:crypto";

const FINGERPRINT_HEX_CHARS = 16;

// SHA-256 of the workflow's canonical identity truncated to 16 hex chars, the same shape as the
// harness fingerprinter. Callers canonicalise the identity with the harness `canonicalise`, so two
// structurally equal identities fingerprint identically regardless of key order.
export function runFingerprint(canonicalIdentity: string): string {
  return createHash("sha256")
    .update(canonicalIdentity, "utf8")
    .digest("hex")
    .slice(0, FINGERPRINT_HEX_CHARS);
}

// The fields the emitter fills in on every event; the caller supplies the rest of the discriminated
// union member minus the envelope.
type EnvelopeFields = "schemaVersion" | "runId" | "fingerprint" | "seq" | "ts";

// Every event member declares exactly these envelope fields, as BaseWorkflowEvent and BaseBugEvent
// do. The emitter fills them in, so a member must not narrow them (for example `runId: "fixed"`).
interface RunEventEnvelope {
  readonly schemaVersion: "1";
  readonly runId: string;
  readonly fingerprint: string;
  readonly seq: number;
  readonly ts: number;
  readonly type: string;
}

export type RunEventBody<Event extends RunEventEnvelope> = {
  [Member in Event as Member["type"]]: Omit<Member, EnvelopeFields>;
}[Event["type"]];

interface RunEventSink<Event> {
  emit(event: Event): void;
}

export interface RunEventEmitter<Event extends RunEventEnvelope> {
  readonly emit: (body: RunEventBody<Event>) => void;
}

export function createRunEventEmitter<Event extends RunEventEnvelope>(
  sink: RunEventSink<Event>,
  runId: string,
  fingerprint: string,
  now: () => number,
): RunEventEmitter<Event> {
  let seq = 0;
  return {
    emit: (body: RunEventBody<Event>): void => {
      seq += 1;
      // SAFETY: Event extends RunEventEnvelope, so every member declares these five envelope fields
      // with the types written here and none narrows them. The body is a complete member minus the
      // envelope, so re-attaching it yields a valid Event. The cast is over the union, not to any.
      const event = {
        schemaVersion: "1" as const,
        runId,
        fingerprint,
        seq,
        ts: now(),
        ...body,
      } as Event;
      sink.emit(event);
    },
  };
}
