// Quality Intelligence drift re-check + targeted regeneration routes (Epic #735, Issue #743).
//
// NOTE on "current sources": The original run's START request sources are NOT persisted in the
// manifest. Therefore re-check and regenerate-stale both require the sources to be re-supplied
// by the caller. Both routes are POST to carry the sources in the body; the GET verb is avoided
// because sources can be arbitrarily large.
//
//   POST /api/quality-intelligence/runs/:id/re-check
//     Body: { sources: QualityIntelligenceInlineSource[] }
//     Returns: QualityIntelligenceUiStalenessReport
//
//   POST /api/quality-intelligence/runs/:id/regenerate-stale
//     Body: { sources: QualityIntelligenceInlineSource[] }
//     Returns: { runId: string; regeneratedCount: number; preservedCount: number }
//
// Both routes go through the central CSRF guard in server.ts (all POSTs do).

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { QualityIntelligence, type QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import {
  ALL_POLICY_PROFILES,
  buildAtomCoverageStatuses,
  buildCoverageMap,
  compareStaleness,
  regressionDefault,
  validateCandidates,
  type AtomCoverageStatus,
  type PolicyProfile,
} from "@oscharko-dev/keiko-quality-intelligence";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  createInMemoryQualityIntelligenceLocalStore,
  loadQualityIntelligenceCandidates,
  loadQualityIntelligenceRun,
  recordQualityIntelligenceCandidates,
  recordQualityIntelligenceRun,
  type QualityIntelligenceCandidateRow,
  type QualityIntelligenceEvidenceManifest,
  type QualityIntelligenceFindingRow,
} from "@oscharko-dev/keiko-evidence";
import { runQualityIntelligenceModelRoutedTestDesign } from "@oscharko-dev/keiko-workflows";
import type {
  QualityIntelligenceIngestedAtom,
  QualityIntelligenceModelRoutedTestDesignDeps,
} from "@oscharko-dev/keiko-workflows";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { makeCapsuleResolver } from "./capsuleAdapter.js";
import { makeFigmaSnapshotLoader, makeFigmaVisionHintProvider } from "./figmaSnapshotAdapter.js";
import { createQiGenerationPort, QiGenerationError } from "./generationPort.js";
import { createQiJudgePort } from "./judgePort.js";
import { resolveQiTestDesignSelection } from "./modelSelection.js";
import { ingestInlineSources, QiIngestionError } from "./runIngestion.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUIREMENTS_ENVELOPE_PREFIX = "qi-src-req-";

type QiTestCaseCandidate = QualityIntelligence.QualityIntelligenceTestCaseCandidate;
type QiRunPlan = QualityIntelligence.QualityIntelligenceRunPlan;
type QiManifest = NonNullable<ReturnType<typeof loadQualityIntelligenceRun>>;
type QiEditedRevision = QI.QualityIntelligenceCandidateEditedRevision;
type QiIngestion = ReturnType<typeof ingestInlineSources>;
type AtomFingerprintRow = ReturnType<typeof mapCurrentAtomFingerprints>[number];

const errorResult = (status: number, code: string, message: string): RouteResult => ({
  status,
  body: { error: { code, message } },
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });

function validateCapsuleSource(
  label: string,
  raw: Record<string, unknown>,
): QI.QualityIntelligenceCapsuleSource | undefined {
  if (typeof raw.capsuleId !== "string" || raw.capsuleId.trim().length === 0) return undefined;
  return { kind: "capsule", label, capsuleId: raw.capsuleId };
}

function validateSource(raw: unknown): QI.QualityIntelligenceInlineSource | undefined {
  if (!isObject(raw) || typeof raw.label !== "string") return undefined;
  const label = raw.label;
  if (raw.kind === "requirements" && typeof raw.text === "string") {
    return { kind: "requirements", label, text: raw.text };
  }
  if (raw.kind === "workspace" && typeof raw.path === "string") {
    return { kind: "workspace", label, path: raw.path };
  }
  if (raw.kind === "file" && typeof raw.path === "string") {
    return { kind: "file", label, path: raw.path };
  }
  if (raw.kind === "capsule") {
    return validateCapsuleSource(label, raw);
  }
  return undefined;
}

type ParseSourcesOutcome =
  | { readonly ok: true; readonly sources: readonly QI.QualityIntelligenceInlineSource[] }
  | { readonly ok: false; readonly result: RouteResult };

async function parseSources(req: IncomingMessage): Promise<ParseSourcesOutcome> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return {
      ok: false,
      result: errorResult(413, "QI_BODY_TOO_LARGE", "Request body is too large."),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "Request body is not valid JSON."),
    };
  }
  if (!isObject(parsed) || !Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "At least one source is required."),
    };
  }
  const sources: QI.QualityIntelligenceInlineSource[] = [];
  for (const raw_ of parsed.sources) {
    const source = validateSource(raw_);
    if (source === undefined) {
      return {
        ok: false,
        result: errorResult(400, "QI_BAD_SOURCE", "A source entry is malformed."),
      };
    }
    sources.push(source);
  }
  return { ok: true, sources };
}

