// QI retention + deletion + restart-recovery semantics (Issue #274, ADR-0023 D8).
//
// Pure decision function (`applyQualityIntelligenceRetention`) consumed by the orchestrator with
// the current store snapshot; the orchestrator does the side effects. Idempotent deletion
// (`deleteQualityIntelligenceRun`) removes the manifest and emits a typed deletion-receipt
// audit event without throwing on a missing run.
//
// Restart recovery is enforced at the WRITE seam: every persist is atomic O_EXCL temp + rename,
// so an unclean shutdown leaves at most one `.tmp` (or nothing). The list/load surfaces filter on
// the `.qi.json` suffix, so a half-written run is never surfaced. There is no recovery procedure
// to call — recovery IS the absence of a code path that surfaces partials.

import { lstatSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertValidRunId } from "@oscharko-dev/keiko-security";
import {
  getQualityIntelligenceRetentionProfile,
  type QualityIntelligenceRetentionProfile,
} from "./retentionPolicy.js";
import {
  createNodeQualityIntelligenceLocalStore,
  QI_SUBDIR,
  type QualityIntelligenceLoadOptions,
  type QualityIntelligenceLocalStore,
} from "./store.js";

// ─── Retention decision (pure) ─────────────────────────────────────────────────────

export interface QualityIntelligenceRunSnapshotEntry {
  readonly runId: string;
  // Epoch millis — the orchestrator derives this from the manifest's `completedAt ?? planAt`
  // (parsed once at decision time). Pure-function tests pass synthetic timestamps directly.
  readonly recordedAt: number;
  readonly retentionPolicyId: string;
}

export interface QualityIntelligenceRetentionDecisionInput {
  readonly snapshot: readonly QualityIntelligenceRunSnapshotEntry[];
  // Wall-clock seam — injectable for determinism, matching the EvidenceDeps `now()` pattern.
  readonly now: number;
}

export interface QualityIntelligenceRetentionDecision {
  readonly runId: string;
  readonly reason: "age-exceeded" | "count-exceeded";
}

export interface QualityIntelligenceRetentionResult {
  readonly expiredRunIds: readonly string[];
  readonly retainedRunIds: readonly string[];
  readonly decisions: readonly QualityIntelligenceRetentionDecision[];
}

