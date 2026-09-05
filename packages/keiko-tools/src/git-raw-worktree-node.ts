// Content-scoped raw status/diff reader for the commit-facts and editor-diff paths (draftDeliveryFacts.ts
// runtime status/diff, not the mutation gateways). `readGitRawWorktreeSnapshot` below produces a
// `GitWorktreeSnapshot` shape ONLY to satisfy that shared type; it never probes the branch's upstream
// tracking relation, so `hasUpstream`/`aheadCount`/`behindCount` are fixed at disengaged values (false/0/0)
// by construction. It MUST NOT be used as the snapshotReader for push preflight (`preflightPush` in
// `git-mutation-preflight.ts`) — that would silently disable the non-fast-forward and nothing-to-push
// checks for every push. A push effect must read the real tracking state via `readGitWorktreeSnapshot`
// (`git-worktree-snapshot-node.ts`) instead.
import { parseGitIndexStat, indexStatMatches, type GitIndexStat } from "./git-index-stat.js";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import { readGitStageFile } from "@oscharko-dev/keiko-workspace/internal/git-index";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import type { GitChangedFile, GitStatusCode } from "@oscharko-dev/keiko-contracts";
import { isRootRelativeFileIdentifier } from "@oscharko-dev/keiko-contracts/runtime/editor-workspace-path";
import { gitBlobObjectId, gitIndexEntriesDigest, type IndexEntry } from "./git-index-identity.js";
import {
  readGitIndexStat,
  readGitIndexEntries,
  readGitTreeEntries,
  readGitRevision,
  readGitFullRef,
  readGitRemoteAliases,
  readGitUntrackedPaths,
  readGitIndexTreeDigest,
  type NodeGitWorktreeReaderDeps,
} from "./git-worktree-snapshot-node.js";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";

