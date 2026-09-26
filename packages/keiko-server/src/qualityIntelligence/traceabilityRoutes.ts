// Quality Intelligence requirement↔test traceability export route (Epic #734, Issue #740).
//
//   * POST /api/quality-intelligence/runs/:id/traceability — export the persisted coverage matrix
//     as an audit-ready requirement↔test traceability matrix (CSV or Markdown).
//
// A dedicated route (not folded into the generic export route) so the matrix-driven serializer,
// which needs the coverage matrix rather than the candidate bodies, stays self-contained. The
// matrix carries refs + status plus an optional already-redacted requirement excerpt (#790); the
// reverse direction is enriched with the run's redacted candidate titles when the candidate
// artifact is loadable. The serializers are deterministic and formula-injection safe.

import type { IncomingMessage } from "node:http";
import { sortedStrings } from "@oscharko-dev/keiko-contracts/runtime/stable-order";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import {
  appendQualityIntelligenceExportRow,
  loadQualityIntelligenceCandidates,
  loadQualityIntelligenceRun,
  type QualityIntelligenceEvidenceManifest,
  type QualityIntelligenceExportRow,
  type QualityIntelligenceCandidateRow,
  type QualityIntelligenceTraceabilityExportMode,
} from "@oscharko-dev/keiko-evidence";
import { QualityIntelligenceExport } from "@oscharko-dev/keiko-quality-intelligence";
import type { RouteContext, RouteResult, RouteDefinition } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  candidateReviewStateOf,
  loadRunReviewState,
  QualityIntelligenceReviewIntegrityError,
  runReviewStateOf,
} from "./reviewStore.js";
import { buildQualityIntelligenceExportProvenance } from "./exportProvenance.js";
import { isDeliverableQualityRow } from "./candidateDeliverability.js";

const MAX_BODY_BYTES = 4 * 1024;

type Format = "csv" | "markdown";

const FORMAT_META: Readonly<Record<Format, { contentType: string; ext: string }>> = {
  csv: { contentType: "text/csv", ext: "csv" },
  markdown: { contentType: "text/markdown", ext: "md" },
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

interface TraceabilityRequest {
  readonly format: Format;
  /** Restrict the exported matrix to APPROVED test cases (mirrors the generic export route). */
  readonly approvedOnly: boolean;
}

type RequestOutcome =
  | { readonly ok: true; readonly request: TraceabilityRequest }
  | { readonly ok: false; readonly result: RouteResult };

// `approvedOnly` is a scope claim the user acts on, so an ill-typed value must NOT be coerced to
// "export everything": a caller that meant to narrow the scope and mistyped the flag would silently
// receive unapproved test cases. Absent is the documented full-matrix default; present-but-not-boolean
// is a client bug and fails closed with a 400.
function parseApprovedOnly(value: unknown): boolean | undefined {
  if (value === undefined) return false;
  return typeof value === "boolean" ? value : undefined;
}

function parseFormatField(value: unknown): Format | undefined {
  if (value === undefined) return "csv";
  return value === "csv" || value === "markdown" ? value : undefined;
}

type BodyOutcome =
  // `fields: undefined` = no body at all; the caller applies the documented defaults.
  | { readonly ok: true; readonly fields: Record<string, unknown> | undefined }
  | { readonly ok: false; readonly result: RouteResult };

// Read the optional JSON body into a plain object. Oversized and malformed payloads fail explicitly
// so a caller can fix a bad request rather than silently receiving default scope and format.
async function readTraceabilityBody(req: IncomingMessage): Promise<BodyOutcome> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return {
      ok: false,
      result: errorResult(413, "QI_BODY_TOO_LARGE", "Traceability export body is too large."),
    };
  }
  if (raw.trim().length === 0) return { ok: true, fields: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "Traceability export body is not valid JSON."),
    };
  }
  if (!isObject(parsed)) {
    return {
      ok: false,
      result: errorResult(400, "QI_BAD_REQUEST", "Traceability export body must be an object."),
    };
  }
  return { ok: true, fields: parsed };
}

