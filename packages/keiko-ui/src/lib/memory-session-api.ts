// The MemoriaViva calls the first-load desktop shell needs at first paint: the chat session's
// proposal accept/reject and forget, and the autonomy-mode policy read/write behind the mode
// picker. Everything else on /api/memory/* (list, review queue, health scan, consolidation,
// journal, edit, pin, archive, correction) belongs to the MemoriaViva window, which loads lazily,
// and stays in memory-api.ts — which re-exports these five so its consumers see one surface.
// Split out for the first-load budget (PR #3602, issue #3591): the whole memory-api module was
// pulled into the initial chunk by these five calls alone.
// Browser-safe: imports only from @oscharko-dev/keiko-contracts (ADR-0019 rule 8).

import { bffFetchJson } from "./http";
import type {
  AcceptMemoryProposalOptions,
  CodingWorkbenchMode,
  MemoryAutonomyPolicyWire,
  MemoryId,
  MemoryRecord,
} from "@oscharko-dev/keiko-contracts";

export interface MemoryActionResponse {
  readonly memory: MemoryRecord;
}

export interface MemoryForgetResponse {
  readonly forgotten: true;
  readonly memoryId?: string;
  readonly memoryIds: readonly string[];
  readonly count: number;
}

// Thin delegation to the shared BFF scaffold, kept as a named private generic so the
// `fetchImpl = fetchJson<T>` default-param test seam every helper relies on stays intact.
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return bffFetchJson<T>(path, init);
}

export async function loadMemoryAutonomyMode(
  fetchImpl = fetchJson<MemoryAutonomyPolicyWire>,
): Promise<MemoryAutonomyPolicyWire> {
  return fetchImpl("/api/memory/autonomy-policy");
}

export async function persistMemoryAutonomyMode(
  requestedMode: CodingWorkbenchMode,
  expectedRevision: number,
  signal?: AbortSignal,
  fetchImpl = fetchJson<MemoryAutonomyPolicyWire>,
): Promise<MemoryAutonomyPolicyWire> {
  return fetchImpl("/api/memory/autonomy-policy", {
    method: "PUT",
    body: JSON.stringify({ requestedMode, expectedRevision }),
    ...(signal === undefined ? {} : { signal }),
  });
}

export async function forgetMemory(
  id: MemoryId,
  fetchImpl = fetchJson<MemoryForgetResponse>,
): Promise<MemoryForgetResponse> {
  return fetchImpl(`/api/memory/${encodeURIComponent(id)}/forget`, {
    method: "POST",
    body: JSON.stringify({
      acknowledged: true,
    }),
  });
}

// `id` is the proposal/record identifier the route encodes into the path. It is typed as a
// plain string because both call sites supply a branded id (chat: MemoryProposalId, review
// queue: MemoryId) and this HTTP boundary only needs the URL path segment, not the brand.
export type MemoryActionFetch = (path: string, init?: RequestInit) => Promise<MemoryActionResponse>;

export async function acceptMemoryProposal(
  id: string,
  optionsOrFetch: AcceptMemoryProposalOptions | MemoryActionFetch = {},
  fetchOverride: MemoryActionFetch = fetchJson<MemoryActionResponse>,
): Promise<MemoryActionResponse> {
  const options = typeof optionsOrFetch === "function" ? {} : optionsOrFetch;
  const fetchImpl = typeof optionsOrFetch === "function" ? optionsOrFetch : fetchOverride;
  return fetchImpl(`/api/memory/proposals/${encodeURIComponent(id)}/accept`, {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function rejectMemoryProposal(
  id: string,
  reason?: string,
  fetchImpl = fetchJson<MemoryActionResponse>,
): Promise<MemoryActionResponse> {
  return fetchImpl(`/api/memory/proposals/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify({ ...(reason !== undefined ? { reason } : {}) }),
  });
}
