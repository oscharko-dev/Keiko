import { dirname } from "node:path";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import type { KnowledgeStore } from "@oscharko-dev/keiko-local-knowledge";
import {
  KnowledgeStoreError,
  openKnowledgeStore,
  resolveKnowledgeStorePath,
  updateCapsuleState,
} from "@oscharko-dev/keiko-local-knowledge";
import { localKnowledgeIndexingRegistry } from "./local-knowledge-indexing-registry.js";
import { localKnowledgeProtectionOptions } from "./localKnowledgeKeyProvider.js";
import type { UiHandlerDeps } from "./deps.js";

interface RecoverableRunningJobRow {
  readonly id: string;
  readonly capsule_id: string;
  readonly cancellation_requested: number;
}

/**
 * Finalize `running` indexing jobs that were orphaned by a crash/restart. A job is left as-is
 * while its capsule or job id is still active in the in-process registry; otherwise it is flipped
 * to `cancelled` (if a cancellation was requested) or `failed`, and its capsule is best-effort
 * marked `error`. Shared verbatim by every store opener that runs on the recovery path so the
 * body cannot drift (GEN-DUP-NEAR-001). The `rows.length === 0` fast path is harmless in every
 * caller and skips `store._internal.now()` when there is nothing to recover.
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
  for (const row of rows) {
    if (
      localKnowledgeIndexingRegistry.isActiveCapsule(row.capsule_id) ||
      localKnowledgeIndexingRegistry.isActiveJob(row.id)
    ) {
      continue;
    }
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
          : "Indexing stopped unexpectedly before completion. Restart the run to finish indexing.",
        id: row.id,
      });
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
  const store = openKnowledgeStore(protection === undefined ? { dbPath } : { dbPath, protection });
  if (options.recover === true) {
    recoverAbandonedIndexingJobs(store);
  }
  return {
    store,
    dbPath,
    close: (): void => {
      store.close();
    },
  };
}
