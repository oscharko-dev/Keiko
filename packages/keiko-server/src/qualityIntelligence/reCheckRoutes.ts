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
import { isAbsolute } from "node:path";
import { QualityIntelligence, type QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import {
  ALL_POLICY_PROFILES,
  buildAtomCoverageStatuses,
  buildCoverageMap,
  compareStaleness,
  deduplicateCandidates,
  regressionDefault,
  validateCandidates,
  type AtomCoverageStatus,
  type PolicyProfile,
} from "@oscharko-dev/keiko-quality-intelligence";
import { assertValidRunId, sha256Hex } from "@oscharko-dev/keiko-security";
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
import {
  QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS,
  excerptsByAtomId,
  runQualityIntelligenceModelRoutedTestDesign,
} from "@oscharko-dev/keiko-workflows";
import type {
  QualityIntelligenceIngestedAtom,
  QualityIntelligenceModelRoutedTestDesignDeps,
} from "@oscharko-dev/keiko-workflows";
import type { RouteContext, RouteDefinition, RouteResult } from "../routes.js";
import { currentRedactionSecrets, type UiHandlerDeps } from "../deps.js";
import { makeCapsuleResolver } from "./capsuleAdapter.js";
import { makeFigmaSnapshotLoader, makeFigmaVisionHintProvider } from "./figmaSnapshotAdapter.js";
import { createQiGenerationPort, QiGenerationError } from "./generationPort.js";
import { createQiJudgePort } from "./judgePort.js";
import { resolveQiTestDesignSelection } from "./modelSelection.js";
import { ingestInlineSourcesAsync, QiIngestionError } from "./runIngestion.js";
import { parseFigmaSnapshotScreenIds } from "./figmaSnapshotScreenIds.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUIREMENTS_ENVELOPE_PREFIX = "qi-src-req-";

type QiTestCaseCandidate = QualityIntelligence.QualityIntelligenceTestCaseCandidate;
type QiRunPlan = QualityIntelligence.QualityIntelligenceRunPlan;
type QiManifest = NonNullable<ReturnType<typeof loadQualityIntelligenceRun>>;
type QiEditedRevision = QI.QualityIntelligenceCandidateEditedRevision;
type QiIngestion = Awaited<ReturnType<typeof ingestInlineSourcesAsync>>;
type AtomFingerprintRow = ReturnType<typeof mapCurrentAtomFingerprints>[number];

const errorResult = (status: number, code: string, message: string): RouteResult => ({
  status,
  body: { error: { code, message } },
});

// Validate the (already-non-empty) :id path param and map an invalid id to a 400 (mirrors the
// evidence read handlers) instead of letting it reach the store and surface as a generic 500 in the
// outer catch. assertValidRunId rejects separators / `..` / NUL, so a traversal-shaped id never
// reaches a filesystem path. Returns the error result to short-circuit, or null when the id is valid.
function invalidRunIdFormat(id: string): RouteResult | null {
  try {
    assertValidRunId(id);
    return null;
  } catch {
    return errorResult(400, "QI_BAD_REQUEST", "Run id is invalid.");
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let capped = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        if (!capped) {
          capped = true;
          chunks.length = 0;
          reject(new Error("body too large"));
          req.resume();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!capped) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });

interface RequestAbortScope {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

function cancellationResult(signal: AbortSignal): RouteResult | null {
  return signal.aborted
    ? errorResult(499, "QI_REQUEST_CANCELLED", "Quality Intelligence request was cancelled.")
    : null;
}

function requestAbortSignal(ctx: RouteContext): RequestAbortScope {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort("quality intelligence request cancelled");
    }
  };
  const abortOnIncompleteRequestClose = (): void => {
    if (!ctx.req.complete) abort();
  };
  const abortOnResponseClose = (): void => {
    if (!ctx.res.writableEnded) abort();
  };
  if (ctx.req.destroyed) {
    abort();
    return { signal: controller.signal, dispose: () => undefined };
  }
  ctx.req.once("aborted", abort);
  ctx.req.once("close", abortOnIncompleteRequestClose);
  if (typeof ctx.res.once === "function") {
    ctx.res.once("close", abortOnResponseClose);
  }
  return {
    signal: controller.signal,
    dispose: (): void => {
      ctx.req.off("aborted", abort);
      ctx.req.off("close", abortOnIncompleteRequestClose);
      if (typeof ctx.res.off === "function") {
        ctx.res.off("close", abortOnResponseClose);
      }
    },
  };
}

function validateCapsuleSource(
  label: string,
  raw: Record<string, unknown>,
): QI.QualityIntelligenceCapsuleSource | undefined {
  if (typeof raw.capsuleId !== "string" || raw.capsuleId.trim().length === 0) return undefined;
  return { kind: "capsule", label, capsuleId: raw.capsuleId };
}

