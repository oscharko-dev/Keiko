// The path- and ref-safe leaf name of one review run (Issue #4133).
//
// Run ids may contain `:`, which neither a Windows path segment nor a Git ref name may hold, so the
// review worktree directory (`<review root>/<leaf>`) and the local-range private ref
// (`refs/keiko-review/local/<leaf>`) use a domain-separated digest of the run id instead. The leaf
// carries no run content and has one fixed shape on every platform.

import { sha256Hex } from "@oscharko-dev/keiko-security";

export const REVIEW_RUN_LEAF_PATTERN = /^r-[a-f0-9]{24}$/u;

export function reviewRunLeaf(runId: string): string {
  const digest = sha256Hex(`keiko-review/leaf:${runId}`);
  return `r-${digest.slice(0, 24)}`;
}