const MAX_INSPECTED_PATHS = 10_000;
const MAX_CONTENT_BYTES = 8_388_608;
export interface GitRawChanges {
  readonly headSha: string;
  readonly branch: string;
  readonly stagedTreeDigest: string;
  readonly changes: readonly GitChangedFile[];
  readonly truncated: boolean;
}
function allowedPath(path: string): boolean {
  return isRootRelativeFileIdentifier(path) && !isDenied(path) && !path.includes("\uFFFD");
}
function indexStatus(head: IndexEntry | undefined, index: IndexEntry | undefined): GitStatusCode {
  if (head === undefined) return index === undefined ? " " : "A";
  if (index === undefined) return "D";
  return head.mode === index.mode && head.objectId === index.objectId ? " " : "M";
}
function changed(
  path: string,
  staged: GitStatusCode,
  worktree: GitStatusCode,
  untracked: boolean,
): GitChangedFile {
  return {
    path,
    indexStatus: untracked ? "?" : staged,
    worktreeStatus: untracked ? "?" : worktree,
    staged: staged !== " ",
    unstaged: worktree !== " " && !untracked,
    untracked,
    conflicted: false,
  };
}
async function inspectWorkingFile(
  deps: NodeGitWorktreeReaderDeps,
  path: string,
  index: IndexEntry | undefined,
  remainingBytes: number,
): Promise<{ status: GitStatusCode; bytes: number; untracked: boolean }> {
  const file = await readGitStageFile(deps.workspace.root, path, remainingBytes);
  if (index === undefined)
    return { status: " ", bytes: file.bytes.length, untracked: file.mode !== "0" };
  if (file.mode === "0") return { status: "D", bytes: 0, untracked: false };
  const same =
    file.mode === index.mode &&
    gitBlobObjectId(file.bytes, index.objectId.length) === index.objectId;
  return { status: same ? " " : "M", bytes: file.bytes.length, untracked: false };
}
export async function readGitRawChanges(deps: NodeGitWorktreeReaderDeps): Promise<GitRawChanges> {
  const headSha = await readGitRevision(deps, "HEAD");
  const branch = (await readGitFullRef(deps, "HEAD")).replace(/^refs\/heads\//u, "");
  const index = new Map((await readGitIndexEntries(deps)).map((entry) => [entry.path, entry]));
  const head = new Map(
    (await readGitTreeEntries(deps, headSha)).map((entry) => [entry.path, entry]),
  );
  const paths = [
    ...new Set([...index.keys(), ...head.keys(), ...(await readGitUntrackedPaths(deps))]),
  ].sort(compareStrings);
  const scanned = await scanPaths(
    deps,
    paths,
    head,
    index,
    parseGitIndexStat(await readGitIndexStat(deps)),
  );
  const stagedTreeDigest = gitIndexEntriesDigest([...index.values()]);
  if (
    (await readGitIndexTreeDigest(deps)) !== stagedTreeDigest ||
    (await readGitRevision(deps, "HEAD")) !== headSha ||
    (await readGitFullRef(deps, "HEAD")) !== `refs/heads/${branch}`
  )
    throw new Error("git-raw-snapshot-drift");
  return { headSha, branch, stagedTreeDigest, ...scanned };
}
async function scanPaths(
  deps: NodeGitWorktreeReaderDeps,
  paths: readonly string[],
  head: ReadonlyMap<string, IndexEntry>,
  index: ReadonlyMap<string, IndexEntry>,
  stats: ReadonlyMap<string, GitIndexStat>,
): Promise<Pick<GitRawChanges, "changes" | "truncated">> {
  const changes: GitChangedFile[] = [];
  let total = 0;
  let truncated = paths.length > MAX_INSPECTED_PATHS;
  for (const path of paths.slice(0, MAX_INSPECTED_PATHS)) {
    if (deps.signal?.aborted === true) throw new Error("git-raw-read-cancelled");
    if (!allowedPath(path)) {
      truncated = true;
      continue;
    }
    if (total >= MAX_CONTENT_BYTES) {
      truncated = true;
      break;
    }
    const working = await workingStatus(deps, path, head, index, stats, MAX_CONTENT_BYTES - total);
    total += working.bytes;
    const staged = indexStatus(head.get(path), index.get(path));
    if (staged !== " " || working.status !== " " || working.untracked)
      changes.push(changed(path, staged, working.status, working.untracked));
  }
  return { changes, truncated };
}
async function workingStatus(
  deps: NodeGitWorktreeReaderDeps,
  path: string,
  head: ReadonlyMap<string, IndexEntry>,
  index: ReadonlyMap<string, IndexEntry>,
  stats: ReadonlyMap<string, GitIndexStat>,
  remainingBytes: number,
): Promise<{ status: GitStatusCode; bytes: number; untracked: boolean }> {
  return index.has(path) &&
    index.get(path)?.mode === head.get(path)?.mode &&
    indexStatMatches(deps.workspace.root, path, stats.get(path))
    ? { status: " " as const, bytes: 0, untracked: false }
    : await inspectWorkingFile(deps, path, index.get(path), remainingBytes);
}

/**
 * Read-only status shape for the commit-facts / editor-diff callers only.
 *
 * `hasUpstream`, `aheadCount` and `behindCount` are NOT derived from the repository — this reader
 * never inspects the upstream tracking relation — and are fixed at their disengaged values so the
 * result type-checks as a `GitWorktreeSnapshot`. Do not wire this reader in as a push effect's
 * `snapshotReader`: `preflightPush` trusts these fields to decide non-fast-forward / nothing-to-push,
 * and disengaged values make both checks silently no-op. Use `readGitWorktreeSnapshot` for that.
 */
export async function readGitRawWorktreeSnapshot(
  deps: NodeGitWorktreeReaderDeps,
): Promise<GitWorktreeSnapshot> {
  const raw = await readGitRawChanges(deps);
  if (raw.truncated) throw new Error("git-raw-snapshot-incomplete");
  return {
    headSha: raw.headSha,
    stagedTreeDigest: raw.stagedTreeDigest,
    currentBranchName: raw.branch,
    headDetached: false,
    stagedFileCount: raw.changes.filter((file) => file.staged).length,
    unstagedFileCount: raw.changes.filter((file) => file.unstaged).length,
    untrackedFileCount: raw.changes.filter((file) => file.untracked).length,
    // Not probed by this reader — see the header comment and the doc comment above.
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    existingLocalBranchNames: [raw.branch],
    remoteAliases: await readGitRemoteAliases(deps),
  };
}
