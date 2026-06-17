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
  buildRequirementExcerpt,
  computeCandidateEquivalenceSignature,
  deduplicateCandidates,
  deriveIntent,
  designTestCaseCandidates,
  scoreFromDimensions,
  TEST_QUALITY_WEAK_THRESHOLD,
  verdictFromDimensions,
  validateCandidates,
  QualityIntelligenceGeneration,
  type AtomCoverageStatus,
  type PolicyProfile,
} from "@oscharko-dev/keiko-quality-intelligence";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type {
  QualityIntelligenceLocalStore,
  QualityIntelligenceRecordOptions,
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
  safeReasonSummary,
  StageCancelledError,
  toCoverageMatrixRows,
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
import { isCancelled } from "./cancellation.js";

type Candidate = QI.QualityIntelligenceTestCaseCandidate;
type EvidenceAtom = QI.QualityIntelligenceEvidenceAtom;

/** A content-bearing ingested atom: the wire-safe atom plus its server-side canonical text. */
export interface QualityIntelligenceIngestedAtom {
  readonly atom: EvidenceAtom;
  readonly canonicalText: string;
  /** Optional opaque metadata for mapping an edited source atom to its current replacement. */
  readonly replacementGroupId?: string;
  readonly replacementOrdinal?: number;
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
  readonly modelId?: string | undefined;
  /** Seed used for this generation, or null when the model does not support seeding (Epic #761). */
  readonly seedUsed?: number | null;
  /** Redaction-safe scalars describing request parameters (e.g. responseFormat, seed) (Epic #761). */
  readonly modelParameters?: Record<string, unknown> | undefined;
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

export interface QualityIntelligenceJudgeSourceContext {
  readonly atomId: string;
  readonly text: string;
}

export interface QualityIntelligenceJudgeInput {
  readonly candidateText: string;
  readonly sourceContext: readonly QualityIntelligenceJudgeSourceContext[];
}

export interface QualityIntelligenceJudgeResult extends QI.TestQualityJudgeVerdict {
  /**
   * Number of actual Model Gateway dispatches made while producing this verdict.
   * Older test doubles omit this field and are treated as one dispatch for compatibility.
   */
  readonly gatewayCallCount?: number;
}

interface CandidateQualityVerdict {
  readonly verdict: QI.TestQualityJudgeVerdict["verdict"];
  readonly score: number;
  readonly dimensions: readonly QI.TestQualityRubricDimension[];
  readonly overallRationale: string;
}

type CandidateWithQualityVerdict = Candidate & {
  readonly qualityVerdict?: CandidateQualityVerdict;
};

/** Abstract model-judge seam (Epic #736, Issue #747). The server backs it with the gateway judge port. */
export interface QualityIntelligenceJudgePort {
  readonly judge: (
    input: QualityIntelligenceJudgeInput,
    signal?: AbortSignal,
  ) => Promise<QualityIntelligenceJudgeResult>;
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
  /**
   * Gateway calls made before this workflow context exists, such as capability-routed vision hints
   * during server-side source ingestion. They are folded into summary + manifest evidence.
   */
  readonly initialModelGatewayCallCount?: number | undefined;
  /** Optional model-judge for test-quality scoring (Epic #736). Absent → judge stage is skipped. */
  readonly judge?: QualityIntelligenceJudgePort | undefined;
  readonly clock?: QualityIntelligenceClock | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly limits?: QualityIntelligenceWorkflowLimits | undefined;
  readonly redaction?: QualityIntelligenceRecordOptions["redaction"] | undefined;
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

function atomFingerprintsFor(ingestedAtoms: readonly QualityIntelligenceIngestedAtom[]): readonly {
  readonly atomId: string;
  readonly envelopeId: string;
  readonly canonicalHashSha256Hex: string;
  readonly replacementGroupId?: string;
  readonly replacementOrdinal?: number;
}[] {
  return Object.freeze(
    ingestedAtoms.map((entry) =>
      Object.freeze({
        atomId: String(entry.atom.id),
        envelopeId: String(entry.atom.sourceEnvelopeId),
        canonicalHashSha256Hex: entry.atom.canonicalHashSha256Hex,
        ...(entry.replacementGroupId !== undefined
          ? { replacementGroupId: entry.replacementGroupId }
          : {}),
        ...(entry.replacementOrdinal !== undefined
          ? { replacementOrdinal: entry.replacementOrdinal }
          : {}),
      }),
    ),
  );
}

/**
 * Map each ingested atom's id to a short, redacted excerpt of its canonical text (#790) so
 * coverage rows and gap findings can name the requirement, not just its opaque id. Atoms whose
 * text collapses to nothing are omitted (the optional field is simply absent downstream).
 */
export function excerptsByAtomId(
  ingestedAtoms: readonly QualityIntelligenceIngestedAtom[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const entry of ingestedAtoms) {
    const excerpt = buildRequirementExcerpt(entry.canonicalText);
    if (excerpt !== undefined) map.set(String(entry.atom.id), excerpt);
  }
  return map;
}

function buildCoverageGapFinding(
  runId: QI.QualityIntelligenceRunId,
  atomStatus: AtomCoverageStatus,
  ordinal: number,
  excerpt: string | undefined,
): QI.QualityIntelligenceCoverageGapFinding {
  const payload = ["v1-cov-gap", String(runId), String(atomStatus.atomId), String(ordinal)].join(
    "",
  );
  const idStr = `qi-finding-${sha256Hex(payload).slice(0, 32)}`;
  // An atom with zero tracing tests is the headline audit gap (high); an atom covered only weakly
  // (incidentally, by broad tests) is a softer "strengthen this" signal (low). This keeps the gap
  // list honest: a flood of low-severity weak findings never drowns out the genuine zero-coverage
  // requirements, and severity-ordered truncation (below) protects the high ones.
  const severity = atomStatus.status === "uncovered" ? "high" : "low";
  // Name the requirement, not just its id (#790): the excerpt is already redacted (and persist
  // redacts every leaf again), so the finding stays evidence-safe while becoming auditor-readable.
  const atomLabel =
    excerpt === undefined
      ? `Atom ${String(atomStatus.atomId)}`
      : `Atom ${String(atomStatus.atomId)} ("${excerpt}")`;
  const summary =
    atomStatus.status === "uncovered"
      ? `${atomLabel} hat keinen zugeordneten Test (uncovered).`
      : `${atomLabel} ist nur schwach abgedeckt (kein dedizierter Test referenziert dieses Atom).`;
  return Object.freeze({
    kind: "coverage-gap",
    id: QI.asQualityIntelligenceValidationFindingId(idStr),
    runId,
    severity,
    summary,
    evidenceAtomIds: Object.freeze([atomStatus.atomId]),
  });
}

/** Candidates plus the attribution metadata of the model call that produced them (Epic #761). */
interface GenerationOutput {
  readonly candidates: readonly Candidate[];
  readonly reviewCandidates: readonly Candidate[];
  readonly skipJudge?: boolean;
  /**
   * Redaction-safe reason set ONLY when generation fell back to the deterministic baseline because
   * the model/parser failed. Surfaced to the user as a degraded-run marker so a baseline-only run is
   * never presented as authoritative model output.
   */
  readonly fallbackReason?: string;
  readonly modelId?: string | undefined;
  readonly seedUsed?: number | null;
  readonly modelParameters: Record<string, unknown> | undefined;
}

const MODEL_DELTA_CANDIDATE_CEILING = 16;
const MODEL_DELTA_CANDIDATE_FLOOR = 3;

function modelDeltaCandidateLimit(evidenceCount: number, runLimit: number): number {
  const boundedRunLimit = Math.max(1, Math.trunc(runLimit));
  const evidenceAwareLimit = Math.max(
    MODEL_DELTA_CANDIDATE_FLOOR,
    Math.max(1, Math.trunc(evidenceCount)) * 2,
  );
  return Math.max(1, Math.min(boundedRunLimit, MODEL_DELTA_CANDIDATE_CEILING, evidenceAwareLimit));
}

function deterministicBaselineCandidates(
  ctx: RunContext,
  input: QualityIntelligenceModelRoutedTestDesignInput,
): readonly Candidate[] {
  const atomTextById = new Map(
    input.ingestedAtoms.map((entry) => [String(entry.atom.id), entry.canonicalText]),
  );
  const candidates = designTestCaseCandidates({
    runId: input.plan.id,
    intent: deriveIntent(input.envelopes, ctx.profile),
    atoms: input.ingestedAtoms.map((entry) => entry.atom),
    atomTextById,
    profile: ctx.profile,
  });
  return truncateCandidates(deduplicateCandidates(candidates), ctx.limits.maxCandidatesPerRun);
}

function parseModelCandidates(
  result: QualityIntelligenceGenerationPortResult,
  ctx: RunContext,
  input: QualityIntelligenceModelRoutedTestDesignInput,
  maxCandidates: number,
): readonly Candidate[] {
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

function appendModelDelta(
  baseline: readonly Candidate[],
  delta: readonly Candidate[],
  limit: number,
): readonly Candidate[] {
  const baselineLimit = delta.length > 0 && limit > 0 ? Math.max(0, limit - 1) : limit;
  const out: Candidate[] = [...baseline].slice(0, baselineLimit);
  const seen = new Set(out.map((candidate) => computeCandidateEquivalenceSignature(candidate)));
  let appendedDelta = 0;
  for (const candidate of delta) {
    const signature = computeCandidateEquivalenceSignature(candidate);
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push(candidate);
    appendedDelta += 1;
    if (out.length >= limit) break;
  }
  if (appendedDelta === 0) {
    for (let index = baselineLimit; index < baseline.length && out.length < limit; index += 1) {
      const candidate = baseline[index];
      if (candidate === undefined) continue;
      out.push(candidate);
    }
  }
  return Object.freeze(out);
}

function selectReviewCandidates(
  persisted: readonly Candidate[],
  baseline: readonly Candidate[],
  delta: readonly Candidate[],
): readonly Candidate[] {
  if (delta.length === 0) {
    return Object.freeze([] as readonly Candidate[]);
  }
  const persistedIds = new Set(persisted.map((candidate) => String(candidate.id)));
  const persistedDelta = delta.filter((candidate) => persistedIds.has(String(candidate.id)));
  return persistedDelta.length > 0 ? Object.freeze(persistedDelta) : baseline;
}

function modelGenerationOutput(
  result: QualityIntelligenceGenerationPortResult,
  ctx: RunContext,
  input: QualityIntelligenceModelRoutedTestDesignInput,
  runCandidateLimit: number,
  modelDeltaLimit: number,
): GenerationOutput {
  const baseline = deterministicBaselineCandidates(ctx, input);
  const delta = parseModelCandidates(result, ctx, input, modelDeltaLimit);
  const candidates = appendModelDelta(baseline, delta, runCandidateLimit);
  return {
    candidates,
    reviewCandidates: selectReviewCandidates(candidates, baseline, delta),
    ...(result.modelId !== undefined ? { modelId: result.modelId } : {}),
    ...(result.modelId !== undefined
      ? { seedUsed: result.seedUsed ?? null }
      : result.seedUsed !== undefined
        ? { seedUsed: result.seedUsed }
        : {}),
    modelParameters: result.modelParameters,
  };
}

function baselineFallbackGenerationOutput(
  ctx: RunContext,
  input: QualityIntelligenceModelRoutedTestDesignInput,
  reasonSummary: string,
): GenerationOutput {
  const candidates = deterministicBaselineCandidates(ctx, input);
  return {
    candidates,
    reviewCandidates: candidates,
    skipJudge: true,
    fallbackReason: reasonSummary,
    modelParameters: { generationFallbackReason: reasonSummary },
  };
}

function hasQiCode(error: unknown, code: string): boolean {
  if (!(error instanceof Error)) return false;
  const coded = error as Error & { readonly code?: unknown };
  return typeof coded.code === "string" && coded.code === code;
}

function shouldCountRejectedGenerationDispatch(error: unknown): boolean {
  return !hasQiCode(error, "QI_PROMPT_TOO_LARGE");
}

async function generateCandidates(
  ctx: RunContext,
  input: QualityIntelligenceModelRoutedTestDesignInput,
  deps: QualityIntelligenceModelRoutedTestDesignDeps,
): Promise<GenerationOutput> {
  if (input.ingestedAtoms.length === 0) {
    throw new EmptyEvidenceError();
  }
  const evidence = input.ingestedAtoms.map((a, i) => ({
    index: i + 1,
    kind: a.atom.kind,
    text: a.canonicalText,
  }));
  const runCandidateLimit = ctx.limits.maxCandidatesPerRun;
  const modelDeltaLimit = modelDeltaCandidateLimit(evidence.length, runCandidateLimit);
  const instruction = QualityIntelligenceGeneration.buildTestDesignInstruction({
    evidenceCount: evidence.length,
    profile: ctx.profile,
    maxTestCases: modelDeltaLimit,
  });
  // Count the generation gateway dispatch as an ATTEMPT, mirroring the judge contract
  // (judgeOneCandidate counts before its await). The generation port makes at most one gateway
  // dispatch per call, so a rejection (Azure 5xx / timeout / network / abort) still means one call
  // was attempted and billed. Counting only result.modelCallCount AFTER a successful await
  // under-reported a failed run's audit trail as 0 gateway calls (#273 audit; #843 undercount class).
  // The deterministic baseline port never rejects and reports modelCallCount 0, so it is unaffected.
  let result: QualityIntelligenceGenerationPortResult;
  let countedGatewayDispatch = false;
  try {
    result = await deps.generate.generate({
      systemPrompt: QualityIntelligenceGeneration.QI_TEST_DESIGN_SYSTEM_PROMPT,
      instruction,
      evidence,
      maxCandidates: modelDeltaLimit,
      signal: ctx.signal,
    });
    ctx.modelGatewayCallCount += result.modelCallCount;
    countedGatewayDispatch = result.modelCallCount > 0;
    if (result.modelId === undefined && result.modelCallCount === 0) {
      const candidates = deterministicBaselineCandidates(ctx, input);
      return {
        candidates,
        reviewCandidates: candidates,
        ...(result.seedUsed !== undefined ? { seedUsed: result.seedUsed } : {}),
        modelParameters: result.modelParameters,
      };
    }
    return modelGenerationOutput(result, ctx, input, runCandidateLimit, modelDeltaLimit);
  } catch (error) {
    if (isCancellationError(ctx, error)) throw new StageCancelledError();
    if (!countedGatewayDispatch && shouldCountRejectedGenerationDispatch(error)) {
      ctx.modelGatewayCallCount += 1;
    }
    return baselineFallbackGenerationOutput(ctx, input, safeReasonSummary(error));
  }
}

function candidateSummaryText(candidate: Candidate): string {
  const parts = [
    `Titel: ${candidate.title}`,
    `Vorbedingungen: ${candidate.preconditions.join("; ")}`,
    `Schritte: ${candidate.steps.join("; ")}`,
    `Erwartetes Ergebnis: ${candidate.expectedResults.join("; ")}`,
  ];
  return parts.join("\n");
}

const JUDGE_SUMMARY_DIMENSION_LIMIT = 2;
const FINDING_KIND_TRUNCATION_PRIORITY: Readonly<Record<string, number>> = {
  "test-quality": 0,
};

const JUDGE_DIMENSION_LABEL: Readonly<Record<QI.TestQualityDimensionName, string>> = {
  verifiability: "Prüfbarkeit",
  atomicity: "Atomarität",
  determinism: "Determinismus",
  "ac-fidelity": "AC-Treue",
};

function sourceContextForCandidate(
  candidate: Candidate,
  ingestedAtoms: readonly QualityIntelligenceIngestedAtom[],
): readonly QualityIntelligenceJudgeSourceContext[] {
  const byAtomId = new Map(
    ingestedAtoms.map((entry) => [
      String(entry.atom.id),
      Object.freeze({
        atomId: String(entry.atom.id),
        text: entry.canonicalText,
      }),
    ]),
  );
  const matched = candidate.derivedFromAtomIds
    .map((atomId) => byAtomId.get(String(atomId)))
    .filter((entry): entry is QualityIntelligenceJudgeSourceContext => entry !== undefined);
  if (matched.length > 0) return Object.freeze(matched);
  return Object.freeze(
    ingestedAtoms.map((entry) =>
      Object.freeze({
        atomId: String(entry.atom.id),
        text: entry.canonicalText,
      }),
    ),
  );
}

function judgeRationaleSummary(verdict: QI.TestQualityJudgeVerdict): string {
  const weakDimensions = verdict.dimensions
    .filter((dimension) => dimension.score < TEST_QUALITY_WEAK_THRESHOLD)
    .sort((left, right) => left.score - right.score);
  const dimensionsToDescribe =
    weakDimensions.length > 0
      ? weakDimensions
      : [...verdict.dimensions].sort((a, b) => a.score - b.score);
  return dimensionsToDescribe
    .slice(0, JUDGE_SUMMARY_DIMENSION_LIMIT)
    .map((dimension) => `${JUDGE_DIMENSION_LABEL[dimension.name]}: ${dimension.rationale}`)
    .join("; ");
}

function buildTestQualityFinding(
  runId: QI.QualityIntelligenceRunId,
  candidate: Candidate,
  score: number,
  rationale: string,
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
    summary: rationale,
    evidenceAtomIds: Object.freeze([...candidate.derivedFromAtomIds]),
  });
}

function findingTruncationPriority(finding: QI.QualityIntelligenceValidationFinding): number {
  return FINDING_KIND_TRUNCATION_PRIORITY[finding.kind] ?? 1;
}

interface JudgeStageResult {
  readonly findings: readonly QI.QualityIntelligenceTestQualityFinding[];
  readonly qualityScore: number | null;
  readonly candidateQualityVerdicts: ReadonlyMap<string, CandidateQualityVerdict>;
}

const EMPTY_JUDGE_RESULT: JudgeStageResult = Object.freeze({
  findings: Object.freeze([]),
  qualityScore: null,
  candidateQualityVerdicts: new Map(),
});

// Bounded concurrency for the per-candidate judge calls: cuts the wall-clock of judging a large run
// (one gateway call per candidate) without flooding the gateway, which applies its own per-call
// retry/timeout. Findings are written into a candidate-indexed slot array so the persisted finding
// order stays deterministic regardless of which judge call completes first.
const JUDGE_CONCURRENCY = 4;

function isCancellationError(ctx: RunContext, error: unknown): boolean {
  return error instanceof StageCancelledError || isCancelled(ctx.signal);
}

interface JudgeOutcome {
  readonly strong: boolean;
  readonly finding: QI.QualityIntelligenceTestQualityFinding | null;
  readonly qualityVerdict: CandidateQualityVerdict;
}

interface JudgeSlots {
  readonly findingSlots: (QI.QualityIntelligenceTestQualityFinding | undefined)[];
  readonly verdictSlots: (CandidateQualityVerdict | undefined)[];
}

interface JudgeCounts {
  readonly strongCount: number;
  readonly verdictCount: number;
}

const JUDGE_ERROR_RATIONALE =
  "Der Quality-Judge konnte diesen Kandidaten nicht bewerten; er wird für das Audit als schwach behandelt.";
const JUDGE_BUDGET_RATIONALE =
  "Das Quality-Judge-Budget war vor der Bewertung dieses Kandidaten ausgeschöpft; er wird für das Audit als schwach behandelt.";

function buildSyntheticWeakJudgeOutcome(
  ctx: RunContext,
  candidate: Candidate,
  ordinal: number,
  rationale: string,
): JudgeOutcome {
  return {
    strong: false,
    finding: buildTestQualityFinding(ctx.plan.id, candidate, 0, rationale, ordinal),
    qualityVerdict: syntheticWeakQualityVerdict(rationale),
  };
}

function cloneDimensions(
  dimensions: readonly QI.TestQualityRubricDimension[],
): readonly QI.TestQualityRubricDimension[] {
  return Object.freeze(dimensions.map((dimension) => Object.freeze({ ...dimension })));
}

function qualityVerdictFromJudge(verdict: QI.TestQualityJudgeVerdict): CandidateQualityVerdict {
  const score = scoreFromDimensions(verdict.dimensions);
  return Object.freeze({
    verdict: verdictFromDimensions(verdict.dimensions),
    score,
    dimensions: cloneDimensions(verdict.dimensions),
    overallRationale: verdict.overallRationale,
  });
}

function syntheticWeakQualityVerdict(rationale: string): CandidateQualityVerdict {
  const dimensions = QI.TEST_QUALITY_RUBRIC_DIMENSIONS.map((name) =>
    Object.freeze<QI.TestQualityRubricDimension>({
      name,
      score: 0,
      rationale,
    }),
  );
  return Object.freeze({
    verdict: "weak",
    score: 0,
    dimensions: Object.freeze(dimensions),
    overallRationale: rationale,
  });
}

/**
 * Judge one candidate. Counts actual gateway dispatches reported by the judge port, then returns
 * its outcome. A transient judge error (rate-limit / 5xx / timeout / network) remains
 * run-fail-soft but becomes an explicit weak judge outcome; cancellation is re-raised as
 * `StageCancelledError` so the whole stage aborts. Legacy/test ports that throw without returning
 * dispatch metadata are counted as one attempted gateway call, preserving the audit contract.
 */
async function judgeOneCandidate(
  ctx: RunContext,
  candidate: Candidate,
  ordinal: number,
  ingestedAtoms: readonly QualityIntelligenceIngestedAtom[],
  judge: QualityIntelligenceJudgePort,
): Promise<JudgeOutcome> {
  let verdict: QualityIntelligenceJudgeResult;
  try {
    verdict = await judge.judge(
      {
        candidateText: candidateSummaryText(candidate),
        sourceContext: sourceContextForCandidate(candidate, ingestedAtoms),
      },
      ctx.signal,
    );
    ctx.modelGatewayCallCount += verdict.gatewayCallCount ?? 1;
  } catch (error) {
    if (isCancellationError(ctx, error)) throw new StageCancelledError();
    ctx.modelGatewayCallCount += 1;
    return buildSyntheticWeakJudgeOutcome(ctx, candidate, ordinal, JUDGE_ERROR_RATIONALE);
  }
  const score = scoreFromDimensions(verdict.dimensions);
  const qualityVerdict = qualityVerdictFromJudge(verdict);
  if (qualityVerdict.verdict === "strong") {
    return { strong: true, finding: null, qualityVerdict };
  }
  return {
    strong: false,
    finding: buildTestQualityFinding(
      ctx.plan.id,
      candidate,
      score,
      judgeRationaleSummary(verdict),
      ordinal,
    ),
    qualityVerdict,
  };
}

function makeJudgeSlots(candidateCount: number): JudgeSlots {
  return {
    findingSlots: Array.from({ length: candidateCount }, () => undefined),
    verdictSlots: Array.from({ length: candidateCount }, () => undefined),
  };
}

function recordJudgeOutcome(slots: JudgeSlots, index: number, outcome: JudgeOutcome): boolean {
  slots.verdictSlots[index] = outcome.qualityVerdict;
  if (outcome.finding !== null) slots.findingSlots[index] = outcome.finding;
  return outcome.strong;
}

async function judgeCandidates(
  ctx: RunContext,
  candidates: readonly Candidate[],
  ingestedAtoms: readonly QualityIntelligenceIngestedAtom[],
  judge: QualityIntelligenceJudgePort,
  slots: JudgeSlots,
): Promise<JudgeCounts> {
  let strongCount = 0;
  let verdictCount = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= candidates.length) return;
      const candidate = candidates[i];
      if (candidate === undefined) continue;
      const outcome = await judgeOneCandidate(ctx, candidate, i, ingestedAtoms, judge);
      verdictCount += 1;
      if (recordJudgeOutcome(slots, i, outcome)) strongCount += 1;
    }
  };

  if (candidates.length > 0) {
    await Promise.all(
      Array.from({ length: Math.min(JUDGE_CONCURRENCY, candidates.length) }, () => worker()),
    );
  }
  return { strongCount, verdictCount };
}

