// Quality Intelligence deterministic ("scripted") workflow run entries (Epic #270, Issue #273,
// ADR-0023 D6).
//
// Pure orchestration over the seams shipped in #272 (pure-domain QI logic), #279 (model gateway QI
// dispatcher), and #274 (QI evidence persistence). Shares the run-lifecycle runtime with the
// model-routed entry via `runtimeCommon.ts`. NO new scheduler, NO event bus, NO duplicated
// checkpoint store.
//
// Structurally inspired by Test Intelligence reference (TI) workflow runners, but rewritten
// end-to-end against the Keiko contracts surface; no TI runtime, no TI IR.

import {
  QualityIntelligence as QI,
  type ModelCapability,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-contracts";
import {
  deduplicateCandidates,
  deriveIntent,
  designTestCaseCandidates,
  validateCandidates,
  type PolicyProfile,
} from "@oscharko-dev/keiko-quality-intelligence";
import {
  type QualityIntelligenceBudgetState,
  type QualityIntelligenceDispatcherArgs,
  type QualityIntelligenceDispatcherResult,
  type QualityIntelligenceReplayCachePort,
} from "@oscharko-dev/keiko-model-gateway";
import { type QualityIntelligenceLocalStore } from "@oscharko-dev/keiko-evidence";
import {
  QI_ARTIFACT_REFINEMENT_WORKFLOW_DESCRIPTOR,
  QI_COVERAGE_REVIEW_WORKFLOW_DESCRIPTOR,
  QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR,
  QI_VALIDATION_WORKFLOW_DESCRIPTOR,
} from "./descriptors.js";
import {
  emit,
  emitCandidateProposed,
  emitFindingsRecorded,
  emitQueuedAndStarted,
  coverageMatrixFor,
  finaliseFailureOrCancellation,
  makeContext,
  persistRun,
  truncateCandidates,
  truncateFindings,
  withStage,
  type QualityIntelligenceClock,
  type QualityIntelligenceProvenanceRefs,
  type QualityIntelligenceRunEventSink,
  type QualityIntelligenceRunSummary,
  type RunContext,
} from "./runtimeCommon.js";
import type { QualityIntelligenceWorkflowLimits } from "./descriptors.js";

// Re-export the shared runtime types so the package barrel surface stays stable.
export type {
  QualityIntelligenceClock,
  QualityIntelligenceProvenanceRefs,
  QualityIntelligenceRunEventSink,
  QualityIntelligenceRunStatus,
  QualityIntelligenceRunSummary,
} from "./runtimeCommon.js";

// ─── Model-routed ports (judge dispatch) ───────────────────────────────────────

/**
 * Optional model-routed dispatch surface. When omitted, judges/refinements skip the model call and
 * fall through to the pure-domain validators only. When supplied, the dispatcher is invoked through
 * the gateway seam from #279.
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
  readonly provenanceRefs: QualityIntelligenceProvenanceRefs;
}

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

function contextFor(
  descriptor: typeof QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR,
  plan: QI.QualityIntelligenceRunPlan,
  deps: QualityIntelligenceRunEntryDeps,
): RunContext {
  return makeContext({
    descriptor,
    plan,
    sink: deps.sink,
    clock: deps.clock,
    limits: deps.limits,
    policyProfile: deps.policyProfile,
    signal: deps.signal,
  });
}

// ─── qi:test-design (scripted) ─────────────────────────────────────────────────

// The orchestrator follows a strict 6-stage QI lifecycle (queued → started → 4 stages →
// succeeded); extracting per-stage helpers would obscure the event-emission audit trail.
// eslint-disable-next-line max-lines-per-function
export async function runQualityIntelligenceTestDesign(
  input: QualityIntelligenceTestDesignInput,
  deps: QualityIntelligenceRunEntryDeps,
): Promise<QualityIntelligenceRunSummary> {
  const ctx = contextFor(QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR, input.plan, deps);
  emitQueuedAndStarted(ctx);
  try {
    await withStage(ctx, "plan", async () => Promise.resolve());
    // Intent derivation is a deterministic sub-step of candidate design, not a separately surfaced
    // stage. The shared qi:test-design descriptor declares the model-routed lifecycle
    // (plan, candidates, judge, coverage, validate, finalize); emitting an undeclared "intent"
    // stage here threw via assertStageRegistered and made this scripted entry impossible to
    // succeed. Derive intent inside the declared "candidates" stage so the scripted entry stays a
    // strict subset of the descriptor's stage set.
    const rawCandidates = await withStage(ctx, "candidates", async () => {
      const intent = deriveIntent(input.envelopes, ctx.profile);
      return Promise.resolve(
        designTestCaseCandidates({
          runId: input.plan.id,
          intent,
          atoms: input.atoms,
          profile: ctx.profile,
        }),
      );
    });
    const candidates = truncateCandidates(rawCandidates, ctx.limits.maxCandidatesPerRun);
    emitCandidateProposed(ctx, candidates);
    const coverageMatrix = await withStage(ctx, "coverage", async () =>
      Promise.resolve(coverageMatrixFor(input.plan.id, input.atoms, candidates)),
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
          coverageMatrix,
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
  const ctx = contextFor(QI_COVERAGE_REVIEW_WORKFLOW_DESCRIPTOR, input.plan, deps);
  emitQueuedAndStarted(ctx);
  try {
    await withStage(ctx, "plan", async () => Promise.resolve());
    const coverageMatrix = await withStage(ctx, "analyse", async () =>
      Promise.resolve(coverageMatrixFor(input.plan.id, input.atoms, input.candidates)),
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
          coverageMatrix,
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

// Minimal stand-in for the qi:judge-logic profile so this module does not have to plumb a profile
// id through every caller. The profile lookup itself stays the dispatcher's responsibility.
const QI_JUDGE_LOGIC_PROFILE = Object.freeze({
  id: "qi:judge-logic" as const,
  requiredCapabilities: Object.freeze(["text"] as const),
  tokenBudgetHint: 1024,
  timeoutMsHint: 30_000,
  retriesMax: 1,
  cacheable: false,
  temperatureHint: 0,
});

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
  let budget = modelRouted.initialBudget;
  if (ctx.modelGatewayCallCount >= ctx.limits.maxModelCallsPerRun) {
    return budget;
  }
  const evidence = candidates.slice(0, 4).map((c) => ({
    kind: "normalised-text" as const,
    value: `candidate:${String(c.id)}`,
  }));
  const result = await modelRouted.dispatch.dispatch({
    profile: QI_JUDGE_LOGIC_PROFILE,
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

export async function runQualityIntelligenceValidation(
  input: QualityIntelligenceValidationInput,
  deps: QualityIntelligenceRunEntryDeps,
): Promise<QualityIntelligenceRunSummary> {
  const ctx = contextFor(QI_VALIDATION_WORKFLOW_DESCRIPTOR, input.plan, deps);
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
  const ctx = contextFor(QI_ARTIFACT_REFINEMENT_WORKFLOW_DESCRIPTOR, input.plan, deps);
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
