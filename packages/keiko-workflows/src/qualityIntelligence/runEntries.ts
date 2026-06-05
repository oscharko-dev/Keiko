// Quality Intelligence workflow run entries (Epic #270, Issue #273, ADR-0023 D6).
//
// Pure orchestration over the seams shipped in #272 (pure-domain QI logic),
// #279 (model gateway QI dispatcher), and #274 (QI evidence persistence). NO
// new scheduler, NO new event bus, NO duplicated checkpoint store: this layer
// composes the existing Harness world and emits the versioned QI run-event
// envelope from `@oscharko-dev/keiko-contracts`.
//
// Structurally inspired by Test Intelligence reference (TI) workflow runners,
// but rewritten end-to-end against the Keiko contracts surface; no TI runtime,
// no TI IR. Stage steps map directly onto the pure-domain functions exposed
// by `@oscharko-dev/keiko-quality-intelligence`.

import {
  QualityIntelligence as QI,
  type ModelCapability,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-contracts";
import {
  buildCoverageMap,
  deduplicateCandidates,
  deriveIntent,
  designTestCaseCandidates,
  regressionDefault,
  validateCandidates,
  type PolicyProfile,
} from "@oscharko-dev/keiko-quality-intelligence";
import {
  type QualityIntelligenceBudgetState,
  type QualityIntelligenceDispatcherArgs,
  type QualityIntelligenceDispatcherResult,
  type QualityIntelligenceReplayCachePort,
  QualityIntelligenceSafeErrorException,
} from "@oscharko-dev/keiko-model-gateway";
import {
  QUALITY_INTELLIGENCE_DEFAULT_RETENTION_PROFILE_ID,
  recordQualityIntelligenceRun,
  type QualityIntelligenceLocalStore,
  type QualityIntelligenceRecordInput,
  type QualityIntelligenceRecordResult,
} from "@oscharko-dev/keiko-evidence";
import {
  QI_ARTIFACT_REFINEMENT_WORKFLOW_DESCRIPTOR,
  QI_COVERAGE_REVIEW_WORKFLOW_DESCRIPTOR,
  QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR,
  QI_VALIDATION_WORKFLOW_DESCRIPTOR,
  type QualityIntelligenceWorkflowDescriptor,
  type QualityIntelligenceWorkflowLimits,
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

const DEFAULT_CLOCK: QualityIntelligenceClock = Object.freeze({
  nowIso: (): string => new Date().toISOString(),
});

/**
 * Optional model-routed dispatch surface. When omitted, judges/refinements skip
 * the model call and fall through to the pure-domain validators only. When
 * supplied, the dispatcher is invoked through the gateway seam from #279.
 */
export interface QualityIntelligenceDispatchPort {
  readonly dispatch: (
    args: QualityIntelligenceDispatcherArgs,
  ) => Promise<QualityIntelligenceDispatcherResult>;
}

export interface QualityIntelligenceModelRoutedDeps {
  readonly dispatch: QualityIntelligenceDispatchPort;
  readonly model: ModelCapability;
  readonly providerConfig: QualityIntelligenceDispatcherArgs["providerConfig"];
  readonly port: QualityIntelligenceDispatcherArgs["port"];
  readonly cache: QualityIntelligenceReplayCachePort<NormalizedResponse>;
  readonly initialBudget: QualityIntelligenceBudgetState;
}

export interface QualityIntelligenceRunEntryDeps {
  readonly sink: QualityIntelligenceRunEventSink;
  readonly evidenceStore: QualityIntelligenceLocalStore;
  readonly clock?: QualityIntelligenceClock | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly limits?: QualityIntelligenceWorkflowLimits | undefined;
  readonly policyProfile?: PolicyProfile | undefined;
  readonly modelRouted?: QualityIntelligenceModelRoutedDeps | undefined;
}

export interface QualityIntelligenceTestDesignInput {
  readonly plan: QI.QualityIntelligenceRunPlan;
  readonly envelopes: readonly QI.QualityIntelligenceSourceEnvelope[];
  readonly atoms: readonly QI.QualityIntelligenceEvidenceAtom[];
  readonly provenanceRefs: QI.QualityIntelligenceRunPlan extends never
    ? never
    : QualityIntelligenceProvenanceRefs;
}

// Re-export the evidence manifest provenance shape for callers (the only piece they
// must construct by hand — everything else flows from the plan/atoms/candidates).
export type QualityIntelligenceProvenanceRefs = QualityIntelligenceRecordInput["provenanceRefs"];

export interface QualityIntelligenceCoverageReviewInput {
  readonly plan: QI.QualityIntelligenceRunPlan;
  readonly atoms: readonly QI.QualityIntelligenceEvidenceAtom[];
  readonly candidates: readonly QI.QualityIntelligenceTestCaseCandidate[];
  readonly provenanceRefs: QualityIntelligenceProvenanceRefs;
}

export interface QualityIntelligenceValidationInput {
  readonly plan: QI.QualityIntelligenceRunPlan;
  readonly candidates: readonly QI.QualityIntelligenceTestCaseCandidate[];
  readonly provenanceRefs: QualityIntelligenceProvenanceRefs;
}

export interface QualityIntelligenceArtifactRefinementInput {
  readonly plan: QI.QualityIntelligenceRunPlan;
  readonly atoms: readonly QI.QualityIntelligenceEvidenceAtom[];
  readonly candidates: readonly QI.QualityIntelligenceTestCaseCandidate[];
  readonly provenanceRefs: QualityIntelligenceProvenanceRefs;
}

export type QualityIntelligenceRunStatus = "succeeded" | "failed" | "cancelled";

export interface QualityIntelligenceRunSummary {
  readonly runId: QI.QualityIntelligenceRunId;
  readonly workflowId: QualityIntelligenceWorkflowDescriptor["workflowId"];
  readonly status: QualityIntelligenceRunStatus;
  readonly eventsEmitted: number;
  readonly modelGatewayCallCount: number;
  readonly evidence?: QualityIntelligenceRecordResult | undefined;
  readonly reasonSummary?: string | undefined;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

interface RunContext {
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

function nextSequence(ctx: RunContext): number {
  const value = ctx.sequence;
  ctx.sequence = value + 1;
  return value;
}

function emit(ctx: RunContext, payload: QI.QualityIntelligenceRunEventPayload): void {
  const event: QI.QualityIntelligenceRunEvent = Object.freeze({
    eventSchemaVersion: QI.QUALITY_INTELLIGENCE_EVENT_SCHEMA_VERSION,
    runId: ctx.plan.id,
    sequence: nextSequence(ctx),
    timestamp: ctx.clock.nowIso(),
    payload: Object.freeze(payload),
  });
  ctx.sink.emit(event);
}

function emitQueuedAndStarted(ctx: RunContext): void {
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

class StageCancelledError extends Error {
  constructor() {
    super("Quality Intelligence run cancelled before completion");
    this.name = "StageCancelledError";
  }
}

function checkCancelled(ctx: RunContext): void {
  if (isCancelled(ctx.signal)) {
    throw new StageCancelledError();
  }
}

function safeReasonSummary(error: unknown): string {
  if (error instanceof QualityIntelligenceSafeErrorException) {
    return `qi-safe-error: ${error.safe.code}`;
  }
  if (error instanceof Error) {
    // Strip multi-line stack and downstream sensitive content; first line only,
    // capped to 200 chars — the run-event payload is non-secret.
    const firstLine = error.message.split("\n")[0] ?? error.name;
    return firstLine.slice(0, 200);
  }
  return "unknown-error";
}

async function withStage<T>(
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
      // Stage cancellation is reported by the run-level cancellation event; do
      // NOT emit a stage:failed here so the event stream stays accurate.
      throw caught;
    }
    emit(ctx, {
      kind: "stage:failed",
      stageName,
      reasonSummary: safeReasonSummary(caught),
    });
    throw caught;
  } finally {
    handle.dispose();
  }
}

function makeContext(
  descriptor: QualityIntelligenceWorkflowDescriptor,
  plan: QI.QualityIntelligenceRunPlan,
  deps: QualityIntelligenceRunEntryDeps,
): RunContext {
  return {
    descriptor,
    plan,
    sink: deps.sink,
    clock: deps.clock ?? DEFAULT_CLOCK,
    limits: deps.limits ?? descriptor.defaultLimits,
    profile: deps.policyProfile ?? regressionDefault,
    signal: deps.signal,
    sequence: 0,
    modelGatewayCallCount: 0,
  };
}

function truncateCandidates(
  candidates: readonly QI.QualityIntelligenceTestCaseCandidate[],
  limit: number,
): readonly QI.QualityIntelligenceTestCaseCandidate[] {
  if (candidates.length <= limit) {
    return candidates;
  }
  return Object.freeze(candidates.slice(0, limit));
}

function truncateFindings(
  findings: readonly QI.QualityIntelligenceValidationFinding[],
  limit: number,
): readonly QI.QualityIntelligenceValidationFinding[] {
  if (findings.length <= limit) {
    return findings;
  }
  return Object.freeze(findings.slice(0, limit));
}

function emitCandidateProposed(
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

function emitFindingsRecorded(
  ctx: RunContext,
  findings: readonly QI.QualityIntelligenceValidationFinding[],
): void {
  for (const finding of findings) {
    emit(ctx, { kind: "finding:recorded", findingId: finding.id });
  }
}

interface PersistArgs {
  readonly ctx: RunContext;
  readonly status: QI.QualityIntelligenceRunEvent extends never ? never : EvidenceStatus;
  readonly candidatesCount: number;
  readonly findings: readonly QI.QualityIntelligenceValidationFinding[];
  readonly provenanceRefs: QualityIntelligenceProvenanceRefs;
  readonly completedAt: string | undefined;
  readonly evidenceStore: QualityIntelligenceLocalStore;
}

type EvidenceStatus = "running" | "succeeded" | "failed" | "cancelled";

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
      }),
    ),
  );
}