interface ProfiledRun {
  readonly entry: QualityIntelligenceRunSnapshotEntry;
  readonly profile: QualityIntelligenceRetentionProfile | undefined;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function profileForEntry(entry: QualityIntelligenceRunSnapshotEntry): ProfiledRun {
  return { entry, profile: getQualityIntelligenceRetentionProfile(entry.retentionPolicyId) };
}

// Bucket snapshot entries by their retention-policy id so each profile is enforced
// independently. Entries with an unknown profile id are retained (forward-compat: a future schema
// migration may introduce a profile a current binary does not know).
function bucketByProfile(
  snapshot: readonly QualityIntelligenceRunSnapshotEntry[],
): Map<string, ProfiledRun[]> {
  const buckets = new Map<string, ProfiledRun[]>();
  for (const entry of snapshot) {
    const profiled = profileForEntry(entry);
    const list = buckets.get(entry.retentionPolicyId) ?? [];
    list.push(profiled);
    buckets.set(entry.retentionPolicyId, list);
  }
  return buckets;
}

function decideOneBucket(
  bucket: readonly ProfiledRun[],
  now: number,
): readonly QualityIntelligenceRetentionDecision[] {
  // The first bucket entry's profile is the bucket's profile (all entries share the same
  // retentionPolicyId by construction). Empty bucket → no decisions.
  const head = bucket[0];
  if (head === undefined) {
    return [];
  }
  const profile = head.profile;
  if (profile === undefined) {
    // Unknown profile id: retain everything (forward-compat).
    return [];
  }
  // Newest-first ordering so the "always keep newest N" guarantee is the bucket head.
  const sorted = [...bucket].sort((a, b) => b.entry.recordedAt - a.entry.recordedAt);
  const decisions: QualityIntelligenceRetentionDecision[] = [];
  const maxAgeMs = profile.retainedDays * MS_PER_DAY;
  for (let i = 0; i < sorted.length; i += 1) {
    const slot = sorted[i];
    if (slot === undefined) {
      continue;
    }
    const { entry } = slot;
    if (i >= profile.maxRunArtifacts) {
      decisions.push({ runId: entry.runId, reason: "count-exceeded" });
      continue;
    }
    if (now - entry.recordedAt > maxAgeMs) {
      decisions.push({ runId: entry.runId, reason: "age-exceeded" });
    }
  }
  return decisions;
}

// Pure retention decision. Returns the set of run ids to expire under each entry's configured
// policy. Always keeps the newest N runs per policy (count-exceeded only fires for runs at index
// >= N when sorted newest-first); age decisions are evaluated against the entry's own profile.
export function applyQualityIntelligenceRetention(
  input: QualityIntelligenceRetentionDecisionInput,
): QualityIntelligenceRetentionResult {
  const buckets = bucketByProfile(input.snapshot);
  const decisions: QualityIntelligenceRetentionDecision[] = [];
  for (const bucket of buckets.values()) {
    decisions.push(...decideOneBucket(bucket, input.now));
  }
  const expired = new Set(decisions.map((d) => d.runId));
  const expiredRunIds = [...expired].sort();
  const retainedRunIds = input.snapshot
    .map((entry) => entry.runId)
    .filter((runId) => !expired.has(runId))
    .sort();
  return { expiredRunIds, retainedRunIds, decisions };
}

// ─── Deletion (idempotent) ─────────────────────────────────────────────────────────

export type QualityIntelligenceDeletionStatus = "deleted" | "absent";

export interface QualityIntelligenceDeletionReceipt {
  readonly runId: string;
  readonly status: QualityIntelligenceDeletionStatus;
  readonly auditEvent: QualityIntelligenceRunDeletedEvent;
}

// Audit event emitted by deleteQualityIntelligenceRun. The orchestrator forwards this to the
// audit ledger; the deletion API itself does NOT call the ledger so the keiko-evidence layer
// stays leaf-clean against ADR-0019 trust-rule 6.
export interface QualityIntelligenceRunDeletedEvent {
  readonly type: "qi:run:deleted";
  readonly runId: string;
  readonly status: QualityIntelligenceDeletionStatus;
  // ISO-8601 timestamp. Injectable via options for deterministic tests; defaults to new Date().
  readonly at: string;
}

export interface QualityIntelligenceDeleteOptions extends QualityIntelligenceLoadOptions {
  // Injectable clock — bare function matching the established Keiko evidence determinism seam.
  readonly now?: (() => number) | undefined;
  // Optional per-run side-file root. When supplied (typically `<evidenceDir>/qi/`), the deletion
  // also recursively removes `<sideFileRoot>/<runId>/` so binary side-files written via
  // `writeSideFile` (planned #283 export adapters) are cleaned up alongside the manifest. Missing
  // side-file dir is a no-op; an unrelated FS error propagates as an Error so the caller knows
  // the deletion was partial.
  readonly sideFileRoot?: string | undefined;
}

function resolveDeleteStore(
  options: QualityIntelligenceDeleteOptions,
): QualityIntelligenceLocalStore {
  if (options.store !== undefined) {
    return options.store;
  }
  if (options.evidenceDir !== undefined) {
    return createNodeQualityIntelligenceLocalStore(options.evidenceDir);
  }
  throw new Error("deleteQualityIntelligenceRun requires options.store or options.evidenceDir");
}

// Recursively removes a per-run side-file directory if it exists. Missing dir → no-op.
// A symlink at the run-dir path is refused (defence against a planted symlink redirecting the
// rm into an unrelated tree).
function removeSideFileDirIfPresent(runId: string, sideFileRoot: string): void {
  const runDir = join(sideFileRoot, runId);
  const stat = lstatSync(runDir, { throwIfNoEntry: false });
  if (stat === undefined) {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`QI side-file dir is a symlink, refusing to delete: ${runDir}`);
  }
  rmSync(runDir, { recursive: true, force: true });
}

