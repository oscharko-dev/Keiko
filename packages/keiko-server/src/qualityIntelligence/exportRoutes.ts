// Quality Intelligence export BFF route (Epic #270, Issue #283 + #711).
//
//   * POST /api/quality-intelligence/runs/:id/export — serialise a run's candidates for export
//
// Local formats (csv / spreadsheet-safe-csv / json / markdown / plain-text) return the serialised
// body for a same-origin download — no external credentials. Binary formats (pdf / zip-bundle) are
// assembled server-side and returned as base64 in the JSON envelope. External TMS adapters
// (jira / qtest / xray / polarion / alm / quality-center) are DISABLED for actual writes: they
// only return a dry-run preview, require approved candidates, and never perform an outbound call.
// The candidate bodies were already redacted at persist time; the bundle attests redaction so the
// contract invariant holds. Path-/formula-safety lives in the pure adapters.

import type { IncomingMessage } from "node:http";
import {
  QualityIntelligence,
  sortedStrings,
  type QualityIntelligence as QI,
} from "@oscharko-dev/keiko-contracts";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { QualityIntelligenceExport } from "@oscharko-dev/keiko-quality-intelligence";
import {
  appendQualityIntelligenceExportRow,
  EvidenceReadError,
  loadQualityIntelligenceRun,
  loadQualityIntelligenceCandidates,
  qualityIntelligenceCandidatesArtifactContentHash,
  type QualityIntelligenceCandidateRow,
  type QualityIntelligenceEvidenceManifest,
  type QualityIntelligenceExportRow,
} from "@oscharko-dev/keiko-evidence";
import type { RouteContext, RouteResult, RouteDefinition } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  QualityIntelligenceReviewIntegrityError,
  loadRunReviewState,
  candidateReviewStateOf,
  runReviewStateOf,
} from "./reviewStore.js";
import { assemblePdf, assembleZipBundle } from "./exportAssembly.js";

type Adapter = QI.QualityIntelligenceExportAdapter;

/** Binary-only export modes handled at the route level, not in the domain adapter union. */
type BinaryMode = "pdf" | "zip-bundle";

const ADAPTERS: ReadonlySet<string> = new Set<string>([
  ...QualityIntelligence.QUALITY_INTELLIGENCE_EXPORT_ADAPTERS,
  "pdf",
  "zip-bundle",
]);
const MAX_BODY_BYTES = 16 * 1024;

const LOCAL_META: Readonly<Record<string, { contentType: string; ext: string }>> = {
  csv: { contentType: "text/csv", ext: "csv" },
  "spreadsheet-safe-csv": { contentType: "text/csv", ext: "csv" },
  json: { contentType: "application/json", ext: "json" },
  markdown: { contentType: "text/markdown", ext: "md" },
  "plain-text": { contentType: "text/plain", ext: "txt" },
  // NOTE: no "quality-center" entry — it is a TMS adapter, so a non-dry-run request is rejected with
  // 403 before LOCAL_META is consulted, and the dry-run path returns a preview object that never
  // reads LOCAL_META. The `?? { text/plain, txt }` fallback at the materialised-response site covers
  // any future non-TMS text adapter.
  pdf: { contentType: "application/pdf", ext: "pdf" },
  "zip-bundle": { contentType: "application/zip", ext: "zip" },
};

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