function recordBudgetOverflow(
  ctx: RunContext,
  candidates: readonly Candidate[],
  startIndex: number,
  slots: JudgeSlots,
): number {
  let verdictCount = 0;
  for (let i = startIndex; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    const outcome = buildSyntheticWeakJudgeOutcome(ctx, candidate, i, JUDGE_BUDGET_RATIONALE);
    verdictCount += 1;
    recordJudgeOutcome(slots, i, outcome);
  }
  return verdictCount;
}

function candidateQualityVerdictMap(
  candidates: readonly Candidate[],
  slots: JudgeSlots,
): ReadonlyMap<string, CandidateQualityVerdict> {
  const candidateQualityVerdicts = new Map<string, CandidateQualityVerdict>();
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const qualityVerdict = slots.verdictSlots[i];
    if (candidate !== undefined && qualityVerdict !== undefined) {
      candidateQualityVerdicts.set(String(candidate.id), qualityVerdict);
    }
  }
  return candidateQualityVerdicts;
}

function buildJudgeStageResult(
  candidates: readonly Candidate[],
  slots: JudgeSlots,
  counts: JudgeCounts,
): JudgeStageResult {
  const findings = slots.findingSlots.filter(
    (f): f is QI.QualityIntelligenceTestQualityFinding => f !== undefined,
  );
  const qualityScore =
    counts.verdictCount === 0 ? null : (counts.strongCount / counts.verdictCount) * 100;
  return {
    findings: Object.freeze(findings),
    qualityScore,
    candidateQualityVerdicts: candidateQualityVerdictMap(candidates, slots),
  };
}