// Idempotent removal of a single QI run's local state. Returns a structured receipt rather than
// throwing on a missing run — callers (UI, retention orchestrator) need to distinguish "deleted"
// from "absent" without try/catch noise. When options.sideFileRoot is set, also removes
// `<sideFileRoot>/<runId>/` so binary side-files written by future export adapters are cleaned
// up alongside the manifest.
export function deleteQualityIntelligenceRun(
  runId: string,
  options: QualityIntelligenceDeleteOptions = {},
): QualityIntelligenceDeletionReceipt {
  assertValidRunId(runId);
  const store = resolveDeleteStore(options);
  const removed = store.delete(runId);
  if (options.sideFileRoot !== undefined) {
    removeSideFileDirIfPresent(runId, options.sideFileRoot);
  }
  const at = new Date(options.now?.() ?? Date.now()).toISOString();
  const status: QualityIntelligenceDeletionStatus = removed ? "deleted" : "absent";
  return {
    runId,
    status,
    auditEvent: { type: "qi:run:deleted", runId, status, at },
  };
}

// ─── Corrupt-manifest quarantine ───────────────────────────────────────────────────

// A corrupt QI manifest (failed JSON parse / failed schema-version gate) is quarantined to
// `<runId>.qi.json.corrupt.<iso>` so a single bad file never bricks the entire QI store. This
// mirrors the UI-DB quarantine pattern at packages/keiko-server/src/store/db.ts:193 and the
// memory-vault sidecar pattern (ADR-0019 trust-rule 6 evidence callers).
//
// The function is intentionally a thin FS primitive — it does NOT call `store.load()`. Callers
// detect corruption (`EvidenceReadError` from the store), then call this helper to move the bad
// file aside and re-attempt the read on the now-empty slot. The orchestrator threads it together;
// the store itself stays fail-closed.
export interface QualityIntelligenceQuarantineOptions {
  // Injectable clock — defaults to `new Date()`.
  readonly now?: (() => number) | undefined;
}

export interface QualityIntelligenceQuarantineReceipt {
  readonly originalPath: string;
  readonly quarantinedPath: string;
  readonly status: "quarantined" | "absent";
}

export function quarantineCorruptQualityIntelligenceManifest(
  evidenceDir: string,
  runId: string,
  options: QualityIntelligenceQuarantineOptions = {},
): QualityIntelligenceQuarantineReceipt {
  assertValidRunId(runId);
  const baseDir = join(evidenceDir, QI_SUBDIR);
  const originalPath = join(baseDir, `${runId}.qi.json`);
  const stat = lstatSync(originalPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    return { originalPath, quarantinedPath: originalPath, status: "absent" };
  }
  const ts = new Date(options.now?.() ?? Date.now()).toISOString();
  const quarantinedPath = `${originalPath}.corrupt.${ts}`;
  renameSync(originalPath, quarantinedPath);
  return { originalPath, quarantinedPath, status: "quarantined" };
}

// ─── Restart recovery ──────────────────────────────────────────────────────────────

// Restart recovery is a property of the store, not a procedure. The atomic-write contract
// (O_EXCL temp + rename) guarantees a power loss leaves either the full pre-write state or the
// full post-write state. The list surface filters on the `<runId>.qi.json` suffix; temp files
// (`<runId>.qi.json.<uuid>.tmp`) are invisible to it. This function is the explicit attestation
// of that property — callers can document recovery semantics by calling it and seeing the
// (full-load, partial-skip) accounting.
export interface QualityIntelligenceRecoverySnapshot {
  readonly loadedRunIds: readonly string[];
  readonly skippedRunIds: readonly string[];
}

export function snapshotQualityIntelligenceRunsForRecovery(
  store: QualityIntelligenceLocalStore,
): QualityIntelligenceRecoverySnapshot {
  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const runId of store.list()) {
    const manifest = store.load(runId);
    if (manifest === undefined) {
      skipped.push(runId);
      continue;
    }
    loaded.push(runId);
  }
  return { loadedRunIds: loaded.sort(), skippedRunIds: skipped.sort() };
}