function rowToCandidate(
  row: QualityIntelligenceCandidateRow,
  runId: QI.QualityIntelligenceRunId,
): QI.QualityIntelligenceTestCaseCandidate {
  return {
    id: QualityIntelligence.asQualityIntelligenceTestCaseId(row.id),
    runId,
    derivedFromAtomIds: row.derivedFromAtomIds.map((a) =>
      QualityIntelligence.asQualityIntelligenceEvidenceAtomId(a),
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

type ExportModelProvenance = QI.QualityIntelligenceExportModelProvenance;

const UNKNOWN_MODEL_METADATA = "unknown";

function modelStage(modelId: string | undefined): QI.QualityIntelligenceExportModelStageProvenance {
  return {
    modelId: modelId?.trim() ? modelId : UNKNOWN_MODEL_METADATA,
    provider: UNKNOWN_MODEL_METADATA,
    revision: UNKNOWN_MODEL_METADATA,
  };
}

// eslint-disable-next-line complexity
function buildModelProvenance(
  manifest: QualityIntelligenceEvidenceManifest,
): ExportModelProvenance {
  const generationModelId =
    manifest.modelRouting?.resolved.testDesignModelId ??
    manifest.modelRouting?.preflight.generation?.modelId ??
    manifest.modelId;
  const judgeModelId =
    manifest.modelRouting?.resolved.judgeModelId ?? manifest.modelRouting?.preflight.judge?.modelId;
  return {
    generation: modelStage(generationModelId),
    judge: modelStage(judgeModelId),
    ...(manifest.seedUsed !== undefined ? { seedUsed: manifest.seedUsed } : {}),
    ...(manifest.modelParameters !== undefined
      ? { modelParameters: manifest.modelParameters }
      : {}),
  };
}

function coverageRefFor(runId: string, atomId: string): QI.QualityIntelligenceCoverageMapId {
  return QualityIntelligence.asQualityIntelligenceCoverageMapId(
    `qi-coverage-${sha256Hex(`${runId}|${atomId}`).slice(0, 32)}`,
  );
}

function findingRefFor(
  finding: QualityIntelligenceEvidenceManifest["findings"][number],
  diagnostics: Set<string>,
): QI.QualityIntelligenceValidationFindingId | undefined {
  try {
    return QualityIntelligence.asQualityIntelligenceValidationFindingId(finding.id);
  } catch {
    diagnostics.add("export:finding-ref-invalid-id");
    return undefined;
  }
}

function addMapValue<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const values = map.get(key) ?? new Set<V>();
  values.add(value);
  map.set(key, values);
}

function sortedValues<T extends string>(set: ReadonlySet<T> | undefined): readonly T[] {
  return Object.freeze([...(set ?? new Set<T>())].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

function buildCoverageRefsByCandidate(
  runId: string,
  manifest: QualityIntelligenceEvidenceManifest,
  candidateIds: ReadonlySet<string>,
  diagnostics: Set<string>,
): ReadonlyMap<string, ReadonlySet<QI.QualityIntelligenceCoverageMapId>> {
  const refs = new Map<string, Set<QI.QualityIntelligenceCoverageMapId>>();
  if (manifest.coverageMatrix === undefined) {
    diagnostics.add("export:coverage-map-refs-unavailable");
    return refs;
  }
  if (manifest.coverageMatrix.length === 0) {
    diagnostics.add("export:coverage-map-refs-empty");
    return refs;
  }
  for (const row of manifest.coverageMatrix) {
    const coverageRef = coverageRefFor(runId, row.atomId);
    for (const candidateId of row.coveringCandidateIds) {
      if (candidateIds.has(candidateId)) {
        addMapValue(refs, candidateId, coverageRef);
      }
    }
  }
  return refs;
}

/** Maps each evidence atom id to the candidate ids derived from it or covering it. */
function buildCandidateIdsByAtom(
  manifest: QualityIntelligenceEvidenceManifest,
  candidates: readonly QI.QualityIntelligenceTestCaseCandidate[],
  candidateIds: ReadonlySet<string>,
): ReadonlyMap<string, Set<string>> {
  const byAtom = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    for (const atomId of candidate.derivedFromAtomIds) {
      addMapValue(byAtom, atomId, candidate.id);
    }
  }
  for (const row of manifest.coverageMatrix ?? []) {
    for (const candidateId of row.coveringCandidateIds) {
      if (candidateIds.has(candidateId)) {
        addMapValue(byAtom, row.atomId, candidateId);
      }
    }
  }
  return byAtom;
}

/** Resolves the candidate ids a finding links to, via its direct candidateId and its atoms. */
function findingTargetCandidateIds(
  finding: QualityIntelligenceEvidenceManifest["findings"][number],
  candidateIds: ReadonlySet<string>,
  candidateIdsByAtom: ReadonlyMap<string, Set<string>>,
  diagnostics: Set<string>,
): Set<string> {
  const targetCandidateIds = new Set<string>();
  if (finding.candidateId !== undefined) {
    if (candidateIds.has(finding.candidateId)) {
      targetCandidateIds.add(finding.candidateId);
    } else {
      diagnostics.add("export:finding-ref-candidate-missing");
    }
  }
  for (const atomId of finding.evidenceAtomIds ?? []) {
    for (const candidateId of candidateIdsByAtom.get(atomId) ?? []) {
      targetCandidateIds.add(candidateId);
    }
  }
  return targetCandidateIds;
}

function buildFindingRefsByCandidate(
  manifest: QualityIntelligenceEvidenceManifest,
  candidates: readonly QI.QualityIntelligenceTestCaseCandidate[],
  diagnostics: Set<string>,
): ReadonlyMap<string, ReadonlySet<QI.QualityIntelligenceValidationFindingId>> {
  const refs = new Map<string, Set<QI.QualityIntelligenceValidationFindingId>>();
  const candidateIds = new Set<string>(candidates.map((candidate) => candidate.id));
  const candidateIdsByAtom = buildCandidateIdsByAtom(manifest, candidates, candidateIds);
  for (const finding of manifest.findings) {
    const targetCandidateIds = findingTargetCandidateIds(
      finding,
      candidateIds,
      candidateIdsByAtom,
      diagnostics,
    );
    if (targetCandidateIds.size === 0) {
      diagnostics.add("export:finding-ref-unlinked");
      continue;
    }
    const findingRef = findingRefFor(finding, diagnostics);
    if (findingRef === undefined) {
      continue;
    }
    for (const candidateId of targetCandidateIds) {
      addMapValue(refs, candidateId, findingRef);
    }
  }
  return refs;
}

function integrityPayloadForCandidate(candidate: QI.QualityIntelligenceTestCaseCandidate): unknown {
  return {
    id: candidate.id,
    runId: candidate.runId,
    derivedFromAtomIds: [...candidate.derivedFromAtomIds].sort(),
    title: candidate.title,
    preconditions: candidate.preconditions,
    steps: candidate.steps,
    expectedResults: candidate.expectedResults,
    priority: candidate.priority,
    riskClass: candidate.riskClass,
    tags: [...candidate.tags].sort(),
    status: candidate.status,
  };
}

// eslint-disable-next-line max-lines-per-function
function buildBundle(
  runId: string,
  adapter: Adapter,
  candidates: readonly QI.QualityIntelligenceTestCaseCandidate[],
  createdAt: string,
  manifest: QualityIntelligenceEvidenceManifest,
  candidateArtifactHashSha256Hex: string,
): QI.QualityIntelligenceExportBundle {
  const diagnostics = new Set<string>();
  const candidateIds = new Set<string>(candidates.map((candidate) => candidate.id));
  const coverageRefsByCandidate = buildCoverageRefsByCandidate(
    runId,
    manifest,
    candidateIds,
    diagnostics,
  );
  const findingRefsByCandidate = buildFindingRefsByCandidate(manifest, candidates, diagnostics);
  const contents = candidates.map((candidate) => {
    const coverageMapRefs = sortedValues(coverageRefsByCandidate.get(candidate.id));
    const findingRefs = sortedValues(findingRefsByCandidate.get(candidate.id));
    if (manifest.coverageMatrix !== undefined && manifest.coverageMatrix.length > 0) {
      if (coverageMapRefs.length === 0) diagnostics.add("export:coverage-map-refs-missing");
    }
    if (manifest.findings.length > 0 && findingRefs.length === 0) {
      diagnostics.add("export:finding-refs-missing");
    }
    return {
      candidateId: candidate.id,
      coverageMapRefs,
      findingRefs,
    };
  });
  const redactionAttested = manifest.redactionSummary.totalStringsScanned > 0;
  if (!redactionAttested) {
    diagnostics.add("export:redaction-attestation-missing");
  }
  const modelProvenance = buildModelProvenance(manifest);
  const diagnosticsList = [...diagnostics].sort();
  const integrity = sha256Hex(
    canonicalise({
      runId,
      targetAdapter: adapter,
      redactionAttested,
      candidateArtifactHashSha256Hex,
      diagnostics: diagnosticsList,
      modelProvenance,
      contents: contents
        .map((entry) => ({
          candidateId: entry.candidateId,
          coverageMapRefs: [...entry.coverageMapRefs].sort(),
          findingRefs: [...entry.findingRefs].sort(),
        }))
        .sort((a, b) =>
          a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0,
        ),
      candidates: candidates.map(integrityPayloadForCandidate).sort((a, b) => {
        const left = (a as { id: string }).id;
        const right = (b as { id: string }).id;
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    }),
  );
  return {
    id: QualityIntelligence.asQualityIntelligenceExportBundleId(
      `qi-export-${sha256Hex(`${runId}|${adapter}`).slice(0, 24)}`,
    ),
    runId: QualityIntelligence.asQualityIntelligenceRunId(runId),
    targetAdapter: adapter,
    createdAt,
    integrityHashSha256Hex: integrity,
    redactionAttested,
    contents,
    ...(diagnosticsList.length > 0 ? { diagnostics: diagnosticsList } : {}),
    modelProvenance,
  };
}

interface ExportRequest {
  readonly adapter: Adapter | BinaryMode;
  readonly dryRun: boolean;
  readonly approvedOnly: boolean;
}

interface ExportResponse {
  readonly result: RouteResult;
  /** The export-evidence row to append; present only when the response is a 200 export action. */
  readonly evidence?: QualityIntelligenceExportRow;
}

let exportEvidenceSequence = 0;

function nextExportEvidenceId(
  runId: string,
  target: Adapter | BinaryMode,
  dryRun: boolean,
  createdAt: string,
  integrityHash: string,
): string {
  exportEvidenceSequence += 1;
  return `qi-export-${sha256Hex(
    `${runId}|${target}|${dryRun ? "dry-run" : "artifact"}|${createdAt}|${integrityHash}|${String(
      exportEvidenceSequence,
    )}`,
  ).slice(0, 24)}`;
}

/**
 * Build the export-evidence row for an export action (Issue #283, AC4). Records the target type,
 * a concrete action/artifact id, an integrity hash over the returned artifact or preview, the
 * redaction attestation, model provenance when known, and whether the action was a dry-run.
 */
function buildExportEvidenceRow(
  runId: string,
  target: Adapter | BinaryMode,
  dryRun: boolean,
  createdAt: string,
  integrityHash: string,
  redactionAttested: boolean,
  modelProvenance: ExportModelProvenance | undefined,
): QualityIntelligenceExportRow {
  return {
    id: nextExportEvidenceId(runId, target, dryRun, createdAt, integrityHash),
    targetAdapter: target,
    integrityHash,
    redactionAttested,
    createdAt,
    ...(modelProvenance !== undefined ? { modelProvenance } : {}),
    dryRun,
  };
}

/**
 * Best-effort append of an export-evidence row for a 200 export action (Issue #283, AC4). A failed
 * audit write must NOT withhold an already-computed local export from the user: the artifact has no
 * external side effect, the run already exists on disk, and the manifest write is atomic so this path
 * is rare. Return a warning on failure rather than turning a successful export into a 500. No-op
 * for error responses and for the disabled external-TMS path (which produces no artifact).
 */
function recordExportEvidence(
  runId: string,
  outcome: ExportResponse,
  evidenceDir: string,
): readonly string[] {
  if (outcome.evidence === undefined || outcome.result.status !== 200) {
    return [];
  }
  try {
    appendQualityIntelligenceExportRow({ runId, export: outcome.evidence }, { evidenceDir });
    return [];
  } catch {
    return ["export:evidence-write-failed"];
  }
}

function parseExportBody(body: Record<string, unknown>): ExportRequest | undefined {
  const adapter = body.adapter;
  if (typeof adapter !== "string" || !ADAPTERS.has(adapter)) return undefined;
  return {
    adapter: adapter as Adapter | BinaryMode,
    dryRun: body.dryRun === true,
    approvedOnly: body.approvedOnly === true,
  };
}

function selectRows(
  rows: readonly QualityIntelligenceCandidateRow[],
  approvedOnly: boolean,
  runId: string,
  evidenceDir: string,
): readonly QualityIntelligenceCandidateRow[] {
  if (!approvedOnly) return rows;
  const review = loadRunReviewState(runId, evidenceDir);
  // FIX E (Issue #282) — a reviewer can approve the whole RUN instead of each candidate. A
  // run-level approval is an explicit approval of every candidate, so it satisfies approvedOnly
  // (incl. the TMS adapters that force it). Otherwise fall back to the per-candidate filter.
  if (runReviewStateOf(review) === "approved") return rows;
  return rows.filter((r) => candidateReviewStateOf(review, r.id) === "approved");
}

function isDeliverableQualityRow(row: QualityIntelligenceCandidateRow): boolean {
  return row.status !== "needs-review" && row.qualityVerdict?.verdict !== "weak";
}

type ExportOutcome =
  | { readonly ok: true; readonly request: ExportRequest }
  | { readonly ok: false; readonly result: RouteResult };

function resultWithWarnings(result: RouteResult, warnings: readonly string[]): RouteResult {
  if (warnings.length === 0 || !isObject(result.body)) {
    return result;
  }
  const existing = Array.isArray(result.body.warnings)
    ? result.body.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  return {
    ...result,
    body: {
      ...result.body,
      warnings: sortedStrings(new Set([...existing, ...warnings])),
    },
  };
}

async function readExportRequest(req: IncomingMessage): Promise<ExportOutcome> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return {
      ok: false,
      result: errorResult(413, "QI_BODY_TOO_LARGE", "Export body is too large."),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "Export body is not valid JSON."),
    };
  }
  if (!isObject(parsed)) {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "Export body must be an object."),
    };
  }
  const request = parseExportBody(parsed);
  if (request === undefined) {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_ADAPTER", "A valid export adapter is required."),
    };
  }
  return { ok: true, request };
}

