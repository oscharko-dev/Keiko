// Real-working-tree repository Knowledge Pod (Issue #2569, ADR-0152 D8).
//
// The pod attaches the existing `repository` source scope and drives the existing discovery,
// parser, chunker, lexical/vector, embedding-batcher, checkpoint, and pruning lanes. Refresh
// classification uses the shared fingerprint diff. Only the fingerprint baseline and body-free run
// record are pod-specific package-owned sidecars.

import { randomUUID } from "node:crypto";

import {
  isKnowledgePodEvidenceSafeText,
  isSafeScopePath,
  standardPodModelUsePolicy,
  type EmbeddingModelIdentity,
  type KnowledgeCapsuleId,
  type KnowledgePodModelUsePolicy,
  type KnowledgePodSummary,
  type KnowledgeSourceId,
  type KnowledgeSourceScope,
} from "@oscharko-dev/keiko-contracts";
import type { OpenAIEmbeddingAdapter } from "@oscharko-dev/keiko-model-gateway";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type { DatabaseSync } from "node:sqlite";

import { createCapsule, deleteCapsule, getCapsule } from "./capsule-lifecycle.js";
import { documentIdFor } from "./discovery/types.js";
import { deleteDocumentRow } from "./discovery/persist.js";
import { DEFAULT_DISCOVERY_OPTIONS, type DiscoveryOptions } from "./discovery/types.js";
import { KnowledgeStoreError } from "./errors.js";
import { diffFingerprintSets } from "./fingerprint-diff.js";
import {
  readRepositoryFileFingerprints,
  replaceRepositoryFileFingerprints,
  repositoryFingerprintSetDigest,
  scanRepositoryFingerprints,
  type RepositoryFileFingerprint,
} from "./indexing/repository-fingerprints.js";
import { runIndexingJob, type IndexingEvent, type IndexingResult } from "./indexing/index.js";
import { buildKnowledgePodSummary } from "./knowledge-pods.js";
import type { ParserRegistry } from "./parsers/index.js";
import type { AuditEventSink } from "./privacy/index.js";
import { addSourceToCapsule, listCapsuleSources } from "./source-lifecycle.js";
import type { KnowledgeStore } from "./store.js";

const CREATE_REPOSITORY_RUNS_SQL = `
CREATE TABLE IF NOT EXISTS repository_pod_runs (
  capsule_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'partial', 'failed', 'cancelled')),
  applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
  added_files INTEGER NOT NULL,
  changed_files INTEGER NOT NULL,
  removed_files INTEGER NOT NULL,
  unchanged_files INTEGER NOT NULL,
  failed_documents INTEGER NOT NULL,
  rejected_entries INTEGER NOT NULL,
  fingerprint_set_digest TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (capsule_id, source_id, run_id),
  FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE,
  FOREIGN KEY (capsule_id, source_id) REFERENCES capsule_sources(capsule_id, id) ON DELETE CASCADE
) STRICT;
`.trim();

export interface RepositoryPodDeps {
  readonly store: KnowledgeStore;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly now?: (() => number) | undefined;
  readonly idSource?: (() => string) | undefined;
  readonly auditSink?: AuditEventSink | undefined;
}

export interface RepositoryPodIndexingDeps extends RepositoryPodDeps {
  readonly parserRegistry: ParserRegistry;
  readonly embeddingAdapter: OpenAIEmbeddingAdapter;
  readonly workspaceFs: WorkspaceFs;
  readonly trackedPaths?: ReadonlySet<string> | undefined;
  readonly discoveryOptions?: Omit<DiscoveryOptions, "respectGitIgnore" | "signal"> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onIndexEvent?: ((event: IndexingEvent) => void) | undefined;
}

export interface CreateRepositoryPodShellInput {
  readonly displayName: string;
  readonly repositoryRoot: string;
  readonly includeGlobs?: readonly string[] | undefined;
  readonly excludeGlobs?: readonly string[] | undefined;
  readonly embeddingModelIdentity: EmbeddingModelIdentity;
  readonly modelUsePolicy?: KnowledgePodModelUsePolicy | undefined;
}

export interface RepositoryPodChangeCounts {
  readonly addedFiles: number;
  readonly changedFiles: number;
  readonly removedFiles: number;
  readonly unchangedFiles: number;
  readonly failedDocuments: number;
  readonly rejectedEntries: number;
}

