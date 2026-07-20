import type { DatabaseSync } from "node:sqlite";
import { isCodingWorkbenchMode, type CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";

const MEMORY_CAPTURE_POLICY_ID = "capture";

export function getMemoryAutonomyMode(db: DatabaseSync): CodingWorkbenchMode | undefined {
  const row = db
    .prepare("SELECT requested_mode FROM memory_autonomy_policy WHERE id = ?")
    .get(MEMORY_CAPTURE_POLICY_ID) as { readonly requested_mode?: unknown } | undefined;
  return isCodingWorkbenchMode(row?.requested_mode) ? row.requested_mode : undefined;
}

export function setMemoryAutonomyMode(db: DatabaseSync, mode: CodingWorkbenchMode): void {
  db.prepare(
    `INSERT INTO memory_autonomy_policy (id, requested_mode)
     VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET requested_mode = excluded.requested_mode`,
  ).run(MEMORY_CAPTURE_POLICY_ID, mode);
}
