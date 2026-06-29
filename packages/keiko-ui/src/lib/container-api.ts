/**
 * Typed fetch wrapper for the five /api/containers/* BFF routes (Issue #1388, ADR-0070).
 * Mirrors lib/commands-api.ts: same-origin relative paths, CSRF header on state-changing
 * methods, no response-body logging.
 */

import { ApiError } from "./api";
import type {
  ContainerCapabilityResponse,
  ContainerRunRequest,
  ContainerRunResult,
  ContainerTaskCatalog,
} from "./types";

interface BffError {
  readonly error: { readonly code: string; readonly message: string };
}

async function containerFetch<T>(path: string, init?: RequestInit): Promise<T> {
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

export async function fetchContainerCapability(root: string): Promise<ContainerCapabilityResponse> {
  const params = new URLSearchParams();
  params.set("root", root);
  return containerFetch(`/api/containers/capability?${params.toString()}`);
}

export async function fetchContainerCatalog(projectId: string): Promise<ContainerTaskCatalog> {
  const params = new URLSearchParams();
  params.set("projectId", projectId);
  return containerFetch(`/api/containers/catalog?${params.toString()}`);
}

export async function createContainerRun(input: ContainerRunRequest): Promise<ContainerRunResult> {
  return containerFetch("/api/containers/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function cancelContainerRun(runId: string): Promise<void> {
  await containerFetch<void>(`/api/containers/runs/${encodeURIComponent(runId)}`, {
    method: "DELETE",
  });
}

export function containerEventsUrl(): string {
  return "/api/containers/events";
}
