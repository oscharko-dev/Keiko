// Shared workflow→EvidenceManifest mapping (ADR-0010 + ADR-0011 AC5 + ADR-0012 D9/C2). This is the
// PURE, surface-agnostic core that folds a terminated workflow run (its typed report + buffered
// events) into a redacted, versioned EvidenceManifest and writes it through the #10 EvidenceStore.
//
// It was extracted from src/ui/evidence.ts so BOTH the UI BFF and the evaluation harness build the
// manifest from one implementation. The dependency direction is preserved: this module lives in the
// audit layer and imports only audit + harness + gateway primitives. It defines its own narrow
// `WorkflowRunKind` / `WorkflowTerminalStatus` so it never depends on src/ui types. The UI
// re-exports it (behaviour-preserving); the evaluation runner imports it directly.
//
// Persistence is BEST-EFFORT: a failure anywhere (a malformed report, a redactor error, an fs error)
// is swallowed so the run outcome already recorded by the caller stands. Nothing is logged, so no
// secret can leak through a log line.

import { resolveCostClass } from "./aggregate.js";
import { createAuditRedactor, deepRedactStrings } from "./redaction.js";
import { EVIDENCE_SCHEMA_VERSION, type EvidenceManifest } from "./types.js";
import type { EvidenceStore } from "./store.js";
import { HARNESS_VERSION, type TaskType } from "../harness/index.js";
import type { EnvSource } from "../gateway/index.js";

// The two workflow families the evidence path serves. Distinct from the UI RunKind (which also
// carries "explain-plan", handled by a separate harness-usage fold) so this module needs no ui import.
export type WorkflowRunKind = "unit-tests" | "bug-investigation";

// The terminal run outcomes the registry/runner records. Matches RunOutcome members 1:1.
export type WorkflowTerminalStatus = "completed" | "cancelled" | "failed";

export interface EvidencePersistContext {
  readonly store: EvidenceStore;
  readonly env: EnvSource;
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
    if (event.type !== "workflow:model:call:completed") {
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
    model: { modelId: identity.modelId, costClass: resolveCostClass(identity.modelId) },
    usageTotals: foldWorkflowUsage(events),
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
    verification: verificationOf(report),
    patch: patchOf(report),
    failure: undefined,
  };
}

// Builds, redacts, and writes the workflow manifest through the store. The WHOLE operation is
// best-effort: a failure anywhere is swallowed so the caller's already-recorded outcome stands.
export function persistWorkflowEvidence(
  identity: WorkflowRunIdentity,
  report: unknown,
  events: readonly WorkflowEventLike[],
  ctx: EvidencePersistContext,
): void {
  try {
    const manifest = buildWorkflowManifest(identity, events, report);
    const redactor = createAuditRedactor({}, ctx.env);
    const redacted = deepRedactStrings(manifest, redactor) as EvidenceManifest;
    ctx.store.put(redacted.run.runId, JSON.stringify(redacted));
  } catch {
    // Best-effort: a persist failure must not surface to the caller (AC5 / coordinator guardrail).
  }
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
  const summary = report.verificationSummary;
  return isRecord(summary) ? (summary as unknown as EvidenceManifest["verification"]) : undefined;
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
    applied: report.status === "fix-applied",
    targetFileCount: changedFiles,
    patchBytes: typeof proposedDiff === "string" ? Buffer.byteLength(proposedDiff, "utf8") : 0,
    changedFiles,
    created: 0,
    deleted: 0,
  };
}

function changedFileCount(report: Record<string, unknown>): number {
  const added = report.addedTestFiles;
  if (Array.isArray(added)) {
    return added.length;
  }
  const changed = report.changedFiles;
  return Array.isArray(changed) ? changed.length : 0;
}
