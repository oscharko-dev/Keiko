/**
 * Typed fetch helpers for the Quality Intelligence BFF routes (Issue #280, Epic #270).
 * Same-origin relative paths (/api/quality-intelligence/...).
 * Uses the shared fetchJson helper via the ApiError envelope — never logs bodies.
 */

import type {
  QualityIntelligenceUiRunListResponse,
  QualityIntelligenceUiRunDetail,
  QualityIntelligenceUiCandidate,
  QualityIntelligenceCandidateEditableFields,
  QualityIntelligenceStartRunRequest,
  QualityIntelligenceRunStreamMessage,
  QualityIntelligenceUiStalenessReport,
  QualityIntelligenceUiRegenerateResult,
} from "@oscharko-dev/keiko-contracts";

// ---------------------------------------------------------------------------
// Internal fetch helper (mirrors the pattern in api.ts without re-exporting ApiError)
// ---------------------------------------------------------------------------

import { ApiError } from "./api";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method === "GET" || method === "HEAD" ? {} : { "X-Keiko-CSRF": "1" }),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let code = "INTERNAL";
    let message = `HTTP ${res.status.toString()}`;
    try {
      const envelope = (await res.json()) as { error: { code: string; message: string } };
      code = envelope.error.code;
      message = envelope.error.message;
    } catch {
      // parse failure — keep generic message
    }
    throw new ApiError(code, message, res.status);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// GET /api/quality-intelligence/runs
// ---------------------------------------------------------------------------

/**
 * Returns the full run-list envelope. `limit` / `totalRunIds` / `truncated` are part of the wire
 * contract (issue #646) so the hub can render a "more available" indicator when the route
 * truncated the list — discarding them hid older runs without any hint (uiux-fix F030 C277).
 */
export async function fetchQiRuns(): Promise<QualityIntelligenceUiRunListResponse> {
  return fetchJson<QualityIntelligenceUiRunListResponse>("/api/quality-intelligence/runs");
}

// ---------------------------------------------------------------------------
// GET /api/quality-intelligence/runs/:id
// ---------------------------------------------------------------------------

export async function fetchQiRunDetail(id: string): Promise<QualityIntelligenceUiRunDetail> {
  return fetchJson<QualityIntelligenceUiRunDetail>(
    `/api/quality-intelligence/runs/${encodeURIComponent(id)}`,
  );
}

// ---------------------------------------------------------------------------
// POST /api/quality-intelligence/runs — start a run, consume the SSE progress stream
// ---------------------------------------------------------------------------

async function readPreStreamError(res: Response): Promise<ApiError> {
  let code = "QI_RUN_FAILED";
  let message = `HTTP ${res.status.toString()}`;
  try {
    const envelope = (await res.json()) as { error?: { code?: string; message?: string } };
    code = envelope.error?.code ?? code;
    message = envelope.error?.message ?? message;
  } catch {
    // parse failure — never log the body
  }
  return new ApiError(code, message, res.status);
}

/**
 * Start a Quality Intelligence run and stream its progress. Each `data:` SSE line is parsed into a
 * `QualityIntelligenceRunStreamMessage` and handed to `onMessage`. Resolves when the stream ends;
 * aborting `signal` stops reading (and signals the server to cancel via connection close). Throws
 * `ApiError` when the server returns a pre-stream JSON error instead of an event stream.
 */