/**
 * Adversarially judge every candidate via the model-judge port (Epic #736, Issue #747).
 *
 * Resilience contract: the judge AUGMENTS generation and must never fail an otherwise successful
 * run — a transient per-candidate error becomes an explicit weak test-quality finding and only
 * cancellation aborts the stage. Audit contract: every dispatch is counted into
 * `ctx.modelGatewayCallCount`. Budget contract: at most `ctx.limits.maxJudgeCallsPerRun` candidates
 * make gateway calls; any overflow candidates receive deterministic weak findings so the persisted
 * run still accounts for every candidate. Bounded-concurrency workers share a cursor; findings land
 * in candidate-indexed slots so the persisted order stays deterministic regardless of completion
 * order.
 */
async function runJudgeStage(
  ctx: RunContext,
  candidates: readonly Candidate[],
  ingestedAtoms: readonly QualityIntelligenceIngestedAtom[],
  judge: QualityIntelligenceJudgePort,
): Promise<JudgeStageResult> {
  if (candidates.length === 0) return EMPTY_JUDGE_RESULT;
  const budget = Math.max(0, ctx.limits.maxJudgeCallsPerRun);
  const judgeable = budget >= candidates.length ? candidates : candidates.slice(0, budget);
  const slots = makeJudgeSlots(candidates.length);
  const judged = await judgeCandidates(ctx, judgeable, ingestedAtoms, judge, slots);
  const overflowVerdictCount = recordBudgetOverflow(ctx, candidates, judgeable.length, slots);
  // Per-run quality score = share of candidates with a strong judge outcome, as a percentage (#747).
  // Gateway errors and budget overflow produce explicit weak outcomes so unverified candidates cannot
  // be indistinguishable from strong candidates or inflate the run score.
  return buildJudgeStageResult(candidates, slots, {
    strongCount: judged.strongCount,
    verdictCount: judged.verdictCount + overflowVerdictCount,
  });
}

