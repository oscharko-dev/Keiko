import { dirname } from "node:path";
import type { CapsuleHealth, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type {
  KnowledgeStore,
  VectorIndexOptions,
  VectorIndexUnexpectedFailureDiagnostic,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  createLocalKnowledgeStoreVectorIndexPort,
  findResumableJob,
  KnowledgeStoreError,
  openKnowledgeStore,
  resolveVectorIndexOptions,
  resolveKnowledgeStorePath,
  updateCapsuleState,
  vectorIndexPortAsKnowledgeAdapter,
} from "@oscharko-dev/keiko-local-knowledge";
import { localKnowledgeIndexingRegistry } from "./local-knowledge-indexing-registry.js";
import { localKnowledgeProtectionOptions } from "./localKnowledgeKeyProvider.js";
import type { UiHandlerDeps } from "./deps.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import { processServerLogSink } from "./process-log-sink.js";

type ResumableIndexingJobRecord = NonNullable<ReturnType<typeof findResumableJob>>;

interface RecoverableRunningJobRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly cancellation_requested: number;
}

export interface IndexingRecoveryCandidate {
  readonly state: NonNullable<CapsuleHealth["indexingRecovery"]>["state"];
  readonly job: ResumableIndexingJobRecord;
}

// eslint-disable-next-line no-control-regex -- durable tokens containing control bytes fail closed
const RESUME_TOKEN_CONTROL_CHAR = /[\u0000-\u001f\u007f]/u;

function isValidResumeToken(token: ResumableIndexingJobRecord["resumeToken"]): boolean {
  return (
    token !== undefined &&
    token.length > 0 &&
    token.length <= 1024 &&
    token.trim() === token &&
    !RESUME_TOKEN_CONTROL_CHAR.test(token)
  );
}

function isValidResumeSourceIds(sourceIds: readonly string[]): boolean {
  return (
    sourceIds.length > 0 &&
    sourceIds.every((sourceId) => sourceId.length > 0 && sourceId.trim() === sourceId)
  );
}

function isValidResumableJob(job: ResumableIndexingJobRecord): boolean {
  return isValidResumeToken(job.resumeToken) && isValidResumeSourceIds(job.sourceIds);
}

export function findIndexingRecoveryCandidate(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): IndexingRecoveryCandidate | undefined {
  const job = findResumableJob(store, capsuleId);
  if (job === undefined) return undefined;
  if (
    localKnowledgeIndexingRegistry.isActiveCapsule(String(capsuleId)) ||
    localKnowledgeIndexingRegistry.isActiveJob(job.id)
  ) {
    return { state: "active", job };
  }
  return isValidResumableJob(job) ? { state: "resumable", job } : undefined;
}

function finalizeAbandonedJob(
  store: KnowledgeStore,
  row: RecoverableRunningJobRow,
  finishedAt: number,
): void {
  const cancelled = row.cancellation_requested === 1;
  store._internal.db
    .prepare(
      [
        "UPDATE indexing_jobs SET",
        "  status = :status,",
        "  finished_at = :finished_at,",
        "  last_error_code = :error_code,",
        "  last_error_message = :error_message",
        "WHERE id = :id AND status = 'running'",
      ].join(" "),
    )
    .run({
      status: cancelled ? "cancelled" : "failed",
      finished_at: finishedAt,
      error_code: cancelled ? "CANCELLED" : "INDEXING_INTERRUPTED",
      error_message: cancelled
        ? "Indexing was cancelled before the run could be finalized."
        : "Indexing stopped unexpectedly and cannot be resumed safely.",
      id: row.id,
    });
}

function isActiveRunningRow(row: RecoverableRunningJobRow): boolean {
  return (
    localKnowledgeIndexingRegistry.isActiveCapsule(row.capsule_id) ||
    localKnowledgeIndexingRegistry.isActiveJob(row.id)
  );
}

function candidateForRow(
  store: KnowledgeStore,
  row: RecoverableRunningJobRow,
  resumableByCapsule: Map<string, ResumableIndexingJobRecord | undefined>,
): ResumableIndexingJobRecord | undefined {
  if (!resumableByCapsule.has(row.capsule_id)) {
    resumableByCapsule.set(
      row.capsule_id,
      findResumableJob(store, row.capsule_id as KnowledgeCapsuleId),
    );
  }
  return resumableByCapsule.get(row.capsule_id);
}

function shouldPreserveRunningRow(
  row: RecoverableRunningJobRow,
  candidate: ResumableIndexingJobRecord | undefined,
): boolean {
  return (
    row.cancellation_requested !== 1 && candidate?.id === row.id && isValidResumableJob(candidate)
  );
}

/**
 * Preserve the latest valid resumable job per capsule; finalize active-looking rows that cannot
 * safely resume. In-process jobs are never touched. Repeated recovery is idempotent because a
 * preserved row remains the same `findResumableJob` candidate and terminal rows leave the query.
 */
