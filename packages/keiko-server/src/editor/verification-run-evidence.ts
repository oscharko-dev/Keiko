// Issue #2211 fix-up (Epic #2092) — editor verification-run evidence. Each finished editor
// verification run writes a standard EvidenceManifest via the existing EvidenceStore.put port,
// mirroring command-runner-evidence.ts exactly. The per-step detail reuses the SAME
// `VerificationAuditSummary` projection (keiko-verification's summarizeForAudit) the CLI/SDK
// verification path already writes to its own evidence — never a parallel, ad-hoc evidence shape.
// Content-free per ADR-0048: enums, counts, and redacted command strings only — never raw
// stdout/stderr (summarizeForAudit already excludes outputSummary/detail/locations).

import { deepRedactStrings } from "@oscharko-dev/keiko-evidence";
import type { EvidenceManifest, EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { EVIDENCE_SCHEMA_VERSION } from "@oscharko-dev/keiko-evidence";
import { HARNESS_VERSION } from "@oscharko-dev/keiko-harness";
import type { RunOutcome } from "@oscharko-dev/keiko-harness";
import { summarizeForAudit } from "@oscharko-dev/keiko-verification";
import type { VerificationReport } from "@oscharko-dev/keiko-contracts";

export const EDITOR_VERIFICATION_RUN_EVIDENCE_KIND = "editor-verification-run" as const;

export type EditorVerificationRunEvidenceEntry = EvidenceManifest;

export interface EditorVerificationRunEvidenceInput {
  readonly runId: string;
  readonly projectId: string;
  readonly report: VerificationReport;
  readonly startedAt: number;
}

function verificationRunOutcome(report: VerificationReport): RunOutcome {
  switch (report.overallStatus) {
    case "passed":
    case "skipped":
      return "completed";
    case "timed-out":
      return "limit-exceeded";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "denied":
    case "resource-exceeded":
      return "failed";
  }
}

// PURE. Builds the on-disk manifest from a finished run. The projectId is the workspace root
// (already server-resolved, never client-supplied free text); the report is already redacted at
// the orchestrator, and summarizeForAudit strips output/detail/locations as a second layer.
export function buildEditorVerificationRunEvidenceEntry(
  input: EditorVerificationRunEvidenceInput,
): EditorVerificationRunEvidenceEntry {
  const runId = input.runId;
  return {
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    run: {
      runId,
      fingerprint: runId,
      harnessVersion: HARNESS_VERSION,
      taskType: EDITOR_VERIFICATION_RUN_EVIDENCE_KIND,
      outcome: verificationRunOutcome(input.report),
      startedAt: input.startedAt,
      finishedAt: input.startedAt + input.report.durationMs,
      durationMs: input.report.durationMs,
    },
    model: { modelId: "editor-verification-runner", costClass: "unknown" },
    usageTotals: { promptTokens: 0, completionTokens: 0, requestCount: 0, totalLatencyMs: 0 },
    context: {
      workspaceRoot: input.projectId,
      totalCandidates: 0,
      usedBytes: 0,
      budgetBytes: 0,
      droppedForBudget: 0,
      entries: [],
    },
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
    verification: summarizeForAudit(input.report),
  };
}

// Defense in depth: applies the live redactor to every string leaf before serializing. Mirrors
// appendCommandRunEvidence/appendTerminalEvidence.
export function appendEditorVerificationRunEvidence(
  store: EvidenceStore,
  entry: EditorVerificationRunEvidenceEntry,
  redact: (input: string) => string,
): string {
  const safe = deepRedactStrings(entry, redact) as EditorVerificationRunEvidenceEntry;
  return store.put(safe.run.runId, JSON.stringify(safe, null, 2));
}
