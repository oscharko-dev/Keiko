// Evidence persistence for UI-initiated runs (ADR-0011 AC5; #10 audit public API only). The Wave 2
// BFF never persisted evidence, so UI runs (including cancellations) never reached the evidence
// browser. This module folds a terminated run into a redacted EvidenceManifest and writes it through
// the #10 EvidenceStore, composing the audit layer's PUBLIC API UNCHANGED (no frozen-core edit).
//
// Both task families build the manifest DIRECTLY (coordinator decision: consistency over the awkward
// RunManifest reconstruction the explain-plan path would otherwise need). The hand-built manifest is
// redacted with `deepRedactStrings(manifest, createAuditRedactor({}, env))` BEFORE `store.put`,
// matching #10's redact-before-persist discipline. Persistence is BEST-EFFORT: a failure here must
// never crash the BFF, abort the run, or mask the run outcome.

import {
  createAuditRedactor,
  EVIDENCE_SCHEMA_VERSION,
  resolveCostClass,
  type EvidenceManifest,
} from "../audit/index.js";
import { deepRedactStrings } from "../audit/redaction.js";
import { HARNESS_VERSION, type RunResult, type TaskType } from "../harness/index.js";
import type { EnvSource } from "../gateway/index.js";
import type { EvidenceStore } from "../audit/index.js";
import type { StreamEvent } from "./sink.js";
import type { RunKind } from "./run-request.js";
import type { RunStatus } from "./runs.js";

type TerminalStatus = Exclude<RunStatus, "running">;

export interface EvidencePersistContext {
  readonly store: EvidenceStore;
  readonly env: EnvSource;
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
}

// The registry stores three terminal statuses; all three are valid RunOutcome members, so the
// mapping is the identity. (limit-exceeded never reaches the BFF — the workflow/harness collapse it.)
const KIND_TO_TASK_TYPE: Readonly<Record<RunKind, TaskType>> = {
  "unit-tests": "generate-unit-tests",
  "bug-investigation": "investigate-bug",
  "explain-plan": "explain-plan",
};

// Folds the buffered workflow `workflow:model:call:completed` events into usage totals. The workflow
// event carries token/latency fields at the top level (not under `usage` like the harness event), so
// this cannot reuse the audit `aggregateUsage` fold; it sums the same four dimensions directly.
function foldWorkflowUsage(events: readonly StreamEvent[]): EvidenceManifest["usageTotals"] {
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

function buildManifest(
  identity: RunIdentity,
  usageTotals: EvidenceManifest["usageTotals"],
  extras: Pick<EvidenceManifest, "verification" | "patch" | "failure">,
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
    usageTotals,
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
    ...extras,
  };
}

// Builds, redacts, and writes a manifest through the store. The WHOLE operation (manifest assembly
// included) is best-effort: a failure anywhere — a malformed report, a redactor error, an fs error —
// is swallowed so the run outcome already recorded by the registry stands. Nothing is logged, so no
// secret can leak through a log line.
function persistBuilt(
  build: () => EvidenceManifest,
  ctx: EvidencePersistContext,
): void {
  try {
    const manifest = build();
    const redactor = createAuditRedactor({}, ctx.env);
    const redacted = deepRedactStrings(manifest, redactor) as EvidenceManifest;
    ctx.store.put(redacted.run.runId, JSON.stringify(redacted));
  } catch {
    // Best-effort: a persist failure must not surface to the caller (AC5 / coordinator guardrail).
  }
}

// Persists a terminated WORKFLOW run (unit-tests / bug-investigation). The report is the workflow's
// own typed report; only counts/summaries are folded in (never the raw diff unless opted in, which
// the BFF does not).
export function persistWorkflowEvidence(
  identity: RunIdentity,
  report: unknown,
  events: readonly StreamEvent[],
  ctx: EvidencePersistContext,
): void {
  persistBuilt(
    () =>
      buildManifest(identity, foldWorkflowUsage(events), {
        verification: verificationOf(report),
        patch: patchOf(report),
        failure: undefined,
      }),
    ctx,
  );
}

// Persists a terminated EXPLAIN-PLAN harness run. The RunResult carries the raw harness events whose
// `usage` shape the audit fold understands; the usage is folded the same way the workflow path folds
// its own events so a single manifest-build path serves both.
export function persistExplainEvidence(
  identity: RunIdentity,
  result: RunResult,
  ctx: EvidencePersistContext,
): void {
  persistBuilt(
    () =>
      buildManifest(identity, foldHarnessUsage(result.events), {
        verification: undefined,
        patch: undefined,
        failure: undefined,
      }),
    ctx,
  );
}

function foldHarnessUsage(
  events: RunResult["events"],
): EvidenceManifest["usageTotals"] {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Extracts the verification audit summary from a workflow report when present. The summary is already
// the audit shape; the deep redact below re-scrubs every string leaf for defense in depth.
function verificationOf(report: unknown): EvidenceManifest["verification"] {
  if (!isRecord(report)) {
    return undefined;
  }
  const summary = report.verificationSummary;
  // The workflow report's verificationSummary is already the audit VerificationAuditSummary shape;
  // the deep redact below re-scrubs every string leaf, so trusting the runtime shape is safe here.
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