function buildJudgePortIfAvailable(
  deps: UiHandlerDeps,
  modelId: string,
): ReturnType<typeof createQiJudgePort> | undefined {
  try {
    return createQiJudgePort(deps, modelId);
  } catch {
    return undefined;
  }
}

function resolveProfile(profileId: string | undefined): PolicyProfile {
  if (profileId === undefined || profileId.trim().length === 0) return regressionDefault;
  return ALL_POLICY_PROFILES.find((profile) => profile.id === profileId) ?? regressionDefault;
}

function mapCurrentAtomFingerprints(
  ingestedAtoms: readonly QualityIntelligenceIngestedAtom[],
): readonly {
  readonly atomId: string;
  readonly envelopeId: string;
  readonly canonicalHashSha256Hex: string;
}[] {
  return ingestedAtoms.map((entry) => ({
    atomId: String(entry.atom.id),
    envelopeId: String(entry.atom.sourceEnvelopeId),
    canonicalHashSha256Hex: entry.atom.canonicalHashSha256Hex,
  }));
}

function mapCurrentSourceFingerprints(
  ingestion: ReturnType<typeof ingestInlineSources>,
): readonly { readonly envelopeId: string; readonly integrityHashSha256Hex: string }[] {
  return ingestion.envelopes.map((envelope) => ({
    envelopeId: String(envelope.id),
    integrityHashSha256Hex: envelope.provenance.integrityHashSha256Hex,
  }));
}

function toEvidenceRefs(
  ingestedAtoms: readonly QualityIntelligenceIngestedAtom[],
): QualityIntelligenceEvidenceManifest["evidenceRefs"] {
  return Object.freeze(
    ingestedAtoms.map((entry) =>
      Object.freeze({
        envelopeId: String(entry.atom.sourceEnvelopeId),
        atomId: String(entry.atom.id),
        lifecycleStatus: entry.atom.lifecycleStatus,
      }),
    ),
  );
}

function rowToCandidate(row: QualityIntelligenceCandidateRow, runId: string): QiTestCaseCandidate {
  return {
    id: QualityIntelligence.asQualityIntelligenceTestCaseId(row.id),
    runId: QualityIntelligence.asQualityIntelligenceRunId(runId),
    derivedFromAtomIds: row.derivedFromAtomIds.map((atomId) =>
      QualityIntelligence.asQualityIntelligenceEvidenceAtomId(atomId),
    ),
    title: row.title,
    preconditions: row.preconditions,
    steps: row.steps,
    expectedResults: row.expectedResults,
    priority: row.priority,
    riskClass: row.riskClass,
    tags: row.tags,
    status: row.status,
  };
}

function toCandidateFindingRow(
  finding: QI.QualityIntelligenceValidationFinding,
): QualityIntelligenceFindingRow {
  return {
    id: String(finding.id),
    kind: finding.kind,
    severity: finding.severity,
    summaryRedacted: finding.summary,
    ...(finding.candidateId !== undefined ? { candidateId: String(finding.candidateId) } : {}),
  };
}

function buildCoverageGapFindingRow(
  runId: QI.QualityIntelligenceRunId,
  atomStatus: AtomCoverageStatus,
  ordinal: number,
): QualityIntelligenceFindingRow {
  const payload = ["v1-cov-gap", String(runId), String(atomStatus.atomId), String(ordinal)].join(
    "",
  );
  return Object.freeze({
    id: `qi-finding-${sha256Hex(payload).slice(0, 32)}`,
    kind: "coverage-gap",
    severity: "medium",
    summaryRedacted: `Atom ${String(atomStatus.atomId)} has no sufficient test coverage (status: ${atomStatus.status}).`,
  });
}

function toCoverageMatrix(
  statuses: readonly AtomCoverageStatus[],
): NonNullable<QualityIntelligenceEvidenceManifest["coverageMatrix"]> {
  return Object.freeze(
    statuses.map((status) =>
      Object.freeze({
        atomId: String(status.atomId),
        status: status.status,
        confidence: status.confidence,
        coveringCandidateIds: Object.freeze(status.coveringCandidateIds.map(String)),
      }),
    ),
  );
}

function filteredJudgeFindings(
  findings: readonly QualityIntelligenceFindingRow[],
  candidateIds: ReadonlySet<string>,
): readonly QualityIntelligenceFindingRow[] {
  return findings.filter(
    (finding) =>
      finding.kind === "test-quality" &&
      finding.candidateId !== undefined &&
      candidateIds.has(finding.candidateId),
  );
}

function selectedQualityScore(args: {
  readonly oldManifest: QiManifest;
  readonly regeneratedManifest: QiManifest | undefined;
  readonly preservedCount: number;
  readonly regeneratedCount: number;
}): number | null | undefined {
  const { oldManifest, regeneratedManifest, preservedCount, regeneratedCount } = args;
  if (preservedCount > 0 && regeneratedCount > 0) return null;
  if (regeneratedCount > 0) return regeneratedManifest?.qualityScore ?? null;
  if (preservedCount > 0) return oldManifest.qualityScore ?? null;
  return null;
}

interface DriftContext {
  readonly sources: readonly QI.QualityIntelligenceInlineSource[];
  readonly manifest: QiManifest;
  readonly ingestion: QiIngestion;
  readonly staleness: ReturnType<typeof compareStaleness>;
  readonly oldCandidates: readonly QualityIntelligenceCandidateRow[];
  readonly oldEditedRevisions: readonly QiEditedRevision[];
}

