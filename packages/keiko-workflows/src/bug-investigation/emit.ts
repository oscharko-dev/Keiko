// Event emission helper for the bug-investigation workflow (ADR-0009 D5). Owns the monotonic seq
// counter and stamps every event with the shared envelope ({ schemaVersion, runId, fingerprint,
// seq, ts }). The fingerprint is SHA-256(workflowId + canonical(report) + modelId) truncated to 16
// hex chars — the same shape as the harness fingerprinter — reusing `canonicalise` from the harness
// barrel so two structurally equal reports fingerprint identically regardless of key order.
// Sensitive fields are redacted by the CALLER before handing the event here.

import { createHash } from "node:crypto";
import { canonicalise } from "../../harness/index.js";
import type { BugReportInput } from "./types.js";
import type { BugInvestigationEvent, BugWorkflowEventSink } from "./events.js";

const FINGERPRINT_HEX_CHARS = 16;

export function computeBugFingerprint(report: BugReportInput, modelId: string): string {
  const canonical = canonicalise({ workflowId: "bug-investigation", report, modelId });
  return createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, FINGERPRINT_HEX_CHARS);
}

// The fields the emitter fills in on every event; the caller supplies the rest of the discriminated
// union member minus the envelope.
type EnvelopeFields = "schemaVersion" | "runId" | "fingerprint" | "seq" | "ts";
export type BugEventBody = {
  [E in BugInvestigationEvent as E["type"]]: Omit<E, EnvelopeFields>;
}[BugInvestigationEvent["type"]];

export interface BugEventEmitter {
  readonly emit: (body: BugEventBody) => void;
}

export function createBugEventEmitter(
  sink: BugWorkflowEventSink,
  runId: string,
  fingerprint: string,
  now: () => number,
): BugEventEmitter {
  let seq = 0;
  return {
    emit: (body: BugEventBody): void => {
      seq += 1;
      // The body is a complete discriminated-union member minus the envelope; re-attaching the
      // envelope yields a valid BugInvestigationEvent. The cast is over the union, not a widening.
      const event = {
        schemaVersion: "1" as const,
        runId,
        fingerprint,
        seq,
        ts: now(),
        ...body,
      } as BugInvestigationEvent;
      sink.emit(event);
    },
  };
}
