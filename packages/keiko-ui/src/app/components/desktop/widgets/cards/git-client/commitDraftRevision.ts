import { useState } from "react";
import type { GitRepositoryStatusResponse } from "@oscharko-dev/keiko-contracts";
import type { GitBranchListEntry } from "@/lib/api";

const UNKNOWN_HEAD = "unknown-head";

/**
 * The commit the staged changes would be committed on: the tip of the current branch, or a constant
 * for a detached HEAD. An empty branch list (an unborn HEAD has no ref, and a list not read yet looks
 * the same) yields an explicit unknown-head marker, so the staged selection still binds the draft.
 * `null` while a non-empty branch list does not name the current branch yet (a branch just created is
 * read after the status).
 */
function headCommitOf(
  status: GitRepositoryStatusResponse,
  branches: readonly GitBranchListEntry[],
): string | null {
  if (status.detached) return "detached";
  const current = branches.find((branch) => branch.name === status.branch);
  if (current !== undefined) return current.headRefHash;
  return branches.length === 0 ? UNKNOWN_HEAD : null;
}

/**
 * What a generated commit draft describes: the staged patch and its reported paths. This identity
 * stays in memory and is never logged or sent.
 *
 * A new branch from the current commit keeps it, as does any status read that changes nothing
 * staged. The status digest includes both sides of each staged change, so branch metadata arriving
 * later cannot invalidate an unchanged patch. On a server without the digest, fall back to the
 * branch tip and each staged path. A detached tip is unknown on that fallback path.
 */
export function stagedSelectionSignature(
  status: GitRepositoryStatusResponse | null | undefined,
  branches: readonly GitBranchListEntry[],
): string | null {
  if (status?.available !== true) return null;
  const identity =
    status.stagedDigest === undefined
      ? headCommitOf(status, branches)
      : `staged:${status.stagedDigest}`;
  if (identity === null) return null;
  const staged = status.changes
    .filter((change) => change.staged)
    .map((change) => `${change.indexStatus}\u0000${change.oldPath ?? ""}\u0000${change.path}`)
    .sort((left, right) => left.localeCompare(right));
  return [identity, status.truncated ? "t" : "c", ...staged].join("\u0001");
}

interface LastSignature {
  readonly repository: string | null;
  readonly signature: string;
}

/**
 * The revision a generated commit draft is bound to. It moves when another repository is selected,
 * when the commit or the staged selection under it changes, when this window stages or unstages (the
 * same path can be staged again with other content), and after a re-pair. While a status or the
 * branch list is being read again, the last known signature of the same repository stands.
 */
export function useCommitDraftRevision(
  repository: string | null,
  status: GitRepositoryStatusResponse | null | undefined,
  branches: readonly GitBranchListEntry[],
  epochs: { readonly staging: number; readonly redemptions: number },
): string {
  const [last, setLast] = useState<LastSignature>({ repository, signature: "none" });
  const signature = stagedSelectionSignature(status, branches);
  if (signature !== null && (signature !== last.signature || repository !== last.repository)) {
    setLast({ repository, signature });
  }
  // A signature of the previous repository never stands in for the newly selected one.
  const known = last.repository === repository ? last.signature : "none";
  return [
    repository ?? "",
    String(epochs.redemptions),
    String(epochs.staging),
    signature ?? known,
  ].join("\u0002");
}