type DriftOutcome =
  | { readonly ok: true; readonly value: DriftContext }
  | { readonly ok: false; readonly result: RouteResult };

type ManifestOutcome =
  | { readonly ok: true; readonly manifest: QiManifest }
  | { readonly ok: false; readonly result: RouteResult };

type IngestionOutcome =
  | { readonly ok: true; readonly ingestion: QiIngestion }
  | { readonly ok: false; readonly result: RouteResult };

function loadManifestForDrift(id: string, evidenceDir: string): ManifestOutcome {
  const manifest = loadQualityIntelligenceRun(id, { evidenceDir });
  return manifest === undefined
    ? {
        ok: false,
        result: errorResult(404, "QI_NOT_FOUND", "Quality Intelligence run not found."),
      }
    : { ok: true, manifest };
}

function ingestSourcesForDrift(
  sources: readonly QI.QualityIntelligenceInlineSource[],
  ingestRunId: string,
  deps: UiHandlerDeps,
): IngestionOutcome {
  try {
    return {
      ok: true,
      ingestion: ingestInlineSources({
        request: { sources },
        runId: ingestRunId,
        registeredAt: new Date().toISOString(),
        capsuleResolver: makeCapsuleResolver(deps),
        figmaSnapshotLoader: makeFigmaSnapshotLoader(deps),
        figmaVision: makeFigmaVisionHintProvider(deps),
      }),
    };
  } catch (error) {
    const code = error instanceof QiIngestionError ? error.code : "QI_INGESTION_FAILED";
    const message = error instanceof QiIngestionError ? error.message : "Source ingestion failed.";
    return { ok: false, result: errorResult(400, code, message) };
  }
}

function buildDriftStaleness(
  manifest: QiManifest,
  oldCandidates: readonly QualityIntelligenceCandidateRow[],
  ingestion: QiIngestion,
): ReturnType<typeof compareStaleness> {
  return compareStaleness({
    oldFingerprints: manifest.sourceFingerprints ?? [],
    evidenceRefs: manifest.evidenceRefs.map((ref) => ({
      envelopeId: ref.envelopeId,
      atomId: ref.atomId,
    })),
    candidates: oldCandidates.map((candidate) => ({
      id: candidate.id,
      derivedFromAtomIds: candidate.derivedFromAtomIds,
    })),
    currentFingerprints: mapCurrentSourceFingerprints(ingestion),
    currentAtomFingerprints: mapCurrentAtomFingerprints(ingestion.ingestedAtoms),
    ...(manifest.atomFingerprints !== undefined
      ? { oldAtomFingerprints: manifest.atomFingerprints }
      : {}),
  });
}

function buildDriftContext(
  sources: readonly QI.QualityIntelligenceInlineSource[],
  manifest: QiManifest,
  ingestion: QiIngestion,
  oldArtifact: ReturnType<typeof loadQualityIntelligenceCandidates>,
): DriftContext {
  const oldCandidates = oldArtifact?.candidates ?? [];
  return {
    sources,
    manifest,
    ingestion,
    staleness: buildDriftStaleness(manifest, oldCandidates, ingestion),
    oldCandidates,
    oldEditedRevisions: oldArtifact?.editedRevisions ?? [],
  };
}

async function computeDrift(
  req: RouteContext["req"],
  evidenceDir: string,
  id: string,
  ingestRunId: string,
  deps: UiHandlerDeps,
): Promise<DriftOutcome> {
  const parsed = await parseSources(req);
  if (!parsed.ok) return { ok: false, result: parsed.result };
  const loaded = loadManifestForDrift(id, evidenceDir);
  if (!loaded.ok) return { ok: false, result: loaded.result };
  const ingested = ingestSourcesForDrift(parsed.sources, ingestRunId, deps);
  if (!ingested.ok) return { ok: false, result: ingested.result };
  const oldArtifact = loadQualityIntelligenceCandidates(id, { evidenceDir });
  return {
    ok: true,
    value: buildDriftContext(parsed.sources, loaded.manifest, ingested.ingestion, oldArtifact),
  };
}

interface NarrowedRegeneration {
  readonly staleIds: ReadonlySet<string>;
  readonly atomsToRegenerate: readonly QualityIntelligenceIngestedAtom[];
  readonly preservedCandidates: readonly QualityIntelligenceCandidateRow[];
  readonly preservedEditedRevisions: readonly QiEditedRevision[];
  readonly legacyRequirementsFallback: boolean;
}

interface PreservedState {
  readonly preservedCandidates: readonly QualityIntelligenceCandidateRow[];
  readonly preservedEditedRevisions: readonly QiEditedRevision[];
}

interface CurrentAtomIndexes {
  readonly byId: ReadonlyMap<string, QualityIntelligenceIngestedAtom>;
  readonly byEnvelope: ReadonlyMap<string, readonly QualityIntelligenceIngestedAtom[]>;
  readonly envelopeIds: ReadonlySet<string>;
}

interface OldAtomIndexes {
  readonly byId: ReadonlyMap<
    string,
    { readonly envelopeId: string; readonly canonicalHashSha256Hex: string }
  >;
  readonly idsByEnvelope: ReadonlyMap<string, ReadonlySet<string>>;
}

