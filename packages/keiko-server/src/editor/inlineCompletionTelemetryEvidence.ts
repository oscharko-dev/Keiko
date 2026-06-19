// Content-free audit linkage for inline-completion acceptance/rejection telemetry (Issue #1200,
// Acceptance Criterion 6; EU AI Act Reg. (EU) 2024/1689 Art. 12 record-keeping). The record carries
// only counts plus a HASH of the workspace root — never the root path itself, never buffer text,
// inserted ghost text, prompts, or any code content. It is the auditable acceptance-rate signal the
// product can report without persisting what the user typed or accepted.

import { createHash } from "node:crypto";
import type {
  EditorInlineCompletionTelemetryReport,
  EvidenceStore,
} from "@oscharko-dev/keiko-contracts";
import type { Redactor } from "../deps.js";

export const EDITOR_INLINE_COMPLETION_TELEMETRY_EVIDENCE_SCHEMA_VERSION = "1" as const;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function telemetryEvidenceRunId(rootHash: string, emittedAtMs: number): string {
  const digest = sha256Hex(`${rootHash}\n${String(emittedAtMs)}`).slice(0, 16);
  return `editor-inline-completion-telemetry-${digest}`;
}

export function recordInlineCompletionTelemetryEvidence(
  store: EvidenceStore,
  redactor: Redactor,
  report: EditorInlineCompletionTelemetryReport,
  emittedAtMs: number,
): string {
  // Hash the root so the evidence never carries a workspace filesystem path.
  const rootHash = sha256Hex(report.root);
  const runId = telemetryEvidenceRunId(rootHash, emittedAtMs);
  const manifest = {
    editorInlineCompletionTelemetrySchemaVersion:
      EDITOR_INLINE_COMPLETION_TELEMETRY_EVIDENCE_SCHEMA_VERSION,
    runId,
    emittedAtMs,
    rootHash,
    offered: report.offered,
    shown: report.shown,
    accepted: report.accepted,
    rejected: report.rejected,
    ignored: report.ignored,
    partiallyAccepted: report.partiallyAccepted,
  };
  try {
    store.put(runId, JSON.stringify(redactor(manifest)));
  } catch {
    // Evidence persistence is best-effort; a write failure must not fail the telemetry report.
  }
  return runId;
}