// Validate the parsed body; empty/no body defaults to an unscoped CSV export.
async function parseTraceabilityRequest(req: IncomingMessage): Promise<RequestOutcome> {
  const body = await readTraceabilityBody(req);
  if (!body.ok) return { ok: false, result: body.result };
  if (body.fields === undefined) {
    return { ok: true, request: { format: "csv", approvedOnly: false } };
  }
  const parsed = body.fields;
  const format = parseFormatField(parsed.format);
  if (format === undefined) {
    return {
      ok: false,
      result: errorResult(
        400,
        "QI_BAD_FORMAT",
        "Traceability export format must be csv or markdown.",
      ),
    };
  }
  const approvedOnly = parseApprovedOnly(parsed.approvedOnly);
  if (approvedOnly === undefined) {
    return {
      ok: false,
      result: errorResult(
        400,
        "QI_BAD_REQUEST",
        "Traceability export approvedOnly must be a boolean.",
      ),
    };
  }
  return { ok: true, request: { format, approvedOnly } };
}

type TraceabilityRows = Parameters<typeof QualityIntelligenceExport.adaptToTraceabilityCsv>[0];

// Project persisted matrix rows onto adapter rows; the redacted excerpt (#790) is optional and
// absent on runs recorded before it existed.
function toTraceabilityRows(
  matrix: NonNullable<NonNullable<ReturnType<typeof loadQualityIntelligenceRun>>["coverageMatrix"]>,
): TraceabilityRows {
  return matrix.map((r) => ({
    atomId: r.atomId,
    status: r.status,
    confidence: r.confidence,
    coveringCandidateIds: r.coveringCandidateIds,
    ...(r.requirementExcerptRedacted !== undefined
      ? { requirementExcerptRedacted: r.requirementExcerptRedacted }
      : {}),
  }));
}

/**
 * The set of test ids an approved-only traceability export may contain (0.3.0 release audit).
 *
 * Mirrors `selectRows` in exportRoutes.ts so both export surfaces answer "is this test approved?"
 * identically: a run-level approval is an explicit approval of every test, otherwise each test must
 * carry its own `approved` state. NOT best-effort — `loadRunReviewState` throws on a tampered review
 * audit log and that must propagate, because falling back to "everything is approved" is exactly the
 * failure this scope exists to prevent.
 */
function approvedTestIdsFor(
  id: string,
  evidenceDir: string,
  rows: TraceabilityRows,
): ReadonlySet<string> {
  const review = loadRunReviewState(id, evidenceDir);
  const cited = new Set<string>();
  for (const row of rows) {
    for (const candidateId of row.coveringCandidateIds) cited.add(candidateId);
  }
  if (runReviewStateOf(review) === "approved") return cited;
  const approved = new Set<string>();
  for (const candidateId of cited) {
    if (candidateReviewStateOf(review, candidateId) === "approved") approved.add(candidateId);
  }
  return approved;
}

// Candidate id -> redacted title for the tests->requirements direction (#790). Best-effort: a
// missing/unreadable candidate artifact only drops the titles, never the export.
function candidateTitlesFor(id: string, evidenceDir: string): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  try {
    const artifact = loadQualityIntelligenceCandidates(id, { evidenceDir });
    for (const candidate of artifact?.candidates ?? []) {
      titles.set(candidate.id, candidate.title);
    }
  } catch {
    // Titles are a display enrichment; the matrix itself is loaded and validated separately.
  }
  return titles;
}

let traceabilityExportEvidenceSequence = 0;

/**
 * Best-effort append of an export-evidence row after a successful traceability matrix download
 * (Epic #734, Issue #740). A failed audit write must NOT withhold the already-computed body from
 * the caller: the matrix is deterministic, has no external side effect, and the manifest write is
 * atomic so failures are rare. Return a warning on failure rather than turning a 200 into a 500.
 */