function collectStaleIds(staleness: DriftContext["staleness"]): ReadonlySet<string> {
  return new Set<string>([
    ...staleness.changedStale.map((reason) => reason.candidateId),
    ...staleness.orphanedStale.map((reason) => reason.candidateId),
  ]);
}

function buildPreservedState(drift: DriftContext, staleIds: ReadonlySet<string>): PreservedState {
  const preservedCandidates = drift.oldCandidates.filter(
    (candidate) => !staleIds.has(candidate.id),
  );
  const preservedIds = new Set(preservedCandidates.map((candidate) => candidate.id));
  return {
    preservedCandidates,
    preservedEditedRevisions: drift.oldEditedRevisions.filter((revision) =>
      preservedIds.has(revision.candidateId),
    ),
  };
}

function looksLikeLegacyRequirementsFallback(
  drift: DriftContext,
  staleIds: ReadonlySet<string>,
): boolean {
  if (staleIds.size === 0 || drift.manifest.atomFingerprints !== undefined) return false;
  if (
    !(drift.sources.length > 0 && drift.sources.every((source) => source.kind === "requirements"))
  ) {
    return false;
  }
  const evidenceRefMap = new Map(
    drift.manifest.evidenceRefs.map((ref) => [ref.atomId, ref.envelopeId] as const),
  );
  return drift.oldCandidates.some(
    (candidate) =>
      staleIds.has(candidate.id) &&
      candidate.derivedFromAtomIds.some((atomId) =>
        evidenceRefMap.get(atomId)?.startsWith("qi-src-"),
      ),
  );
}

function buildCurrentAtomIndexes(ingestion: QiIngestion): CurrentAtomIndexes {
  const byId = new Map(
    ingestion.ingestedAtoms.map((entry) => [String(entry.atom.id), entry] as const),
  );
  const byEnvelope = new Map<string, QualityIntelligenceIngestedAtom[]>();
  for (const entry of ingestion.ingestedAtoms) {
    const envelopeId = String(entry.atom.sourceEnvelopeId);
    const current = byEnvelope.get(envelopeId);
    if (current === undefined) {
      byEnvelope.set(envelopeId, [entry]);
    } else {
      current.push(entry);
    }
  }
  return {
    byId,
    byEnvelope,
    envelopeIds: new Set(ingestion.envelopes.map((envelope) => String(envelope.id))),
  };
}

function buildOldAtomIndexes(atomFingerprints: readonly AtomFingerprintRow[]): OldAtomIndexes {
  const byId = new Map(
    atomFingerprints.map(
      (fp) =>
        [
          fp.atomId,
          { envelopeId: fp.envelopeId, canonicalHashSha256Hex: fp.canonicalHashSha256Hex },
        ] as const,
    ),
  );
  const idsByEnvelope = new Map<string, Set<string>>();
  for (const fp of atomFingerprints) {
    const ids = idsByEnvelope.get(fp.envelopeId);
    if (ids === undefined) {
      idsByEnvelope.set(fp.envelopeId, new Set([fp.atomId]));
    } else {
      ids.add(fp.atomId);
    }
  }
  return { byId, idsByEnvelope };
}

function addReplacementRequirementAtoms(
  envelopeId: string,
  current: CurrentAtomIndexes,
  old: OldAtomIndexes,
  atomIdsToRegenerate: Set<string>,
): void {
  const oldIds = old.idsByEnvelope.get(envelopeId) ?? new Set<string>();
  for (const replacement of current.byEnvelope.get(envelopeId) ?? []) {
    const replacementId = String(replacement.atom.id);
    if (!oldIds.has(replacementId)) atomIdsToRegenerate.add(replacementId);
  }
}

function addRegenerationAtomsForCandidate(
  candidate: QualityIntelligenceCandidateRow,
  current: CurrentAtomIndexes,
  old: OldAtomIndexes,
  atomIdsToRegenerate: Set<string>,
): void {
  for (const atomId of candidate.derivedFromAtomIds) {
    const oldAtom = old.byId.get(atomId);
    const currentAtom = current.byId.get(atomId);
    if (
      oldAtom !== undefined &&
      currentAtom !== undefined &&
      currentAtom.atom.canonicalHashSha256Hex !== oldAtom.canonicalHashSha256Hex
    ) {
      atomIdsToRegenerate.add(String(currentAtom.atom.id));
      continue;
    }
    if (oldAtom === undefined || !current.envelopeIds.has(oldAtom.envelopeId)) continue;
    if (!oldAtom.envelopeId.startsWith(REQUIREMENTS_ENVELOPE_PREFIX)) continue;
    addReplacementRequirementAtoms(oldAtom.envelopeId, current, old, atomIdsToRegenerate);
  }
}

function collectAtomsToRegenerate(
  drift: DriftContext,
  staleIds: ReadonlySet<string>,
): readonly QualityIntelligenceIngestedAtom[] {
  const current = buildCurrentAtomIndexes(drift.ingestion);
  const old = buildOldAtomIndexes(drift.manifest.atomFingerprints ?? []);
  const atomIdsToRegenerate = new Set<string>();
  for (const candidate of drift.oldCandidates) {
    if (!staleIds.has(candidate.id)) continue;
    addRegenerationAtomsForCandidate(candidate, current, old, atomIdsToRegenerate);
  }
  return drift.ingestion.ingestedAtoms.filter((entry) =>
    atomIdsToRegenerate.has(String(entry.atom.id)),
  );
}

