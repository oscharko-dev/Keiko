// Content-scoped raw status/diff reader for the commit-facts and editor-diff paths (draftDeliveryFacts.ts
// runtime status/diff, not the mutation gateways). `readGitRawWorktreeSnapshot` below produces a
// `GitWorktreeSnapshot` shape ONLY to satisfy that shared type; it never probes the branch's upstream
// tracking relation, so `hasUpstream`/`aheadCount`/`behindCount` are fixed at disengaged values (false/0/0)
// by construction. It MUST NOT be used as the snapshotReader for push preflight (`preflightPush` in
// `git-mutation-preflight.ts`) — that would silently disable the non-fast-forward and nothing-to-push
// checks for every push. A push effect must read the real tracking state via `readGitWorktreeSnapshot`
// (`git-worktree-snapshot-node.ts`) instead.
import {
  parseGitIndexStat,
  indexStatMatches,
  readGitIndexWriteTimeNs,
  type GitIndexStat,
} from "./git-index-stat.js";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import { readGitStageFile } from "@oscharko-dev/keiko-workspace/internal/git-index";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import type { GitChangedFile, GitStatusCode } from "@oscharko-dev/keiko-contracts";
import { isRootRelativeFileIdentifier } from "@oscharko-dev/keiko-contracts/runtime/editor-workspace-path";
import { gitBlobObjectId, gitIndexEntriesDigest, type IndexEntry } from "./git-index-identity.js";
import {
  GitWorktreeReadError,
  readGitIndexStat,
  readGitIndexEntries,
  readGitTreeEntries,
  readGitHeadState,
  readGitConfigValue,
  readGitFullRef,
  readGitRemoteAliases,
  readGitUntrackedPaths,
  readGitIndexTreeDigest,
  type NodeGitWorktreeReaderDeps,
} from "./git-worktree-snapshot-node.js";
import type { GitWorktreeSnapshot } from "./git-mutation-preflight.js";
import { workspaceFsOf } from "./exec.js";
import { sameGitHeadState, type GitHeadState } from "./git-head-state.js";

const MAX_INSPECTED_PATHS = 10_000;
const MAX_CONTENT_BYTES = 8_388_608;
export type GitRawWorktreeReadCode =
  | "git-raw-snapshot-incomplete"
  | "git-raw-snapshot-drift"
  | "git-raw-read-cancelled"
  | "git-raw-unborn-head";
/**
 * A raw read that cannot be trusted names its closed reason as `code`, so the diagnostic a consumer
 * records carries it (the server's `describeError` reads `code`; an `Error`'s message never reaches
 * the activity log). Run 6, 2026-09-10: every verification failed with `errorKind: "Error"` and only
 * the dist frames said which of this reader's three exits had thrown.
 */
export class GitRawWorktreeReadError extends GitWorktreeReadError {
  public readonly code: GitRawWorktreeReadCode;
  public constructor(code: GitRawWorktreeReadCode) {
    super(code);
    this.name = "GitRawWorktreeReadError";
    this.code = code;
  }
}
interface GitRawChangesBody {
  readonly branch: string;
  readonly stagedTreeDigest: string;
  readonly changes: readonly GitChangedFile[];
  readonly truncated: boolean;
  /**
   * Paths the workspace deny list keeps outside Keiko's governed content surface (`.idea/**`,
   * `.env`, `.keiko/**`, ...): never read, never listed in `changes`, counted here. Keiko's edit and
   * staging lanes refuse the same paths, so nothing Keiko commits can hide behind this count, and
   * the staged tree digest still binds the exact index they may sit in. Before 2026-09-10 one such
   * path marked the whole snapshot truncated: a repository that tracked its IDE metadata
   * (`.idea/.gitignore`, run 6 of the Workbench engagement) could never be verified or committed.
   */
  readonly deniedPathCount: number;
  /**
   * Untracked nested repositories (`vendor/` holding its own `.git`): Git lists the directory, not
   * its files. They are opaque -- counted, never read into, never listed in `changes` and so never
   * staged -- and no longer fail the whole read (#4491).
   */
  readonly opaqueUntrackedCount: number;
}
/** The raw read of a repository whose HEAD is born: the commit it names is `headSha`. */
export interface GitRawChanges extends GitRawChangesBody {
  readonly headSha: string;
}
/**
 * The raw read of a repository whose HEAD may be unborn (#4491). An unborn HEAD diffs against the
 * empty tree: every index entry is an addition. The state is explicit, never an empty sha.
 */