function recordTraceabilityExportEvidence(
  id: string,
  target: QualityIntelligenceTraceabilityExportMode,
  body: string,
  manifest: QualityIntelligenceEvidenceManifest,
  evidenceDir: string,
  approvedOnly: boolean,
): readonly string[] {
  const createdAt = new Date().toISOString();
  const integrityHash = sha256Hex(body);
  const provenance = buildQualityIntelligenceExportProvenance(manifest);
  traceabilityExportEvidenceSequence += 1;
  const row: QualityIntelligenceExportRow = {
    id: `qi-export-${sha256Hex(
      `${id}|${target}|${createdAt}|${integrityHash}|${String(traceabilityExportEvidenceSequence)}`,
    ).slice(0, 24)}`,
    targetAdapter: target,
    integrityHash,
    redactionAttested: manifest.redactionSummary.totalStringsScanned > 0,
    createdAt,
    modelProvenance: provenance.model,
    policyProvenance: provenance.policy,
    dryRun: false,
    // The scope is part of what this artifact claims: without it the audit trail cannot tell an
    // approved-only compliance download from a full diagnostic one.
    approvedOnly,
  };
  try {
    appendQualityIntelligenceExportRow({ runId: id, export: row }, { evidenceDir });
    return [];
  } catch {
    return ["export:evidence-write-failed"];
  }
}

type ScopedRowsOutcome =
  | {
      readonly ok: true;
      readonly rows: TraceabilityRows;
      readonly omittedByQualityGate: number;
    }
  | { readonly ok: false; readonly result: RouteResult };

function loadDeliverableCandidateIds(
  id: string,
  evidenceDir: string,
): readonly QualityIntelligenceCandidateRow[] | undefined {
  const review = loadRunReviewState(id, evidenceDir);
  return loadQualityIntelligenceCandidates(id, { evidenceDir })?.candidates.filter((candidate) =>
    isDeliverableQualityRow(candidate, review),
  );
}

// PR-review follow-up (Codex thread 3772030500): count the covering-candidate ids that the
// deliverability gate drops from the matrix. The set is derived from the ORIGINAL rows the
// user asked to export so the omission surfaces to the client even when the caller runs the
// compliance-shaped path (approvedOnly=false) — matching the omittedByQualityGate signal the
// generic candidate/TMS route already publishes.
function countCoveringIdsOmittedByGate(
  rows: TraceabilityRows,
  permittedIds: ReadonlySet<string>,
): number {
  const allCoveringIds = new Set<string>();
  for (const row of rows) {
    for (const id of row.coveringCandidateIds) allCoveringIds.add(id);
  }
  let omitted = 0;
  for (const id of allCoveringIds) if (!permittedIds.has(id)) omitted += 1;
  return omitted;
}

function qualityScopedRows(
  id: string,
  evidenceDir: string,
  rows: TraceabilityRows,
): ScopedRowsOutcome {
  try {
    const candidates = loadDeliverableCandidateIds(id, evidenceDir);
    if (candidates === undefined) {
      return {
        ok: false,
        result: errorResult(500, "QI_LOAD_FAILED", "Failed to load the Quality Intelligence run."),
      };
    }
    const permitted = new Set(candidates.map((candidate) => candidate.id));
    return {
      ok: true,
      rows: QualityIntelligenceExport.scopeTraceabilityRowsToTests(rows, permitted),
      omittedByQualityGate: countCoveringIdsOmittedByGate(rows, permitted),
    };
  } catch (error) {
    if (error instanceof QualityIntelligenceReviewIntegrityError) {
      return {
        ok: false,
        result: errorResult(
          409,
          "QI_REVIEW_TAMPERED",
          "The review artifact failed integrity validation.",
        ),
      };
    }
    return {
      ok: false,
      result: errorResult(500, "QI_LOAD_FAILED", "Failed to load the Quality Intelligence run."),
    };
  }
}