function narrowRegeneration(drift: DriftContext): NarrowedRegeneration {
  const staleIds = collectStaleIds(drift.staleness);
  const preserved = buildPreservedState(drift, staleIds);
  const legacyRequirementsFallback = looksLikeLegacyRequirementsFallback(drift, staleIds);
  if (legacyRequirementsFallback || staleIds.size === 0) {
    return {
      staleIds,
      atomsToRegenerate: Object.freeze([]),
      preservedCandidates: preserved.preservedCandidates,
      preservedEditedRevisions: preserved.preservedEditedRevisions,
      legacyRequirementsFallback,
    };
  }
  return {
    staleIds,
    atomsToRegenerate: collectAtomsToRegenerate(drift, staleIds),
    preservedCandidates: preserved.preservedCandidates,
    preservedEditedRevisions: preserved.preservedEditedRevisions,
    legacyRequirementsFallback: false,
  };
}

interface RegenSuccess {
  readonly manifest: QiManifest;
  readonly candidates: readonly QiTestCaseCandidate[];
  readonly generatedAt: string;
}

type RegenOutcome =
  | { readonly ok: true; readonly value: RegenSuccess }
  | { readonly ok: false; readonly result: RouteResult };

function regenWorkflowDeps(
  deps: UiHandlerDeps,
  target: { readonly kind: "baseline" } | { readonly kind: "model"; readonly modelId: string },
  evidenceStore: ReturnType<typeof createInMemoryQualityIntelligenceLocalStore>,
  capture: (cands: readonly QiTestCaseCandidate[], generatedAt: string) => void,
): QualityIntelligenceModelRoutedTestDesignDeps {
  return {
    sink: { emit: () => undefined },
    evidenceStore,
    candidatesSink: {
      record: (cands, generatedAt): void => {
        capture(cands, generatedAt);
      },
    },
    generate: createQiGenerationPort(deps, target),
    ...(target.kind === "model" ? { judge: buildJudgePortIfAvailable(deps, target.modelId) } : {}),
  };
}

function buildScopedRegenPlan(newRunId: string, requestedAt: string): QiRunPlan {
  return {
    id: QualityIntelligence.asQualityIntelligenceRunId(newRunId),
    requestedAt,
    plannerKind: "model-routed",
    stages: [],
  };
}

async function executeScopedWorkflow(args: {
  readonly deps: UiHandlerDeps;
  readonly target:
    | { readonly kind: "baseline" }
    | { readonly kind: "model"; readonly modelId: string };
  readonly evidenceStore: ReturnType<typeof createInMemoryQualityIntelligenceLocalStore>;
  readonly capture: (cands: readonly QiTestCaseCandidate[], generatedAt: string) => void;
  readonly plan: QiRunPlan;
  readonly ingestion: QiIngestion;
  readonly atomsToRegenerate: readonly QualityIntelligenceIngestedAtom[];
  readonly profile: PolicyProfile;
}): Promise<RouteResult | null> {
  const { deps, target, evidenceStore, capture, plan, ingestion, atomsToRegenerate, profile } =
    args;
  try {
    const summary = await runQualityIntelligenceModelRoutedTestDesign(
      {
        plan,
        envelopes: ingestion.envelopes,
        ingestedAtoms: atomsToRegenerate,
        provenanceRefs: ingestion.provenanceRefs,
        profile,
      },
      regenWorkflowDeps(deps, target, evidenceStore, capture),
    );
    return summary.status === "succeeded"
      ? null
      : errorResult(500, "QI_REGEN_FAILED", "Scoped regeneration did not succeed.");
  } catch (error) {
    const code = error instanceof QiGenerationError ? error.code : "QI_REGEN_FAILED";
    const message =
      error instanceof QiGenerationError ? error.message : "Scoped regeneration failed.";
    return errorResult(500, code, message);
  }
}

function finalizeScopedWorkflow(
  evidenceStore: ReturnType<typeof createInMemoryQualityIntelligenceLocalStore>,
  newRunId: string,
  generatedCandidates: readonly QiTestCaseCandidate[],
  generatedAt: string | undefined,
): RegenOutcome {
  const manifest = evidenceStore.load(newRunId);
  if (manifest === undefined || generatedAt === undefined) {
    return {
      ok: false,
      result: errorResult(500, "QI_REGEN_FAILED", "Scoped regeneration did not persist in memory."),
    };
  }
  return {
    ok: true,
    value: { manifest, candidates: generatedCandidates, generatedAt },
  };
}