export async function startQiRun(
  request: QualityIntelligenceStartRunRequest,
  signal: AbortSignal,
  onMessage: (message: QualityIntelligenceRunStreamMessage) => void,
): Promise<void> {
  const res = await fetch("/api/quality-intelligence/runs", {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
    },
    body: JSON.stringify(request),
    signal,
  });

  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.includes("text/event-stream")) {
    throw await readPreStreamError(res);
  }
  const body = res.body;
  if (body === null) {
    throw new ApiError("QI_NO_STREAM", "The server did not return a progress stream.", res.status);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        try {
          onMessage(
            JSON.parse(line.slice("data:".length).trim()) as QualityIntelligenceRunStreamMessage,
          );
        } catch {
          // ignore malformed frame
        }
      }
    }
  } finally {
    // Cancel the body stream before releasing the lock so the HTTP connection closes
    // promptly on abort. That close is what fires the server's res.on("close") cancel hook
    // (runRoutes.ts handleStartQiRun), which aborts the in-flight run and stops model-gateway
    // work. releaseLock() alone leaves the connection open until GC collects the Response, so a
    // cancelled run would keep generating for an indeterminate time. cancel() on an already-ended
    // or errored stream is a harmless no-op; swallow its rejection.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/quality-intelligence/runs/:id  (Issue #282 follow-up)
// ---------------------------------------------------------------------------

export interface QiDeleteResult {
  readonly runId: string;
  readonly status: string;
  readonly removedCompanionSuffixes: readonly string[];
}

/**
 * Permanently delete a QI run and its companion files. Returns the deletion receipt.
 * 200 → receipt; 404 → ApiError("QI_NOT_FOUND"); 400/500 → ApiError(code).
 * CSRF is injected automatically by fetchJson for non-GET methods.
 */
export async function deleteQiRun(id: string): Promise<QiDeleteResult> {
  return fetchJson<QiDeleteResult>(`/api/quality-intelligence/runs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------------------
// POST /api/quality-intelligence/runs/:id/cancel
// ---------------------------------------------------------------------------

export async function cancelQiRun(id: string): Promise<void> {
  await fetchJson<{ cancelled: boolean }>(
    `/api/quality-intelligence/runs/${encodeURIComponent(id)}/cancel`,
    { method: "POST", body: "{}" },
  );
}

// ---------------------------------------------------------------------------
// POST /api/quality-intelligence/runs/:id/review  (Issue #282)
// ---------------------------------------------------------------------------

export type QiReviewAction = "approve" | "reject" | "request-changes" | "reopen" | "withdraw";

export interface QiReviewResult {
  readonly runState: string;
  readonly candidateStates: Readonly<Record<string, string>>;
  readonly auditCount: number;
}

export async function reviewQiRun(
  runId: string,
  action: QiReviewAction,
  candidateId?: string,
  reviewerLabel?: string,
): Promise<QiReviewResult> {
  return fetchJson<QiReviewResult>(
    `/api/quality-intelligence/runs/${encodeURIComponent(runId)}/review`,
    {
      method: "POST",
      body: JSON.stringify({
        action,
        ...(candidateId !== undefined ? { candidateId } : {}),
        ...(reviewerLabel !== undefined ? { reviewerLabel } : {}),
      }),
    },
  );
}

// ---------------------------------------------------------------------------
// POST /api/quality-intelligence/runs/:id/edit  (Issue #727, Epic #712)
// ---------------------------------------------------------------------------

/**
 * Edit a generated candidate's fields inline. Returns the server's redacted, BFF-safe projection of
 * the updated candidate. Only the changed fields are submitted (`edited`); the server merges them
 * over the existing row and records provenance + an audit entry.
 */
export async function editQiCandidate(
  runId: string,
  candidateId: string,
  edited: QualityIntelligenceCandidateEditableFields,
  editorLabel?: string,
): Promise<QualityIntelligenceUiCandidate> {
  const res = await fetchJson<{ candidate: QualityIntelligenceUiCandidate }>(
    `/api/quality-intelligence/runs/${encodeURIComponent(runId)}/edit`,
    {
      method: "POST",
      body: JSON.stringify({
        candidateId,
        edited,
        ...(editorLabel !== undefined ? { editorLabel } : {}),
      }),
    },
  );
  return res.candidate;
}

// ---------------------------------------------------------------------------
// POST /api/quality-intelligence/runs/:id/re-check + /regenerate-stale  (Epic #735)
// ---------------------------------------------------------------------------

/**
 * Re-check a run for source drift. Re-ingests the supplied sources server-side, compares their
 * fingerprints to the recorded run, and reports which generated tests are stale.
 */
export async function reCheckQiRun(
  runId: string,
  sources: QualityIntelligenceStartRunRequest["sources"],
): Promise<QualityIntelligenceUiStalenessReport> {
  return fetchJson<QualityIntelligenceUiStalenessReport>(
    `/api/quality-intelligence/runs/${encodeURIComponent(runId)}/re-check`,
    { method: "POST", body: JSON.stringify({ sources }) },
  );
}

/**
 * Regenerate only the stale tests of a run, preserving fresh candidates and human edits. Writes a
 * NEW immutable run and returns its id.
 */
export async function regenerateStaleQiRun(
  runId: string,
  sources: QualityIntelligenceStartRunRequest["sources"],
): Promise<QualityIntelligenceUiRegenerateResult> {
  return fetchJson<QualityIntelligenceUiRegenerateResult>(
    `/api/quality-intelligence/runs/${encodeURIComponent(runId)}/regenerate-stale`,
    { method: "POST", body: JSON.stringify({ sources }) },
  );
}

// ---------------------------------------------------------------------------
// POST /api/quality-intelligence/runs/:id/export  (Issue #283)
// ---------------------------------------------------------------------------

export interface QiExportLocalResult {
  readonly dryRun: false;
  readonly adapter: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteLen: number;
  readonly body: string;
  readonly encoding?: "base64";
}

export interface QiExportDryRunResult {
  readonly dryRun: true;
  readonly adapter: string;
  readonly candidateCount: number;
  readonly byteLen: number;
  readonly preview: string;
}

export type QiExportResult = QiExportLocalResult | QiExportDryRunResult;

export async function exportQiRun(
  runId: string,
  adapter: string,
  options?: { readonly dryRun?: boolean; readonly approvedOnly?: boolean },
): Promise<QiExportResult> {
  return fetchJson<QiExportResult>(
    `/api/quality-intelligence/runs/${encodeURIComponent(runId)}/export`,
    {
      method: "POST",
      body: JSON.stringify({
        adapter,
        dryRun: options?.dryRun ?? false,
        approvedOnly: options?.approvedOnly ?? false,
      }),
    },
  );
}

// ---------------------------------------------------------------------------
// POST /api/quality-intelligence/runs/:id/traceability  (Epic #734, Issue #740)
// ---------------------------------------------------------------------------

export type QiTraceabilityFormat = "csv" | "markdown";

export interface QiTraceabilityResult {
  readonly format: QiTraceabilityFormat;
  readonly filename: string;
  readonly contentType: string;
  readonly byteLen: number;
  readonly body: string;
}

/**
 * Export the persisted requirement<->test traceability matrix (CSV or Markdown). The body is plain
 * text (no base64), suitable for a same-origin Blob download.
 */
export async function exportQiRunTraceability(
  runId: string,
  format: QiTraceabilityFormat,
): Promise<QiTraceabilityResult> {
  return fetchJson<QiTraceabilityResult>(
    `/api/quality-intelligence/runs/${encodeURIComponent(runId)}/traceability`,
    {
      method: "POST",
      body: JSON.stringify({ format }),
    },
  );
}
