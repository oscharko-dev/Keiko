import { statSync } from "node:fs";

import { workspaceRootsNameSameFolder } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";

/**
 * Whether two repository roots are one folder, decided by the filesystem they live on and never by
 * the platform's default letter-case rule: a case-sensitive volume or directory can hold two
 * folders that differ only in case, and a case-insensitive one names one folder with several
 * spellings. Roots that spell the same folder exactly (separators and a trailing separator aside)
 * are the same; otherwise both are looked up and are the same only when the filesystem reports one
 * device and one file identity. A root that does not exist is never proven the same, so the caller
 * refuses (fail closed); any other lookup error propagates to the caller's own error path. Empty
 * roots never match.
 */
export function repositoryRootsAreSameFolder(left: string, right: string): boolean {
  if (left === "" || right === "") return false;
  if (workspaceRootsNameSameFolder(left, right, false)) return true;
  const first = statSync(left, { bigint: true, throwIfNoEntry: false });
  const second = statSync(right, { bigint: true, throwIfNoEntry: false });
  if (first === undefined || second === undefined) return false;
  // An identity of zero is a filesystem that reports none: it proves nothing.
  return first.ino !== 0n && first.ino === second.ino && first.dev === second.dev;
}