async function runScopedEphemeral(args: {
  readonly deps: UiHandlerDeps;
  readonly target:
    | { readonly kind: "baseline" }
    | { readonly kind: "model"; readonly modelId: string };
  readonly newRunId: string;
  readonly requestedAt: string;
  readonly ingestion: QiIngestion;
  readonly atomsToRegenerate: readonly QualityIntelligenceIngestedAtom[];
  readonly profile: PolicyProfile;
}): Promise<RegenOutcome> {
  const { deps, target, newRunId, requestedAt, ingestion, atomsToRegenerate, profile } = args;
  const evidenceStore = createInMemoryQualityIntelligenceLocalStore();
  let generatedCandidates: readonly QiTestCaseCandidate[] = [];
  let generatedAt: string | undefined;
  const failure = await executeScopedWorkflow({
    deps,
    target,
    evidenceStore,
    capture: (cands, ts) => {
      generatedCandidates = [...cands];
      generatedAt = ts;
    },
    plan: buildScopedRegenPlan(newRunId, requestedAt),
    ingestion,
    atomsToRegenerate,
    profile,
  });
  if (failure !== null) return { ok: false, result: failure };
  return finalizeScopedWorkflow(evidenceStore, newRunId, generatedCandidates, generatedAt);
}

function buildMergedCandidates(
  newRunId: string,
  preservedCandidates: readonly QualityIntelligenceCandidateRow[],
  regeneratedCandidates: readonly QiTestCaseCandidate[],
): readonly QiTestCaseCandidate[] {
  return [
    ...preservedCandidates.map((candidate) => rowToCandidate(candidate, newRunId)),
    ...regeneratedCandidates,
  ];
}

function buildCoverageArtifacts(
  runId: QI.QualityIntelligenceRunId,
  ingestion: QiIngestion,
  mergedCandidates: readonly QiTestCaseCandidate[],
): {
  readonly coverageMatrix: NonNullable<QualityIntelligenceEvidenceManifest["coverageMatrix"]>;
  readonly coverageGapRows: readonly QualityIntelligenceFindingRow[];
} {
  const atoms = ingestion.ingestedAtoms.map((entry) => entry.atom);
  const coverageMap = buildCoverageMap({ runId, atoms, candidates: mergedCandidates });
  const atomStatuses = buildAtomCoverageStatuses(atoms, coverageMap);
  return {
    coverageMatrix: toCoverageMatrix(atomStatuses),
    coverageGapRows: atomStatuses
      .map((status, index) =>
        status.status === "covered" ? null : buildCoverageGapFindingRow(runId, status, index),
      )
      .filter((row): row is QualityIntelligenceFindingRow => row !== null),
  };
}

function buildMergedFindings(args: {
  readonly runId: QI.QualityIntelligenceRunId;
  readonly mergedCandidates: readonly QiTestCaseCandidate[];
  readonly coverageGapRows: readonly QualityIntelligenceFindingRow[];
  readonly oldManifest: QiManifest;
  readonly preservedCandidates: readonly QualityIntelligenceCandidateRow[];
  readonly regeneratedCandidates: readonly QiTestCaseCandidate[];
  readonly regeneratedManifest: QiManifest | undefined;
}): readonly QualityIntelligenceFindingRow[] {
  const preservedIds = new Set(args.preservedCandidates.map((candidate) => candidate.id));
  const regeneratedIds = new Set(
    args.regeneratedCandidates.map((candidate) => String(candidate.id)),
  );
  const preservedJudgeRows = filteredJudgeFindings(args.oldManifest.findings, preservedIds);
  const regeneratedJudgeRows =
    args.regeneratedManifest === undefined
      ? []
      : filteredJudgeFindings(args.regeneratedManifest.findings, regeneratedIds);
  return Object.freeze([
    ...args.coverageGapRows,
    ...validateCandidates(args.runId, args.mergedCandidates).map(toCandidateFindingRow),
    ...preservedJudgeRows,
    ...regeneratedJudgeRows,
  ]);
}

function buildMergedRunRecord(args: {
  readonly newRunId: string;
  readonly requestedAt: string;
  readonly profile: PolicyProfile;
  readonly oldManifest: QiManifest;
  readonly ingestion: QiIngestion;
  readonly preservedCandidates: readonly QualityIntelligenceCandidateRow[];
  readonly regeneratedCandidates: readonly QiTestCaseCandidate[];
  readonly regeneratedManifest: QiManifest | undefined;
  readonly completedAt: string;
  readonly findings: readonly QualityIntelligenceFindingRow[];
  readonly coverageMatrix: NonNullable<QualityIntelligenceEvidenceManifest["coverageMatrix"]>;
}): Parameters<typeof recordQualityIntelligenceRun>[0] {
  const { newRunId, requestedAt, profile, oldManifest, ingestion, preservedCandidates } = args;
  return {
    runId: newRunId,
    planAt: requestedAt,
    completedAt: args.completedAt,
    status: "succeeded",
    policyProfileIds: [profile.id],
    retentionPolicyId: oldManifest.retentionPolicyId,
    modelGatewayCallCount: args.regeneratedManifest?.modelGatewayCallCount ?? 0,
    totals: {
      candidates: args.preservedCandidates.length + args.regeneratedCandidates.length,
      findings: args.findings.length,
      exports: 0,
    },
    findings: args.findings,
    exports: Object.freeze([]),
    evidenceRefs: toEvidenceRefs(ingestion.ingestedAtoms),
    provenanceRefs: ingestion.provenanceRefs,
    coverageMatrix: args.coverageMatrix,
    qualityScore: selectedQualityScore({
      oldManifest,
      regeneratedManifest: args.regeneratedManifest,
      preservedCount: preservedCandidates.length,
      regeneratedCount: args.regeneratedCandidates.length,
    }),
    sourceFingerprints: mapCurrentSourceFingerprints(ingestion),
    atomFingerprints: mapCurrentAtomFingerprints(ingestion.ingestedAtoms),
    ...optionalModelFields(args.regeneratedManifest),
  };
}