// Loads and integrity-validates the candidate artifact for export. Returns a typed error result on
// tamper/empty so handleQiExport stays under the LOC bound.
function loadExportableArtifact(
  id: string,
  evidenceDir: string,
):
  | { readonly artifact: NonNullable<ReturnType<typeof loadQualityIntelligenceCandidates>> }
  | { readonly error: RouteResult } {
  let artifact: ReturnType<typeof loadQualityIntelligenceCandidates>;
  try {
    artifact = loadQualityIntelligenceCandidates(id, { evidenceDir });
  } catch (error) {
    if (error instanceof EvidenceReadError) {
      return {
        error: errorResult(
          409,
          "QI_CANDIDATES_TAMPERED",
          "The candidate artifact failed integrity validation.",
        ),
      };
    }
    throw error;
  }
  if (artifact === undefined || artifact.candidates.length === 0) {
    return {
      error: errorResult(409, "QI_NO_CANDIDATES", "This run has no candidates to export."),
    };
  }
  return { artifact };
}

export async function handleQiExport(ctx: RouteContext, deps: UiHandlerDeps): Promise<RouteResult> {
  const { id } = ctx.params;
  if (id === undefined || id.trim().length === 0) {
    return errorResult(400, "QI_BAD_REQUEST", "Run id is required.");
  }
  const evidenceDir = deps.evidenceDir;
  if (evidenceDir === undefined) {
    return errorResult(500, "QI_NO_EVIDENCE_DIR", "The evidence directory is not configured.");
  }
  const parsed = await readExportRequest(ctx.req);
  if (!parsed.ok) return parsed.result;
  try {
    const manifest = loadQualityIntelligenceRun(id, { evidenceDir });
    if (manifest === undefined) {
      return errorResult(404, "QI_NOT_FOUND", "Quality Intelligence run not found.");
    }
    const loaded = loadExportableArtifact(id, evidenceDir);
    if ("error" in loaded) return loaded.error;
    const artifact = loaded.artifact;
    const outcome = serialiseExport(
      id,
      parsed.request,
      artifact.candidates,
      manifest,
      evidenceDir,
      qualityIntelligenceCandidatesArtifactContentHash(artifact),
    );
    // Emit audit evidence for every materialised export or dry-run preview (Issue #283, AC4). The
    // append is best-effort and must not turn a successful export into a 500 — see recordExportEvidence.
    const evidenceWarnings = recordExportEvidence(id, outcome, evidenceDir);
    return resultWithWarnings(outcome.result, evidenceWarnings);
  } catch (error) {
    if (error instanceof QualityIntelligenceReviewIntegrityError) {
      return errorResult(
        409,
        "QI_REVIEW_TAMPERED",
        "The review artifact failed integrity validation.",
      );
    }
    return errorResult(500, "QI_EXPORT_FAILED", "Failed to build the export.");
  }
}

