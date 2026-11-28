import { statSync } from "node:fs";

import { workspaceRootsNameSameFolder } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";

/**
 * Text identity under the host's own path syntax. A backslash separates folders only on Windows; on
 * a POSIX host it is an ordinary file-name character, so `a\b` and `a/b` are two folders and only
 * the filesystem lookup may call them one.
 */
function spellSameFolder(left: string, right: string): boolean {
  if (process.platform === "win32") return workspaceRootsNameSameFolder(left, right, false);
  return trimTrailingSlashes(left) === trimTrailingSlashes(right);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value.charAt(end - 1) === "/") end -= 1;
  return value.slice(0, end);
}

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
  if (spellSameFolder(left, right)) return true;
  const first = statSync(left, { bigint: true, throwIfNoEntry: false });
  const second = statSync(right, { bigint: true, throwIfNoEntry: false });
  if (first === undefined || second === undefined) return false;
  // An identity of zero is a filesystem that reports none: it proves nothing.
  return first.ino !== 0n && first.ino === second.ino && first.dev === second.dev;
}