// Carry forward the regenerated manifest's optional model provenance (modelId / modelParameters /
// seedUsed) only when present, so the merged record omits — rather than nulls — an absent field.
function optionalModelFields(
  regeneratedManifest: QiManifest | undefined,
): Partial<
  Pick<
    Parameters<typeof recordQualityIntelligenceRun>[0],
    "modelId" | "modelParameters" | "seedUsed"
  >
> {
  if (regeneratedManifest === undefined) return {};
  return {
    ...(regeneratedManifest.modelId !== undefined ? { modelId: regeneratedManifest.modelId } : {}),
    ...(regeneratedManifest.modelParameters !== undefined
      ? { modelParameters: regeneratedManifest.modelParameters }
      : {}),
    ...(regeneratedManifest.seedUsed !== undefined
      ? { seedUsed: regeneratedManifest.seedUsed }
      : {}),
  };
}

function recordMergedManifest(
  evidenceDir: string,
  args: Parameters<typeof buildMergedRunRecord>[0],
): void {
  recordQualityIntelligenceRun(buildMergedRunRecord(args), { evidenceDir });
}

function recordMergedCandidatesArtifact(args: {
  readonly deps: UiHandlerDeps;
  readonly evidenceDir: string;
  readonly newRunId: string;
  readonly completedAt: string;
  readonly mergedCandidates: readonly QiTestCaseCandidate[];
  readonly preservedEditedRevisions: readonly QiEditedRevision[];
}): void {
  recordQualityIntelligenceCandidates({
    runId: args.newRunId,
    generatedAt: args.completedAt,
    candidates: args.mergedCandidates,
    editedRevisions: args.preservedEditedRevisions,
    evidenceDir: args.evidenceDir,
    redact: args.deps.redactor,
  });
}

interface PersistMergedRunArgs {
  readonly deps: UiHandlerDeps;
  readonly evidenceDir: string;
  readonly newRunId: string;
  readonly requestedAt: string;
  readonly profile: PolicyProfile;
  readonly oldManifest: QiManifest;
  readonly ingestion: QiIngestion;
  readonly preservedCandidates: readonly QualityIntelligenceCandidateRow[];
  readonly preservedEditedRevisions: readonly QiEditedRevision[];
  readonly regeneratedCandidates: readonly QiTestCaseCandidate[];
  readonly regeneratedManifest: QiManifest | undefined;
  readonly completedAt: string;
}

function persistMergedRun(args: PersistMergedRunArgs): void {
  const mergedCandidates = buildMergedCandidates(
    args.newRunId,
    args.preservedCandidates,
    args.regeneratedCandidates,
  );
  const runId = QualityIntelligence.asQualityIntelligenceRunId(args.newRunId);
  const coverage = buildCoverageArtifacts(runId, args.ingestion, mergedCandidates);
  const findings = buildMergedFindings({
    runId,
    mergedCandidates,
    coverageGapRows: coverage.coverageGapRows,
    oldManifest: args.oldManifest,
    preservedCandidates: args.preservedCandidates,
    regeneratedCandidates: args.regeneratedCandidates,
    regeneratedManifest: args.regeneratedManifest,
  });
  recordMergedManifest(args.evidenceDir, {
    newRunId: args.newRunId,
    requestedAt: args.requestedAt,
    profile: args.profile,
    oldManifest: args.oldManifest,
    ingestion: args.ingestion,
    preservedCandidates: args.preservedCandidates,
    regeneratedCandidates: args.regeneratedCandidates,
    regeneratedManifest: args.regeneratedManifest,
    completedAt: args.completedAt,
    findings,
    coverageMatrix: coverage.coverageMatrix,
  });
  recordMergedCandidatesArtifact({
    deps: args.deps,
    evidenceDir: args.evidenceDir,
    newRunId: args.newRunId,
    completedAt: args.completedAt,
    mergedCandidates,
    preservedEditedRevisions: args.preservedEditedRevisions,
  });
}

interface RegeneratedSlice {
  readonly manifest: QiManifest | undefined;
  readonly candidates: readonly QiTestCaseCandidate[];
  readonly completedAt: string;
}

type RegeneratedSliceOutcome =
  | { readonly ok: true; readonly value: RegeneratedSlice }
  | { readonly ok: false; readonly result: RouteResult };

function immediateRegenerationResult(
  id: string,
  drift: DriftContext,
  narrowed: NarrowedRegeneration,
): RouteResult | null {
  if (narrowed.staleIds.size === 0) {
    return {
      status: 200,
      body: { runId: id, regeneratedCount: 0, preservedCount: drift.oldCandidates.length },
    };
  }
  if (!narrowed.legacyRequirementsFallback) return null;
  return errorResult(
    409,
    "QI_REGEN_LEGACY_REQUIREMENTS_UNSUPPORTED",
    "This run predates atom-level requirements drift metadata. Start a new QI run against the current requirements sources instead.",
  );
}

