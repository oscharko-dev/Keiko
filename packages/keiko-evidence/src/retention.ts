// Retention and rotation (ADR-0010 D6). The single most dangerous operation in the layer, so it is
// the most tightly bounded: it deletes ONLY ledger-created `<runId>.json` files (every runId the
// store enumerates already passed assertValidRunId), inside the contained base dir, via
// EvidenceStore.delete. It computes the delete set then deletes that set (no recursion). "Oldest" is
// read from each manifest's finishedAt header — never filesystem mtime, which a developer touch
// could perturb. When disabled, deletion is a no-op. An unparseable manifest is left untouched
// rather than risking deletion of a file we cannot read a header from.

import type { EvidenceStore } from "./store.js";
import type { RetentionPolicy } from "./types.js";

interface Candidate {
  readonly runId: string;
  readonly finishedAt: number;
  readonly bytes: number;
}

function readHeader(json: string): { finishedAt: number; bytes: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    const finishedAt = (parsed as { run?: { finishedAt?: unknown } }).run?.finishedAt;
    if (typeof finishedAt !== "number") {
      return undefined;
    }
    return { finishedAt, bytes: Buffer.byteLength(json, "utf8") };
  } catch {
    return undefined;
  }
}

// Newest-first ordering by finishedAt; ties broken by runId so the order is deterministic.
function collectCandidates(store: EvidenceStore): readonly Candidate[] {
  const candidates: Candidate[] = [];
  for (const runId of store.list()) {
    const json = store.get(runId);
    if (json === undefined) {
      continue;
    }
    const header = readHeader(json);
    if (header === undefined) {
      continue;
    }
    candidates.push({ runId, finishedAt: header.finishedAt, bytes: header.bytes });
  }
  candidates.sort((a, b) => b.finishedAt - a.finishedAt || a.runId.localeCompare(b.runId));
  return candidates;
}

function beyondMaxRuns(sorted: readonly Candidate[], maxRuns: number): readonly string[] {
  return sorted.slice(Math.max(maxRuns, 0)).map((c) => c.runId);
}

function olderThanAge(sorted: readonly Candidate[], maxAgeMs: number): readonly string[] {
  const newest = sorted[0]?.finishedAt;
  if (newest === undefined) {
    return [];
  }
  const cutoff = newest - maxAgeMs;
  return sorted.filter((c) => c.finishedAt < cutoff).map((c) => c.runId);
}

function overByteCap(sorted: readonly Candidate[], maxTotalBytes: number): readonly string[] {
  const doomed: string[] = [];
  let running = 0;
  // Walk newest-first, keeping manifests until the cap is reached; the rest (oldest) are deleted.
  // The newest manifest (index 0) is ALWAYS kept even if it alone exceeds the cap — retention must
  // never delete the just-written run, and "delete oldest until under the cap" cannot apply to a
  // single most-recent file.
  for (let i = 0; i < sorted.length; i += 1) {
    const candidate = sorted[i];
    if (candidate === undefined) {
      continue;
    }
    running += candidate.bytes;
    if (i > 0 && running > maxTotalBytes) {
      doomed.push(candidate.runId);
    }
  }
  return doomed;
}

function computeDeleteSet(
  sorted: readonly Candidate[],
  policy: RetentionPolicy,
): ReadonlySet<string> {
  const doomed = new Set<string>();
  if (policy.maxRuns !== undefined) {
    for (const id of beyondMaxRuns(sorted, policy.maxRuns)) {
      doomed.add(id);
    }
  }
  if (policy.maxAgeMs !== undefined) {
    for (const id of olderThanAge(sorted, policy.maxAgeMs)) {
      doomed.add(id);
    }
  }
  if (policy.maxTotalBytes !== undefined) {
    for (const id of overByteCap(sorted, policy.maxTotalBytes)) {
      doomed.add(id);
    }
  }
  return doomed;
}

export function applyRetention(store: EvidenceStore, policy: RetentionPolicy): void {
  if (policy.disabled === true) {
    return;
  }
  const sorted = collectCandidates(store);
  for (const runId of computeDeleteSet(sorted, policy)) {
    store.delete(runId);
  }
}
