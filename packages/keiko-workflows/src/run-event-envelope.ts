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

export type RunEventBody<Event extends { readonly type: string }> = {
  [Member in Event as Member["type"]]: Omit<Member, EnvelopeFields>;
}[Event["type"]];

interface RunEventSink<Event> {
  emit(event: Event): void;
}

export interface RunEventEmitter<Event extends { readonly type: string }> {
  readonly emit: (body: RunEventBody<Event>) => void;
}

export function createRunEventEmitter<Event extends { readonly type: string }>(
  sink: RunEventSink<Event>,
  runId: string,
  fingerprint: string,
  now: () => number,
): RunEventEmitter<Event> {
  let seq = 0;
  return {
    emit: (body: RunEventBody<Event>): void => {
      seq += 1;
      // SAFETY: The body is a complete discriminated-union member minus the envelope; re-attaching
      // the envelope yields a valid Event. The cast is over the union, not a widening to any.
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