export interface RepositoryPodRunRecord {
  readonly runId: string;
  readonly outcome: "succeeded" | "partial" | "failed" | "cancelled";
  readonly applied: boolean;
  readonly counts: RepositoryPodChangeCounts;
  readonly fingerprintSetDigest: string;
  readonly completedAt: number;
}

export interface RepositoryPodRefreshResult {
  readonly run: RepositoryPodRunRecord;
  readonly indexing: IndexingResult;
  readonly summary: KnowledgePodSummary;
}

export interface RefreshRepositoryPodInput {
  readonly runId?: string | undefined;
}

function ensureRunStorage(db: DatabaseSync): void {
  db.exec(CREATE_REPOSITORY_RUNS_SQL);
}

function repositoryScope(input: CreateRepositoryPodShellInput): KnowledgeSourceScope {
  if (!isSafeScopePath(input.repositoryRoot)) {
    throw new KnowledgeStoreError("repository root failed the safe-path gate");
  }
  return {
    kind: "repository",
    repositoryRoot: input.repositoryRoot,
    ...(input.includeGlobs === undefined ? {} : { includeGlobs: input.includeGlobs }),
    ...(input.excludeGlobs === undefined ? {} : { excludeGlobs: input.excludeGlobs }),
  };
}

function requireEvidenceSafeName(displayName: string): void {
  if (!isKnowledgePodEvidenceSafeText(displayName)) {
    throw new KnowledgeStoreError("repository pod display name is not evidence-safe");
  }
}

export function createRepositoryPodShell(
  deps: RepositoryPodDeps,
  input: CreateRepositoryPodShellInput,
): KnowledgePodSummary {
  requireEvidenceSafeName(input.displayName);
  createCapsule(
    deps.store,
    {
      id: deps.capsuleId,
      displayName: input.displayName,
      tags: [],
      retrievalEffort: "default",
      outputMode: "answers",
      answerGroundingPolicy: "require-citations-or-state-no-evidence",
      modelUsePolicy: input.modelUsePolicy ?? standardPodModelUsePolicy(),
      embeddingModelIdentity: input.embeddingModelIdentity,
      lifecycleState: "draft",
      storageReference: `capsules/${deps.capsuleId}`,
    },
    deps.auditSink,
  );
  addSourceToCapsule(
    deps.store,
    deps.capsuleId,
    {
      id: deps.sourceId,
      displayName: input.displayName,
      tags: [],
      scope: repositoryScope(input),
    },
    deps.auditSink,
  );
  ensureRunStorage(deps.store._internal.db);
  return buildSummary(deps.store, deps.capsuleId);
}

function buildSummary(store: KnowledgeStore, capsuleId: KnowledgeCapsuleId): KnowledgePodSummary {
  const capsule = getCapsule(store, capsuleId);
  if (capsule === undefined) throw new KnowledgeStoreError("repository capsule vanished");
  return buildKnowledgePodSummary(store, capsule);
}

function requireRepositoryScope(
  deps: RepositoryPodDeps,
): Extract<KnowledgeSourceScope, { readonly kind: "repository" }> {
  const source = listCapsuleSources(deps.store, deps.capsuleId).find(
    (candidate) => candidate.id === deps.sourceId,
  );
  if (source?.scope.kind !== "repository") {
    throw new KnowledgeStoreError("repository pod source is missing or has the wrong scope");
  }
  return source.scope;
}

function resolvedDiscoveryOptions(deps: RepositoryPodIndexingDeps): DiscoveryOptions {
  const configured = deps.discoveryOptions ?? DEFAULT_DISCOVERY_OPTIONS;
  return {
    maxDepth: configured.maxDepth,
    maxFiles: configured.maxFiles,
    respectGitIgnore: true,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  };
}

interface DrainedIndexing {
  readonly result: IndexingResult;
  readonly failedRelativePaths: ReadonlySet<string>;
}

async function drainIndexing(
  events: AsyncIterable<IndexingEvent>,
  onEvent?: (event: IndexingEvent) => void,
): Promise<DrainedIndexing> {
  let result: IndexingResult | undefined;
  const failedRelativePaths = new Set<string>();
  for await (const event of events) {
    onEvent?.(event);
    if (event.kind === "document-failed" && event.relativePath !== undefined) {
      failedRelativePaths.add(event.relativePath);
    }
    if (
      event.kind === "job-completed" ||
      event.kind === "job-failed" ||
      event.kind === "job-cancelled"
    ) {
      result = event.result;
    }
  }
  if (result === undefined)
    throw new KnowledgeStoreError("repository indexing ended without result");
  return { result, failedRelativePaths };
}

