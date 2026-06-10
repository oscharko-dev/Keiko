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
import {
  loadQualityIntelligenceCandidates,
  loadQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import { QualityIntelligenceExport } from "@oscharko-dev/keiko-quality-intelligence";
import type { RouteContext, RouteResult, RouteDefinition } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";

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

// Parse the requested format from the (optional) JSON body; defaults to CSV. An unreadable or
// malformed body falls back to CSV rather than failing — the run id alone is a valid request.
async function parseFormat(req: IncomingMessage): Promise<Format> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    return "csv";
  }
  if (raw.trim().length === 0) return "csv";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const fmt = (parsed as Record<string, unknown>).format;
      if (fmt === "markdown") return "markdown";
    }
  } catch {
    return "csv";
  }
  return "csv";
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
  const format = await parseFormat(ctx.req);
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
  const rows = toTraceabilityRows(matrix);
  const display = { candidateTitleById: candidateTitlesFor(id, evidenceDir) };
  const body =
    format === "markdown"
      ? QualityIntelligenceExport.adaptToTraceabilityMarkdown(rows, display)
      : QualityIntelligenceExport.adaptToTraceabilityCsv(rows, display);
  const meta = FORMAT_META[format];
  return {
    status: 200,
    body: {
      format,
      filename: `${id}-traceability.${meta.ext}`,
      contentType: meta.contentType,
      byteLen: Buffer.byteLength(body, "utf8"),
      body,
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
