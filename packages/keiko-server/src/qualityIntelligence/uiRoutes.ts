// Quality Intelligence read-only UI BFF routes (Issue #280, Epic #270).
//
// Two additive HTTP handlers under `/api/quality-intelligence/runs*`:
//   * GET /api/quality-intelligence/runs       — list run summaries
//   * GET /api/quality-intelligence/runs/:id   — single run detail
//
// Hard constraints:
//   * No raw prompts, model outputs, credentials, or unsafe markdown in responses.
//   * Only refs, counts, and redacted summaries reach the browser.
//   * Error JSON NEVER contains sensitive field values — only safe error codes.
//   * No provider SDK imports; no outbound network calls from these handlers.
//   * listQualityIntelligenceRuns / loadQualityIntelligenceRun are composed from
//     keiko-evidence UNCHANGED (ADR-0023 D8).

import {
  listQualityIntelligenceRuns,
  loadQualityIntelligenceRun,
} from "@oscharko-dev/keiko-evidence";
import type {
  QualityIntelligenceUiRunSummary,
  QualityIntelligenceUiRunListResponse,
  QualityIntelligenceUiRunDetail,
  QualityIntelligenceUiFindingSummary,
  QualityIntelligenceUiEvidenceRef,
} from "@oscharko-dev/keiko-contracts";
import type { RouteContext, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";

// Issue #646 — bound manifest loading on the run-list path. Default 100 keeps the local BFF
// responsive on large evidence stores; the max cap of 500 mirrors the QI run-detail budget so
// the UI cannot ask for an unbounded scan even with an explicit query parameter.
export const QI_RUN_LIST_DEFAULT_LIMIT = 100;
export const QI_RUN_LIST_MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// Evidence-dir resolution — mirrors the pattern from read-handlers.ts (no new logic)
// ---------------------------------------------------------------------------

function resolveEvidenceDir(deps: UiHandlerDeps): string | undefined {
  return deps.evidenceDir;
}

// ---------------------------------------------------------------------------
// Projection helpers — build browser-safe wire shapes from manifest data.
// NEVER include raw prompt, raw source content, credentials, or unsafe markdown.
// ---------------------------------------------------------------------------

function projectRunSummary(
  manifest: ReturnType<typeof loadQualityIntelligenceRun>,
): QualityIntelligenceUiRunSummary | null {
  if (manifest === undefined) return null;
  return {
    id: manifest.runId,
    status: manifest.status,
    requestedAt: manifest.planAt,
    completedAt: manifest.completedAt ?? null,
    totals: {
      candidates: manifest.totals.candidates,
      findings: manifest.totals.findings,
      exports: manifest.totals.exports,
    },
  };
}

function projectRunDetail(
  manifest: ReturnType<typeof loadQualityIntelligenceRun>,
): QualityIntelligenceUiRunDetail | null {
  if (manifest === undefined) return null;

  const findingRefs: QualityIntelligenceUiFindingSummary[] = manifest.findings.map((f) => ({
    id: f.id,
    kind: f.kind,
    severity: f.severity,
    // summaryRedacted has already been passed through the QI redaction pipeline
    // by the manifest builder (keiko-evidence) before persist.
    summaryRedacted: f.summaryRedacted,
  }));

  // Candidate ids are derived from finding candidateId references (where present).
  // The manifest itself does not store a flat candidateIds list; we project unique
  // candidate IDs that appear in evidence refs provenance.
  // For the scaffold, use provenanceRefs.envelopeIds as candidate references
  // since the full candidate list is a domain concern deferred to #281.
  const candidateIds: string[] = [...manifest.provenanceRefs.envelopeIds];

  const evidenceRefs: QualityIntelligenceUiEvidenceRef[] = manifest.evidenceRefs.map((r) => ({
    envelopeId: r.envelopeId,
    atomId: r.atomId,
  }));

  return {
    id: manifest.runId,
    status: manifest.status,
    requestedAt: manifest.planAt,
    completedAt: manifest.completedAt ?? null,
    totals: {
      candidates: manifest.totals.candidates,
      findings: manifest.totals.findings,
      exports: manifest.totals.exports,
    },
    findingRefs,
    candidateIds,
    evidenceRefs,
    manifestSchemaVersion: manifest.qiEvidenceSchemaVersion,
  };
}

// ---------------------------------------------------------------------------
// GET /api/quality-intelligence/runs
// ---------------------------------------------------------------------------

type LimitOutcome =
  | { readonly ok: true; readonly limit: number }
  | { readonly ok: false; readonly response: RouteResult };

function parseLimitParam(ctx: RouteContext): LimitOutcome {
  const raw = ctx.url.searchParams.get("limit");
  if (raw === null) {
    return { ok: true, limit: QI_RUN_LIST_DEFAULT_LIMIT };
  }
  // Strict integer parse: reject empty, leading zeros, signs, decimals, scientific notation,
  // whitespace, NaN/Infinity. Anything that isn't a bare decimal positive integer 400s.
  if (!/^[1-9]\d*$/.test(raw)) {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: { code: "BAD_REQUEST", message: "limit must be a positive integer" } },
      },
    };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return {
      ok: false,
      response: {
        status: 400,
        body: { error: { code: "BAD_REQUEST", message: "limit must be a positive integer" } },
      },
    };
  }
  return { ok: true, limit: Math.min(value, QI_RUN_LIST_MAX_LIMIT) };
}

