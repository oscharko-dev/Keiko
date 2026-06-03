/**
 * Typed fetch wrapper for the five /api/terminal/* BFF routes (ADR-0018 D8).
 * Mirrors lib/browser-api.ts: same-origin relative paths, CSRF header on
 * state-changing methods, no response-body logging.
 */

import { ApiError } from "./api";
import type {
  TerminalDirectoryListing,
  TerminalExecutionInput,
  TerminalExecutionResult,
  TerminalPolicySummary,
} from "./types";

interface BffError {
  readonly error: { readonly code: string; readonly message: string };
}

async function terminalFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const isStateChanging = method !== "GET" && method !== "HEAD";
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
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

export async function fetchTerminalPolicy(): Promise<TerminalPolicySummary> {
  return terminalFetch("/api/terminal/policy");
}

export async function fetchTerminalDirectories(
  projectId: string,
  path?: string,
): Promise<TerminalDirectoryListing> {
  const params = new URLSearchParams();
  params.set("projectId", projectId);
  if (path !== undefined && path.length > 0) params.set("path", path);
  return terminalFetch(`/api/terminal/directories?${params.toString()}`);
}

export async function createTerminalExecution(
  input: TerminalExecutionInput,
): Promise<TerminalExecutionResult> {
  return terminalFetch("/api/terminal/executions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function abortTerminalExecution(executionId: string): Promise<void> {
  await terminalFetch<void>(
    `/api/terminal/executions/${encodeURIComponent(executionId)}`,
    { method: "DELETE" },
  );
}

export function terminalEventsUrl(): string {
  return "/api/terminal/events";
}
