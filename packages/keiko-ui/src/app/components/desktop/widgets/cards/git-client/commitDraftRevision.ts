import { useState } from "react";
import type { GitRepositoryStatusResponse } from "@oscharko-dev/keiko-contracts";

/**
 * The staged selection a generated commit draft describes: each staged path with its index status,
 * in a stable order. `null` while no status is loaded. Paths stay in memory only; the value is never
 * logged or sent.
 */
export function stagedSelectionSignature(
  status: GitRepositoryStatusResponse | null | undefined,
): string | null {
  if (status?.available !== true) return null;
  const staged = status.changes
    .filter((change) => change.staged)
    .map((change) => `${change.indexStatus}\u0000${change.oldPath ?? ""}\u0000${change.path}`)
    .sort((left, right) => left.localeCompare(right));
  return `${status.truncated ? "t" : "c"}\u0001${staged.join("\u0001")}`;
}

/**
 * The revision a generated commit draft is bound to. It moves when the staged selection changes, when
 * this window stages or unstages (the same path can be staged again with other content), and after a
 * re-pair; a status read that keeps the staged selection — a new branch from the current commit, a
 * refresh — leaves it alone. A status being read again keeps the last known selection.
 */
export function useCommitDraftRevision(
  status: GitRepositoryStatusResponse | null | undefined,
  stagingEpoch: number,
  redemptions: number,
): string {
  const [lastSignature, setLastSignature] = useState("none");
  const signature = stagedSelectionSignature(status);
  if (signature !== null && signature !== lastSignature) setLastSignature(signature);
  const current = signature ?? lastSignature;
  return `${String(redemptions)}\u0002${String(stagingEpoch)}\u0002${current}`;
}