export interface GitRawChangesAtHead extends GitRawChangesBody {
  readonly head: GitHeadState;
}
// A path git reports that this snapshot cannot represent -- not a root-relative file identifier, or
// carrying a replacement character from an undecodable name -- leaves the snapshot incomplete.
function representablePath(path: string): boolean {
  return isRootRelativeFileIdentifier(path) && !path.includes("\uFFFD");
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
const GITLINK_MODE = "160000";
interface WorkingInspection {
  readonly status: GitStatusCode;
  readonly bytes: number;
  readonly untracked: boolean;
}
// Regular files differ by the execute bit only when `core.fileMode` is on; a link never matches a file.
function sameMode(fileMode: string, indexMode: string, honourExecuteBit: boolean): boolean {
  if (fileMode === indexMode) return true;
  return !honourExecuteBit && fileMode !== "120000" && indexMode !== "120000";
}
async function inspectWorkingFile(
  scan: ScanInputs,
  path: string,
  index: IndexEntry | undefined,
  remainingBytes: number,
): Promise<WorkingInspection> {
  const file = await readGitStageFile(scan.deps.workspace.root, path, {
    maxBytes: remainingBytes,
    fs: workspaceFsOf(scan.deps),
    symlinks: "read-only",
  });
  if (index === undefined)
    return { status: " ", bytes: file.bytes.length, untracked: file.mode !== "0" };
  if (file.mode === "0") return { status: "D", bytes: 0, untracked: false };
  const same =
    sameMode(file.mode, index.mode, await scan.fileMode()) &&
    gitBlobObjectId(file.bytes, index.objectId.length) === index.objectId;
  return { status: same ? " " : "M", bytes: file.bytes.length, untracked: false };
}
/** Reads the changes of a born HEAD; an unborn HEAD fails closed with `git-raw-unborn-head`. */
export async function readGitRawChanges(deps: NodeGitWorktreeReaderDeps): Promise<GitRawChanges> {
  const { head, ...body } = await readGitRawChangesAtHead(deps);
  if (head.kind === "unborn") throw new GitRawWorktreeReadError("git-raw-unborn-head");
  return { headSha: head.sha, ...body };
}
async function headBranch(deps: NodeGitWorktreeReaderDeps, head: GitHeadState): Promise<string> {
  if (head.kind === "unborn") return head.branch;
  return (await readGitFullRef(deps, "HEAD")).replace(/^refs\/heads\//u, "");
}
/** Reads the changes of HEAD whether born or unborn; an unborn HEAD's base is the empty tree. */
export async function readGitRawChangesAtHead(
  deps: NodeGitWorktreeReaderDeps,
): Promise<GitRawChangesAtHead> {
  const head = await readGitHeadState(deps);
  const branch = await headBranch(deps, head);
  const index = new Map((await readGitIndexEntries(deps)).map((entry) => [entry.path, entry]));
  const headEntries = head.kind === "born" ? await readGitTreeEntries(deps, head.sha) : [];
  const headTree = new Map(headEntries.map((entry) => [entry.path, entry]));
  // A nested repository is listed as `dir/`: an opaque untracked entry that is counted, never read
  // into and never staged (Git itself reports `?? dir/`).
  const untracked = await readGitUntrackedPaths(deps);
  const opaque = untracked.filter((path) => path.endsWith("/"));
  const paths = [
    ...new Set([...index.keys(), ...headTree.keys(), ...untracked.filter((p) => !p.endsWith("/"))]),
  ].sort(compareStrings);
  const scanned = await scanPaths(
    {
      deps,
      head: headTree,
      index,
      stats: parseGitIndexStat(await readGitIndexStat(deps)),
      indexWriteTimeNs: readGitIndexWriteTimeNs(deps.workspace.root, workspaceFsOf(deps)),
      fileMode: lazyFileMode(deps),
    },
    paths,
  );
  const stagedTreeDigest = gitIndexEntriesDigest([...index.values()]);
  if (!(await stillSameSnapshot(deps, head, branch, stagedTreeDigest)))
    throw new GitRawWorktreeReadError("git-raw-snapshot-drift");
  return { head, branch, stagedTreeDigest, opaqueUntrackedCount: opaque.length, ...scanned };
}
// The index, the HEAD state (born commit or unborn branch) and the branch ref must be what they were
// when the scan began; a branch that was created meanwhile turns an unborn read into drift.
async function stillSameSnapshot(
  deps: NodeGitWorktreeReaderDeps,
  head: GitHeadState,
  branch: string,
  stagedTreeDigest: string,
): Promise<boolean> {
  return (
    (await readGitIndexTreeDigest(deps)) === stagedTreeDigest &&
    sameGitHeadState(await readGitHeadState(deps), head) &&
    (head.kind === "unborn" || (await readGitFullRef(deps, "HEAD")) === `refs/heads/${branch}`)
  );
}
// Git canonicalizes the value (`--type=bool`), so an empty value or `00` reads as Git reads it.
function lazyFileMode(deps: NodeGitWorktreeReaderDeps): () => Promise<boolean> {
  let value: Promise<boolean> | undefined;
  return () => (value ??= readGitConfigValue(deps, "core.filemode").then((raw) => raw !== "false"));
}
interface ScanInputs {
  readonly deps: NodeGitWorktreeReaderDeps;
  readonly head: ReadonlyMap<string, IndexEntry>;
  readonly index: ReadonlyMap<string, IndexEntry>;
  readonly stats: ReadonlyMap<string, GitIndexStat>;
  readonly indexWriteTimeNs: string | undefined;
  // `core.fileMode`, read once and only when a changed regular file needs the verdict.
  readonly fileMode: () => Promise<boolean>;
}
async function scanPaths(
  scan: ScanInputs,
  paths: readonly string[],
): Promise<Pick<GitRawChanges, "changes" | "truncated" | "deniedPathCount">> {
  const changes: GitChangedFile[] = [];
  let total = 0;
  let deniedPathCount = 0;
  let truncated = paths.length > MAX_INSPECTED_PATHS;
  for (const path of paths.slice(0, MAX_INSPECTED_PATHS)) {
    if (scan.deps.signal?.aborted === true)
      throw new GitRawWorktreeReadError("git-raw-read-cancelled");
    if (!representablePath(path)) {
      truncated = true;
      continue;
    }
    if (isDenied(path)) {
      deniedPathCount += 1;
      continue;
    }
    if (total >= MAX_CONTENT_BYTES) {
      truncated = true;
      break;
    }
    const working = await workingStatus(scan, path, MAX_CONTENT_BYTES - total);
    total += working.bytes;
    const staged = indexStatus(scan.head.get(path), scan.index.get(path));
    if (staged !== " " || working.status !== " " || working.untracked)
      changes.push(changed(path, staged, working.status, working.untracked));
  }
  return { changes, truncated, deniedPathCount };
}
async function workingStatus(
  scan: ScanInputs,
  path: string,
  remainingBytes: number,
): Promise<WorkingInspection> {
  const entry = scan.index.get(path);
  const clean: WorkingInspection = { status: " ", bytes: 0, untracked: false };
  // A submodule is a gitlink, not a file: its directory is never read. Keiko's governed lane does not
  // enter a submodule, so a moved or dirty submodule HEAD is not judged here (`git status` would say
  // ` M`); the gitlink commit itself is still compared head-to-index by `indexStatus`.
  if (entry?.mode === GITLINK_MODE || scan.head.get(path)?.mode === GITLINK_MODE) return clean;
  return entry !== undefined &&
    entry.mode === scan.head.get(path)?.mode &&
    indexStatMatches(
      scan.deps.workspace.root,
      path,
      scan.stats.get(path),
      scan.indexWriteTimeNs,
      workspaceFsOf(scan.deps),
    )
    ? clean
    : await inspectWorkingFile(scan, path, entry, remainingBytes);
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
  const snapshot = await readGitRawWorktreeSnapshotAtHead(deps);
  if (snapshot.headSha === undefined) throw new GitRawWorktreeReadError("git-raw-unborn-head");
  return snapshot;
}

/**
 * The same snapshot for the local stage and commit preflight, which can act on an unborn branch
 * (#4491): `headSha` is absent exactly when HEAD is unborn, as `GitWorktreeSnapshot` documents.
 * Every caller that needs a commit to push or compare keeps `readGitRawWorktreeSnapshot`.
 */
export async function readGitRawWorktreeSnapshotAtHead(
  deps: NodeGitWorktreeReaderDeps,
): Promise<GitWorktreeSnapshot> {
  const raw = await readGitRawChangesAtHead(deps);
  if (raw.truncated) throw new GitRawWorktreeReadError("git-raw-snapshot-incomplete");
  return {
    ...(raw.head.kind === "born" ? { headSha: raw.head.sha } : {}),
    stagedTreeDigest: raw.stagedTreeDigest,
    currentBranchName: raw.branch,
    headDetached: false,
    stagedFileCount: raw.changes.filter((file) => file.staged).length,
    unstagedFileCount: raw.changes.filter((file) => file.unstaged).length,
    untrackedFileCount:
      raw.changes.filter((file) => file.untracked).length + raw.opaqueUntrackedCount,
    deniedPathCount: raw.deniedPathCount,
    // Not probed by this reader — see the header comment and the doc comment above.
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    existingLocalBranchNames: [raw.branch],
    remoteAliases: await readGitRemoteAliases(deps),
  };
}
