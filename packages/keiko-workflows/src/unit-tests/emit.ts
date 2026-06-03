// Event emission helper for the workflow (ADR-0008 D4). Owns the monotonic seq counter and stamps
// every event with the shared envelope ({ schemaVersion, runId, fingerprint, seq, ts }). The
// fingerprint is SHA-256(workflowId + canonical(target) + modelId) truncated to 16 hex chars — the
// same shape as the harness fingerprinter — reusing `canonicalise` from the harness barrel so two
// structurally equal targets fingerprint identically regardless of key order. Sensitive fields are
// redacted by the CALLER before handing the event here (this helper does not inspect payloads).

import { createHash } from "node:crypto";
import { canonicalise } from "../../harness/index.js";
import type { UnitTestTarget } from "./types.js";
import type { WorkflowEvent, WorkflowEventSink } from "./events.js";

const FINGERPRINT_HEX_CHARS = 16;

export function computeFingerprint(target: UnitTestTarget, modelId: string): string {
  const canonical = canonicalise({ workflowId: "unit-test-generation", target, modelId });
  return createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, FINGERPRINT_HEX_CHARS);
}

// The fields the emitter fills in on every event; the caller supplies the rest of the discriminated
// union member minus the envelope.
type EnvelopeFields = "schemaVersion" | "runId" | "fingerprint" | "seq" | "ts";
export type WorkflowEventBody = {
  [E in WorkflowEvent as E["type"]]: Omit<E, EnvelopeFields>;
}[WorkflowEvent["type"]];

export interface EventEmitter {
  readonly emit: (body: WorkflowEventBody) => void;
}

export function createEventEmitter(
  sink: WorkflowEventSink,
  runId: string,
  fingerprint: string,
  now: () => number,
): EventEmitter {
  let seq = 0;
  return {
    emit: (body: WorkflowEventBody): void => {
      seq += 1;
      // The body is a complete discriminated-union member minus the envelope; re-attaching the
      // envelope yields a valid WorkflowEvent. The cast is over the union, not a widening to any.
      const event = {
        schemaVersion: "1" as const,
        runId,
        fingerprint,
        seq,
        ts: now(),
        ...body,
      } as WorkflowEvent;
      sink.emit(event);
    },
  };
}