function persistRun(args: PersistArgs): QualityIntelligenceRecordResult {
  const findingRows = mapFindingsToRows(args.findings);
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
    evidenceRefs: Object.freeze([]),
    provenanceRefs: args.provenanceRefs,
  };
  return recordQualityIntelligenceRun(input, { store: args.evidenceStore });
}

// ─── qi:test-design ──────────────────────────────────────────────────────────

// The orchestrator follows a strict 6-stage QI lifecycle (queued → started → 4
// stages → succeeded); extracting per-stage helpers would obscure the
// event-emission audit trail.
// eslint-disable-next-line max-lines-per-function
export async function runQualityIntelligenceTestDesign(
  input: QualityIntelligenceTestDesignInput,
  deps: QualityIntelligenceRunEntryDeps,
): Promise<QualityIntelligenceRunSummary> {
  const ctx = makeContext(QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR, input.plan, deps);
  emitQueuedAndStarted(ctx);
  try {
    await withStage(ctx, "plan", async () => Promise.resolve());
    const intent = await withStage(ctx, "intent", async () =>
      Promise.resolve(deriveIntent(input.envelopes, ctx.profile)),
    );
    const rawCandidates = await withStage(ctx, "candidates", async () =>
      Promise.resolve(
        designTestCaseCandidates({
          runId: input.plan.id,
          intent,
          atoms: input.atoms,
          profile: ctx.profile,
        }),
      ),
    );
    const candidates = truncateCandidates(rawCandidates, ctx.limits.maxCandidatesPerRun);
    emitCandidateProposed(ctx, candidates);
    await withStage(ctx, "coverage", async () =>
      Promise.resolve(buildCoverageMap({ runId: input.plan.id, atoms: input.atoms, candidates })),
    );
    const rawFindings = await withStage(ctx, "validate", async () =>
      Promise.resolve(validateCandidates(input.plan.id, candidates)),
    );
    const findings = truncateFindings(rawFindings, ctx.limits.maxFindingsPerRun);
    emitFindingsRecorded(ctx, findings);
    const evidence = await withStage(ctx, "finalize", async () =>
      Promise.resolve(
        persistRun({
          ctx,
          status: "succeeded",
          candidatesCount: candidates.length,
          findings,
          provenanceRefs: input.provenanceRefs,
          completedAt: ctx.clock.nowIso(),
          evidenceStore: deps.evidenceStore,
        }),
      ),
    );
    emit(ctx, { kind: "run:succeeded" });
    return Object.freeze<QualityIntelligenceRunSummary>({
      runId: input.plan.id,
      workflowId: ctx.descriptor.workflowId,
      status: "succeeded",
      eventsEmitted: ctx.sequence,
      modelGatewayCallCount: ctx.modelGatewayCallCount,
      evidence,
    });
  } catch (caught: unknown) {
    return finaliseFailureOrCancellation(ctx, caught, {
      candidatesCount: 0,
      findings: Object.freeze([]),
      provenanceRefs: input.provenanceRefs,
      evidenceStore: deps.evidenceStore,
    });
  }
}

