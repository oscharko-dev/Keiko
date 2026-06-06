// Shared workflow→EvidenceManifest mapping (ADR-0010 + ADR-0011 AC5 + ADR-0012 D9/C2). This is the
// PURE, surface-agnostic core that folds a terminated workflow run (its typed report + buffered
// events) into a redacted, versioned EvidenceManifest and writes it through the #10 EvidenceStore.
//
// Both the UI BFF and the evaluation harness build the manifest from this shared
// implementation. Gateway lookups (the model cost class) are accepted through the
// injected `EvidencePersistContext.costClassResolver` port rather than imported from
// the gateway capability registry. It defines its own narrow `WorkflowRunKind` /
// `WorkflowTerminalStatus` so it never depends on UI-local types.
//
import { buildEvidenceReport, type EvidenceReport } from "./report.js";
import { createAuditRedactor, deepRedactStrings } from "./redaction.js";
import { EVIDENCE_SCHEMA_VERSION, type EvidenceManifest } from "./types.js";
import type { EvidenceStore } from "./store.js";
import {
  HARNESS_VERSION,
  type AuditSummary,
  type CostClass,
  type TaskType,
} from "@oscharko-dev/keiko-contracts";
import type { EnvSource } from "@oscharko-dev/keiko-security";

// The two workflow families the evidence path serves. Distinct from the UI RunKind (which also
// carries "explain-plan", handled by a separate harness-usage fold) so this module needs no ui import.
export type WorkflowRunKind = "unit-tests" | "bug-investigation";

// The terminal run outcomes the registry/runner records. Matches RunOutcome members 1:1.
export type WorkflowTerminalStatus = "completed" | "cancelled" | "failed";

export interface EvidencePersistContext {
  readonly store: EvidenceStore;
  readonly env: EnvSource;
  readonly additionalSecrets?: readonly string[] | undefined;
  // Cost-class lookup port. Mirrors EvidenceDeps.costClassResolver so the evidence
  // package never imports the gateway capability registry directly. Absent → "unknown".
  readonly costClassResolver?: ((modelId: string) => CostClass | "unknown") | undefined;
}

// Identity + timing held when a workflow run terminates. `modelId` is the request model; the
// timestamps frame the manifest run-identity window.
export interface WorkflowRunIdentity {
  readonly runId: string;
  readonly fingerprint: string;
  readonly modelId: string;
  readonly kind: WorkflowRunKind;
  readonly status: WorkflowTerminalStatus;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly workspaceRoot?: string | undefined;
}

// A structural workflow event: every workflow/harness event carries this envelope; the manifest fold
// only needs `type` to filter and the usage fields on the model-call-completed event.
export interface WorkflowEventLike {
  readonly type: string;
}

const KIND_TO_TASK_TYPE: Readonly<Record<WorkflowRunKind, TaskType>> = {
  "unit-tests": "generate-unit-tests",
  "bug-investigation": "investigate-bug",
};

