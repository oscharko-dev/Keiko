// Quality Intelligence model-routed test-design run entry (Epic #270, Issue #272/#273/#279).
//
// The live generation path: real source evidence → Keiko Model Gateway → generated test-case
// candidates → pure-domain dedup / coverage / validation → evidence + candidate-artifact persist.
// Shares the run-lifecycle runtime with the scripted entries via `runtimeCommon.ts`. The model call
// is injected as an abstract `generate` port so this module stays free of provider SDKs and the
// server tier owns the gateway wiring (ADR-0023 D5/D6).

import { QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import {
  buildAtomCoverageStatuses,
  buildCoverageMap,
  deduplicateCandidates,
  validateCandidates,
  QualityIntelligenceGeneration,
  type AtomCoverageStatus,
  type PolicyProfile,
} from "@oscharko-dev/keiko-quality-intelligence";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  QualityIntelligenceCoverageMatrixRow,
  QualityIntelligenceLocalStore,
} from "@oscharko-dev/keiko-evidence";
import { QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR } from "./descriptors.js";
import {
  emit,
  emitCandidateProposed,
  emitFindingsRecorded,
  emitQueuedAndStarted,
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

type Candidate = QI.QualityIntelligenceTestCaseCandidate;
type EvidenceAtom = QI.QualityIntelligenceEvidenceAtom;

/** A content-bearing ingested atom: the wire-safe atom plus its server-side canonical text. */
export interface QualityIntelligenceIngestedAtom {
  readonly atom: EvidenceAtom;
  readonly canonicalText: string;
}

export interface QualityIntelligenceGenerationPortArgs {
  readonly systemPrompt: string;
  readonly instruction: string;
  readonly evidence: readonly {
    readonly index: number;
    readonly kind: string;
    readonly text: string;
  }[];
  readonly maxCandidates: number;
  readonly signal?: AbortSignal | undefined;
}

export interface QualityIntelligenceGenerationPortResult {
  readonly rawText: string;
  readonly modelCallCount: number;
  readonly modelId: string;
}

/** Abstract model-generation seam. The server backs it with the real Keiko Model Gateway port. */
export interface QualityIntelligenceGenerationPort {
  readonly generate: (
    args: QualityIntelligenceGenerationPortArgs,
  ) => Promise<QualityIntelligenceGenerationPortResult>;
}

/** Persistence seam for the generated candidate bodies (companion artifact in #274). */
export interface QualityIntelligenceCandidatesSink {
  readonly record: (candidates: readonly Candidate[], generatedAt: string) => void;
}

/** Abstract model-judge seam (Epic #736, Issue #747). The server backs it with the gateway judge port. */
export interface QualityIntelligenceJudgePort {
  readonly judge: (
    candidateText: string,
    signal?: AbortSignal,
  ) => Promise<QI.TestQualityJudgeVerdict>;
}

export interface QualityIntelligenceModelRoutedTestDesignInput {
  readonly plan: QI.QualityIntelligenceRunPlan;
  readonly envelopes: readonly QI.QualityIntelligenceSourceEnvelope[];
  readonly ingestedAtoms: readonly QualityIntelligenceIngestedAtom[];
  readonly provenanceRefs: QualityIntelligenceProvenanceRefs;
  readonly profile?: PolicyProfile | undefined;
}

export interface QualityIntelligenceModelRoutedTestDesignDeps {
  readonly sink: QualityIntelligenceRunEventSink;
  readonly evidenceStore: QualityIntelligenceLocalStore;
  readonly candidatesSink: QualityIntelligenceCandidatesSink;
  readonly generate: QualityIntelligenceGenerationPort;
  /** Optional model-judge for test-quality scoring (Epic #736). Absent → judge stage is skipped. */
  readonly judge?: QualityIntelligenceJudgePort | undefined;
  readonly clock?: QualityIntelligenceClock | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly limits?: QualityIntelligenceWorkflowLimits | undefined;
}

class EmptyEvidenceError extends Error {
  constructor() {
    super("No usable evidence atoms were ingested for the run");
    this.name = "EmptyEvidenceError";
  }
}

class UnparseableModelOutputError extends Error {
  constructor() {
    super("Model output could not be parsed into test cases");
    this.name = "UnparseableModelOutputError";
  }
}

interface QiEvidenceRefRow {
  readonly envelopeId: string;
  readonly atomId: string;
  readonly lifecycleStatus: QI.QualityIntelligenceLifecycleStatus;
}

function evidenceRefsFor(
  ingestedAtoms: readonly QualityIntelligenceIngestedAtom[],
): readonly QiEvidenceRefRow[] {
  return Object.freeze(
    ingestedAtoms.map((a) =>
      Object.freeze({
        envelopeId: String(a.atom.sourceEnvelopeId),
        atomId: String(a.atom.id),
        lifecycleStatus: a.atom.lifecycleStatus,
      }),
    ),
  );
}

function buildCoverageGapFinding(
  runId: QI.QualityIntelligenceRunId,
  atomStatus: AtomCoverageStatus,
  ordinal: number,
): QI.QualityIntelligenceCoverageGapFinding {
  const payload = ["v1-cov-gap", String(runId), String(atomStatus.atomId), String(ordinal)].join(
    "",
  );
  const idStr = `qi-finding-${sha256Hex(payload).slice(0, 32)}`;
  return Object.freeze({
    kind: "coverage-gap",
    id: QI.asQualityIntelligenceValidationFindingId(idStr),
    runId,
    severity: "medium",
    summary: `Atom ${String(atomStatus.atomId)} has no sufficient test coverage (status: ${atomStatus.status}).`,
    evidenceAtomIds: Object.freeze([atomStatus.atomId]),
  });
}

function toCoverageMatrixRows(
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

async function generateCandidates(
  ctx: RunContext,
  input: QualityIntelligenceModelRoutedTestDesignInput,
  deps: QualityIntelligenceModelRoutedTestDesignDeps,
): Promise<readonly Candidate[]> {
  if (input.ingestedAtoms.length === 0) {
    throw new EmptyEvidenceError();
  }
  const evidence = input.ingestedAtoms.map((a, i) => ({
    index: i + 1,
    kind: a.atom.kind,
    text: a.canonicalText,
  }));
  const maxCandidates = ctx.limits.maxCandidatesPerRun;
  const instruction = QualityIntelligenceGeneration.buildTestDesignInstruction({
    evidenceCount: evidence.length,
    profile: ctx.profile,
    maxTestCases: maxCandidates,
  });
  const result = await deps.generate.generate({
    systemPrompt: QualityIntelligenceGeneration.QI_TEST_DESIGN_SYSTEM_PROMPT,
    instruction,
    evidence,
    maxCandidates,
    signal: ctx.signal,
  });
  ctx.modelGatewayCallCount += result.modelCallCount;
  const parsed = QualityIntelligenceGeneration.parseGeneratedCandidates(result.rawText, {
    runId: input.plan.id,
    atomIds: input.ingestedAtoms.map((a) => a.atom.id),
    profile: ctx.profile,
    maxCandidates,
  });
  if (!parsed.recovered) {
    throw new UnparseableModelOutputError();
  }
  return truncateCandidates(deduplicateCandidates(parsed.candidates), maxCandidates);
}

function candidateSummaryText(candidate: Candidate): string {
  const parts = [
    `Title: ${candidate.title}`,
    `Steps: ${candidate.steps.join("; ")}`,
    `Expected: ${candidate.expectedResults.join("; ")}`,
  ];
  return parts.join("\n");
}

function buildTestQualityFinding(
  runId: QI.QualityIntelligenceRunId,
  candidate: Candidate,
  score: number,
  ordinal: number,
): QI.QualityIntelligenceTestQualityFinding {
  const payload = ["v1-tq", String(runId), String(candidate.id), String(ordinal)].join("");
  const idStr = `qi-finding-${sha256Hex(payload).slice(0, 32)}`;
  const severity: QI.QualityIntelligenceSeverity = score < 30 ? "high" : "medium";
  return Object.freeze({
    kind: "test-quality",
    id: QI.asQualityIntelligenceValidationFindingId(idStr),
    runId,
    candidateId: candidate.id,
    severity,
    summary: `Test quality score ${String(Math.round(score))}/100 — candidate judged weak.`,
    evidenceAtomIds: Object.freeze([...candidate.derivedFromAtomIds]),
  });
}

interface JudgeStageResult {
  readonly findings: readonly QI.QualityIntelligenceTestQualityFinding[];
  readonly qualityScore: number | null;
}

async function runJudgeStage(
  ctx: RunContext,
  candidates: readonly Candidate[],
  judge: QualityIntelligenceJudgePort,
): Promise<JudgeStageResult> {
  if (candidates.length === 0) return { findings: Object.freeze([]), qualityScore: null };
  const findings: QI.QualityIntelligenceTestQualityFinding[] = [];
  let strongCount = 0;
  let scored = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    scored += 1;
    const text = candidateSummaryText(candidate);
    const verdict = await judge.judge(text, ctx.signal);
    if (verdict.verdict === "strong") {
      strongCount += 1;
      continue;
    }
    const scores = verdict.dimensions.map((d) => d.score);
    const mean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    findings.push(buildTestQualityFinding(ctx.plan.id, candidate, mean, i));
  }
  // Per-run quality score = share of candidates the judge rated "strong", as a percentage (#747).
  const qualityScore = scored === 0 ? null : (strongCount / scored) * 100;
  return { findings: Object.freeze(findings), qualityScore };
}

/**
 * Execute a model-routed QI test-design run end to end. Emits the standard QI run-event envelope,
 * fails the run with a safe reason when the model output is unusable (rather than silently emitting
 * zero candidates), and persists both the run manifest and the generated candidate bodies.
 */
// eslint-disable-next-line max-lines-per-function -- strict QI lifecycle: linear stage audit trail.
export async function runQualityIntelligenceModelRoutedTestDesign(
  input: QualityIntelligenceModelRoutedTestDesignInput,
  deps: QualityIntelligenceModelRoutedTestDesignDeps,
): Promise<QualityIntelligenceRunSummary> {
  const ctx = makeContext({
    descriptor: QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR,
    plan: input.plan,
    sink: deps.sink,
    clock: deps.clock,
    limits: deps.limits,
    policyProfile: input.profile,
    signal: deps.signal,
  });
  const evidenceRefs = evidenceRefsFor(input.ingestedAtoms);
  emitQueuedAndStarted(ctx);
  try {
    await withStage(ctx, "plan", async () => Promise.resolve());
    const candidates = await withStage(ctx, "candidates", async () =>
      generateCandidates(ctx, input, deps),
    );
    emitCandidateProposed(ctx, candidates);
    const judgeResult = await withStage(ctx, "judge", async () => {
      if (deps.judge === undefined) {
        return Promise.resolve<JudgeStageResult>({
          findings: Object.freeze([]),
          qualityScore: null,
        });
      }
      return runJudgeStage(ctx, candidates, deps.judge);
    });
    const atoms = input.ingestedAtoms.map((a) => a.atom);
    const coverageMap = await withStage(ctx, "coverage", async () =>
      Promise.resolve(buildCoverageMap({ runId: input.plan.id, atoms, candidates })),
    );
    const atomStatuses = buildAtomCoverageStatuses(atoms, coverageMap);
    const coverageMatrix = toCoverageMatrixRows(atomStatuses);
    const gapFindings: QI.QualityIntelligenceCoverageGapFinding[] = [];
    for (let i = 0; i < atomStatuses.length; i += 1) {
      const s = atomStatuses[i];
      if (s !== undefined && s.status !== "covered") {
        gapFindings.push(buildCoverageGapFinding(input.plan.id, s, i));
      }
    }
    const rawFindings = await withStage(ctx, "validate", async () =>
      Promise.resolve(validateCandidates(input.plan.id, candidates)),
    );
    const allFindings: readonly QI.QualityIntelligenceValidationFinding[] = [
      ...gapFindings,
      ...rawFindings,
      ...judgeResult.findings,
    ];
    const findings = truncateFindings(allFindings, ctx.limits.maxFindingsPerRun);
    emitFindingsRecorded(ctx, findings);
    const evidence = await withStage(ctx, "finalize", async () => {
      const completedAt = ctx.clock.nowIso();
      const result = persistRun({
        ctx,
        status: "succeeded",
        candidatesCount: candidates.length,
        findings,
        evidenceRefs,
        provenanceRefs: input.provenanceRefs,
        completedAt,
        evidenceStore: deps.evidenceStore,
        coverageMatrix,
        qualityScore: judgeResult.qualityScore,
      });
      deps.candidatesSink.record(candidates, completedAt);
      return Promise.resolve(result);
    });
    emit(ctx, { kind: "run:succeeded" });
    return Object.freeze<QualityIntelligenceRunSummary>({
      runId: input.plan.id,
      workflowId: ctx.descriptor.workflowId,
      status: "succeeded",
      eventsEmitted: ctx.sequence,
      modelGatewayCallCount: ctx.modelGatewayCallCount,
      evidence,
      qualityScore: judgeResult.qualityScore,
    });
  } catch (caught: unknown) {
    return finaliseFailureOrCancellation(ctx, caught, {
      candidatesCount: 0,
      findings: Object.freeze([]),
      evidenceRefs,
      provenanceRefs: input.provenanceRefs,
      evidenceStore: deps.evidenceStore,
    });
  }
}
