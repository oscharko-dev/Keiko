/**
 * Typed fetch wrapper for the four /api/commands/* BFF routes (Issue #1387).
 * Mirrors lib/terminal-api.ts: same-origin relative paths, CSRF header on
 * state-changing methods, no response-body logging.
 */

import { ApiError } from "./api";
import type { CommandTaskCatalog, CommandTaskRunRequest, CommandTaskRunResult } from "./types";

interface BffError {
  readonly error: { readonly code: string; readonly message: string };
}

async function commandFetch<T>(path: string, init?: RequestInit): Promise<T> {
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
