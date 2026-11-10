// Linked-worktree `.git` pointer fixtures for suites that run on Windows hosts as well as POSIX
// ones (#4068).
//
// Git for Windows marks a worktree's `.git` file hidden, and Windows refuses a truncating open of a
// hidden file (`writeFileSync` with its default `w` flag fails with EPERM). Deleting the file first
// would work, but it gives the pointer a new file identity, and the managed-worktree identity binds
// that identity: a suite that means "the same pointer with other bytes" would then test a replaced
// one. This rewrites the pointer in place on every host, keeping its file identity.
// Shared fixture modules live under `src/test-support/` (KEIKO-0130): outside the build, coverage
// and Sonar scope.

import { truncateSync, writeFileSync } from "node:fs";

export function rewriteGitPointerInPlace(path: string, contents: string): void {
  writeFileSync(path, contents, { flag: "r+" });
  truncateSync(path, Buffer.byteLength(contents, "utf8"));
}
