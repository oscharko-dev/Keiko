/**
 * Typed fetch helpers for the Quality Intelligence BFF routes (Issue #280, Epic #270).
 * Same-origin relative paths (/api/quality-intelligence/...).
 * Uses the shared fetchJson helper via the ApiError envelope — never logs bodies.
 */

import type {
  QualityIntelligenceUiRunSummary,
  QualityIntelligenceUiRunDetail,
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