// eslint-disable-next-line max-lines-per-function
function binaryResponse(
  runId: string,
  mode: BinaryMode,
  rows: readonly QualityIntelligenceCandidateRow[],
  manifest: QualityIntelligenceEvidenceManifest,
  candidateArtifactHashSha256Hex: string,
): ExportResponse {
  const brandedRunId = QualityIntelligence.asQualityIntelligenceRunId(runId);
  const candidates = rows.map((r) => rowToCandidate(r, brandedRunId));
  const createdAt = new Date().toISOString();
  const meta = LOCAL_META[mode] ?? { contentType: "application/octet-stream", ext: "bin" };
  const warnings = new Set<string>();
  let bytes: Uint8Array;
  if (mode === "pdf") {
    const bundle = buildBundle(
      runId,
      "plain-text",
      candidates,
      createdAt,
      manifest,
      candidateArtifactHashSha256Hex,
    );
    for (const warning of bundle.diagnostics ?? []) warnings.add(warning);
    const serialized = QualityIntelligenceExport.serializeExportBundle(bundle, candidates);
    bytes = assemblePdf(serialized.body, runId);
  } else {
    const enc = new TextEncoder();
    // Only timestamp-free serializers go into the bundle so the ZIP is byte-deterministic (its
    // integrity feeds the Living-Tests drift epic #735). JSON is intentionally excluded: its body
    // embeds the export `createdAt`, so a JSON-in-ZIP would differ on every export. JSON stays
    // available as a standalone export.
    const formats: readonly Adapter[] = ["csv", "markdown", "plain-text"];
    const entries = formats.map((fmt) => {
      const bundle = buildBundle(
        runId,
        fmt,
        candidates,
        createdAt,
        manifest,
        candidateArtifactHashSha256Hex,
      );
      for (const warning of bundle.diagnostics ?? []) warnings.add(warning);
      const serialized = QualityIntelligenceExport.serializeExportBundle(bundle, candidates);
      const ext = LOCAL_META[fmt]?.ext ?? "txt";
      return { name: `${runId}.${ext}`, bytes: enc.encode(serialized.body) };
    });
    bytes = assembleZipBundle(entries);
  }
  const bodyBase64 = Buffer.from(bytes).toString("base64");
  const modelProvenance = buildModelProvenance(manifest);
  const redactionAttested = manifest.redactionSummary.totalStringsScanned > 0;
  return {
    result: {
      status: 200,
      body: {
        dryRun: false,
        adapter: mode,
        filename: `${runId}.${meta.ext}`,
        contentType: meta.contentType,
        byteLen: bytes.length,
        encoding: "base64" as const,
        body: bodyBase64,
        ...(warnings.size > 0 ? { warnings: sortedStrings(warnings) } : {}),
      },
    },
    evidence: buildExportEvidenceRow(
      runId,
      mode,
      false,
      createdAt,
      sha256Hex(bodyBase64),
      redactionAttested,
      modelProvenance,
    ),
  };
}