// ─── qi:coverage-review ──────────────────────────────────────────────────────

export async function runQualityIntelligenceCoverageReview(
  input: QualityIntelligenceCoverageReviewInput,
  deps: QualityIntelligenceRunEntryDeps,
): Promise<QualityIntelligenceRunSummary> {
  const ctx = makeContext(QI_COVERAGE_REVIEW_WORKFLOW_DESCRIPTOR, input.plan, deps);
  emitQueuedAndStarted(ctx);
  try {
    await withStage(ctx, "plan", async () => Promise.resolve());
    await withStage(ctx, "analyse", async () =>
      Promise.resolve(
        buildCoverageMap({
          runId: input.plan.id,
          atoms: input.atoms,
          candidates: input.candidates,
        }),
      ),
    );
    const evidence = await withStage(ctx, "report", async () =>
      Promise.resolve(
        persistRun({
          ctx,
          status: "succeeded",
          candidatesCount: input.candidates.length,
          findings: Object.freeze([]),
          provenanceRefs: input.provenanceRefs,
          completedAt: ctx.clock.nowIso(),
          evidenceStore: deps.evidenceStore,
        }),
      ),
    );
    emit(ctx, { kind: "run:succeeded" });
    return Object.freeze<QualityIntelligenceRunSummary>({
      runId: input.plan.id,
      workflowId: ctx.descriptor.workflowId,
      status: "succeeded",
      eventsEmitted: ctx.sequence,
      modelGatewayCallCount: ctx.modelGatewayCallCount,
      evidence,
    });
  } catch (caught: unknown) {
    return finaliseFailureOrCancellation(ctx, caught, {
      candidatesCount: input.candidates.length,
      findings: Object.freeze([]),
      provenanceRefs: input.provenanceRefs,
      evidenceStore: deps.evidenceStore,
    });
  }
}