function validateCapsuleSetSource(
  label: string,
  raw: Record<string, unknown>,
): QI.QualityIntelligenceCapsuleSetSource | undefined {
  if (typeof raw.capsuleSetId !== "string" || raw.capsuleSetId.trim().length === 0) {
    return undefined;
  }
  return { kind: "capsule-set", label, capsuleSetId: raw.capsuleSetId };
}

function validateFigmaSnapshotSource(
  label: string,
  raw: Record<string, unknown>,
): QI.QualityIntelligenceFigmaSnapshotSource | undefined {
  if (typeof raw.snapshotRunId !== "string" || raw.snapshotRunId.trim().length === 0) {
    return undefined;
  }
  // Shared with the start-run route so re-check accepts/rejects EXACTLY the same screenIds inputs:
  // absent → whole snapshot; present → non-empty, bounded, canonicalised scope; empty array rejected.
  const parsed = parseFigmaSnapshotScreenIds(raw.screenIds);
  if (!parsed.ok) {
    return undefined;
  }
  return {
    kind: "figma-snapshot",
    label,
    snapshotRunId: raw.snapshotRunId,
    ...(parsed.screenIds !== undefined ? { screenIds: parsed.screenIds } : {}),
  };
}

function validateImageSource(
  label: string,
  raw: Record<string, unknown>,
): QI.QualityIntelligenceImageSource | undefined {
  if (raw.sourceKind !== "figma-snapshot-screen") return undefined;
  if (typeof raw.snapshotRunId !== "string" || raw.snapshotRunId.trim().length === 0) {
    return undefined;
  }
  if (typeof raw.screenId !== "string" || raw.screenId.trim().length === 0) return undefined;
  return {
    kind: "image",
    label,
    sourceKind: "figma-snapshot-screen",
    snapshotRunId: raw.snapshotRunId,
    screenId: raw.screenId,
  };
}