function runRepositoryIndexing(
  deps: RepositoryPodIndexingDeps,
  discoveryOptions: DiscoveryOptions,
): Promise<DrainedIndexing> {
  return drainIndexing(
    runIndexingJob({
      capsuleId: deps.capsuleId,
      sourceIds: [deps.sourceId],
      parserRegistry: deps.parserRegistry,
      workspaceFs: deps.workspaceFs,
      embeddingAdapter: deps.embeddingAdapter,
      store: deps.store,
      discoveryOptions,
      ...(deps.auditSink === undefined ? {} : { auditSink: deps.auditSink }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.idSource === undefined ? {} : { idSource: deps.idSource }),
    }),
    deps.onIndexEvent,
  );
}

function fingerprintMap(
  fingerprints: readonly RepositoryFileFingerprint[],
): ReadonlyMap<string, string> {
  return new Map(fingerprints.map((item) => [item.relativePath, item.contentFingerprint]));
}

function failedWithheldBaseline(
  fingerprints: readonly RepositoryFileFingerprint[],
  failedRelativePaths: ReadonlySet<string>,
): readonly RepositoryFileFingerprint[] {
  return fingerprints.filter((item) => !failedRelativePaths.has(item.relativePath));
}

function pruneRemovedDocuments(
  deps: RepositoryPodDeps,
  prior: ReadonlyMap<string, RepositoryFileFingerprint>,
  next: readonly RepositoryFileFingerprint[],
): void {
  const nextPaths = new Set(next.map((item) => item.relativePath));
  for (const relativePath of prior.keys()) {
    if (nextPaths.has(relativePath)) continue;
    const documentId = documentIdFor({
      capsuleId: deps.capsuleId,
      sourceId: deps.sourceId,
      relativePath,
    });
    deleteDocumentRow(deps.store._internal.db, deps.capsuleId, documentId);
  }
}

function runCounts(
  prior: ReadonlyMap<string, RepositoryFileFingerprint>,
  next: readonly RepositoryFileFingerprint[],
  result: IndexingResult,
  rejectedEntries: number,
): RepositoryPodChangeCounts {
  const delta = diffFingerprintSets(fingerprintMap([...prior.values()]), fingerprintMap(next), {
    detectMoves: false,
  });
  return {
    addedFiles: delta.added,
    changedFiles: delta.changed,
    removedFiles: delta.removed,
    unchangedFiles: delta.unchanged,
    failedDocuments: result.failedDocuments,
    rejectedEntries,
  };
}

function persistRun(deps: RepositoryPodDeps, record: RepositoryPodRunRecord): void {
  ensureRunStorage(deps.store._internal.db);
  deps.store._internal.db
    .prepare(
      `INSERT INTO repository_pod_runs (
         capsule_id, source_id, run_id, outcome, applied, added_files, changed_files,
         removed_files, unchanged_files, failed_documents, rejected_entries,
         fingerprint_set_digest, completed_at
       ) VALUES (
         :capsule_id, :source_id, :run_id, :outcome, :applied, :added_files, :changed_files,
         :removed_files, :unchanged_files, :failed_documents, :rejected_entries,
         :fingerprint_set_digest, :completed_at
       )`,
    )
    .run({
      capsule_id: deps.capsuleId,
      source_id: deps.sourceId,
      run_id: record.runId,
      outcome: record.outcome,
      applied: record.applied ? 1 : 0,
      added_files: record.counts.addedFiles,
      changed_files: record.counts.changedFiles,
      removed_files: record.counts.removedFiles,
      unchanged_files: record.counts.unchangedFiles,
      failed_documents: record.counts.failedDocuments,
      rejected_entries: record.counts.rejectedEntries,
      fingerprint_set_digest: record.fingerprintSetDigest,
      completed_at: record.completedAt,
    });
}

function buildRunRecord(
  deps: RepositoryPodDeps,
  runId: string,
  indexing: IndexingResult,
  counts: RepositoryPodChangeCounts,
  persisted: readonly RepositoryFileFingerprint[],
  applied: boolean,
): RepositoryPodRunRecord {
  const outcome = applied && counts.failedDocuments > 0 ? "partial" : indexing.status;
  return {
    runId,
    outcome,
    applied,
    counts,
    fingerprintSetDigest: repositoryFingerprintSetDigest(persisted),
    completedAt: (deps.now ?? deps.store._internal.now)(),
  };
}

