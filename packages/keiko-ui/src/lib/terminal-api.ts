/**
 * Typed fetch wrapper for the five /api/terminal/* BFF routes (ADR-0018 D8).
 * Mirrors lib/browser-api.ts: same-origin relative paths, CSRF header on
 * state-changing methods, no response-body logging.
 */

import { bffFetchJson } from "./http";
import type {
  TerminalDirectoryListing,
  TerminalExecutionInput,
  TerminalExecutionResult,
  TerminalPolicySummary,
} from "./types";

// Thin wrapper over the shared BFF scaffold (GEN-DUP-NEAR-004): CSRF + JSON content-type on
// state-changing methods, error-envelope parse, and the 204 → undefined short-circuit.
async function terminalFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return bffFetchJson<T>(path, init);
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
  await terminalFetch<void>(`/api/terminal/executions/${encodeURIComponent(executionId)}`, {
    method: "DELETE",
  });
}

export function terminalEventsUrl(): string {
  return "/api/terminal/events";
}
