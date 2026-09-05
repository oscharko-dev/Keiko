import { dirname } from "node:path";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { assertContainedRealPath, resolveWithinWorkspace } from "@oscharko-dev/keiko-workspace";

export interface GitIndexStat {
  readonly ctimeNs: string;
  readonly mtimeNs: string;
  readonly size: number;
}
function timestamp(line: string, prefix: string): string {
  if (!line.startsWith(prefix)) throw new TypeError("git-index-stat-invalid");
  const match = /^(\d+):(\d+)$/u.exec(line.slice(prefix.length));
  if (match?.[1] === undefined || match[2] === undefined)
    throw new TypeError("git-index-stat-invalid");
  return String(BigInt(match[1]) * 1_000_000_000n + BigInt(match[2]));
}
export function parseGitIndexStat(output: string): ReadonlyMap<string, GitIndexStat> {
  const result = new Map<string, GitIndexStat>();
  let rest = output;
  while (rest.length > 0) {
    const end = rest.indexOf("\0");
    if (end < 1) throw new TypeError("git-index-stat-invalid");
    const path = rest.slice(0, end);
    const lines = rest.slice(end + 1).split("\n", 5);
    if (lines.length !== 5) throw new TypeError("git-index-stat-invalid");
    const size = /^ {2}size: (\d+)\tflags: ([a-f\d]+)$/u.exec(lines[4] ?? "");
    if (size?.[1] === undefined || result.has(path)) throw new TypeError("git-index-stat-invalid");
    result.set(path, {
      ctimeNs: timestamp(lines[0] ?? "", "  ctime: "),
      mtimeNs: timestamp(lines[1] ?? "", "  mtime: "),
      size: Number(size[1]),
    });
    rest = rest.slice(end + 1 + lines.reduce((count, line) => count + line.length + 1, 0));
  }
  return result;
}
/**
 * Stat hits avoid materializing unchanged large files; changed content always uses raw bytes.
 *
 * Owner audit finding b2-7: a stat match alone is not sufficient. git's own `read-cache.c` treats a
 * cached entry as "racily clean" — and re-reads its content rather than trusting the cache — when
 * the entry's recorded mtime is not strictly older than the index file's own last-write time,
 * because a same-length rewrite that lands within the filesystem's timestamp granularity after
 * staging can leave size/ctime/mtime unchanged from the index's point of view while the worktree
 * content has moved on. `indexWriteTimeNs`, when the caller can supply it, applies that identical
 * guard here: an entry whose mtime is at or after the index's own write time is reported as NOT
 * matching, which sends the caller back to a real content read instead of trusting the stale cache.
 * Omitting it preserves this function's prior (pre-guard) behaviour for a caller that cannot yet
 * supply the index's write time.
 */
export function indexStatMatches(
  root: string,
  path: string,
  expected: GitIndexStat | undefined,
  indexWriteTimeNs?: string,
): boolean {
  if (expected === undefined) return false;
  if (indexWriteTimeNs !== undefined && BigInt(expected.mtimeNs) >= BigInt(indexWriteTimeNs))
    return false;
  const absolute = resolveWithinWorkspace(root, path);
  if (!nodeWorkspaceFs.exists(absolute)) return false;
  assertContainedRealPath(nodeWorkspaceFs, root, dirname(absolute), "git-raw-parent");
  const stat = nodeWorkspaceFs.stat(absolute);
  return (
    stat.isFile &&
    stat.hardLinkCount === 1 &&
    stat.size === expected.size &&
    stat.ctimeNs === expected.ctimeNs &&
    stat.mtimeNs === expected.mtimeNs
  );
}
