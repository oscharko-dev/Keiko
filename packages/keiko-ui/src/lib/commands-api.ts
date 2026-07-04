/**
 * Typed fetch wrapper for the four /api/commands/* BFF routes (Issue #1387).
 * Mirrors lib/terminal-api.ts: same-origin relative paths, CSRF header on
 * state-changing methods, no response-body logging.
 */

import { bffFetchJson } from "./http";
import type { CommandTaskCatalog, CommandTaskRunRequest, CommandTaskRunResult } from "./types";

// Thin wrapper over the shared BFF scaffold (GEN-DUP-NEAR-004): CSRF + JSON content-type on
// state-changing methods, error-envelope parse, and the 204 → undefined short-circuit.
async function commandFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return bffFetchJson<T>(path, init);
}

export async function fetchCommandCatalog(projectId: string): Promise<CommandTaskCatalog> {
  const params = new URLSearchParams();
  params.set("projectId", projectId);
  return commandFetch(`/api/commands/catalog?${params.toString()}`);
}

export async function createCommandRun(
  input: CommandTaskRunRequest,
): Promise<CommandTaskRunResult> {
  return commandFetch("/api/commands/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function cancelCommandRun(runId: string): Promise<void> {
  await commandFetch<void>(`/api/commands/runs/${encodeURIComponent(runId)}`, {
    method: "DELETE",
  });
}

export function commandEventsUrl(): string {
  return "/api/commands/events";
}
