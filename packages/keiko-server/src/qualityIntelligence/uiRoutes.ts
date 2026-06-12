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
  loadQualityIntelligenceCandidates,
  type QualityIntelligenceCandidateRow,
} from "@oscharko-dev/keiko-evidence";
import type {
  QualityIntelligenceUiRunSummary,
  QualityIntelligenceUiRunListResponse,
  QualityIntelligenceUiRunDetail,
  QualityIntelligenceUiFindingSummary,
  QualityIntelligenceUiEvidenceRef,
  QualityIntelligenceUiCandidate,
  QualityIntelligenceUiAtomCoverage,
  QualityIntelligenceUiWeakTestFlag,
  QualityIntelligenceUiDriftMetadata,
} from "@oscharko-dev/keiko-contracts";
import type { RouteContext, RouteResult } from "../routes.js";
import type { UiHandlerDeps } from "../deps.js";
import { loadRunReviewState, candidateReviewStateOf, runReviewStateOf } from "./reviewStore.js";
import { qiRunRegistry } from "./runRegistry.js";

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

interface RunDetailInputs {
  readonly manifest: NonNullable<ReturnType<typeof loadQualityIntelligenceRun>>;
  readonly candidateRows: readonly QualityIntelligenceCandidateRow[];
  readonly reviewArtifact: ReturnType<typeof loadRunReviewState>;
}

/**
 * Build a candidateId → weak-test flag map from the persisted test-quality findings (Epic #736).
 * Only findings of kind "test-quality" that carry a candidateId contribute; the first finding wins
 * per candidate (the judge emits at most one test-quality finding per candidate).
 */
function buildWeakTestFlags(
  manifest: NonNullable<ReturnType<typeof loadQualityIntelligenceRun>>,
): ReadonlyMap<string, QualityIntelligenceUiWeakTestFlag> {
  const flags = new Map<string, QualityIntelligenceUiWeakTestFlag>();
  for (const f of manifest.findings) {
    if (f.kind !== "test-quality" || f.candidateId === undefined) continue;
    if (flags.has(f.candidateId)) continue;
    flags.set(f.candidateId, { severity: f.severity, rationale: f.summaryRedacted });
  }
  return flags;
}

function projectCandidate(
  row: QualityIntelligenceCandidateRow,
  reviewArtifact: ReturnType<typeof loadRunReviewState>,
  weakTestFlags: ReadonlyMap<string, QualityIntelligenceUiWeakTestFlag>,
): QualityIntelligenceUiCandidate {
  const weakTestFlag = weakTestFlags.get(row.id);
  return {
    id: row.id,
    title: row.title,
    preconditions: row.preconditions,
    steps: row.steps,
    expectedResults: row.expectedResults,
    priority: row.priority,
    riskClass: row.riskClass,
    tags: row.tags,
    status: row.status,
    reviewState: candidateReviewStateOf(reviewArtifact, row.id),
    derivedFromAtomIds: row.derivedFromAtomIds,
    ...(weakTestFlag !== undefined ? { weakTestFlag } : {}),
  };
}

function projectCoverageByAtom(
  manifest: NonNullable<ReturnType<typeof loadQualityIntelligenceRun>>,
): readonly QualityIntelligenceUiAtomCoverage[] {
  if (manifest.coverageMatrix === undefined) return Object.freeze([]);
  return Object.freeze(
    manifest.coverageMatrix.map((row) => ({
      atomId: row.atomId,
      status: row.status,
      confidence: row.confidence,
      // Optional redacted excerpt (#790); absent on runs recorded before it existed.
      ...(row.requirementExcerptRedacted !== undefined
        ? { requirementExcerptRedacted: row.requirementExcerptRedacted }
        : {}),
    })),
  );
}

