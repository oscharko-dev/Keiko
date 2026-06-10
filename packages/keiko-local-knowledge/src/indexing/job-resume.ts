// Resume helpers for the indexing orchestrator (Epic #189, Issue #196). The orchestrator
// writes `indexing_jobs.status = 'running'` at job-started and transitions to a terminal
// status at finalize. A run that crashes between those two writes leaves an orphaned row
// in `running` state — `findResumableJob` is how a follow-up process notices that row.
//
// The function is read-only on purpose: we do NOT auto-resume here. Callers (UI surfaces,
// the eventual `keiko index --resume` CLI) decide whether to re-run, abandon, or alert.
// The returned `IndexingJobRecord` carries `resume_token` (the lexicographically-greatest
// embedded `chunk_id` from the prior run) so a resumed run can elect to skip past it.

import type { IndexingJobRecord, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";

import { rowToIndexingJobRecord, selectRunningJobByCapsule } from "./job-persist.js";
import type { KnowledgeStore } from "../store.js";

export function findResumableJob(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
): IndexingJobRecord | undefined {
  const row = selectRunningJobByCapsule(store._internal.db, capsuleId);
  return row === undefined ? undefined : rowToIndexingJobRecord(row);
}