function indexingResultCanApply(result: IndexingResult, rejectedEntries: number): boolean {
  if (result.status === "succeeded") return true;
  return (
    result.status === "failed" &&
    result.processedDocuments === 0 &&
    result.skippedDocuments > 0 &&
    result.failedDocuments === rejectedEntries &&
    result.lastError?.code === "DISCOVERY_FAILED:PATH_ESCAPE"
  );
}

export async function refreshRepositoryPod(
  deps: RepositoryPodIndexingDeps,
  input: RefreshRepositoryPodInput = {},
): Promise<RepositoryPodRefreshResult> {
  const scope = requireRepositoryScope(deps);
  const discovery = resolvedDiscoveryOptions(deps);
  const prior = readRepositoryFileFingerprints(deps.store, deps.capsuleId, deps.sourceId);
  const scan = await scanRepositoryFingerprints({
    fs: deps.workspaceFs,
    scope,
    discovery,
    ...(deps.trackedPaths === undefined ? {} : { trackedPaths: deps.trackedPaths }),
  });
  const runId = input.runId ?? deps.idSource?.() ?? randomUUID();
  const drained = await runRepositoryIndexing(deps, discovery);
  const next = failedWithheldBaseline(scan.fingerprints, drained.failedRelativePaths);
  const applied = indexingResultCanApply(drained.result, scan.rejectedEntries);
  if (applied) {
    replaceRepositoryFileFingerprints(
      deps.store,
      deps.capsuleId,
      deps.sourceId,
      next,
      runId,
      () => {
        pruneRemovedDocuments(deps, prior, next);
      },
    );
  }
  const persisted = applied ? next : [...prior.values()];
  const counts = runCounts(prior, scan.fingerprints, drained.result, scan.rejectedEntries);
  const run = buildRunRecord(deps, runId, drained.result, counts, persisted, applied);
  persistRun(deps, run);
  return { run, indexing: drained.result, summary: buildSummary(deps.store, deps.capsuleId) };
}

// Scope args stay positional to match the package's `list*` reader convention
// (`listConnectorSourceMetadata(store, capsuleId)`), which the barrel-surface gate in
// `index.test.ts` enforces as the Foundry-IQ no-global-pool proxy: every `list*` export other than
// the top-level capsule/set enumerations must take its scope explicitly.
export function listRepositoryPodRuns(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  sourceId: KnowledgeSourceId,
): readonly RepositoryPodRunRecord[] {
  ensureRunStorage(store._internal.db);
  interface Row {
    readonly run_id: string;
    readonly outcome: RepositoryPodRunRecord["outcome"];
    readonly applied: number;
    readonly added_files: number;
    readonly changed_files: number;
    readonly removed_files: number;
    readonly unchanged_files: number;
    readonly failed_documents: number;
    readonly rejected_entries: number;
    readonly fingerprint_set_digest: string;
    readonly completed_at: number;
  }
  const rows = store._internal.db
    .prepare(
      `SELECT run_id, outcome, applied, added_files, changed_files, removed_files,
              unchanged_files, failed_documents, rejected_entries, fingerprint_set_digest,
              completed_at
       FROM repository_pod_runs
       WHERE capsule_id = :capsule_id AND source_id = :source_id
       ORDER BY completed_at ASC, run_id ASC`,
    )
    .all({ capsule_id: capsuleId, source_id: sourceId }) as unknown as readonly Row[];
  return rows.map((row) => ({
    runId: row.run_id,
    outcome: row.outcome,
    applied: row.applied === 1,
    counts: {
      addedFiles: row.added_files,
      changedFiles: row.changed_files,
      removedFiles: row.removed_files,
      unchangedFiles: row.unchanged_files,
      failedDocuments: row.failed_documents,
      rejectedEntries: row.rejected_entries,
    },
    fingerprintSetDigest: row.fingerprint_set_digest,
    completedAt: row.completed_at,
  }));
}

export function deleteRepositoryPod(deps: RepositoryPodDeps): void {
  deleteCapsule(deps.store, deps.capsuleId, deps.auditSink);
}