// Apply the same deliverability gate as the candidate/TMS route unconditionally, then optionally
// narrow further to approved tests. Tampered review evidence fails closed with the sibling 409.
// omittedByQualityGate reflects the deliverability filter's drops — the approvedOnly narrowing
// after it is a user-chosen scope, not a quality omission, so it does not add to the count.
function scopedRows(
  id: string,
  evidenceDir: string,
  rows: TraceabilityRows,
  approvedOnly: boolean,
): ScopedRowsOutcome {
  const qualityScoped = qualityScopedRows(id, evidenceDir, rows);
  if (!qualityScoped.ok || !approvedOnly) return qualityScoped;
  let approved: ReadonlySet<string>;
  try {
    approved = approvedTestIdsFor(id, evidenceDir, qualityScoped.rows);
  } catch (error) {
    if (error instanceof QualityIntelligenceReviewIntegrityError) {
      return {
        ok: false,
        result: errorResult(
          409,
          "QI_REVIEW_TAMPERED",
          "The review artifact failed integrity validation.",
        ),
      };
    }
    return {
      ok: false,
      result: errorResult(500, "QI_LOAD_FAILED", "Failed to load the Quality Intelligence run."),
    };
  }
  return {
    ok: true,
    rows: QualityIntelligenceExport.scopeTraceabilityRowsToTests(qualityScoped.rows, approved),
    omittedByQualityGate: qualityScoped.omittedByQualityGate,
  };
}

function resultWarnings(warnings: readonly string[]): { readonly warnings?: readonly string[] } {
  return warnings.length > 0 ? { warnings: sortedStrings(warnings) } : {};
}

// eslint-disable-next-line max-lines-per-function, complexity
export async function handleQiTraceabilityExport(
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
  const parsed = await parseTraceabilityRequest(ctx.req);
  if (!parsed.ok) return parsed.result;
  const { format, approvedOnly } = parsed.request;
  let manifest: ReturnType<typeof loadQualityIntelligenceRun>;
  try {
    manifest = loadQualityIntelligenceRun(id, { evidenceDir });
  } catch {
    // CWE-209: never surface the underlying filesystem/parse error detail to the client; a
    // corrupt or unreadable manifest is reported as an opaque 500 (mirrors uiRoutes.ts).
    return errorResult(500, "QI_LOAD_FAILED", "Failed to load the Quality Intelligence run.");
  }
  if (manifest === undefined) {
    return errorResult(404, "QI_NOT_FOUND", "Quality Intelligence run not found.");
  }
  const matrix = manifest.coverageMatrix ?? [];
  if (matrix.length === 0) {
    return errorResult(409, "QI_NO_COVERAGE", "This run has no coverage matrix to export.");
  }
  const scoped = scopedRows(id, evidenceDir, toTraceabilityRows(matrix), approvedOnly);
  if (!scoped.ok) return scoped.result;
  const rows = scoped.rows;
  const display = { candidateTitleById: candidateTitlesFor(id, evidenceDir) };
  const adapterBody =
    format === "markdown"
      ? QualityIntelligenceExport.adaptToTraceabilityMarkdown(rows, display)
      : QualityIntelligenceExport.adaptToTraceabilityCsv(rows, display);
  const body =
    format === "csv" ? QualityIntelligenceExport.toExcelFriendlyCsv(adapterBody) : adapterBody;
  const target: QualityIntelligenceTraceabilityExportMode =
    format === "markdown" ? "traceability-markdown" : "traceability-csv";
  // Emit audit evidence for the materialised download (Epic #734, Issue #740). Best-effort: see
  // recordTraceabilityExportEvidence for the warning-on-failure rationale.
  const warnings = recordTraceabilityExportEvidence(
    id,
    target,
    body,
    manifest,
    evidenceDir,
    approvedOnly,
  );
  const meta = FORMAT_META[format];
  return {
    status: 200,
    body: {
      format,
      filename: `${id}-traceability.${meta.ext}`,
      contentType: meta.contentType,
      byteLen: Buffer.byteLength(body, "utf8"),
      body,
      // PR-review follow-up (Codex thread 3772030500): expose the deliverability-gate omission
      // count so the client's ExportBar can surface it next to the download in the same React
      // commit — matches the omittedByQualityGate field the candidate/TMS export route already
      // publishes.
      omittedByQualityGate: scoped.omittedByQualityGate,
      ...resultWarnings(warnings),
    },
  };
}

export const QI_TRACEABILITY_ROUTE_GROUP: readonly RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/quality-intelligence/runs/:id/traceability",
    handler: handleQiTraceabilityExport,
  },
];
