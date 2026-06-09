// Shared Quality Intelligence run-lifecycle runtime (Epic #270, Issue #273, ADR-0023 D6).
//
// Behaviour-preserving extraction of the run-event emission, stage tracking, cancellation, and
// evidence-persistence helpers shared by every QI run entry (the deterministic test-design /
// coverage / validation / refinement entries in `runEntries.ts` and the model-routed test-design
// entry in `modelRoutedTestDesign.ts`). NO new scheduler, NO event bus: this composes the existing
// Harness world and emits the versioned QI run-event envelope from `@oscharko-dev/keiko-contracts`.

import { QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import {
  recordQualityIntelligenceRun,
  type QualityIntelligenceCoverageMatrixRow,
  type QualityIntelligenceLocalStore,
  type QualityIntelligenceRecordInput,
  type QualityIntelligenceRecordResult,
} from "@oscharko-dev/keiko-evidence";
import { QualityIntelligenceSafeErrorException } from "@oscharko-dev/keiko-model-gateway";
import {
  buildAtomCoverageStatuses,
  buildCoverageMap,
  regressionDefault,
  type AtomCoverageStatus,
  type PolicyProfile,
} from "@oscharko-dev/keiko-quality-intelligence";
import { QUALITY_INTELLIGENCE_DEFAULT_RETENTION_PROFILE_ID } from "@oscharko-dev/keiko-evidence";
import type {
  QualityIntelligenceWorkflowDescriptor,
  QualityIntelligenceWorkflowLimits,
} from "./descriptors.js";
import { composeStageCancellation, isCancelled } from "./cancellation.js";

// ─── Public ports ────────────────────────────────────────────────────────────

/** Sink for QI run events. Mirrors the harness EventSink shape but typed for the QI envelope. */
export interface QualityIntelligenceRunEventSink {
  readonly emit: (event: QI.QualityIntelligenceRunEvent) => void;
}

/** Wall-clock port. Defaults to `Date.now`; injected for deterministic tests. */
export interface QualityIntelligenceClock {
  readonly nowIso: () => string;
}

export const DEFAULT_CLOCK: QualityIntelligenceClock = Object.freeze({
  nowIso: (): string => new Date().toISOString(),
});

export type QualityIntelligenceProvenanceRefs = QualityIntelligenceRecordInput["provenanceRefs"];

export type QualityIntelligenceRunStatus = "succeeded" | "failed" | "cancelled";

export interface QualityIntelligenceRunSummary {
  readonly runId: QI.QualityIntelligenceRunId;
  readonly workflowId: QualityIntelligenceWorkflowDescriptor["workflowId"];
  readonly status: QualityIntelligenceRunStatus;
  readonly eventsEmitted: number;
  readonly modelGatewayCallCount: number;
  readonly evidence?: QualityIntelligenceRecordResult | undefined;
  readonly reasonSummary?: string | undefined;
  /** Mean test-quality judge score [0-100]; null when the judge stage was skipped or unavailable. */
  readonly qualityScore?: number | null;
}

// ─── Run context ─────────────────────────────────────────────────────────────

export interface RunContext {
  readonly descriptor: QualityIntelligenceWorkflowDescriptor;
  readonly plan: QI.QualityIntelligenceRunPlan;
  readonly sink: QualityIntelligenceRunEventSink;
  readonly clock: QualityIntelligenceClock;
  readonly limits: QualityIntelligenceWorkflowLimits;
  readonly profile: PolicyProfile;
  readonly signal: AbortSignal | undefined;
  sequence: number;
  modelGatewayCallCount: number;
}

export interface RunContextInit {
  readonly descriptor: QualityIntelligenceWorkflowDescriptor;
  readonly plan: QI.QualityIntelligenceRunPlan;
  readonly sink: QualityIntelligenceRunEventSink;
  readonly clock?: QualityIntelligenceClock | undefined;
  readonly limits?: QualityIntelligenceWorkflowLimits | undefined;
  readonly policyProfile?: PolicyProfile | undefined;
  readonly signal?: AbortSignal | undefined;
}

export function makeContext(init: RunContextInit): RunContext {
  return {
    descriptor: init.descriptor,
    plan: init.plan,
    sink: init.sink,
    clock: init.clock ?? DEFAULT_CLOCK,
    limits: init.limits ?? init.descriptor.defaultLimits,
    profile: init.policyProfile ?? regressionDefault,
    signal: init.signal,
    sequence: 0,
    modelGatewayCallCount: 0,
  };
}

function nextSequence(ctx: RunContext): number {
  const value = ctx.sequence;
  ctx.sequence = value + 1;
  return value;
}

export function emit(ctx: RunContext, payload: QI.QualityIntelligenceRunEventPayload): void {
  const event: QI.QualityIntelligenceRunEvent = Object.freeze({
    eventSchemaVersion: QI.QUALITY_INTELLIGENCE_EVENT_SCHEMA_VERSION,
    runId: ctx.plan.id,
    sequence: nextSequence(ctx),
    timestamp: ctx.clock.nowIso(),
    payload: Object.freeze(payload),
  });
  ctx.sink.emit(event);
}

export function emitQueuedAndStarted(ctx: RunContext): void {
  emit(ctx, { kind: "run:queued" });
  emit(ctx, { kind: "run:started" });
}

function assertStageRegistered(
  descriptor: QualityIntelligenceWorkflowDescriptor,
  stageName: string,
): void {
  if (!descriptor.stageNames.includes(stageName)) {
    throw new Error(`Stage "${stageName}" is not declared by descriptor ${descriptor.workflowId}`);
  }
}

export class StageCancelledError extends Error {
  constructor() {
    super("Quality Intelligence run cancelled before completion");
    this.name = "StageCancelledError";
  }
}

export function checkCancelled(ctx: RunContext): void {
  if (isCancelled(ctx.signal)) {
    throw new StageCancelledError();
  }
}

export function safeReasonSummary(error: unknown): string {
  if (error instanceof QualityIntelligenceSafeErrorException) {
    return `qi-safe-error: ${error.safe.code}`;
  }
  if (error instanceof Error) {
    const firstLine = error.message.split("\n")[0] ?? error.name;
    return firstLine.slice(0, 200);
  }
  return "unknown-error";
}

export async function withStage<T>(
  ctx: RunContext,
  stageName: string,
  body: () => Promise<T>,
): Promise<T> {
  assertStageRegistered(ctx.descriptor, stageName);
  checkCancelled(ctx);
  emit(ctx, { kind: "stage:started", stageName });
  const handle = composeStageCancellation(ctx.signal);
  try {
    const result = await body();
    checkCancelled(ctx);
    emit(ctx, { kind: "stage:completed", stageName });
    return result;
  } catch (caught: unknown) {
    if (caught instanceof StageCancelledError) {
      throw caught;
    }
    if (isCancelled(ctx.signal)) {
      // The stage work threw because the run was cancelled mid-flight (e.g. the model call's
      // AbortSignal fired and the gateway rejected). That is a cancellation, not a stage failure:
      // do not emit stage:failed, and let the finaliser classify the run as "cancelled".
      throw new StageCancelledError();
    }
    emit(ctx, { kind: "stage:failed", stageName, reasonSummary: safeReasonSummary(caught) });
    throw caught;
  } finally {
    handle.dispose();
  }
}

// ─── Candidate / finding helpers ─────────────────────────────────────────────

export function truncateCandidates(
  candidates: readonly QI.QualityIntelligenceTestCaseCandidate[],
  limit: number,
): readonly QI.QualityIntelligenceTestCaseCandidate[] {
  return candidates.length <= limit ? candidates : Object.freeze(candidates.slice(0, limit));
}

export function truncateFindings(
  findings: readonly QI.QualityIntelligenceValidationFinding[],
  limit: number,
): readonly QI.QualityIntelligenceValidationFinding[] {
  return findings.length <= limit ? findings : Object.freeze(findings.slice(0, limit));
}

/** Project per-atom coverage statuses into persistable, refs-only matrix rows (Epic #734). */
export function toCoverageMatrixRows(
  statuses: readonly AtomCoverageStatus[],
): readonly QualityIntelligenceCoverageMatrixRow[] {
  return Object.freeze(
    statuses.map((s) =>
      Object.freeze({
        atomId: String(s.atomId),
        status: s.status,
        confidence: s.confidence,
        coveringCandidateIds: Object.freeze(s.coveringCandidateIds.map(String)),
      }),
    ),
  );
}

/**
 * Build the persistable coverage matrix for a run from its atoms + candidates. Used by every run
 * path so coverage is persisted consistently (the scripted paths previously discarded it).
 */
export function coverageMatrixFor(
  runId: QI.QualityIntelligenceRunId,
  atoms: readonly QI.QualityIntelligenceEvidenceAtom[],
  candidates: readonly QI.QualityIntelligenceTestCaseCandidate[],
): readonly QualityIntelligenceCoverageMatrixRow[] {
  const coverageMap = buildCoverageMap({ runId, atoms, candidates });
  return toCoverageMatrixRows(buildAtomCoverageStatuses(atoms, coverageMap));
}

export function emitCandidateProposed(
  ctx: RunContext,
  candidates: readonly QI.QualityIntelligenceTestCaseCandidate[],
): void {
  for (const candidate of candidates) {
    emit(ctx, {
      kind: "candidate:proposed",
      candidateId: candidate.id,
      derivedFromAtomIds: candidate.derivedFromAtomIds,
    });
  }
}

export function emitFindingsRecorded(
  ctx: RunContext,
  findings: readonly QI.QualityIntelligenceValidationFinding[],
): void {
  for (const finding of findings) {
    emit(ctx, { kind: "finding:recorded", findingId: finding.id });
  }
}

// ─── Evidence persistence ────────────────────────────────────────────────────

export type EvidenceStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface PersistArgs {
  readonly ctx: RunContext;
  readonly status: EvidenceStatus;
  readonly candidatesCount: number;
  readonly findings: readonly QI.QualityIntelligenceValidationFinding[];
  readonly evidenceRefs?: QualityIntelligenceRecordInput["evidenceRefs"] | undefined;
  readonly provenanceRefs: QualityIntelligenceProvenanceRefs;
  readonly completedAt: string | undefined;
  readonly evidenceStore: QualityIntelligenceLocalStore;
  readonly coverageMatrix?: QualityIntelligenceRecordInput["coverageMatrix"];
  readonly qualityScore?: number | null;
  readonly sourceFingerprints?: QualityIntelligenceRecordInput["sourceFingerprints"];
  readonly atomFingerprints?: QualityIntelligenceRecordInput["atomFingerprints"];
  /** Model id that generated the candidates (Epic #761). */
  readonly modelId?: string;
  /** Redaction-safe request parameter scalars (Epic #761). */
  readonly modelParameters?: Record<string, unknown>;
  /** Seed used for deterministic sampling (Epic #761). */
  readonly seedUsed?: number | null;
}

function mapFindingsToRows(
  findings: readonly QI.QualityIntelligenceValidationFinding[],
): QualityIntelligenceRecordInput["findings"] {
  return Object.freeze(
    findings.map((f) =>
      Object.freeze({
        id: String(f.id),
        kind: f.kind,
        severity: f.severity,
        summaryRedacted: f.summary,
        ...(f.candidateId !== undefined ? { candidateId: String(f.candidateId) } : {}),
      }),
    ),
  );
}

export function persistRun(args: PersistArgs): QualityIntelligenceRecordResult {
  const findingRows = mapFindingsToRows(args.findings);
  const evidenceRefs = args.evidenceRefs ?? Object.freeze([]);
  const input: QualityIntelligenceRecordInput = {
    runId: String(args.ctx.plan.id),
    planAt: args.ctx.plan.requestedAt,
    completedAt: args.completedAt,
    status: args.status,
    policyProfileIds: Object.freeze([args.ctx.profile.id]),
    retentionPolicyId: QUALITY_INTELLIGENCE_DEFAULT_RETENTION_PROFILE_ID,
    modelGatewayCallCount: args.ctx.modelGatewayCallCount,
    totals: Object.freeze({
      candidates: args.candidatesCount,
      findings: findingRows.length,
      exports: 0,
    }),
    findings: findingRows,
    exports: Object.freeze([]),
    evidenceRefs,
    provenanceRefs: args.provenanceRefs,
    coverageMatrix: args.coverageMatrix,
    ...(args.qualityScore !== undefined ? { qualityScore: args.qualityScore } : {}),
    ...(args.sourceFingerprints !== undefined
      ? { sourceFingerprints: args.sourceFingerprints }
      : {}),
    ...(args.atomFingerprints !== undefined ? { atomFingerprints: args.atomFingerprints } : {}),
    ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
    ...(args.modelParameters !== undefined ? { modelParameters: args.modelParameters } : {}),
    ...(args.seedUsed !== undefined ? { seedUsed: args.seedUsed } : {}),
  };
  return recordQualityIntelligenceRun(input, { store: args.evidenceStore });
}

// ─── Shared failure / cancellation finaliser ─────────────────────────────────

export interface FinaliseArgs {
  readonly candidatesCount: number;
  readonly findings: readonly QI.QualityIntelligenceValidationFinding[];
  readonly evidenceRefs?: QualityIntelligenceRecordInput["evidenceRefs"] | undefined;
  readonly provenanceRefs: QualityIntelligenceProvenanceRefs;
  readonly evidenceStore: QualityIntelligenceLocalStore;
}

export function finaliseFailureOrCancellation(
  ctx: RunContext,
  caught: unknown,
  args: FinaliseArgs,
): QualityIntelligenceRunSummary {
  // A StageCancelledError, or any error raised while the run signal is aborted, is a cancellation
  // (defense-in-depth: an abort-induced rejection that bypassed withStage must not look like a failure).
  if (caught instanceof StageCancelledError || isCancelled(ctx.signal)) {
    emit(ctx, { kind: "run:cancelled" });
    return Object.freeze<QualityIntelligenceRunSummary>({
      runId: ctx.plan.id,
      workflowId: ctx.descriptor.workflowId,
      status: "cancelled",
      eventsEmitted: ctx.sequence,
      modelGatewayCallCount: ctx.modelGatewayCallCount,
    });
  }
  const reasonSummary = safeReasonSummary(caught);
  emit(ctx, { kind: "run:failed", reasonSummary });
  let evidence: QualityIntelligenceRecordResult | undefined;
  try {
    evidence = persistRun({
      ctx,
      status: "failed",
      candidatesCount: args.candidatesCount,
      findings: args.findings,
      evidenceRefs: args.evidenceRefs,
      provenanceRefs: args.provenanceRefs,
      completedAt: ctx.clock.nowIso(),
      evidenceStore: args.evidenceStore,
    });
  } catch {
    evidence = undefined;
  }
  return Object.freeze<QualityIntelligenceRunSummary>({
    runId: ctx.plan.id,
    workflowId: ctx.descriptor.workflowId,
    status: "failed",
    eventsEmitted: ctx.sequence,
    modelGatewayCallCount: ctx.modelGatewayCallCount,
    evidence,
    reasonSummary,
  });
}
