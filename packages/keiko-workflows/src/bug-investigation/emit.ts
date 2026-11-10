// Event emission for the bug-investigation workflow (ADR-0009 D5). The fingerprint identity is
// { workflowId, report, modelId }; run-event-envelope.ts owns the envelope, the seq counter and the
// fingerprint shape. Sensitive fields are redacted by the CALLER before handing the event here.

import { canonicalise } from "@oscharko-dev/keiko-harness";
import type { BugReportInput } from "./types.js";
import type { BugInvestigationEvent, BugWorkflowEventSink } from "./events.js";
import {
  createRunEventEmitter,
  runFingerprint,
  type RunEventBody,
  type RunEventEmitter,
} from "../run-event-envelope.js";

export function computeBugFingerprint(report: BugReportInput, modelId: string): string {
  return runFingerprint(canonicalise({ workflowId: "bug-investigation", report, modelId }));
}

export type BugEventBody = RunEventBody<BugInvestigationEvent>;

export type BugEventEmitter = RunEventEmitter<BugInvestigationEvent>;

export function createBugEventEmitter(
  sink: BugWorkflowEventSink,
  runId: string,
  fingerprint: string,
  now: () => number,
): BugEventEmitter {
  return createRunEventEmitter(sink, runId, fingerprint, now);
}
