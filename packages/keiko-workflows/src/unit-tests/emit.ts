// Event emission for the unit-test workflow (ADR-0008 D4). The fingerprint identity is
// { workflowId, target, modelId }; run-event-envelope.ts owns the envelope, the seq counter and the
// fingerprint shape. Sensitive fields are redacted by the CALLER before handing the event here.

import { canonicalise } from "@oscharko-dev/keiko-harness";
import type { UnitTestTarget } from "./types.js";
import type { WorkflowEvent, WorkflowEventSink } from "./events.js";
import {
  createRunEventEmitter,
  runFingerprint,
  type RunEventBody,
  type RunEventEmitter,
} from "../run-event-envelope.js";

export function computeFingerprint(target: UnitTestTarget, modelId: string): string {
  return runFingerprint(canonicalise({ workflowId: "unit-test-generation", target, modelId }));
}

export type WorkflowEventBody = RunEventBody<WorkflowEvent>;

export type EventEmitter = RunEventEmitter<WorkflowEvent>;

export function createEventEmitter(
  sink: WorkflowEventSink,
  runId: string,
  fingerprint: string,
  now: () => number,
): EventEmitter {
  return createRunEventEmitter(sink, runId, fingerprint, now);
}