// eslint-disable-next-line max-lines-per-function
function serialisedResponse(
  runId: string,
  request: ExportRequest,
  rows: readonly QualityIntelligenceCandidateRow[],
  manifest: QualityIntelligenceEvidenceManifest,
  candidateArtifactHashSha256Hex: string,
): ExportResponse {
  const adapter = request.adapter;
  if (adapter === "pdf" || adapter === "zip-bundle") {
    return binaryResponse(runId, adapter, rows, manifest, candidateArtifactHashSha256Hex);
  }
  const brandedRunId = QualityIntelligence.asQualityIntelligenceRunId(runId);
  const candidates = rows.map((r) => rowToCandidate(r, brandedRunId));
  const createdAt = new Date().toISOString();
  const bundle = buildBundle(
    runId,
    adapter,
    candidates,
    createdAt,
    manifest,
    candidateArtifactHashSha256Hex,
  );
  const serialized = QualityIntelligenceExport.serializeExportBundle(bundle, candidates);
  const warnings = bundle.diagnostics ?? [];
  if (request.dryRun) {
    return {
      result: {
        status: 200,
        body: {
          dryRun: true,
          adapter,
          candidateCount: rows.length,
          byteLen: serialized.byteLen,
          preview: serialized.body.slice(0, 1200),
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      },
      evidence: buildExportEvidenceRow(
        runId,
        adapter,
        true,
        createdAt,
        sha256Hex(serialized.body),
        bundle.redactionAttested,
        bundle.modelProvenance,
      ),
    };
  }
  const meta = LOCAL_META[adapter] ?? { contentType: "text/plain", ext: "txt" };
  const body =
    meta.contentType === "text/csv"
      ? QualityIntelligenceExport.toExcelFriendlyCsv(serialized.body)
      : serialized.body;
  return {
    result: {
      status: 200,
      body: {
        dryRun: false,
        adapter,
        filename: `${runId}.${meta.ext}`,
        contentType: meta.contentType,
        byteLen: Buffer.byteLength(body, "utf8"),
        body,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    },
    evidence: buildExportEvidenceRow(
      runId,
      adapter,
      false,
      createdAt,
      sha256Hex(body),
      bundle.redactionAttested,
      bundle.modelProvenance,
    ),
  };
}

function serialiseExport(
  runId: string,
  request: ExportRequest,
  allRows: readonly QualityIntelligenceCandidateRow[],
  manifest: QualityIntelligenceEvidenceManifest,
  evidenceDir: string,
  candidateArtifactHashSha256Hex: string,
): ExportResponse {
  const adapter = request.adapter;
  const isBinary = adapter === "pdf" || adapter === "zip-bundle";
  const isTms = !isBinary && QualityIntelligence.QUALITY_INTELLIGENCE_TMS_ADAPTERS.has(adapter);
  const approvedOnly = isTms ? true : request.approvedOnly;
  const rows = selectRows(allRows, approvedOnly, runId, evidenceDir).filter(
    isDeliverableQualityRow,
  );
  if (rows.length === 0) {
    return {
      result: errorResult(
        409,
        "QI_NOTHING_TO_EXPORT",
        approvedOnly
          ? "No approved candidates to export."
          : "No exportable candidates passed the quality gate.",
      ),
    };
  }
  if (isTms && !request.dryRun) {
    // External TMS write is disabled — no artifact is produced, so no export-evidence row is
    // recorded for this rejected action.
    return {
      result: errorResult(
        403,
        "QI_EXTERNAL_EXPORT_DISABLED",
        "External TMS export is disabled. Configure the connector and use a dry-run preview.",
      ),
    };
  }
  return serialisedResponse(runId, request, rows, manifest, candidateArtifactHashSha256Hex);
}

export const QI_EXPORT_ROUTE_GROUP: readonly RouteDefinition[] = [
  { method: "POST", pattern: "/api/quality-intelligence/runs/:id/export", handler: handleQiExport },
];
