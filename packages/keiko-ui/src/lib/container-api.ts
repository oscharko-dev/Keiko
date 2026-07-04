/**
 * Typed fetch wrapper for the five /api/containers/* BFF routes (Issue #1388, ADR-0070).
 * Mirrors lib/commands-api.ts: same-origin relative paths, CSRF header on state-changing
 * methods, no response-body logging.
 */

import { bffFetchJson } from "./http";
import type {
  ContainerCapabilityResponse,
  ContainerRunRequest,
  ContainerRunResult,
  ContainerTaskCatalog,
} from "./types";

// Thin wrapper over the shared BFF scaffold (GEN-DUP-NEAR-004): CSRF + JSON content-type on
// state-changing methods, error-envelope parse, and the 204 → undefined short-circuit.
async function containerFetch<T>(path: string, init?: RequestInit): Promise<T> {
  return bffFetchJson<T>(path, init);
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