// ─── qi:validation ───────────────────────────────────────────────────────────

async function maybeRunJudges(
  ctx: RunContext,
  candidates: readonly QI.QualityIntelligenceTestCaseCandidate[],
  modelRouted: QualityIntelligenceModelRoutedDeps | undefined,
): Promise<QualityIntelligenceBudgetState | undefined> {
  if (modelRouted === undefined) {
    return undefined;
  }
  if (candidates.length === 0) {
    return modelRouted.initialBudget;
  }
  // Single judge dispatch per run keeps the orchestration deterministic and
  // bounded by the model-call budget. The dispatcher handles capability/budget
  // / cache / cancellation; if it throws a SafeErrorException, the stage's
  // catch surfaces a qi/* reasonSummary.
  let budget = modelRouted.initialBudget;
  if (ctx.modelGatewayCallCount >= ctx.limits.maxModelCallsPerRun) {
    return budget;
  }
  const profile = QI_JUDGE_LOGIC_PROFILE;
  const evidence = candidates.slice(0, 4).map((c) => ({
    kind: "normalised-text" as const,
    value: `candidate:${String(c.id)}`,
  }));
  const result = await modelRouted.dispatch.dispatch({
    profile,
    instruction: "Evaluate the listed candidates for logic defects (Keiko QI judge).",
    evidence,
    model: modelRouted.model,
    providerConfig: modelRouted.providerConfig,
    port: modelRouted.port,
    cache: modelRouted.cache,
    budget,
    signal: ctx.signal,
  });
  ctx.modelGatewayCallCount += 1;
  budget = result.budget;
  return budget;
}

// Minimal stand-in for the qi:judge-logic profile so this module does not have
// to plumb a profile id through every caller. The profile lookup itself stays
// the dispatcher's responsibility — this is the typed handle.
const QI_JUDGE_LOGIC_PROFILE = Object.freeze({
  id: "qi:judge-logic" as const,
  requiredCapabilities: Object.freeze(["text"] as const),
  tokenBudgetHint: 1024,
  timeoutMsHint: 30_000,
  retriesMax: 1,
  cacheable: false,
  temperatureHint: 0,
});