function candidatesWithQualityVerdicts(
  candidates: readonly Candidate[],
  verdicts: ReadonlyMap<string, CandidateQualityVerdict>,
): readonly Candidate[] {
  if (verdicts.size === 0) return candidates;
  return Object.freeze(
    candidates.map((candidate): Candidate => {
      const qualityVerdict = verdicts.get(String(candidate.id));
      if (qualityVerdict === undefined) return candidate;
      return Object.freeze<CandidateWithQualityVerdict>({
        ...candidate,
        qualityVerdict,
      });
    }),
  );
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
  ctx.modelGatewayCallCount += deps.initialModelGatewayCallCount ?? 0;
  const evidenceRefs = evidenceRefsFor(input.ingestedAtoms);
  emitQueuedAndStarted(ctx);
  try {
    await withStage(ctx, "plan", async () => Promise.resolve());
    const generation = await withStage(ctx, "candidates", async () =>
      generateCandidates(ctx, input, deps),
    );
    const candidates = generation.candidates;
    const reviewCandidates = generation.reviewCandidates;
    // A provider/parser failure is caught inside generateCandidates and degrades to the deterministic
    // baseline (skipJudge), keeping the run alive. That degradation MUST stay visible: the redacted
    // reason is threaded into the terminal summary (and surfaced on the wire `done` frame as
    // `degraded` + `reasonSummary`) so the run is never presented as an authoritative model-backed
    // result (regulated-delivery audit, QI-DEG-01).
    const degradedReason =
      generation.skipJudge === true
        ? (generation.fallbackReason ?? "qi-generation-fallback")
        : undefined;
    emitCandidateProposed(ctx, candidates);
    const judge = deps.judge;
    const judgeResult = await withStage(ctx, "judge", async () => {
      if (judge === undefined || generation.skipJudge === true) return EMPTY_JUDGE_RESULT;
      try {
        return await runJudgeStage(ctx, reviewCandidates, input.ingestedAtoms, judge);
      } catch (error) {
        // Cancellation must still abort the run; anything else is fail-soft so an optional judge
        // can never turn a successful generation into a failed run (Epic #736 augments-not-harms).
        if (isCancellationError(ctx, error)) throw error;
        return EMPTY_JUDGE_RESULT;
      }
    });
    const atoms = input.ingestedAtoms.map((a) => a.atom);
    const coverageMap = await withStage(ctx, "coverage", async () =>
      Promise.resolve(buildCoverageMap({ runId: input.plan.id, atoms, candidates })),
    );
    const atomStatuses = buildAtomCoverageStatuses(atoms, coverageMap);
    const excerptByAtomId = excerptsByAtomId(input.ingestedAtoms);
    const coverageMatrix = toCoverageMatrixRows(atomStatuses, excerptByAtomId);
    const gapFindings: QI.QualityIntelligenceCoverageGapFinding[] = [];
    for (let i = 0; i < atomStatuses.length; i += 1) {
      const s = atomStatuses[i];
      if (s !== undefined && s.status !== "covered") {
        gapFindings.push(
          buildCoverageGapFinding(input.plan.id, s, i, excerptByAtomId.get(String(s.atomId))),
        );
      }
    }
    const rawFindings = await withStage(ctx, "validate", async () =>
      Promise.resolve(validateCandidates(input.plan.id, candidates)),
    );
    // Order by severity (critical -> low) BEFORE truncation so that, if the run hits the
    // per-run findings cap, the most severe findings — uncovered-requirement gaps included —
    // always survive the cut rather than being dropped by array position. Within a severity tier,
    // keep test-quality findings first because #748 weak-test flags are projected exclusively from
    // those candidate-scoped findings; stable sort preserves original order for all remaining ties.
    const allFindings: readonly QI.QualityIntelligenceValidationFinding[] = [
      ...gapFindings,
      ...rawFindings,
      ...judgeResult.findings,
    ]
      .slice()
      .sort(
        (a, b) =>
          QI.QUALITY_INTELLIGENCE_SEVERITY_RANK[a.severity] -
            QI.QUALITY_INTELLIGENCE_SEVERITY_RANK[b.severity] ||
          findingTruncationPriority(a) - findingTruncationPriority(b),
      );
    const findings = truncateFindings(allFindings, ctx.limits.maxFindingsPerRun);
    emitFindingsRecorded(ctx, findings);
    const evidence = await withStage(ctx, "finalize", async () => {
      const completedAt = ctx.clock.nowIso();
      const sourceFingerprints = input.envelopes.map((e) => ({
        envelopeId: String(e.id),
        integrityHashSha256Hex: e.provenance.integrityHashSha256Hex,
      }));
      const atomFingerprints = atomFingerprintsFor(input.ingestedAtoms);
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
        ...(deps.redaction !== undefined ? { redaction: deps.redaction } : {}),
        ...(sourceFingerprints.length > 0 ? { sourceFingerprints } : {}),
        ...(atomFingerprints.length > 0 ? { atomFingerprints } : {}),
        ...(generation.modelId !== undefined ? { modelId: generation.modelId } : {}),
        ...(generation.seedUsed !== undefined ? { seedUsed: generation.seedUsed } : {}),
        ...(generation.modelParameters !== undefined
          ? { modelParameters: generation.modelParameters }
          : {}),
      });
      deps.candidatesSink.record(
        candidatesWithQualityVerdicts(candidates, judgeResult.candidateQualityVerdicts),
        completedAt,
      );
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
      ...(degradedReason !== undefined ? { reasonSummary: degradedReason } : {}),
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
