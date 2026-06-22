// QI retention + deletion + restart-recovery semantics (Issue #274, ADR-0023 D8).
//
// Pure decision function (`applyQualityIntelligenceRetention`) consumed by the orchestrator with
// the current store snapshot; the orchestrator does the side effects. Idempotent deletion
// (`deleteQualityIntelligenceRun`) removes the manifest AND its companion artifacts
// (`.candidates.json` plus any caller-supplied server-owned suffixes) so a deleted run leaves no
// orphaned customer-derived content, and emits a typed deletion-receipt audit event without
// throwing on a missing run.
//
// Restart recovery is enforced at the WRITE seam: every persist is atomic O_EXCL temp + rename,
// so an unclean shutdown leaves at most one `.tmp` (or nothing). The list/load surfaces filter on
// the `.qi.json` suffix, so a half-written run is never surfaced. There is no recovery procedure
// to call — recovery IS the absence of a code path that surfaces partials.

import { lstatSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { assertValidRunId } from "@oscharko-dev/keiko-security";
import { CANDIDATES_SUFFIX } from "./candidatesArtifact.js";
import { deleteQualityIntelligenceCompanionArtifact } from "./companionStore.js";
import type { QualityIntelligenceEvidenceManifest } from "./manifestSchema.js";
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

// Companion artifacts that `keiko-evidence` OWNS and writes alongside the run manifest under
// `qi/`, keyed by `<runId>`. They are swept by default on deletion so a "deleted" run never leaves
// customer-derived generated content (`.candidates.json`) orphaned on disk (Issue #274 AC4).
// Higher layers that own their own companions (e.g. keiko-server's `.review.json`, the figma
// route companions) pass their suffixes via `QualityIntelligenceDeleteOptions.companionSuffixes`;
// keiko-evidence MUST NOT hard-code suffixes it does not own (layering). The figma-snapshot
// companion + its `figma-snapshots/<runId>/` side-files are deliberately EXCLUDED here — they have
// their own retention seam (`enforceFigmaSnapshotRetention`) and are cleaned by that subsystem.
const QI_EVIDENCE_OWNED_COMPANION_SUFFIXES: readonly string[] = Object.freeze([CANDIDATES_SUFFIX]);

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
  // Companion-artifact suffixes that were present and removed alongside the manifest (e.g.
  // `.candidates.json`). Empty when only an in-memory store was used or no companion existed.
  readonly removedCompanionSuffixes: readonly string[];
  readonly auditEvent: QualityIntelligenceRunDeletedEvent;
}