export function recoverAbandonedIndexingJobs(store: KnowledgeStore): void {
  const rows = store._internal.db
    .prepare(
      [
        "SELECT id, capsule_id, cancellation_requested",
        "FROM indexing_jobs",
        "WHERE status = 'running'",
        "ORDER BY started_at ASC, id ASC",
      ].join(" "),
    )
    .all() as unknown as readonly RecoverableRunningJobRow[];
  if (rows.length === 0) {
    return;
  }
  const finishedAt = store._internal.now();
  const resumableByCapsule = new Map<string, ResumableIndexingJobRecord | undefined>();
  for (const row of rows) {
    if (isActiveRunningRow(row)) continue;
    const candidate = candidateForRow(store, row, resumableByCapsule);
    if (shouldPreserveRunningRow(row, candidate)) continue;
    finalizeAbandonedJob(store, row, finishedAt);
    try {
      updateCapsuleState(store, row.capsule_id as KnowledgeCapsuleId, "error");
    } catch {
      // informational only — the recovered job row is the durable source of truth
    }
  }
}

export interface OpenKnowledgeStoreForDeps {
  readonly store: KnowledgeStore;
  readonly dbPath: string;
  readonly vectorIndex: VectorIndexOptions;
  close(): void;
}

export interface OpenKnowledgeStoreForDepsOptions {
  /**
   * When true, orphaned `running` jobs are finalized before the handle is returned. The hot read
   * path (grounded ask/preview) passes false so a concurrent, actively-running indexing job is
   * never mistaken for an abandoned one and flipped to `failed`; the capsule-management handlers
   * and the remediation path pass true because they open the store to reconcile state after a
   * potential restart.
   */
  readonly recover?: boolean;
}

/**
 * Shared store-open boilerplate: resolve the UI runtime-state dir, resolve the knowledge store
 * path, layer the local-knowledge protection options, open the store, and (optionally) run
 * abandoned-job recovery. Every deps-based opener funnels through here so the resolution order
 * cannot drift (GEN-DUP-NEAR-006). Callers wrap the returned shape to expose exactly the fields
 * their external contract promises.
 */
export function openKnowledgeStoreForDeps(
  deps: UiHandlerDeps,
  options: OpenKnowledgeStoreForDepsOptions = {},
): OpenKnowledgeStoreForDeps {
  const root =
    deps.uiDbPath === undefined || deps.uiDbPath.length === 0 ? undefined : dirname(deps.uiDbPath);
  if (root === undefined) {
    throw new KnowledgeStoreError("UI runtime-state path is unavailable.");
  }
  const dbPath = resolveKnowledgeStorePath({ runtimeStateDir: root });
  const protection = localKnowledgeProtectionOptions(deps.localKnowledgeKeyProvider);
  const openOptions = localKnowledgeVectorIndexOptions(deps);
  // `logSink` is not optional decoration on this call: store recovery is otherwise SILENT. A
  // database confirmed corrupt is renamed aside and a fresh empty one takes its place, and a
  // wrong key against an encrypted store fails closed behind an opaque server error. Both are
  // exactly the "my capsules vanished" reports this log exists to explain.
  const logSink = processServerLogSink();
  const store = openKnowledgeStore(
    protection === undefined
      ? { dbPath, vectorIndex: openOptions, logSink }
      : { dbPath, protection, vectorIndex: openOptions, logSink },
  );
  if (options.recover === true) {
    recoverAbandonedIndexingJobs(store);
  }
  // ADR-0152 D3: knowledge retrieval is served through the pillar-neutral `VectorIndexPort`.
  // The port implementation is bound to THIS store; the adapter shim wires it into the
  // existing `VectorIndexOptions.adapter` seam so `tryVectorIndexForCapsule` keeps using the
  // same call, and the `openOptions` (which decide native-runtime resolution) are passed
  // through without their adapter slot so the port dispatch does not re-enter through itself.
  const vectorIndex: VectorIndexOptions = {
    ...openOptions,
    adapter: vectorIndexPortAsKnowledgeAdapter(
      createLocalKnowledgeStoreVectorIndexPort({
        namespace: "knowledge",
        store,
        vectorIndexOptions: openOptions,
      }),
    ),
  };
  return {
    store,
    dbPath,
    vectorIndex,
    close: (): void => {
      store.close();
    },
  };
}

export function localKnowledgeVectorIndexOptions(
  deps: Pick<UiHandlerDeps, "diagnostics" | "env">,
): VectorIndexOptions {
  return {
    ...resolveVectorIndexOptions(undefined, deps.env),
    onUnexpectedFailure: (failure): void => {
      reportUnexpectedVectorIndexFailure(deps.diagnostics, failure);
    },
  };
}

function reportUnexpectedVectorIndexFailure(
  diagnostics: UiHandlerDeps["diagnostics"],
  failure: VectorIndexUnexpectedFailureDiagnostic,
): void {
  emitServerDiagnostic(
    diagnostics,
    serverDiagnosticFromError({
      correlationId: failure.correlationId,
      operation: failure.operation,
      source: failure.source,
      error: failure.error,
      summary: "Local knowledge vector-index search failed.",
      redact: () => "Local knowledge vector-index search failed.",
    }),
  );
}