function validateConnectorSource(
  label: string,
  raw: Record<string, unknown>,
): QI.QualityIntelligenceInlineSource | undefined {
  if (raw.kind === "capsule") {
    return validateCapsuleSource(label, raw);
  }
  if (raw.kind === "capsule-set") {
    return validateCapsuleSetSource(label, raw);
  }
  if (raw.kind === "figma-snapshot") {
    return validateFigmaSnapshotSource(label, raw);
  }
  if (raw.kind === "image") {
    return validateImageSource(label, raw);
  }
  return undefined;
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
  return validateConnectorSource(label, raw);
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
    if (source.kind === "file" && !isAbsolute(source.path)) {
      return {
        ok: false,
        result: errorResult(
          400,
          "QI_BAD_SOURCE",
          "File source paths must be absolute local paths.",
        ),
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
  readonly replacementGroupId?: string;
  readonly replacementOrdinal?: number;
}[] {
  return ingestedAtoms.map((entry) => ({
    atomId: String(entry.atom.id),
    envelopeId: String(entry.atom.sourceEnvelopeId),
    canonicalHashSha256Hex: entry.atom.canonicalHashSha256Hex,
    ...(entry.replacementGroupId !== undefined
      ? { replacementGroupId: entry.replacementGroupId }
      : {}),
    ...(entry.replacementOrdinal !== undefined
      ? { replacementOrdinal: entry.replacementOrdinal }
      : {}),
  }));
}

function mapCurrentSourceFingerprints(
  ingestion: QiIngestion,
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
  excerpt: string | undefined,
): QualityIntelligenceFindingRow {
  const payload = ["v1-cov-gap", String(runId), String(atomStatus.atomId), String(ordinal)].join(
    "",
  );
  // Mirror the initial-run severity model (modelRoutedTestDesign): a zero-coverage requirement is
  // the headline audit gap (high); a weakly-covered one is a softer "strengthen this" signal (low).
  const severity = atomStatus.status === "uncovered" ? "high" : "low";
  // Mirror the initial-run summary shape (#790): name the requirement via its redacted excerpt,
  // not just the opaque atom id, so the regenerated run's gap findings stay auditor-readable.
  const atomLabel =
    excerpt === undefined
      ? `Atom ${String(atomStatus.atomId)}`
      : `Atom ${String(atomStatus.atomId)} ("${excerpt}")`;
  const summaryRedacted =
    atomStatus.status === "uncovered"
      ? `${atomLabel} hat keinen zugeordneten Test (uncovered).`
      : `${atomLabel} ist nur schwach abgedeckt (kein dedizierter Test referenziert dieses Atom).`;
  return Object.freeze({
    id: `qi-finding-${sha256Hex(payload).slice(0, 32)}`,
    kind: "coverage-gap",
    severity,
    summaryRedacted,
  });
}

function toCoverageMatrix(
  statuses: readonly AtomCoverageStatus[],
  excerptByAtomId: ReadonlyMap<string, string>,
): NonNullable<QualityIntelligenceEvidenceManifest["coverageMatrix"]> {
  return Object.freeze(
    statuses.map((status) => {
      const excerpt = excerptByAtomId.get(String(status.atomId));
      return Object.freeze({
        atomId: String(status.atomId),
        status: status.status,
        confidence: status.confidence,
        coveringCandidateIds: Object.freeze(status.coveringCandidateIds.map(String)),
        ...(excerpt !== undefined ? { requirementExcerptRedacted: excerpt } : {}),
      });
    }),
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

async function ingestSourcesForDrift(
  sources: readonly QI.QualityIntelligenceInlineSource[],
  ingestRunId: string,
  deps: UiHandlerDeps,
): Promise<IngestionOutcome> {
  try {
    return {
      ok: true,
      ingestion: await ingestInlineSourcesAsync({
        request: { sources },
        runId: ingestRunId,
        registeredAt: new Date().toISOString(),
        allowEmpty: true,
        capsuleResolver: makeCapsuleResolver(deps),
        // Drift must see the board's LATEST snapshot, not the pinned immutable record — a pinned
        // write-once runId can never drift under its own identity (#735). Generate keeps pinning.
        figmaSnapshotLoader: makeFigmaSnapshotLoader(deps, { resolveLatestByScope: true }),
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
  const oldAtomFingerprints = manifest.atomFingerprints;
  const oldFingerprints =
    oldAtomFingerprints === undefined ? Object.freeze([]) : (manifest.sourceFingerprints ?? []);
  return compareStaleness({
    // Newer runs persist atom fingerprints, which are required for exact per-test drift. Older
    // source-only manifests cannot safely distinguish an unchanged workspace path set from edited
    // file content, so fail closed instead of reporting "fresh" from envelope fingerprints alone.
    oldFingerprints,
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
    ...(oldAtomFingerprints !== undefined ? { oldAtomFingerprints } : {}),
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
  const ingested = await ingestSourcesForDrift(parsed.sources, ingestRunId, deps);
  if (!ingested.ok) return { ok: false, result: ingested.result };
  const oldArtifact = loadQualityIntelligenceCandidates(id, { evidenceDir });
  if (oldArtifact === undefined && loaded.manifest.totals.candidates > 0) {
    return {
      ok: false,
      result: errorResult(
        500,
        "QI_CANDIDATES_MISSING",
        "The candidate artifact for this Quality Intelligence run is missing.",
      ),
    };
  }
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
  readonly replacementEntries: readonly ReplacementIndexEntry[];
  readonly envelopeIds: ReadonlySet<string>;
}

interface OldAtomIndexEntry {
  readonly envelopeId: string;
  readonly canonicalHashSha256Hex: string;
  readonly replacementGroupId?: string;
  readonly replacementOrdinal?: number;
}

interface OldAtomIndexes {
  readonly byId: ReadonlyMap<string, OldAtomIndexEntry>;
  readonly idsByEnvelope: ReadonlyMap<string, ReadonlySet<string>>;
  readonly idsInEnvelope: ReadonlyMap<string, readonly string[]>;
  readonly replacementEntries: readonly ReplacementIndexEntry[];
}

interface ReplacementIndexEntry {
  readonly atomId: string;
  readonly canonicalHashSha256Hex: string;
  readonly replacementGroupId: string;
  readonly replacementOrdinal: number;
}

const ALIGN_INSERT_DELETE_COST = 3;
const ALIGN_SUBSTITUTE_COST = 4;
const ALIGN_CROSS_OLD_ATOM_COST = 10;

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
  if (!(
    drift.sources.length > 0 && drift.sources.every((source) => source.kind === "requirements")
  )) {
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
  const replacementEntries: ReplacementIndexEntry[] = [];
  for (const entry of ingestion.ingestedAtoms) {
    const envelopeId = String(entry.atom.sourceEnvelopeId);
    const current = byEnvelope.get(envelopeId);
    if (current === undefined) {
      byEnvelope.set(envelopeId, [entry]);
    } else {
      current.push(entry);
    }
    if (entry.replacementGroupId !== undefined && entry.replacementOrdinal !== undefined) {
      replacementEntries.push({
        atomId: String(entry.atom.id),
        canonicalHashSha256Hex: entry.atom.canonicalHashSha256Hex,
        replacementGroupId: entry.replacementGroupId,
        replacementOrdinal: entry.replacementOrdinal,
      });
    }
  }
  return {
    byId,
    byEnvelope,
    replacementEntries,
    envelopeIds: new Set(ingestion.envelopes.map((envelope) => String(envelope.id))),
  };
}

function buildOldAtomIndexes(atomFingerprints: readonly AtomFingerprintRow[]): OldAtomIndexes {
  const byId = new Map(
    atomFingerprints.map(
      (fp) =>
        [
          fp.atomId,
          {
            envelopeId: fp.envelopeId,
            canonicalHashSha256Hex: fp.canonicalHashSha256Hex,
            ...(fp.replacementGroupId !== undefined
              ? { replacementGroupId: fp.replacementGroupId }
              : {}),
            ...(fp.replacementOrdinal !== undefined
              ? { replacementOrdinal: fp.replacementOrdinal }
              : {}),
          },
        ] as const,
    ),
  );
  const idsByEnvelope = new Map<string, Set<string>>();
  const idsInEnvelope = new Map<string, string[]>();
  const replacementEntries: ReplacementIndexEntry[] = [];
  for (const fp of atomFingerprints) {
    const ids = idsByEnvelope.get(fp.envelopeId);
    if (ids === undefined) {
      idsByEnvelope.set(fp.envelopeId, new Set([fp.atomId]));
    } else {
      ids.add(fp.atomId);
    }
    const orderedIds = idsInEnvelope.get(fp.envelopeId);
    if (orderedIds === undefined) {
      idsInEnvelope.set(fp.envelopeId, [fp.atomId]);
    } else {
      orderedIds.push(fp.atomId);
    }
    if (fp.replacementGroupId !== undefined && fp.replacementOrdinal !== undefined) {
      replacementEntries.push({
        atomId: fp.atomId,
        canonicalHashSha256Hex: fp.canonicalHashSha256Hex,
        replacementGroupId: fp.replacementGroupId,
        replacementOrdinal: fp.replacementOrdinal,
      });
    }
  }
  return { byId, idsByEnvelope, idsInEnvelope, replacementEntries };
}

function replacementEntriesByGroup(
  entries: readonly ReplacementIndexEntry[],
): ReadonlyMap<string, readonly ReplacementIndexEntry[]> {
  const groups = new Map<string, ReplacementIndexEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.replacementGroupId);
    if (group === undefined) {
      groups.set(entry.replacementGroupId, [entry]);
    } else {
      group.push(entry);
    }
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.replacementOrdinal - b.replacementOrdinal);
  }
  return groups;
}

function alignmentPairCost(
  oldEntry: ReplacementIndexEntry,
  currentEntry: ReplacementIndexEntry,
  oldAtomIds: ReadonlySet<string>,
): number {
  if (oldEntry.atomId === currentEntry.atomId) return 0;
  if (currentEntry.canonicalHashSha256Hex === oldEntry.canonicalHashSha256Hex) return 0;
  return oldAtomIds.has(currentEntry.atomId) ? ALIGN_CROSS_OLD_ATOM_COST : ALIGN_SUBSTITUTE_COST;
}

function replacementIndexEntryAt(
  entries: readonly ReplacementIndexEntry[],
  index: number,
): ReplacementIndexEntry {
  const entry = entries[index];
  if (entry === undefined) throw new Error("Replacement alignment index out of bounds.");
  return entry;
}

function matrixValue(matrix: readonly (readonly number[])[], row: number, col: number): number {
  const value = matrix[row]?.[col];
  if (value === undefined) throw new Error("Replacement alignment matrix index out of bounds.");
  return value;
}

function setMatrixValue(matrix: number[][], row: number, col: number, value: number): void {
  const rowValues = matrix[row];
  if (rowValues === undefined) {
    throw new Error("Replacement alignment matrix index out of bounds.");
  }
  rowValues[col] = value;
}

function buildAlignmentCostMatrix(
  oldEntries: readonly ReplacementIndexEntry[],
  currentEntries: readonly ReplacementIndexEntry[],
  oldAtomIds: ReadonlySet<string>,
): readonly (readonly number[])[] {
  const matrix: number[][] = Array.from({ length: oldEntries.length + 1 }, () =>
    Array.from({ length: currentEntries.length + 1 }, () => 0),
  );
  for (let oldIndex = 1; oldIndex <= oldEntries.length; oldIndex += 1) {
    setMatrixValue(matrix, oldIndex, 0, oldIndex * ALIGN_INSERT_DELETE_COST);
  }
  for (let currentIndex = 1; currentIndex <= currentEntries.length; currentIndex += 1) {
    setMatrixValue(matrix, 0, currentIndex, currentIndex * ALIGN_INSERT_DELETE_COST);
  }
  for (let oldIndex = 1; oldIndex <= oldEntries.length; oldIndex += 1) {
    for (let currentIndex = 1; currentIndex <= currentEntries.length; currentIndex += 1) {
      const pairCost = alignmentPairCost(
        replacementIndexEntryAt(oldEntries, oldIndex - 1),
        replacementIndexEntryAt(currentEntries, currentIndex - 1),
        oldAtomIds,
      );
      const pair = matrixValue(matrix, oldIndex - 1, currentIndex - 1) + pairCost;
      const deletion = matrixValue(matrix, oldIndex - 1, currentIndex) + ALIGN_INSERT_DELETE_COST;
      const insertion = matrixValue(matrix, oldIndex, currentIndex - 1) + ALIGN_INSERT_DELETE_COST;
      setMatrixValue(matrix, oldIndex, currentIndex, Math.min(pair, deletion, insertion));
    }
  }
  return matrix;
}

function alignReplacementEntries(
  oldEntries: readonly ReplacementIndexEntry[],
  currentEntries: readonly ReplacementIndexEntry[],
): ReadonlyMap<string, string> {
  const mapping = new Map<string, string>();
  const oldAtomIds = new Set(oldEntries.map((entry) => entry.atomId));
  const costs = buildAlignmentCostMatrix(oldEntries, currentEntries, oldAtomIds);
  let oldIndex = oldEntries.length;
  let currentIndex = currentEntries.length;
  while (oldIndex > 0 && currentIndex > 0) {
    const oldEntry = replacementIndexEntryAt(oldEntries, oldIndex - 1);
    const currentEntry = replacementIndexEntryAt(currentEntries, currentIndex - 1);
    const pairCost = alignmentPairCost(oldEntry, currentEntry, oldAtomIds);
    const currentCost = matrixValue(costs, oldIndex, currentIndex);
    const pair = matrixValue(costs, oldIndex - 1, currentIndex - 1) + pairCost;
    const deletion = matrixValue(costs, oldIndex - 1, currentIndex) + ALIGN_INSERT_DELETE_COST;
    const insertion = matrixValue(costs, oldIndex, currentIndex - 1) + ALIGN_INSERT_DELETE_COST;
    if (pairCost === 0 && currentCost === pair) {
      mapping.set(oldEntry.atomId, currentEntry.atomId);
      oldIndex -= 1;
      currentIndex -= 1;
    } else if (currentCost === insertion) {
      currentIndex -= 1;
    } else if (currentCost === deletion) {
      oldIndex -= 1;
    } else {
      mapping.set(oldEntry.atomId, currentEntry.atomId);
      oldIndex -= 1;
      currentIndex -= 1;
    }
  }
  return mapping;
}

function buildReplacementAtomMap(
  oldEntries: readonly ReplacementIndexEntry[],
  currentEntries: readonly ReplacementIndexEntry[],
): ReadonlyMap<string, string> {
  const oldGroups = replacementEntriesByGroup(oldEntries);
  const currentGroups = replacementEntriesByGroup(currentEntries);
  const mapping = new Map<string, string>();
  for (const [groupId, oldGroup] of oldGroups) {
    const currentGroup = currentGroups.get(groupId);
    if (currentGroup === undefined) continue;
    for (const [oldAtomId, currentAtomId] of alignReplacementEntries(oldGroup, currentGroup)) {
      mapping.set(oldAtomId, currentAtomId);
    }
  }
  return mapping;
}

function addPositionalReplacementRequirementAtom(
  atomId: string,
  envelopeId: string,
  current: CurrentAtomIndexes,
  old: OldAtomIndexes,
  atomIdsToRegenerate: Set<string>,
): void {
  const oldIds = old.idsByEnvelope.get(envelopeId) ?? new Set<string>();
  const oldIdsInEnvelope = old.idsInEnvelope.get(envelopeId) ?? [];
  const currentAtomsInEnvelope = current.byEnvelope.get(envelopeId) ?? [];
  const oldIndex = oldIdsInEnvelope.indexOf(atomId);
  const replacement = oldIndex >= 0 ? currentAtomsInEnvelope[oldIndex] : undefined;
  const replacementId = replacement === undefined ? undefined : String(replacement.atom.id);
  if (replacementId !== undefined && !oldIds.has(replacementId)) {
    atomIdsToRegenerate.add(replacementId);
  }
}

function addChangedCurrentAtom(
  oldAtom: OldAtomIndexEntry,
  currentEntry: QualityIntelligenceIngestedAtom | undefined,
  atomIdsToRegenerate: Set<string>,
): boolean {
  if (currentEntry === undefined) return false;
  if (currentEntry.atom.canonicalHashSha256Hex === oldAtom.canonicalHashSha256Hex) return false;
  atomIdsToRegenerate.add(String(currentEntry.atom.id));
  return true;
}

function addMappedReplacementAtom(
  atomId: string,
  current: CurrentAtomIndexes,
  old: OldAtomIndexes,
  replacementAtomIdsByOldAtomId: ReadonlyMap<string, string>,
  atomIdsToRegenerate: Set<string>,
): boolean {
  const replacementAtomId = replacementAtomIdsByOldAtomId.get(atomId);
  if (replacementAtomId === undefined || replacementAtomId === atomId) return false;
  if (old.byId.has(replacementAtomId) || !current.byId.has(replacementAtomId)) return false;
  atomIdsToRegenerate.add(replacementAtomId);
  return true;
}

function addRegenerationAtomsForCandidate(
  candidate: QualityIntelligenceCandidateRow,
  current: CurrentAtomIndexes,
  old: OldAtomIndexes,
  replacementAtomIdsByOldAtomId: ReadonlyMap<string, string>,
  atomIdsToRegenerate: Set<string>,
): void {
  for (const atomId of candidate.derivedFromAtomIds) {
    const oldAtom = old.byId.get(atomId);
    const currentAtom = current.byId.get(atomId);
    if (oldAtom === undefined || !current.envelopeIds.has(oldAtom.envelopeId)) continue;
    if (addChangedCurrentAtom(oldAtom, currentAtom, atomIdsToRegenerate)) continue;
    if (
      addMappedReplacementAtom(
        atomId,
        current,
        old,
        replacementAtomIdsByOldAtomId,
        atomIdsToRegenerate,
      )
    ) {
      continue;
    }
    if (!oldAtom.envelopeId.startsWith(REQUIREMENTS_ENVELOPE_PREFIX)) continue;
    addPositionalReplacementRequirementAtom(
      atomId,
      oldAtom.envelopeId,
      current,
      old,
      atomIdsToRegenerate,
    );
  }
}

function collectAtomsToRegenerate(
  drift: DriftContext,
  staleIds: ReadonlySet<string>,
): readonly QualityIntelligenceIngestedAtom[] {
  const current = buildCurrentAtomIndexes(drift.ingestion);
  const old = buildOldAtomIndexes(drift.manifest.atomFingerprints ?? []);
  const replacementAtomIdsByOldAtomId = buildReplacementAtomMap(
    old.replacementEntries,
    current.replacementEntries,
  );
  const atomIdsToRegenerate = new Set<string>();
  for (const candidate of drift.oldCandidates) {
    if (!staleIds.has(candidate.id)) continue;
    addRegenerationAtomsForCandidate(
      candidate,
      current,
      old,
      replacementAtomIdsByOldAtomId,
      atomIdsToRegenerate,
    );
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
  signal: AbortSignal,
): QualityIntelligenceModelRoutedTestDesignDeps {
  return {
    sink: { emit: () => undefined },
    signal,
    evidenceStore,
    candidatesSink: {
      record: (cands, generatedAt): void => {
        capture(cands, generatedAt);
      },
    },
    generate: createQiGenerationPort(deps, target),
    // The regenerate-stale judge deliberately shares the auto-selected generation model id rather than
    // resolving an independent qi:judge-logic model the way the initial run does (runExecution.ts).
    // This is safe because the regen target comes from resolveQiTestDesignSelection(deps) with NO
    // explicit model request: auto-selection prefers structured-output models, so whenever a judge is
    // possible (a structured-output model is configured) the generation model already satisfies
    // qi:judge-logic, and when only chat-only models exist both generation and the judge degrade
    // (judge skipped via buildJudgePortIfAvailable's typed-unavailable catch). The initial-run
    // asymmetry — an explicitly requested chat-only generation model paired with a separate
    // structured-output judge — cannot arise here because the regen path never carries an explicit
    // generation-model request.
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
    { readonly kind: "baseline" } | { readonly kind: "model"; readonly modelId: string };
  readonly evidenceStore: ReturnType<typeof createInMemoryQualityIntelligenceLocalStore>;
  readonly capture: (cands: readonly QiTestCaseCandidate[], generatedAt: string) => void;
  readonly plan: QiRunPlan;
  readonly ingestion: QiIngestion;
  readonly atomsToRegenerate: readonly QualityIntelligenceIngestedAtom[];
  readonly profile: PolicyProfile;
  readonly signal: AbortSignal;
}): Promise<RouteResult | null> {
  const {
    deps,
    target,
    evidenceStore,
    capture,
    plan,
    ingestion,
    atomsToRegenerate,
    profile,
    signal,
  } = args;
  try {
    const summary = await runQualityIntelligenceModelRoutedTestDesign(
      {
        plan,
        envelopes: ingestion.envelopes,
        ingestedAtoms: atomsToRegenerate,
        provenanceRefs: ingestion.provenanceRefs,
        profile,
      },
      regenWorkflowDeps(deps, target, evidenceStore, capture, signal),
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
    { readonly kind: "baseline" } | { readonly kind: "model"; readonly modelId: string };
  readonly newRunId: string;
  readonly requestedAt: string;
  readonly ingestion: QiIngestion;
  readonly atomsToRegenerate: readonly QualityIntelligenceIngestedAtom[];
  readonly profile: PolicyProfile;
  readonly signal: AbortSignal;
}): Promise<RegenOutcome> {
  const { deps, target, newRunId, requestedAt, ingestion, atomsToRegenerate, profile, signal } =
    args;
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
    signal,
  });
  if (failure !== null) return { ok: false, result: failure };
  return finalizeScopedWorkflow(evidenceStore, newRunId, generatedCandidates, generatedAt);
}

function buildMergedCandidates(
  newRunId: string,
  preservedCandidates: readonly QualityIntelligenceCandidateRow[],
  regeneratedCandidates: readonly QiTestCaseCandidate[],
): readonly QiTestCaseCandidate[] {
  return deduplicateCandidates([
    ...preservedCandidates.map((candidate) => rowToCandidate(candidate, newRunId)),
    ...regeneratedCandidates,
  ]);
}

function assertMergedCandidateBudget(
  preservedCandidates: readonly QualityIntelligenceCandidateRow[],
  regeneratedCandidates: readonly QiTestCaseCandidate[],
): RouteResult | null {
  const limit = QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS.maxCandidatesPerRun;
  if (preservedCandidates.length + regeneratedCandidates.length <= limit) return null;
  return errorResult(
    409,
    "QI_REGEN_CANDIDATE_CAP_EXCEEDED",
    "Regenerating the stale tests would exceed the per-run candidate limit. Reduce the stale scope or start a fresh QI run against the current source.",
  );
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
  const excerptByAtomId = excerptsByAtomId(ingestion.ingestedAtoms);
  return {
    coverageMatrix: toCoverageMatrix(atomStatuses, excerptByAtomId),
    coverageGapRows: atomStatuses
      .map((status, index) =>
        status.status === "covered"
          ? null
          : buildCoverageGapFindingRow(
              runId,
              status,
              index,
              excerptByAtomId.get(String(status.atomId)),
            ),
      )
      .filter((row): row is QualityIntelligenceFindingRow => row !== null),
  };
}

// Order by severity (critical -> low) BEFORE truncating, then cap to the per-run limit — mirroring
// the initial run path (modelRoutedTestDesign). Sorting first guarantees that if the merge hits the
// cap, the most severe findings (including high-severity uncovered-requirement coverage gaps) survive
// rather than being dropped by array position. Array.prototype.sort is stable, so same-severity
// insertion order — coverage-gap rows first — is preserved, matching the initial path exactly.
function sortAndCapMergedFindings(
  rows: readonly QualityIntelligenceFindingRow[],
  cap: number,
): readonly QualityIntelligenceFindingRow[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        QualityIntelligence.QUALITY_INTELLIGENCE_SEVERITY_RANK[a.severity] -
        QualityIntelligence.QUALITY_INTELLIGENCE_SEVERITY_RANK[b.severity],
    )
    .slice(0, cap);
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
  // Source the cap from the default workflow limits: the re-check regeneration sub-run
  // (regenWorkflowDeps) passes no custom `limits`, so it runs under these defaults — keeping the
  // merge cap consistent with the sub-run's own maxFindingsPerRun.
  const merged = sortAndCapMergedFindings(
    [
      ...args.coverageGapRows,
      ...validateCandidates(args.runId, args.mergedCandidates).map(toCandidateFindingRow),
      ...preservedJudgeRows,
      ...regeneratedJudgeRows,
    ],
    QUALITY_INTELLIGENCE_DEFAULT_WORKFLOW_LIMITS.maxFindingsPerRun,
  );
  return Object.freeze(merged);
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
  additionalSecrets: readonly string[],
): void {
  // Persist-time secret scrubbing at parity with the initial-run path (runExecution.ts
  // buildWorkflowDeps): the merged manifest carries judge rationales forwarded from the regenerated
  // run, so the live additionalSecrets list must reach the manifest writer here too — otherwise a
  // configured provider secret echoed in a rationale that the security-package builtin patterns do
  // not match would survive into the on-disk merged manifest (Issue #747 defence-in-depth).
  recordQualityIntelligenceRun(buildMergedRunRecord(args), {
    evidenceDir,
    redaction: { additionalSecrets },
  });
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
  recordMergedCandidatesArtifact({
    deps: args.deps,
    evidenceDir: args.evidenceDir,
    newRunId: args.newRunId,
    completedAt: args.completedAt,
    mergedCandidates,
    preservedEditedRevisions: args.preservedEditedRevisions,
  });
  recordMergedManifest(
    args.evidenceDir,
    {
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
    },
    currentRedactionSecrets(args.deps),
  );
}

interface RegeneratedSlice {
  readonly manifest: QiManifest | undefined;
  readonly candidates: readonly QiTestCaseCandidate[];
  readonly completedAt: string;
}

type RegeneratedSliceOutcome =
  | { readonly ok: true; readonly value: RegeneratedSlice }
  | { readonly ok: false; readonly result: RouteResult };

function immediateRegenerationResult(narrowed: NarrowedRegeneration): RouteResult | null {
  if (narrowed.legacyRequirementsFallback) {
    return errorResult(
      409,
      "QI_REGEN_LEGACY_REQUIREMENTS_UNSUPPORTED",
      "This run predates atom-level requirements drift metadata. Start a new QI run against the current requirements sources instead.",
    );
  }
  // Data-loss guard: targeted regeneration must never turn a non-empty run into an empty one. If
  // every candidate is stale yet nothing maps to a regeneratable atom (preserved == 0 AND nothing to
  // regenerate), persisting the merge would silently drop the entire run. This is the catastrophic
  // shape an atom-id scheme drift would take; fail closed with an actionable error instead (Epic
  // #735 drift correctness). The legitimate "some tests orphaned, some preserved" case keeps
  // preserved > 0 and is unaffected.
  if (narrowed.preservedCandidates.length === 0 && narrowed.atomsToRegenerate.length === 0) {
    return errorResult(
      409,
      "QI_REGEN_WOULD_EMPTY",
      "Regenerating the stale tests would remove every test in this run because the current source no longer maps to any of them. Start a fresh QI run against the current source instead.",
    );
  }
  return null;
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
  readonly signal: AbortSignal;
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
    signal: args.signal,
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

function persistRegenerationResult(args: {
  readonly deps: UiHandlerDeps;
  readonly evidenceDir: string;
  readonly newRunId: string;
  readonly requestedAt: string;
  readonly drift: DriftContext;
  readonly narrowed: NarrowedRegeneration;
  readonly profile: PolicyProfile;
  readonly regenerated: RegeneratedSlice;
}): void {
  persistMergedRun({
    deps: args.deps,
    evidenceDir: args.evidenceDir,
    newRunId: args.newRunId,
    requestedAt: args.requestedAt,
    profile: args.profile,
    oldManifest: args.drift.manifest,
    ingestion: args.drift.ingestion,
    preservedCandidates: args.narrowed.preservedCandidates,
    preservedEditedRevisions: args.narrowed.preservedEditedRevisions,
    regeneratedCandidates: args.regenerated.candidates,
    regeneratedManifest: args.regenerated.manifest,
    completedAt: args.regenerated.completedAt,
  });
}

function regenerationSuccessResult(args: {
  readonly newRunId: string;
  readonly regeneratedCount: number;
  readonly preservedCount: number;
}): RouteResult {
  return {
    status: 200,
    body: {
      runId: args.newRunId,
      regeneratedCount: args.regeneratedCount,
      preservedCount: args.preservedCount,
    },
  };
}

async function regenerateFromDrift(args: {
  readonly deps: UiHandlerDeps;
  readonly evidenceDir: string;
  readonly newRunId: string;
  readonly requestedAt: string;
  readonly drift: DriftContext;
  readonly signal: AbortSignal;
}): Promise<RouteResult> {
  const { deps, evidenceDir, newRunId, requestedAt, drift, signal } = args;
  const narrowed = narrowRegeneration(drift);
  const immediate = immediateRegenerationResult(narrowed);
  if (immediate !== null) return immediate;
  const cancelledBeforeRegeneration = cancellationResult(signal);
  if (cancelledBeforeRegeneration !== null) return cancelledBeforeRegeneration;
  const profile = resolveProfile(drift.manifest.policyProfileIds[0]);
  const regenerated = await regenerateCandidateSlice({
    deps,
    newRunId,
    requestedAt,
    drift,
    narrowed,
    profile,
    signal,
  });
  if (!regenerated.ok) return regenerated.result;
  const cancelledBeforePersist = cancellationResult(signal);
  if (cancelledBeforePersist !== null) return cancelledBeforePersist;
  const budgetError = assertMergedCandidateBudget(
    narrowed.preservedCandidates,
    regenerated.value.candidates,
  );
  if (budgetError !== null) return budgetError;
  persistRegenerationResult({
    deps,
    evidenceDir,
    newRunId,
    requestedAt,
    drift,
    narrowed,
    profile,
    regenerated: regenerated.value,
  });
  return regenerationSuccessResult({
    newRunId,
    regeneratedCount: regenerated.value.candidates.length,
    preservedCount: narrowed.preservedCandidates.length,
  });
}

export async function handleQiReCheck(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const { id } = ctx.params;
  if (id === undefined || id.trim().length === 0) {
    return errorResult(400, "QI_BAD_REQUEST", "Run id is required.");
  }
  const invalidId = invalidRunIdFormat(id);
  if (invalidId !== null) return invalidId;
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
  const invalidId = invalidRunIdFormat(id);
  if (invalidId !== null) return invalidId;
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined) {
    return errorResult(500, "QI_NO_EVIDENCE_DIR", "The evidence directory is not configured.");
  }
  const newRunId = `qi-run-${randomUUID()}`;
  const requestedAt = new Date().toISOString();
  const abortScope = requestAbortSignal(ctx);
  try {
    const drift = await computeDrift(ctx.req, evidenceDir, id, newRunId, deps);
    if (!drift.ok) return drift.result;
    return await regenerateFromDrift({
      deps,
      evidenceDir,
      newRunId,
      requestedAt,
      drift: drift.value,
      signal: abortScope.signal,
    });
  } catch {
    return errorResult(500, "QI_REGEN_FAILED", "Failed to regenerate stale candidates.");
  } finally {
    abortScope.dispose();
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
