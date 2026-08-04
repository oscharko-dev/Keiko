// Retention and rotation (ADR-0010 D6). The single most dangerous operation in the layer, so it is
// the most tightly bounded: it deletes ONLY ledger-created `<runId>.json` files (every runId the
// store enumerates already passed assertValidRunId), inside the contained base dir, via
// EvidenceStore.delete. It computes the delete set then deletes that set (no recursion). "Oldest" is
// read from each manifest's finishedAt header — never filesystem mtime, which a developer touch
// could perturb. When disabled, deletion is a no-op. An unparseable manifest is left untouched
// rather than risking deletion of a file we cannot read a header from. Recognised task types map to
// one of two closed, contract-owned partitions. Unknown task types are likewise retained fail-safe.

import type { EvidenceStore } from "./store.js";
import type { EvidenceRetentionPartition, EvidenceTaskType, RetentionPolicy } from "./types.js";

const RETENTION_PARTITIONS = ["chat-rag", "regulated"] as const;
const RETENTION_PARTITION_BY_TASK_TYPE = Object.freeze({
  "generate-unit-tests": "regulated",
  "investigate-bug": "regulated",
  "explain-plan": "regulated",
  verify: "regulated",
  "editor-agent-turn": "regulated",
  "browser-capture": "regulated",
  "terminal-execution": "regulated",
  "command-run": "regulated",
  "container-run": "regulated",
  "connected-context": "chat-rag",
  "editor-verification-run": "regulated",
} as const satisfies Readonly<Record<EvidenceTaskType, EvidenceRetentionPartition>>);

interface Candidate {
  readonly runId: string;
  readonly finishedAt: number;
  readonly bytes: number;
  readonly partition: EvidenceRetentionPartition;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retentionPartition(taskType: unknown): EvidenceRetentionPartition | undefined {
  if (typeof taskType !== "string" || !Object.hasOwn(RETENTION_PARTITION_BY_TASK_TYPE, taskType)) {
    return undefined;
  }
  const partitions: Readonly<Record<string, EvidenceRetentionPartition | undefined>> =
    RETENTION_PARTITION_BY_TASK_TYPE;
  return partitions[taskType];
}

function readHeader(json: string): Omit<Candidate, "runId"> | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed) || !isRecord(parsed.run)) return undefined;
    const finishedAt = parsed.run.finishedAt;
    const partition = retentionPartition(parsed.run.taskType);
    if (typeof finishedAt !== "number" || !Number.isFinite(finishedAt) || partition === undefined) {
      return undefined;
    }
    return { finishedAt, bytes: Buffer.byteLength(json, "utf8"), partition };
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
    candidates.push({ runId, ...header });
  }
  candidates.sort((a, b) => b.finishedAt - a.finishedAt || a.runId.localeCompare(b.runId));
  return candidates;
}

function beyondMaxRuns(sorted: readonly Candidate[], maxRuns: number): readonly string[] {
  return sorted.slice(Math.max(maxRuns, 0)).map((c) => c.runId);
}

function beyondPartitionMaxRuns(
  sorted: readonly Candidate[],
  policy: RetentionPolicy,
): readonly string[] {
  const doomed: string[] = [];
  for (const partition of RETENTION_PARTITIONS) {
    const maxRuns = policy.maxRunsByPartition?.[partition];
    if (maxRuns === undefined) continue;
    const candidates = sorted.filter((candidate) => candidate.partition === partition);
    doomed.push(...beyondMaxRuns(candidates, maxRuns));
  }
  return doomed;
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
  for (const id of beyondPartitionMaxRuns(sorted, policy)) {
    doomed.add(id);
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

export function applyRetention(store: EvidenceStore, policy: RetentionPolicy): number {
  if (policy.disabled === true) {
    return 0;
  }
  const sorted = collectCandidates(store);
  const deleteSet = computeDeleteSet(sorted, policy);
  for (const runId of deleteSet) {
    store.delete(runId);
  }
  return deleteSet.size;
}
