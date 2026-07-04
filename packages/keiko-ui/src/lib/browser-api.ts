/**
 * Typed fetch wrapper for the eight /api/browser/* BFF routes (ADR-0017 D8).
 * Mirrors the conventions in lib/api.ts: same-origin relative paths, CSRF
 * header on state-changing methods, no response-body logging.
 */

import { bffFetchJson } from "./http";
import type {
  BrowserContentResult,
  BrowserNavigateResult,
  BrowserScreenshotResult,
  BrowserSessionMeta,
  CdpReachability,
} from "./types";

// Thin wrapper over the shared BFF scaffold (GEN-DUP-NEAR-004). State-changing requests always carry
// Content-Type: application/json so the server's rejectIfInvalidStateChange gate passes — even DELETE
// which carries no body; the shared helper applies that plus the CSRF header and the 204 → undefined
// short-circuit.
async function browserFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return bffFetchJson<T>(path, init);
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
