/**
 * Typed fetch wrapper for the eight /api/browser/* BFF routes (ADR-0017 D8).
 * Mirrors the conventions in lib/api.ts: same-origin relative paths, CSRF
 * header on state-changing methods, no response-body logging.
 */

import { ApiError } from "./api";
import type {
  BrowserContentResult,
  BrowserNavigateResult,
  BrowserScreenshotResult,
  BrowserSessionMeta,
  CdpReachability,
} from "./types";

interface BffError {
  readonly error: { readonly code: string; readonly message: string };
}

async function browserFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const isStateChanging = method !== "GET" && method !== "HEAD";
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      // State-changing requests always need Content-Type: application/json so the server's
      // rejectIfInvalidStateChange gate passes — even DELETE which carries no body.
      ...(isStateChanging ? { "Content-Type": "application/json" } : {}),
      ...(isStateChanging ? { "X-Keiko-CSRF": "1" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let code = "INTERNAL";
    let message = `HTTP ${res.status.toString()}`;
    try {
      const envelope = (await res.json()) as BffError;
      code = envelope.error.code;
      message = envelope.error.message;
    } catch {
      // parse failure — keep generic, never log
    }
    throw new ApiError(code, message, res.status);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function fetchBrowserStatus(port: number): Promise<CdpReachability> {
  return browserFetch(`/api/browser/status?port=${encodeURIComponent(String(port))}`);
}

export async function createBrowserSession(port: number): Promise<BrowserSessionMeta> {
  return browserFetch("/api/browser/sessions", {
    method: "POST",
    body: JSON.stringify({ port }),
  });
}

export async function deleteBrowserSession(sessionId: string): Promise<void> {
  await browserFetch<void>(`/api/browser/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export async function browserNavigate(
  sessionId: string,
  url: string,
): Promise<BrowserNavigateResult> {
  return browserFetch(`/api/browser/sessions/${encodeURIComponent(sessionId)}/navigate`, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

export async function browserScreenshot(sessionId: string): Promise<BrowserScreenshotResult> {
  return browserFetch(`/api/browser/sessions/${encodeURIComponent(sessionId)}/screenshot`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function browserApplyScreenshot(
  sessionId: string,
  captureSeq: number,
): Promise<BrowserScreenshotResult> {
  return browserFetch(`/api/browser/sessions/${encodeURIComponent(sessionId)}/apply`, {
    method: "POST",
    body: JSON.stringify({ captureSeq }),
  });
}

export async function browserContent(sessionId: string): Promise<BrowserContentResult> {
  return browserFetch(`/api/browser/sessions/${encodeURIComponent(sessionId)}/content`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function browserEventsUrl(sessionId: string): string {
  return `/api/browser/sessions/${encodeURIComponent(sessionId)}/events`;
}
