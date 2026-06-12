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
import { QualityIntelligence, type QualityIntelligence as QI } from "@oscharko-dev/keiko-contracts";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import { QualityIntelligenceExport } from "@oscharko-dev/keiko-quality-intelligence";
import {
  appendQualityIntelligenceExportRow,
  loadQualityIntelligenceRun,
  loadQualityIntelligenceCandidates,
  type QualityIntelligenceCandidateRow,
  type QualityIntelligenceExportRow,
} from "@oscharko-dev/keiko-evidence";
import type { RouteContext, RouteResult, RouteDefinition } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { loadRunReviewState, candidateReviewStateOf, runReviewStateOf } from "./reviewStore.js";
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

function buildBundle(
  runId: string,
  adapter: Adapter,
  candidates: readonly QI.QualityIntelligenceTestCaseCandidate[],
  createdAt: string,
): QI.QualityIntelligenceExportBundle {
  const contents = candidates.map((c) => ({
    candidateId: c.id,
    coverageMapRefs: Object.freeze([]),
    findingRefs: Object.freeze([]),
  }));
  const integrity = sha256Hex(JSON.stringify(candidates.map((c) => String(c.id))));
  return {
    id: QualityIntelligence.asQualityIntelligenceExportBundleId(
      `qi-export-${sha256Hex(`${runId}|${adapter}`).slice(0, 24)}`,
    ),
    runId: QualityIntelligence.asQualityIntelligenceRunId(runId),
    targetAdapter: adapter,
    createdAt,
    integrityHashSha256Hex: integrity,
    redactionAttested: true,
    contents,
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

/**
 * Build the export-evidence row for an export action (Issue #283, AC4). Records the target type, a
 * deterministic artifact id, an integrity hash over the exported candidate ids, the redaction
 * attestation (candidates were redacted at persist time), and whether the action was a dry-run.
 */
function buildExportEvidenceRow(
  runId: string,
  target: Adapter | BinaryMode,
  rows: readonly QualityIntelligenceCandidateRow[],
  dryRun: boolean,
): QualityIntelligenceExportRow {
  return {
    id: `qi-export-${sha256Hex(`${runId}|${target}`).slice(0, 24)}`,
    targetAdapter: target,
    integrityHash: sha256Hex(JSON.stringify(rows.map((r) => r.id))),
    redactionAttested: true,
    dryRun,
  };
}

/**
 * Best-effort append of an export-evidence row for a 200 export action (Issue #283, AC4). A failed
 * audit write must NOT withhold an already-computed local export from the user: the artifact has no
 * external side effect, the run already exists on disk, and the manifest write is atomic so this path
 * is rare. Swallow on failure rather than turning a successful export into a 500. No-op for error
 * responses and for the disabled external-TMS path (which produces no artifact).
 */
function recordExportEvidence(runId: string, outcome: ExportResponse, evidenceDir: string): void {
  if (outcome.evidence === undefined || outcome.result.status !== 200) {
    return;
  }
  try {
    appendQualityIntelligenceExportRow({ runId, export: outcome.evidence }, { evidenceDir });
  } catch {
    // intentionally swallowed — see doc comment
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

type ExportOutcome =
  | { readonly ok: true; readonly request: ExportRequest }
  | { readonly ok: false; readonly result: RouteResult };

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
    if (loadQualityIntelligenceRun(id, { evidenceDir }) === undefined) {
      return errorResult(404, "QI_NOT_FOUND", "Quality Intelligence run not found.");
    }
    const artifact = loadQualityIntelligenceCandidates(id, { evidenceDir });
    if (artifact === undefined || artifact.candidates.length === 0) {
      return errorResult(409, "QI_NO_CANDIDATES", "This run has no candidates to export.");
    }
    const outcome = serialiseExport(id, parsed.request, artifact.candidates, evidenceDir);
    // Emit audit evidence for every materialised export or dry-run preview (Issue #283, AC4). The
    // append is best-effort and must not turn a successful export into a 500 — see recordExportEvidence.
    recordExportEvidence(id, outcome, evidenceDir);
    return outcome.result;
  } catch {
    return errorResult(500, "QI_EXPORT_FAILED", "Failed to build the export.");
  }
}

function binaryResponse(
  runId: string,
  mode: BinaryMode,
  rows: readonly QualityIntelligenceCandidateRow[],
): ExportResponse {
  const brandedRunId = QualityIntelligence.asQualityIntelligenceRunId(runId);
  const candidates = rows.map((r) => rowToCandidate(r, brandedRunId));
  const createdAt = new Date().toISOString();
  const meta = LOCAL_META[mode] ?? { contentType: "application/octet-stream", ext: "bin" };
  let bytes: Uint8Array;
  if (mode === "pdf") {
    const bundle = buildBundle(runId, "plain-text", candidates, createdAt);
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
      const bundle = buildBundle(runId, fmt, candidates, createdAt);
      const serialized = QualityIntelligenceExport.serializeExportBundle(bundle, candidates);
      const ext = LOCAL_META[fmt]?.ext ?? "txt";
      return { name: `${runId}.${ext}`, bytes: enc.encode(serialized.body) };
    });
    bytes = assembleZipBundle(entries);
  }
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
        body: Buffer.from(bytes).toString("base64"),
      },
    },
    evidence: buildExportEvidenceRow(runId, mode, rows, false),
  };
}

function serialisedResponse(
  runId: string,
  request: ExportRequest,
  rows: readonly QualityIntelligenceCandidateRow[],
): ExportResponse {
  const adapter = request.adapter;
  if (adapter === "pdf" || adapter === "zip-bundle") {
    return binaryResponse(runId, adapter, rows);
  }
  const brandedRunId = QualityIntelligence.asQualityIntelligenceRunId(runId);
  const candidates = rows.map((r) => rowToCandidate(r, brandedRunId));
  const bundle = buildBundle(runId, adapter, candidates, new Date().toISOString());
  const serialized = QualityIntelligenceExport.serializeExportBundle(bundle, candidates);
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
        },
      },
      evidence: buildExportEvidenceRow(runId, adapter, rows, true),
    };
  }
  const meta = LOCAL_META[adapter] ?? { contentType: "text/plain", ext: "txt" };
  return {
    result: {
      status: 200,
      body: {
        dryRun: false,
        adapter,
        filename: `${runId}.${meta.ext}`,
        contentType: meta.contentType,
        byteLen: serialized.byteLen,
        body: serialized.body,
      },
    },
    evidence: buildExportEvidenceRow(runId, adapter, rows, false),
  };
}

function serialiseExport(
  runId: string,
  request: ExportRequest,
  allRows: readonly QualityIntelligenceCandidateRow[],
  evidenceDir: string,
): ExportResponse {
  const adapter = request.adapter;
  const isBinary = adapter === "pdf" || adapter === "zip-bundle";
  const isTms = !isBinary && QualityIntelligence.QUALITY_INTELLIGENCE_TMS_ADAPTERS.has(adapter);
  const approvedOnly = isTms ? true : request.approvedOnly;
  const rows = selectRows(allRows, approvedOnly, runId, evidenceDir);
  if (rows.length === 0) {
    return {
      result: errorResult(
        409,
        "QI_NOTHING_TO_EXPORT",
        approvedOnly ? "No approved candidates to export." : "No candidates to export.",
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
  return serialisedResponse(runId, request, rows);
}

export const QI_EXPORT_ROUTE_GROUP: readonly RouteDefinition[] = [
  { method: "POST", pattern: "/api/quality-intelligence/runs/:id/export", handler: handleQiExport },
];