// Audit event emitted by deleteQualityIntelligenceRun. The orchestrator forwards this to the
// audit ledger; the deletion API itself does NOT call the ledger so the keiko-evidence layer
// stays leaf-clean against ADR-0019 trust-rule 6.
export interface QualityIntelligenceRunDeletedEvent {
  readonly type: "qi:run:deleted";
  readonly runId: string;
  readonly status: QualityIntelligenceDeletionStatus;
  // Companion suffixes removed with the manifest — recorded on the audit event so the ledger can
  // attest the deletion was complete for compliance (Issue #274 AC4).
  readonly removedCompanionSuffixes: readonly string[];
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
  // Additional companion-artifact suffixes owned by HIGHER layers (e.g. keiko-server's
  // `.review.json`, `.figma-codegen.json`, `.figma-audit.json`, `.figma-consent.json`). The
  // evidence-owned companions (`.candidates.json`) are ALWAYS swept when `evidenceDir` is supplied;
  // pass server-owned suffixes here so the orchestrator can guarantee a deleted run leaves no
  // orphaned artifact. Each is matched EXACTLY (`<runId><suffix>`), realpath-contained, and
  // symlink-refusing. Ignored when only an in-memory `store` is supplied (nothing on disk).
  readonly companionSuffixes?: readonly string[] | undefined;
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

function containedPath(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function realDirectoryForDeletion(path: string, label: string): string | undefined {
  const lexical = resolve(path);
  const stat = lstatSync(lexical, { throwIfNoEntry: false });
  if (stat === undefined) {
    return undefined;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a real directory, refusing to delete: ${lexical}`);
  }
  return realpathSync(lexical);
}

function realEvidenceRootForContainment(evidenceDir: string): string | undefined {
  try {
    return realpathSync(resolve(evidenceDir));
  } catch {
    return undefined;
  }
}

// Recursively removes a per-run side-file directory if it exists. Missing dir → no-op. Symlinked
// side-file roots or run dirs are refused before the manifest is deleted so retention cannot rm
// outside the evidence tree or emit a false successful deletion receipt. The evidence root itself
// may be a workspace-approved symlink; canonicalize it for containment instead of rejecting it.
function removeSideFileDirIfPresent(
  runId: string,
  sideFileRoot: string,
  evidenceDir: string | undefined,
): void {
  const root = realDirectoryForDeletion(sideFileRoot, "QI side-file root");
  if (root === undefined) {
    return;
  }
  if (evidenceDir !== undefined) {
    const evidenceRoot = realEvidenceRootForContainment(evidenceDir);
    if (evidenceRoot === undefined || !containedPath(root, evidenceRoot)) {
      throw new Error(
        `QI side-file root escapes the evidence directory, refusing to delete: ${root}`,
      );
    }
  }
  const runDir = join(root, runId);
  // Defence-in-depth: runId is already `assertValidRunId`-checked (no separators, no `..`, no
  // leading dot) before this is reached. Assert containment against the canonical side-file root so
  // symlinked roots or future validation drift cannot redirect recursive deletion outside evidence.
  if (!containedPath(runDir, root)) {
    throw new Error(`QI side-file dir escapes the side-file root, refusing to delete: ${runDir}`);
  }
  const stat = lstatSync(runDir, { throwIfNoEntry: false });
  if (stat === undefined) {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`QI side-file dir is a symlink, refusing to delete: ${runDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`QI side-file dir is not a real directory, refusing to delete: ${runDir}`);
  }
  rmSync(runDir, { recursive: true, force: true });
}

// Sweep the run's companion artifacts (evidence-owned + caller-supplied) from the contained `qi/`
// dir. Exact-suffix, idempotent: a companion that does not exist is skipped. Returns the suffixes
// that were actually removed so the deletion receipt/audit event can attest completeness.
function removeRunCompanions(
  evidenceDir: string,
  runId: string,
  extraSuffixes: readonly string[] | undefined,
): readonly string[] {
  const suffixes = [
    ...new Set<string>([...QI_EVIDENCE_OWNED_COMPANION_SUFFIXES, ...(extraSuffixes ?? [])]),
  ];
  const removed: string[] = [];
  for (const suffix of suffixes) {
    if (deleteQualityIntelligenceCompanionArtifact(evidenceDir, runId, suffix)) {
      removed.push(suffix);
    }
  }
  return removed.sort();
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
  if (options.sideFileRoot !== undefined) {
    removeSideFileDirIfPresent(runId, options.sideFileRoot, options.evidenceDir);
  }
  const removed = store.delete(runId);
  // Sweep companion artifacts so a deleted run leaves no orphaned customer-derived content on disk
  // (Issue #274 AC4). On-disk only — skipped when just an in-memory store is supplied.
  const removedCompanionSuffixes =
    options.evidenceDir === undefined
      ? []
      : removeRunCompanions(options.evidenceDir, runId, options.companionSuffixes);
  const at = new Date(options.now?.() ?? Date.now()).toISOString();
  const status: QualityIntelligenceDeletionStatus = removed ? "deleted" : "absent";
  return {
    runId,
    status,
    removedCompanionSuffixes,
    auditEvent: { type: "qi:run:deleted", runId, status, removedCompanionSuffixes, at },
  };
}

// ─── Retention enforcement orchestration (Issue #1323 AC4) ──────────────────────────

// Wires the pure decision (`applyQualityIntelligenceRetention`) to the hardened deletion primitive
// (`deleteQualityIntelligenceRun`) over a real on-disk store, so retention policy ids become
// OPERATIONAL — short-lived runs are purged deterministically rather than the id staying passive
// metadata. This function performs side effects (it lists + loads + deletes) but stays leaf-clean:
// it never calls the audit ledger. Each deletion receipt carries a `qi:run:deleted` audit event the
// CALLER (the server bootstrap seam) forwards to its audit sink — keiko-evidence does not.
//
// Fail-safe by construction: a run only enters the retention snapshot when its manifest LOADS and
// carries a PARSEABLE timestamp. A corrupt manifest, an integrity-gate failure (EvidenceReadError),
// or an unparseable `completedAt ?? planAt` is SKIPPED — never purged on doubt. Unknown-policy and
// newest-N retention are handled inside the pure decision.

export interface QualityIntelligenceRetentionEnforcementOptions {
  readonly evidenceDir: string;
  // Injectable wall-clock seam for deterministic tests; defaults to Date.now at call time.
  readonly now?: (() => number) | undefined;
  // Server-owned companion suffixes forwarded to each deletion (e.g. `.review.json`); the
  // evidence-owned `.candidates.json` is always swept by the primitive.
  readonly companionSuffixes?: readonly string[] | undefined;
  // Per-run side-file root (`<evidenceDir>/qi/`); when set, each purged run's `<root>/<runId>/` is
  // removed by the primitive alongside the manifest.
  readonly sideFileRoot?: string | undefined;
}

export interface QualityIntelligenceRetentionEnforcementResult {
  readonly receipts: readonly QualityIntelligenceDeletionReceipt[];
  readonly failures: readonly QualityIntelligenceRetentionDeletionFailure[];
  readonly result: QualityIntelligenceRetentionResult;
}

export interface QualityIntelligenceRetentionDeletionFailure {
  readonly runId: string;
  readonly message: string;
}

// Load one run's manifest and project it onto a retention snapshot entry. Returns undefined when the
// run MUST be skipped: load returned absent/corrupt (undefined or EvidenceReadError) or the
// manifest's `completedAt ?? planAt` is not a parseable timestamp. Skipping means the run never
// reaches the decision and is therefore never purged — the destructive-path fail-safe.
function snapshotEntryForRun(
  store: QualityIntelligenceLocalStore,
  runId: string,
): QualityIntelligenceRunSnapshotEntry | undefined {
  let manifest: QualityIntelligenceEvidenceManifest | undefined;
  try {
    manifest = store.load(runId);
  } catch {
    // A corrupt / tampered / unreadable manifest fails closed: skip, never delete.
    return undefined;
  }
  if (manifest === undefined) {
    return undefined;
  }
  const recordedAt = Date.parse(manifest.completedAt ?? manifest.planAt);
  if (Number.isNaN(recordedAt)) {
    // No usable timestamp → cannot age the run out safely → retain.
    return undefined;
  }
  return { runId, recordedAt, retentionPolicyId: manifest.retentionPolicyId };
}

function buildRetentionSnapshot(
  store: QualityIntelligenceLocalStore,
): readonly QualityIntelligenceRunSnapshotEntry[] {
  const snapshot: QualityIntelligenceRunSnapshotEntry[] = [];
  for (const runId of store.list()) {
    const entry = snapshotEntryForRun(store, runId);
    if (entry !== undefined) {
      snapshot.push(entry);
    }
  }
  return snapshot;
}

export function enforceQualityIntelligenceRetentionPolicy(
  options: QualityIntelligenceRetentionEnforcementOptions,
): QualityIntelligenceRetentionEnforcementResult {
  const store = createNodeQualityIntelligenceLocalStore(options.evidenceDir);
  const snapshot = buildRetentionSnapshot(store);
  const result = applyQualityIntelligenceRetention({
    snapshot,
    now: options.now?.() ?? Date.now(),
  });
  const receipts: QualityIntelligenceDeletionReceipt[] = [];
  const failures: QualityIntelligenceRetentionDeletionFailure[] = [];
  for (const runId of result.expiredRunIds) {
    try {
      receipts.push(
        deleteQualityIntelligenceRun(runId, {
          evidenceDir: options.evidenceDir,
          now: options.now,
          companionSuffixes: options.companionSuffixes,
          sideFileRoot: options.sideFileRoot,
        }),
      );
    } catch (error) {
      failures.push({
        runId,
        message: error instanceof Error ? error.message : "unknown deletion failure",
      });
    }
  }
  return { receipts, failures, result };
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
