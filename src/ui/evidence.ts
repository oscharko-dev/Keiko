// Evidence persistence for UI-initiated runs (ADR-0011 AC5; #10 audit public API only). The Wave 2
// BFF never persisted evidence, so UI runs (including cancellations) never reached the evidence
// browser. This module folds a terminated run into a redacted EvidenceManifest and writes it through
// the #10 EvidenceStore, composing the audit layer's PUBLIC API UNCHANGED (no frozen-core edit).
//
// The WORKFLOW manifest mapping now lives in the shared audit module `workflow-evidence.ts` (ADR-0012
// C2), so the evaluation harness and this BFF build it from one implementation. This module keeps the
// EXPLAIN-PLAN harness path (whose `usage` shape differs) local, and adapts the UI RunKind/RunStatus
// to the shared module's narrow workflow types. Persistence errors surface to the run engine so the
// final registry payload cannot silently omit required evidence.

import {
  buildEvidenceReport,
  createAuditRedactor,
  EVIDENCE_SCHEMA_VERSION,
  persistWorkflowEvidence as persistWorkflowEvidenceCore,
  type EvidenceReport,
  type EvidenceManifest,
  type WorkflowRunKind,
} from "../audit/index.js";
import { deepRedactStrings } from "../audit/redaction.js";
import { HARNESS_VERSION, type RunResult, type TaskType } from "../harness/index.js";
import { resolveCostClass, type EnvSource } from "../gateway/index.js";
import type { EvidenceStore } from "../audit/index.js";
import type { StreamEvent } from "./sink.js";
import type { RunKind } from "./run-request.js";
import type { RunStatus } from "./runs.js";

type TerminalStatus = Exclude<RunStatus, "running">;

export interface EvidencePersistContext {
  readonly store: EvidenceStore;
  readonly env: EnvSource;
  readonly additionalSecrets?: readonly string[] | undefined;
}

// Identity + timing the BFF already holds when a run terminates. `modelId` is the request model; the
// timestamps frame the manifest run-identity window.
export interface RunIdentity {
  readonly runId: string;
  readonly fingerprint: string;
  readonly modelId: string;
  readonly kind: RunKind;
  readonly status: TerminalStatus;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly workspaceRoot?: string | undefined;
}

// Only the two model-driven workflow kinds map to the shared audit core; explain-plan and verify
// follow their own manifest paths (different usage shape / no usage at all).
function toWorkflowKind(kind: RunKind): WorkflowRunKind {
  return kind === "bug-investigation" ? "bug-investigation" : "unit-tests";
}

// Persists a terminated WORKFLOW run (unit-tests / bug-investigation) via the shared audit core. The
// report is the workflow's own typed report; only counts/summaries are folded in (never the raw diff).
export function persistWorkflowEvidence(
  identity: RunIdentity,
  report: unknown,
  events: readonly StreamEvent[],
  ctx: EvidencePersistContext,
): EvidenceReport {
  return persistWorkflowEvidenceCore(
    {
      runId: identity.runId,
      fingerprint: identity.fingerprint,
      modelId: identity.modelId,
      kind: toWorkflowKind(identity.kind),
      status: identity.status,
      startedAt: identity.startedAt,
      finishedAt: identity.finishedAt,
      ...(identity.workspaceRoot === undefined ? {} : { workspaceRoot: identity.workspaceRoot }),
    },
    report,
    events,
    { ...ctx, costClassResolver: resolveCostClass },
  );
}

// Persists a terminated EXPLAIN-PLAN harness run. The RunResult carries the raw harness events whose
// `usage` shape the audit fold understands; the usage is folded directly so the explain path keeps a
// single manifest-build path independent of the shared workflow core (which folds top-level fields).
export function persistExplainEvidence(
  identity: RunIdentity,
  result: RunResult,
  ctx: EvidencePersistContext,
): EvidenceReport {
  const manifest = buildExplainManifest(identity, result);
  const redactor = createAuditRedactor(
    { additionalSecrets: ctx.additionalSecrets ?? [] },
    ctx.env,
  );
  const redacted = deepRedactStrings(manifest, redactor) as EvidenceManifest;
  const location = ctx.store.put(redacted.run.runId, JSON.stringify(redacted));
  return buildEvidenceReport(redacted, location);
}

const KIND_TO_TASK_TYPE: Readonly<Record<RunKind, TaskType>> = {
  "unit-tests": "generate-unit-tests",
  "bug-investigation": "investigate-bug",
  "explain-plan": "explain-plan",
  verify: "verify",
};

// Persists a terminated VERIFY run. Verify never calls a model, so usageTotals are all zero and
// stateTransitions/toolCalls/commandExecutions stay empty (the verification orchestrator's own
// audit summarisation lives in `src/verification/summary.ts` and is out of scope for this leaf).
export function persistVerifyEvidence(
  identity: RunIdentity,
  ctx: EvidencePersistContext,
): EvidenceReport {
  const manifest = buildVerifyManifest(identity);
  const redactor = createAuditRedactor(
    { additionalSecrets: ctx.additionalSecrets ?? [] },
    ctx.env,
  );
  const redacted = deepRedactStrings(manifest, redactor) as EvidenceManifest;
  const location = ctx.store.put(redacted.run.runId, JSON.stringify(redacted));
  return buildEvidenceReport(redacted, location);
}

function buildVerifyManifest(identity: RunIdentity): EvidenceManifest {
  const context =
    identity.workspaceRoot === undefined
      ? undefined
      : {
          workspaceRoot: identity.workspaceRoot,
          totalCandidates: 0,
          usedBytes: 0,
          budgetBytes: 0,
          droppedForBudget: 0,
          entries: [],
        };
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
    usageTotals: { promptTokens: 0, completionTokens: 0, requestCount: 0, totalLatencyMs: 0 },
    ...(context === undefined ? {} : { context }),
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
    verification: undefined,
    patch: undefined,
    failure: undefined,
  };
}

function buildExplainManifest(identity: RunIdentity, result: RunResult): EvidenceManifest {
  const context =
    identity.workspaceRoot === undefined
      ? undefined
      : {
          workspaceRoot: identity.workspaceRoot,
          totalCandidates: 0,
          usedBytes: 0,
          budgetBytes: 0,
          droppedForBudget: 0,
          entries: [],
        };
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
    usageTotals: foldHarnessUsage(result.events),
    ...(context === undefined ? {} : { context }),
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
    verification: undefined,
    patch: undefined,
    failure: undefined,
  };
}

function foldHarnessUsage(events: RunResult["events"]): EvidenceManifest["usageTotals"] {
  let promptTokens = 0;
  let completionTokens = 0;
  let requestCount = 0;
  let totalLatencyMs = 0;
  for (const event of events) {
    if (event.type !== "model:call:completed") {
      continue;
    }
    promptTokens += event.usage.promptTokens;
    completionTokens += event.usage.completionTokens;
    totalLatencyMs += event.usage.latencyMs;
    requestCount += 1;
  }
  return { promptTokens, completionTokens, requestCount, totalLatencyMs };
}