export function handleListQiRuns(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const limitOutcome = parseLimitParam(ctx);
  if (!limitOutcome.ok) return limitOutcome.response;
  const limit = limitOutcome.limit;
  const evidenceDir = resolveEvidenceDir(deps);
  try {
    const runIds = listQualityIntelligenceRuns({ evidenceDir });
    const totalRunIds = runIds.length;
    const truncated = totalRunIds > limit;
    const runs: QualityIntelligenceUiRunSummary[] = [];
    // Issue #646: stop iterating as soon as the bounded slice is full so we never load more
    // manifests than the route promised. A single corrupt manifest still skips its slot, but
    // we do NOT advance past `limit` to refill it — the goal is bounded work per request.
    for (const id of runIds) {
      if (runs.length >= limit) break;
      try {
        const manifest = loadQualityIntelligenceRun(id, { evidenceDir });
        const summary = projectRunSummary(manifest);
        if (summary !== null) runs.push(summary);
      } catch {
        // A single corrupt manifest must not prevent listing other runs.
        // Skip and continue — the store's quarantine mechanism handles it.
      }
    }
    const body: QualityIntelligenceUiRunListResponse = { runs, limit, totalRunIds, truncated };
    return { status: 200, body };
    // Static codes only — never echo OS fs error text (CWE-209).
  } catch {
    return {
      status: 500,
      body: {
        error: {
          code: "LIST_FAILED",
          message: "Failed to list Quality Intelligence runs",
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// GET /api/quality-intelligence/runs/:id
// ---------------------------------------------------------------------------

export function handleGetQiRun(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const { id } = ctx.params;
  if (id === undefined || id.trim().length === 0) {
    return { status: 400, body: { error: { code: "BAD_REQUEST", message: "Run id is required" } } };
  }
  const evidenceDir = resolveEvidenceDir(deps);
  try {
    const manifest = loadQualityIntelligenceRun(id, { evidenceDir });
    if (manifest === undefined) {
      return {
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "Quality Intelligence run not found" } },
      };
    }
    const detail = projectRunDetail(manifest);
    if (detail === null) {
      return {
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "Quality Intelligence run not found" } },
      };
    }
    return { status: 200, body: detail };
    // Static codes only — never echo OS fs error text (CWE-209).
  } catch {
    return {
      status: 500,
      body: {
        error: { code: "INTERNAL", message: "Failed to load Quality Intelligence run" },
      },
    };
  }
}