export async function runQualityIntelligenceValidation(
  input: QualityIntelligenceValidationInput,
  deps: QualityIntelligenceRunEntryDeps,
): Promise<QualityIntelligenceRunSummary> {
  const ctx = makeContext(QI_VALIDATION_WORKFLOW_DESCRIPTOR, input.plan, deps);
  emitQueuedAndStarted(ctx);
  try {
    await withStage(ctx, "plan", async () => Promise.resolve());
    await withStage(ctx, "run-judges", async () => {
      await maybeRunJudges(ctx, input.candidates, deps.modelRouted);
    });
    const rawFindings = await withStage(ctx, "reconcile", async () =>
      Promise.resolve(validateCandidates(input.plan.id, input.candidates)),
    );
    const findings = truncateFindings(rawFindings, ctx.limits.maxFindingsPerRun);
    emitFindingsRecorded(ctx, findings);
    const evidence = await withStage(ctx, "report", async () =>
      Promise.resolve(
        persistRun({
          ctx,
          status: "succeeded",
          candidatesCount: input.candidates.length,
          findings,
          provenanceRefs: input.provenanceRefs,
          completedAt: ctx.clock.nowIso(),
          evidenceStore: deps.evidenceStore,
        }),
      ),
    );
    emit(ctx, { kind: "run:succeeded" });
    return Object.freeze<QualityIntelligenceRunSummary>({
      runId: input.plan.id,
      workflowId: ctx.descriptor.workflowId,
      status: "succeeded",
      eventsEmitted: ctx.sequence,
      modelGatewayCallCount: ctx.modelGatewayCallCount,
      evidence,
    });
  } catch (caught: unknown) {
    return finaliseFailureOrCancellation(ctx, caught, {
      candidatesCount: input.candidates.length,
      findings: Object.freeze([]),
      provenanceRefs: input.provenanceRefs,
      evidenceStore: deps.evidenceStore,
    });
  }
}

// ─── qi:artifact-refinement ──────────────────────────────────────────────────

export async function runQualityIntelligenceArtifactRefinement(
  input: QualityIntelligenceArtifactRefinementInput,
  deps: QualityIntelligenceRunEntryDeps,
): Promise<QualityIntelligenceRunSummary> {
  const ctx = makeContext(QI_ARTIFACT_REFINEMENT_WORKFLOW_DESCRIPTOR, input.plan, deps);
  emitQueuedAndStarted(ctx);
  try {
    await withStage(ctx, "plan", async () => Promise.resolve());
    const refinedRaw = await withStage(ctx, "refine", async () =>
      Promise.resolve(deduplicateCandidates(input.candidates)),
    );
    const refined = truncateCandidates(refinedRaw, ctx.limits.maxCandidatesPerRun);
    emitCandidateProposed(ctx, refined);
    const rawFindings = await withStage(ctx, "validate", async () =>
      Promise.resolve(validateCandidates(input.plan.id, refined)),
    );
    const findings = truncateFindings(rawFindings, ctx.limits.maxFindingsPerRun);
    emitFindingsRecorded(ctx, findings);
    const evidence = await withStage(ctx, "report", async () =>
      Promise.resolve(
        persistRun({
          ctx,
          status: "succeeded",
          candidatesCount: refined.length,
          findings,
          provenanceRefs: input.provenanceRefs,
          completedAt: ctx.clock.nowIso(),
          evidenceStore: deps.evidenceStore,
        }),
      ),
    );
    emit(ctx, { kind: "run:succeeded" });
    return Object.freeze<QualityIntelligenceRunSummary>({
      runId: input.plan.id,
      workflowId: ctx.descriptor.workflowId,
      status: "succeeded",
      eventsEmitted: ctx.sequence,
      modelGatewayCallCount: ctx.modelGatewayCallCount,
      evidence,
    });
  } catch (caught: unknown) {
    return finaliseFailureOrCancellation(ctx, caught, {
      candidatesCount: input.candidates.length,
      findings: Object.freeze([]),
      provenanceRefs: input.provenanceRefs,
      evidenceStore: deps.evidenceStore,
    });
  }
}

// ─── Shared failure / cancellation finaliser ─────────────────────────────────

interface FinaliseArgs {
  readonly candidatesCount: number;
  readonly findings: readonly QI.QualityIntelligenceValidationFinding[];
  readonly provenanceRefs: QualityIntelligenceProvenanceRefs;
  readonly evidenceStore: QualityIntelligenceLocalStore;
}

function finaliseFailureOrCancellation(
  ctx: RunContext,
  caught: unknown,
  args: FinaliseArgs,
): QualityIntelligenceRunSummary {
  if (caught instanceof StageCancelledError) {
    emit(ctx, { kind: "run:cancelled" });
    // Per AC: partial cancellation must NOT poison the evidence store. We do
    // not persist a cancelled record from this layer; callers that need a
    // breadcrumb can record one explicitly with status:"cancelled".
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
  // Failures finalise the run record with status:"failed" so audits can see it.
  // If the persistence itself throws, surface the failure summary without the
  // evidence handle.
  let evidence: QualityIntelligenceRecordResult | undefined;
  try {
    evidence = persistRun({
      ctx,
      status: "failed",
      candidatesCount: args.candidatesCount,
      findings: args.findings,
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
