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
  deduplicateCandidates,
  scoreFromDimensions,
  TEST_QUALITY_WEAK_THRESHOLD,
  validateCandidates,
  QualityIntelligenceGeneration,
  type AtomCoverageStatus,
  type PolicyProfile,
} from "@oscharko-dev/keiko-quality-intelligence";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { QualityIntelligenceLocalStore } from "@oscharko-dev/keiko-evidence";
import { QI_TEST_DESIGN_WORKFLOW_DESCRIPTOR } from "./descriptors.js";
import {
  emit,
  emitCandidateProposed,
  emitFindingsRecorded,
  emitQueuedAndStarted,
  finaliseFailureOrCancellation,
  makeContext,
  persistRun,
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

/** Abstract model-judge seam (Epic #736, Issue #747). The server backs it with the gateway judge port. */
export interface QualityIntelligenceJudgePort {
  readonly judge: (
    input: QualityIntelligenceJudgeInput,
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

function atomFingerprintsFor(ingestedAtoms: readonly QualityIntelligenceIngestedAtom[]): readonly {
  readonly atomId: string;
  readonly envelopeId: string;
  readonly canonicalHashSha256Hex: string;
}[] {
  return Object.freeze(
    ingestedAtoms.map((entry) =>
      Object.freeze({
        atomId: String(entry.atom.id),
        envelopeId: String(entry.atom.sourceEnvelopeId),
        canonicalHashSha256Hex: entry.atom.canonicalHashSha256Hex,
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
      ? `${atomLabel} has no tracing test (uncovered).`
      : `${atomLabel} is only weakly covered (no dedicated test traces to it).`;
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
  readonly modelId?: string | undefined;
  readonly seedUsed?: number | null;
  readonly modelParameters: Record<string, unknown> | undefined;
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
  return {
    candidates: truncateCandidates(deduplicateCandidates(parsed.candidates), maxCandidates),
    ...(result.modelId !== undefined ? { modelId: result.modelId } : {}),
    ...(result.modelId !== undefined
      ? { seedUsed: result.seedUsed ?? null }
      : result.seedUsed !== undefined
        ? { seedUsed: result.seedUsed }
        : {}),
    modelParameters: result.modelParameters,
  };
}

function candidateSummaryText(candidate: Candidate): string {
  const parts = [
    `Title: ${candidate.title}`,
    `Steps: ${candidate.steps.join("; ")}`,
    `Expected: ${candidate.expectedResults.join("; ")}`,
  ];
  return parts.join("\n");
}

const JUDGE_SUMMARY_DIMENSION_LIMIT = 2;

const JUDGE_DIMENSION_LABEL: Readonly<Record<QI.TestQualityDimensionName, string>> = {
  verifiability: "Verifiability",
  atomicity: "Atomicity",
  determinism: "Determinism",
  "ac-fidelity": "AC fidelity",
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

interface JudgeStageResult {
  readonly findings: readonly QI.QualityIntelligenceTestQualityFinding[];
  readonly qualityScore: number | null;
}

const EMPTY_JUDGE_RESULT: JudgeStageResult = Object.freeze({
  findings: Object.freeze([]),
  qualityScore: null,
});

// Bounded concurrency for the per-candidate judge calls: cuts the wall-clock of judging a large run
// (one gateway call per candidate) without flooding the gateway, which applies its own per-call
// retry/timeout. Findings are written into a candidate-indexed slot array so the persisted finding
// order stays deterministic regardless of which judge call completes first.
const JUDGE_CONCURRENCY = 4;

function isCancellationError(ctx: RunContext, error: unknown): boolean {
  return error instanceof StageCancelledError || isCancelled(ctx.signal);
}

type JudgeOutcome =
  | {
      readonly judged: true;
      readonly strong: boolean;
      readonly finding: QI.QualityIntelligenceTestQualityFinding | null;
    }
  | { readonly judged: false };

const JUDGE_SKIPPED: JudgeOutcome = Object.freeze({ judged: false });

/**
 * Judge one candidate. Counts the gateway dispatch, then returns its outcome. A transient judge
 * error (rate-limit / 5xx / timeout / network) degrades to "unjudged" (fail-soft); cancellation is
 * re-raised as `StageCancelledError` so the whole stage aborts. The dispatch is counted BEFORE the
 * await so the audit trail reflects every gateway call attempt, even one that then throws.
 */
async function judgeOneCandidate(
  ctx: RunContext,
  candidate: Candidate,
  ordinal: number,
  ingestedAtoms: readonly QualityIntelligenceIngestedAtom[],
  judge: QualityIntelligenceJudgePort,
): Promise<JudgeOutcome> {
  ctx.modelGatewayCallCount += 1;
  let verdict: QI.TestQualityJudgeVerdict;
  try {
    verdict = await judge.judge(
      {
        candidateText: candidateSummaryText(candidate),
        sourceContext: sourceContextForCandidate(candidate, ingestedAtoms),
      },
      ctx.signal,
    );
  } catch (error) {
    if (isCancellationError(ctx, error)) throw new StageCancelledError();
    return JUDGE_SKIPPED;
  }
  if (verdict.verdict === "strong") return { judged: true, strong: true, finding: null };
  return {
    judged: true,
    strong: false,
    finding: buildTestQualityFinding(
      ctx.plan.id,
      candidate,
      scoreFromDimensions(verdict.dimensions),
      judgeRationaleSummary(verdict),
      ordinal,
    ),
  };
}

/**
 * Adversarially judge every candidate via the model-judge port (Epic #736, Issue #747).
 *
 * Resilience contract: the judge AUGMENTS generation and must never harm a successful run — a
 * transient per-candidate error is fail-soft (that candidate is excluded from the score, no
 * finding) and only cancellation aborts the stage. Audit contract: every dispatch is counted into
 * `ctx.modelGatewayCallCount`. Budget contract: at most `ctx.limits.maxJudgeCallsPerRun` candidates
 * are judged. Bounded-concurrency workers share a cursor; findings land in candidate-indexed slots
 * so the persisted order stays deterministic regardless of completion order.
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
  if (judgeable.length === 0) return EMPTY_JUDGE_RESULT;

  const findingSlots: (QI.QualityIntelligenceTestQualityFinding | undefined)[] = Array.from(
    { length: judgeable.length },
    () => undefined,
  );
  let strongCount = 0;
  let scored = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= judgeable.length) return;
      const candidate = judgeable[i];
      if (candidate === undefined) continue;
      const outcome = await judgeOneCandidate(ctx, candidate, i, ingestedAtoms, judge);
      if (!outcome.judged) continue;
      scored += 1;
      if (outcome.strong) strongCount += 1;
      else if (outcome.finding !== null) findingSlots[i] = outcome.finding;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(JUDGE_CONCURRENCY, judgeable.length) }, () => worker()),
  );

  const findings = findingSlots.filter(
    (f): f is QI.QualityIntelligenceTestQualityFinding => f !== undefined,
  );
  // Per-run quality score = share of SUCCESSFULLY JUDGED candidates the judge rated "strong", as a
  // percentage (#747). Candidates the judge could not evaluate are excluded from the denominator
  // rather than counted as weak, so the score honestly reflects what was actually judged.
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
    const generation = await withStage(ctx, "candidates", async () =>
      generateCandidates(ctx, input, deps),
    );
    const candidates = generation.candidates;
    emitCandidateProposed(ctx, candidates);
    const judge = deps.judge;
    const judgeResult = await withStage(ctx, "judge", async () => {
      if (judge === undefined) return EMPTY_JUDGE_RESULT;
      try {
        return await runJudgeStage(ctx, candidates, input.ingestedAtoms, judge);
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
    // always survive the cut rather than being dropped by array position (Array.sort is stable,
    // so same-severity insertion order is preserved).
    const allFindings: readonly QI.QualityIntelligenceValidationFinding[] = [
      ...gapFindings,
      ...rawFindings,
      ...judgeResult.findings,
    ]
      .slice()
      .sort(
        (a, b) =>
          QI.QUALITY_INTELLIGENCE_SEVERITY_RANK[a.severity] -
          QI.QUALITY_INTELLIGENCE_SEVERITY_RANK[b.severity],
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
        ...(sourceFingerprints.length > 0 ? { sourceFingerprints } : {}),
        ...(atomFingerprints.length > 0 ? { atomFingerprints } : {}),
        ...(generation.modelId !== undefined ? { modelId: generation.modelId } : {}),
        ...(generation.seedUsed !== undefined ? { seedUsed: generation.seedUsed } : {}),
        ...(generation.modelParameters !== undefined
          ? { modelParameters: generation.modelParameters }
          : {}),
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