function computeCoveragePercentage(
  coverageByAtom: readonly QualityIntelligenceUiAtomCoverage[],
): number {
  if (coverageByAtom.length === 0) return 0;
  const covered = coverageByAtom.filter((r) => r.status === "covered").length;
  return (covered / coverageByAtom.length) * 100;
}

function projectDriftMetadata(
  manifest: NonNullable<ReturnType<typeof loadQualityIntelligenceRun>>,
  candidateRows: readonly QualityIntelligenceCandidateRow[],
): QualityIntelligenceUiDriftMetadata {
  const sourceFingerprintCount = manifest.sourceFingerprints?.length ?? 0;
  const atomFingerprintCount = manifest.atomFingerprints?.length ?? 0;
  const supported = sourceFingerprintCount > 0 && candidateRows.length > 0;
  return {
    status: supported ? "not-checked" : "unavailable",
    sourceFingerprintCount,
    atomFingerprintCount,
    reCheckSupported: supported,
    regenerateStaleSupported: supported,
  };
}

function projectRunDetail(inputs: RunDetailInputs): QualityIntelligenceUiRunDetail {
  const { manifest, candidateRows, reviewArtifact } = inputs;
  const findingRefs: QualityIntelligenceUiFindingSummary[] = manifest.findings.map((f) => ({
    id: f.id,
    kind: f.kind,
    severity: f.severity,
    summaryRedacted: f.summaryRedacted,
  }));
  const weakTestFlags = buildWeakTestFlags(manifest);
  const candidates: QualityIntelligenceUiCandidate[] = candidateRows.map((row) =>
    projectCandidate(row, reviewArtifact, weakTestFlags),
  );
  const candidateIds: string[] =
    candidates.length > 0 ? candidates.map((c) => c.id) : [...manifest.provenanceRefs.envelopeIds];
  const evidenceRefs: QualityIntelligenceUiEvidenceRef[] = manifest.evidenceRefs.map((r) => ({
    envelopeId: r.envelopeId,
    atomId: r.atomId,
  }));
  const coverageByAtom = projectCoverageByAtom(manifest);
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
    candidates,
    evidenceRefs,
    reviewState: runReviewStateOf(reviewArtifact),
    manifestSchemaVersion: manifest.qiEvidenceSchemaVersion,
    coveragePercentage: computeCoveragePercentage(coverageByAtom),
    coverageByAtom,
    qualityScore: manifest.qualityScore ?? null,
    drift: projectDriftMetadata(manifest, candidateRows),
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
    // In-flight runs (not yet persisted to evidence) appear first so a running run is visible
    // immediately. Completed runs come from evidence (restart-safe).
    const active = qiRunRegistry.listActiveSummaries();
    const activeIds = new Set(active.map((r) => r.id));
    const runIds = listQualityIntelligenceRuns({ evidenceDir }).filter((id) => !activeIds.has(id));
    const totalRunIds = active.length + runIds.length;
    const truncated = totalRunIds > limit;
    const runs: QualityIntelligenceUiRunSummary[] = [];
    for (const summary of active) {
      if (runs.length >= limit) break;
      runs.push(summary);
    }
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
        // A single corrupt manifest must not prevent listing other runs: skip and continue. The
        // store fails closed on a corrupt manifest (EvidenceReadError) so nothing unsafe is
        // surfaced. Quarantine (`quarantineCorruptQualityIntelligenceManifest`) is a SEPARATE,
        // explicitly-invoked maintenance step — it is intentionally NOT run from this read path
        // (a GET must not rename files); its wiring is deferred with the retention orchestrator
        // (Issue #274 follow-up).
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
    const candidatesArtifact =
      evidenceDir === undefined
        ? undefined
        : loadQualityIntelligenceCandidates(id, { evidenceDir });
    const reviewArtifact =
      evidenceDir === undefined ? undefined : loadRunReviewState(id, evidenceDir);
    const detail = projectRunDetail({
      manifest,
      candidateRows: candidatesArtifact?.candidates ?? [],
      reviewArtifact,
    });
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