// Folds the buffered `workflow:model:call:completed` events into usage totals. The workflow event
// carries token/latency fields at the TOP level (not under `usage` like the harness event), so this
// sums the four dimensions directly rather than reusing the audit `aggregateUsage` fold.
export function foldWorkflowUsage(
  events: readonly WorkflowEventLike[],
): EvidenceManifest["usageTotals"] {
  let promptTokens = 0;
  let completionTokens = 0;
  let requestCount = 0;
  let totalLatencyMs = 0;
  for (const event of events) {
    if (
      event.type !== "workflow:model:call:completed" &&
      event.type !== "bug:model:call:completed"
    ) {
      continue;
    }
    const record = event as unknown as Record<string, unknown>;
    promptTokens += numberOf(record.promptTokens);
    completionTokens += numberOf(record.completionTokens);
    totalLatencyMs += numberOf(record.latencyMs);
    requestCount += 1;
  }
  return { promptTokens, completionTokens, requestCount, totalLatencyMs };
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function buildWorkflowManifest(
  identity: WorkflowRunIdentity,
  events: readonly WorkflowEventLike[],
  report: unknown,
  costClassResolver?: (modelId: string) => CostClass | "unknown",
): EvidenceManifest {
  return {
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    run: {
      runId: identity.runId,
      fingerprint: identity.fingerprint,
      harnessVersion: HARNESS_VERSION,
      taskType: KIND_TO_TASK_TYPE[identity.kind],
      outcome: identity.status,
      startedAt: identity.startedAt,
      finishedAt: identity.finishedAt,
      durationMs: Math.max(0, identity.finishedAt - identity.startedAt),
    },
    model: {
      modelId: identity.modelId,
      costClass: costClassResolver?.(identity.modelId) ?? "unknown",
    },
    usageTotals: foldWorkflowUsage(events),
    ...(contextOf(identity.workspaceRoot) === undefined
      ? {}
      : { context: contextOf(identity.workspaceRoot) }),
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
    verification: verificationOf(report),
    patch: patchOf(report),
    failure: undefined,
  };
}

function contextOf(workspaceRoot: string | undefined): AuditSummary | undefined {
  if (workspaceRoot === undefined) {
    return undefined;
  }
  return {
    workspaceRoot,
    totalCandidates: 0,
    usedBytes: 0,
    budgetBytes: 0,
    droppedForBudget: 0,
    entries: [],
  };
}

// Builds, redacts, writes the workflow manifest through the store, and returns the structured
// EvidenceReport. Errors intentionally surface to the caller so UI/evaluation paths cannot silently
// claim a terminal run without a durable evidence artifact.
export function persistWorkflowEvidence(
  identity: WorkflowRunIdentity,
  report: unknown,
  events: readonly WorkflowEventLike[],
  ctx: EvidencePersistContext,
): EvidenceReport {
  const manifest = buildWorkflowManifest(identity, events, report, ctx.costClassResolver);
  const redactor = createAuditRedactor({ additionalSecrets: ctx.additionalSecrets ?? [] }, ctx.env);
  const redacted = deepRedactStrings(manifest, redactor) as EvidenceManifest;
  const location = ctx.store.put(redacted.run.runId, JSON.stringify(redacted));
  return buildEvidenceReport(redacted, location);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Extracts the verification audit summary from a workflow report when present. The summary is already
// the audit shape; the deep redact in persist re-scrubs every string leaf for defense in depth.
function verificationOf(report: unknown): EvidenceManifest["verification"] {
  if (!isRecord(report)) {
    return undefined;
  }
  const summary = report.verificationSummary ?? verifiedVerificationOf(report);
  return isRecord(summary) ? (summary as unknown as EvidenceManifest["verification"]) : undefined;
}

function verifiedVerificationOf(report: Record<string, unknown>): unknown {
  const verified = report.verified;
  return isRecord(verified) ? verified.verification : undefined;
}

// Builds patch metadata (counts/bytes only, never the raw diff) from a workflow report. unit-tests
// reports carry `addedTestFiles`; bug-investigation reports carry `changedFiles`.
function patchOf(report: unknown): EvidenceManifest["patch"] {
  if (!isRecord(report)) {
    return undefined;
  }
  const proposedDiff = report.proposedDiff;
  const proposed = typeof proposedDiff === "string" && proposedDiff.length > 0;
  const changedFiles = changedFileCount(report);
  if (!proposed && changedFiles === 0) {
    return undefined;
  }
  return {
    proposed,
    applied: patchApplied(report),
    targetFileCount: changedFiles,
    patchBytes: typeof proposedDiff === "string" ? Buffer.byteLength(proposedDiff, "utf8") : 0,
    changedFiles,
    created: 0,
    deleted: 0,
  };
}

function patchApplied(report: Record<string, unknown>): boolean {
  if (report.status === "completed" || report.status === "fix-applied") {
    return true;
  }
  const verified = report.verified;
  return isRecord(verified) && verified.patchApplied === true;
}

function changedFileCount(report: Record<string, unknown>): number {
  const added = report.addedTestFiles;
  if (Array.isArray(added)) {
    return added.length;
  }
  const changed = report.changedFiles;
  return Array.isArray(changed) ? changed.length : 0;
}
