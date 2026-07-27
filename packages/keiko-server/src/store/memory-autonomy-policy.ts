import type { DatabaseSync } from "node:sqlite";
import {
  compareCodingWorkbenchModeAuthority,
  isCodingWorkbenchMode,
  type CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";
import type { MemoryAutonomyPolicyRecord } from "./types.js";

const MEMORY_CAPTURE_POLICY_ID = "capture";

function policyRecord(row: unknown): MemoryAutonomyPolicyRecord | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const candidate = row as Record<string, unknown>;
  return isCodingWorkbenchMode(candidate.requested_mode) &&
    Number.isSafeInteger(candidate.revision) &&
    Number(candidate.revision) >= 0
    ? { requestedMode: candidate.requested_mode, revision: Number(candidate.revision) }
    : undefined;
}

export function readMemoryAutonomyPolicy(db: DatabaseSync): MemoryAutonomyPolicyRecord | undefined {
  const row = db
    .prepare("SELECT requested_mode, revision FROM memory_autonomy_policy WHERE id = ?")
    .get(MEMORY_CAPTURE_POLICY_ID);
  return policyRecord(row);
}

function updateIsAllowed(
  current: MemoryAutonomyPolicyRecord | undefined,
  mode: CodingWorkbenchMode,
  expectedRevision: number,
): boolean {
  if (current === undefined) return expectedRevision === 0;
  return (
    current.revision === expectedRevision ||
    (expectedRevision < current.revision &&
      compareCodingWorkbenchModeAuthority(mode, current.requestedMode) < 0)
  );
}

export function updateMemoryAutonomyPolicy(
  db: DatabaseSync,
  mode: CodingWorkbenchMode,
  expectedRevision: number,
): MemoryAutonomyPolicyRecord | undefined {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = readMemoryAutonomyPolicy(db);
    if (!updateIsAllowed(current, mode, expectedRevision)) {
      db.exec("COMMIT");
      return undefined;
    }
    const revision = (current?.revision ?? 0) + 1;
    if (current === undefined) {
      db.prepare(
        "INSERT INTO memory_autonomy_policy (id, requested_mode, revision) VALUES (?, ?, ?)",
      ).run(MEMORY_CAPTURE_POLICY_ID, mode, revision);
    } else {
      db.prepare(
        "UPDATE memory_autonomy_policy SET requested_mode = ?, revision = ? WHERE id = ?",
      ).run(mode, revision, MEMORY_CAPTURE_POLICY_ID);
    }
    db.exec("COMMIT");
    return { requestedMode: mode, revision };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
