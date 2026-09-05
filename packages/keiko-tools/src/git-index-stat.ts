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
/** Stat hits avoid materializing unchanged large files; changed content always uses raw bytes. */
export function indexStatMatches(
  root: string,
  path: string,
  expected: GitIndexStat | undefined,
): boolean {
  if (expected === undefined) return false;
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
