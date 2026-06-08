/**
 * Typed fetch helpers for the Quality Intelligence BFF routes (Issue #280, Epic #270).
 * Same-origin relative paths (/api/quality-intelligence/...).
 * Uses the shared fetchJson helper via the ApiError envelope — never logs bodies.
 */

import type {
  QualityIntelligenceUiRunSummary,
  QualityIntelligenceUiRunDetail,
  QualityIntelligenceStartRunRequest,
  QualityIntelligenceRunStreamMessage,
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

export async function fetchQiRuns(): Promise<readonly QualityIntelligenceUiRunSummary[]> {
  const res = await fetchJson<{ runs: readonly QualityIntelligenceUiRunSummary[] }>(
    "/api/quality-intelligence/runs",
  );
  return res.runs;
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
    reader.releaseLock();
  }
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
): Promise<QiReviewResult> {
  return fetchJson<QiReviewResult>(
    `/api/quality-intelligence/runs/${encodeURIComponent(runId)}/review`,
    {
      method: "POST",
      body: JSON.stringify({ action, ...(candidateId !== undefined ? { candidateId } : {}) }),
    },
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