function resolveScopedRegenerationTarget(
  deps: UiHandlerDeps,
): { readonly kind: "baseline" } | { readonly kind: "model"; readonly modelId: string } {
  const selection = resolveQiTestDesignSelection(deps);
  return selection.kind === "model"
    ? { kind: "model", modelId: selection.modelId }
    : { kind: "baseline" };
}

async function regenerateCandidateSlice(args: {
  readonly deps: UiHandlerDeps;
  readonly newRunId: string;
  readonly requestedAt: string;
  readonly drift: DriftContext;
  readonly narrowed: NarrowedRegeneration;
  readonly profile: PolicyProfile;
}): Promise<RegeneratedSliceOutcome> {
  if (args.narrowed.atomsToRegenerate.length === 0) {
    return {
      ok: true,
      value: { manifest: undefined, candidates: [], completedAt: new Date().toISOString() },
    };
  }
  const outcome = await runScopedEphemeral({
    deps: args.deps,
    target: resolveScopedRegenerationTarget(args.deps),
    newRunId: args.newRunId,
    requestedAt: args.requestedAt,
    ingestion: args.drift.ingestion,
    atomsToRegenerate: args.narrowed.atomsToRegenerate,
    profile: args.profile,
  });
  return outcome.ok
    ? {
        ok: true,
        value: {
          manifest: outcome.value.manifest,
          candidates: outcome.value.candidates,
          completedAt: outcome.value.generatedAt,
        },
      }
    : outcome;
}

async function regenerateFromDrift(args: {
  readonly deps: UiHandlerDeps;
  readonly id: string;
  readonly evidenceDir: string;
  readonly newRunId: string;
  readonly requestedAt: string;
  readonly drift: DriftContext;
}): Promise<RouteResult> {
  const { deps, id, evidenceDir, newRunId, requestedAt, drift } = args;
  const narrowed = narrowRegeneration(drift);
  const immediate = immediateRegenerationResult(id, drift, narrowed);
  if (immediate !== null) return immediate;
  const profile = resolveProfile(drift.manifest.policyProfileIds[0]);
  const regenerated = await regenerateCandidateSlice({
    deps,
    newRunId,
    requestedAt,
    drift,
    narrowed,
    profile,
  });
  if (!regenerated.ok) return regenerated.result;
  persistMergedRun({
    deps,
    evidenceDir,
    newRunId,
    requestedAt,
    profile,
    oldManifest: drift.manifest,
    ingestion: drift.ingestion,
    preservedCandidates: narrowed.preservedCandidates,
    preservedEditedRevisions: narrowed.preservedEditedRevisions,
    regeneratedCandidates: regenerated.value.candidates,
    regeneratedManifest: regenerated.value.manifest,
    completedAt: regenerated.value.completedAt,
  });
  return {
    status: 200,
    body: {
      runId: newRunId,
      regeneratedCount: regenerated.value.candidates.length,
      preservedCount: narrowed.preservedCandidates.length,
    },
  };
}

export async function handleQiReCheck(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const { id } = ctx.params;
  if (id === undefined || id.trim().length === 0) {
    return errorResult(400, "QI_BAD_REQUEST", "Run id is required.");
  }
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined) {
    return errorResult(500, "QI_NO_EVIDENCE_DIR", "The evidence directory is not configured.");
  }
  try {
    const drift = await computeDrift(ctx.req, evidenceDir, id, `qi-recheck-${id}`, deps);
    if (!drift.ok) return drift.result;
    const { staleness } = drift.value;
    return {
      status: 200,
      body: {
        runId: id,
        staleCount: staleness.changedStale.length + staleness.orphanedStale.length,
        fresh: staleness.fresh,
        changedStale: staleness.changedStale,
        orphanedStale: staleness.orphanedStale,
      },
    };
  } catch {
    return errorResult(
      500,
      "QI_RECHECK_FAILED",
      "Failed to inspect the current sources for drift.",
    );
  }
}

export async function handleQiRegenerateStale(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const { id } = ctx.params;
  if (id === undefined || id.trim().length === 0) {
    return errorResult(400, "QI_BAD_REQUEST", "Run id is required.");
  }
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined) {
    return errorResult(500, "QI_NO_EVIDENCE_DIR", "The evidence directory is not configured.");
  }
  const newRunId = `qi-run-${randomUUID()}`;
  const requestedAt = new Date().toISOString();
  try {
    const drift = await computeDrift(ctx.req, evidenceDir, id, newRunId, deps);
    if (!drift.ok) return drift.result;
    return await regenerateFromDrift({
      deps,
      id,
      evidenceDir,
      newRunId,
      requestedAt,
      drift: drift.value,
    });
  } catch {
    return errorResult(500, "QI_REGEN_FAILED", "Failed to regenerate stale candidates.");
  }
}

export const QI_RECHECK_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/quality-intelligence/runs/:id/re-check",
    handler: handleQiReCheck,
  },
  {
    method: "POST",
    pattern: "/api/quality-intelligence/runs/:id/regenerate-stale",
    handler: handleQiRegenerateStale,
  },
];
