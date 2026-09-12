import { isUtf8 } from "node:buffer";
import type {
  CodingRuntimeGitStatus,
  GitChangedFile,
  GitEditorDiffFile,
  GitEditorDiffResponse,
  GitEditorDiffScope,
} from "@oscharko-dev/keiko-contracts";
import {
  GIT_EDITOR_DIFF_MAX_BYTES,
  GIT_EDITOR_DIFF_MAX_FILES,
} from "@oscharko-dev/keiko-contracts/runtime/git-editor";
import { CODING_RUNTIME_GIT_MAX_PATHS } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
import { boundWorkspaceFs, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { readGitStageFile } from "@oscharko-dev/keiko-workspace/internal/git-index";
import {
  readGitRevision,
  readGitIndexTreeDigest,
  gitBlobObjectId,
  readGitRawChanges,
  readGitIndexEntries,
  readGitTreeEntries,
  readGitBlobText,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { parseGitEditorUnifiedDiff } from "../gitDiffParser.js";
import {
  lineChangeCounts,
  lineDiffSide,
  searchLineChanges,
  unifiedDiffHunks,
  type LineChangeBlock,
  type LineDiffSide,
} from "./lineDiff.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  gitDeliveryTerminationHandler,
  type GitDeliveryExecutionSeams,
  type GitDeliveryTerminationLogSeam,
} from "./execution.js";
import type { VerifiedCommitRunContext } from "./verifiedCommitTypes.js";
import { runtimeGitPaths } from "../coding-runtime/codingRuntimeGitIpc.js";
/**
 * The port a run's filesystem reads resolve containment through: the owned-root port the managed
 * prover bound to the run's WorkspaceInfo, else the plain node port. A managed task worktree below
 * the always-denied `.keiko` segment is admitted only through that binding (2026-09-10).
 */
export function runtimeWorkspaceFs(
  context: Pick<VerifiedCommitRunContext, "workspace">,
): WorkspaceFs {
  return boundWorkspaceFs(context.workspace, nodeWorkspaceFs);
}
/**
 * A raw status read that skipped deny-listed paths (`.idea/**`, `.env`, ...) leaves the count in the
 * activity log, so a status or commit-facts read whose listing omits them is reconstructable from
 * the log alone (AGENTS.md §8). Before 2026-09-10 such a path failed the whole read instead.
 */
export function logDeniedPathExclusion(
  seams: GitDeliveryTerminationLogSeam,
  correlationId: string | undefined,
  deniedPathCount: number | undefined,
): void {
  if (deniedPathCount === undefined || deniedPathCount === 0) return;
  (seams.activityLog ?? processServerLogSink()).write({
    category: "security",
    op: "git.raw-status.denied-paths-excluded",
    correlationId: correlationId ?? UNKNOWN_CORRELATION_ID,
    extra: { deniedPathCount },
  });
}
/** Where a diff search that stopped at a bound is recorded, and under which operation. */
interface DiffSearchLog {
  readonly seams: GitDeliveryTerminationLogSeam;
  readonly correlationId: string | undefined;
}
/**
 * A diff search that stopped at a bound shows its region as one replaced block: correct, never
 * minimal. The line names the bound and the sides' line counts, so a whole-file hunk in the editor or
 * a whole-file count in a stage review is reconstructable from the log alone (AGENTS.md §8).
 */
function searchLoggedLineChanges(
  log: DiffSearchLog,
  before: LineDiffSide,
  after: LineDiffSide,
): readonly LineChangeBlock[] {
  const search = searchLineChanges(before, after);
  if (search.bound !== undefined) {
    (log.seams.activityLog ?? processServerLogSink()).write({
      category: "process",
      op: "git.runtime-diff.search-bounded",
      correlationId: log.correlationId ?? UNKNOWN_CORRELATION_ID,
      extra: { bound: search.bound, oldLines: before.lines.length, newLines: after.lines.length },
    });
  }
  return search.blocks;
}
export function runtimeGitReadDeps(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
): Parameters<typeof readGitRawChanges>[0] {
  return {
    workspace: context.workspace,
    signal: context.signal,
    onTerminated: gitDeliveryTerminationHandler(execution, context.correlationId),
  };
}
export async function runtimeGitStatus(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
): Promise<CodingRuntimeGitStatus> {
  const raw = await readGitRawChanges(runtimeGitReadDeps(context, execution));
  logDeniedPathExclusion(execution, context.correlationId, raw.deniedPathCount);
  return {
    kind: "status",
    headSha: raw.headSha,
    stagedTreeDigest: raw.stagedTreeDigest,
    branch: raw.branch,
    changes: raw.changes.slice(0, 50),
    truncated: raw.truncated || raw.changes.length > 50,
  };
}
interface DiffSides {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly added: boolean;
  readonly deleted: boolean;
  readonly binary: boolean;
  readonly same: boolean;
  readonly oldMode: string;
  readonly newMode: string;
}
// The patch the editor's diff parser reads: Git's own headers for the change, then the hunks of the
// in-process line diff of the two raw sides, so a one-line edit is one hunk inside its context and
// not a whole-file replacement (CodeRabbit review, PR #3452; lineDiff.ts says why not `git diff`).
function unifiedPatch(sides: DiffSides, log: DiffSearchLog): string {
  const a = JSON.stringify(`a/${sides.path}`);
  const b = JSON.stringify(`b/${sides.path}`);
  const headers = patchHeaders(sides, a, b);
  const before = lineDiffSide(sides.before);
  const after = lineDiffSide(sides.after);
  const hunks = unifiedDiffHunks(before, after, searchLoggedLineChanges(log, before, after));
  if (hunks.length === 0) return `${headers.join("\n")}\n`;
  return [
    ...headers,
    `--- ${sides.added ? "/dev/null" : a}`,
    `+++ ${sides.deleted ? "/dev/null" : b}`,
    ...hunks,
    "",
  ].join("\n");
}
function patchHeaders(sides: DiffSides, a: string, b: string): readonly string[] {
  return [
    `diff --git ${a} ${b}`,
    ...(sides.added ? [`new file mode ${sides.newMode}`] : []),
    ...(sides.deleted ? [`deleted file mode ${sides.oldMode}`] : []),
    ...(!sides.added && !sides.deleted && sides.oldMode !== sides.newMode
      ? [`old mode ${sides.oldMode}`, `new mode ${sides.newMode}`]
      : []),
  ];
}
function diffFile(
  sides: DiffSides,
  scope: GitEditorDiffScope,
  log: DiffSearchLog,
): GitEditorDiffFile | undefined {
  if ((sides.added && sides.deleted) || sides.same) return undefined;
  if (sides.binary)
    return {
      path: sides.path,
      layer: scope === "staged" ? "staged" : "worktree",
      status: binaryStatus(sides),
      binary: true,
      hunks: [],
      addedLines: 0,
      removedLines: 0,
      truncated: false,
    };
  return parseGitEditorUnifiedDiff(unifiedPatch(sides, log), {
    scope,
    selectedRootPrefix: "",
    processTruncated: false,
  }).files[0];
}
function binaryStatus(sides: DiffSides): GitEditorDiffFile["status"] {
  if (sides.added) return "added";
  return sides.deleted ? "deleted" : "modified";
}

async function readSides(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
  path: string,
  scope: GitEditorDiffScope,
): Promise<DiffSides> {
  const deps = runtimeGitReadDeps(context, execution);
  const index = (await readGitIndexEntries(deps)).find((entry) => entry.path === path);
  const base =
    scope === "staged"
      ? (await readGitTreeEntries(deps, await readGitRevision(deps, "HEAD"))).find(
          (entry) => entry.path === path,
        )
      : index;
  const before = await objectSide(deps, base);
  const after =
    scope === "staged"
      ? await objectSide(deps, index)
      : await workingSide(context, path, index?.objectId.length ?? 40);
  return {
    path,
    before: before.text,
    after: after.text,
    added: before.missing,
    deleted: after.missing,
    binary: before.binary || after.binary,
    same: before.objectId === after.objectId && before.mode === after.mode,
    oldMode: before.mode,
    newMode: after.mode,
  };
}
interface FileSide {
  readonly mode: string;
  readonly objectId: string;
  readonly text: string;
  readonly missing: boolean;
  readonly binary: boolean;
}
async function objectSide(
  deps: ReturnType<typeof runtimeGitReadDeps>,
  entry: { readonly objectId: string; readonly mode: string } | undefined,
): Promise<FileSide> {
  if (entry === undefined)
    return { text: "", missing: true, binary: false, objectId: "", mode: "0" };
  const text = await readGitBlobText(deps, entry.objectId);
  return {
    text,
    missing: false,
    binary: text.includes("\0") || text.includes("\uFFFD"),
    mode: entry.mode,
    objectId: entry.objectId,
  };
}
async function workingSide(
  context: VerifiedCommitRunContext,
  path: string,
  hashLength: number,
): Promise<FileSide> {
  const file = await readGitStageFile(context.workspace.root, path, {
    fs: runtimeWorkspaceFs(context),
  });
  return {
    objectId: file.mode === "0" ? "" : gitBlobObjectId(file.bytes, hashLength),
    mode: file.mode,
    text: Buffer.from(file.bytes).toString("utf8"),
    missing: file.mode === "0",
    binary: !isUtf8(file.bytes) || file.bytes.includes(0),
  };
}

function changedInScope(change: GitChangedFile, scope: GitEditorDiffScope): boolean {
  return scope === "staged" ? change.staged : change.unstaged || change.untracked;
}

function pathMatches(requested: string, candidate: string): boolean {
  return candidate === requested || candidate.startsWith(`${requested}/`);
}

function expandDiffPaths(
  requested: readonly string[],
  changes: readonly GitChangedFile[],
  scope: GitEditorDiffScope,
): { readonly paths: readonly string[]; readonly truncated: boolean } {
  const eligible = changes.filter((change) => changedInScope(change, scope));
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const requestedPath of requested) {
    for (const change of eligible) {
      if (!pathMatches(requestedPath, change.path) || seen.has(change.path)) continue;
      if (selected.length === CODING_RUNTIME_GIT_MAX_PATHS)
        return { paths: selected, truncated: true };
      seen.add(change.path);
      selected.push(change.path);
    }
  }
  return { paths: selected, truncated: false };
}

async function readSelectedDiffFiles(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
  scope: GitEditorDiffScope,
  paths: readonly string[],
  initiallyTruncated: boolean,
): Promise<{
  readonly files: readonly GitEditorDiffFile[];
  readonly totalBytes: number;
  readonly truncated: boolean;
}> {
  const files: GitEditorDiffFile[] = [];
  let totalBytes = 0;
  let truncated = initiallyTruncated;
  for (const path of paths) {
    if (!context.stillAuthorized() || context.signal?.aborted === true)
      throw new Error("git-runtime-authority-denied");
    const file = diffFile(await readSides(context, execution, path, scope), scope, {
      seams: execution,
      correlationId: context.correlationId,
    });
    if (file === undefined) continue;
    truncated ||= file.truncated;
    totalBytes += Buffer.byteLength(JSON.stringify(file));
    if (totalBytes > 60_000) {
      truncated = true;
      break;
    }
    files.push(file);
  }
  return { files, totalBytes, truncated };
}

/** One requested stage path as Git's own change list sees it: pending, or fully staged already. */
export interface StageSelectionChange {
  readonly path: string;
  readonly pending: boolean;
}

/** The operator-facing counts a stage proposal's review carries for an admitted selection. */
export interface StageSelectionReview {
  readonly fileCount: number;
  readonly addedLines: number;
  readonly deletedLines: number;
}

/**
 * Admits a stage selection against Git's own change list, or refuses it whole.
 *
 * `propose()` used to reuse the model-facing `runtimeGitDiff` for this and refuse the selection
 * whenever that reader had truncated — but the reader's byte budget bounds a RESPONSE, not a
 * selection: eight ordinary files whose rendered hunks exceeded it were refused as unreviewable, and
 * the run stopped one step after a green verification (Coding Workbench run 13, 2026-09-10). A path
 * is admitted only when the change list names it exactly — as a pending change, or as a fully staged
 * one whose no-op the binding keeps by exact path — so directories, unchanged and absent paths,
 * conflicts, and paths a truncated scan never reached are never admitted, and nothing the scan
 * observed is refused for its size.
 */
export async function admitStageSelection(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
  paths: readonly string[],
): Promise<readonly StageSelectionChange[] | undefined> {
  const raw = await readGitRawChanges(runtimeGitReadDeps(context, execution));
  logDeniedPathExclusion(execution, context.correlationId, raw.deniedPathCount);
  const changes = new Map(raw.changes.map((change) => [change.path, change]));
  const admitted: StageSelectionChange[] = [];
  for (const path of paths) {
    const change = changes.get(path);
    if (change === undefined || change.conflicted) return undefined;
    admitted.push({ path, pending: change.unstaged || change.untracked });
  }
  return admitted;
}

/**
 * Line counts for an admitted selection: the changed lines of each pending path's two sides, from
 * the same line diff the diff reader renders but never limited by its response budget. A one-line
 * edit counts 1/1, not every line of both sides (CodeRabbit review, PR #3452). A fully staged path
 * contributes nothing: there is no index-to-worktree change left to count.
 */
export async function reviewStageSelection(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
  selection: readonly StageSelectionChange[],
): Promise<StageSelectionReview> {
  let addedLines = 0;
  let deletedLines = 0;
  for (const change of selection.filter((entry) => entry.pending)) {
    if (!context.stillAuthorized() || context.signal?.aborted === true)
      throw new Error("git-runtime-authority-denied");
    const sides = await readSides(context, execution, change.path, "unstaged");
    if (sides.binary || sides.same) continue;
    const before = lineDiffSide(sides.before);
    const after = lineDiffSide(sides.after);
    const log = { seams: execution, correlationId: context.correlationId };
    const counts = lineChangeCounts(before, after, searchLoggedLineChanges(log, before, after));
    addedLines += counts.added;
    deletedLines += counts.deleted;
  }
  return { fileCount: selection.length, addedLines, deletedLines };
}

export async function runtimeGitDiff(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
  scope: GitEditorDiffScope,
  paths: readonly string[],
): Promise<GitEditorDiffResponse> {
  if (!runtimeGitPaths(paths)) throw new Error("git-runtime-paths-invalid");
  const deps = runtimeGitReadDeps(context, execution);
  const raw = await readGitRawChanges(deps);
  logDeniedPathExclusion(execution, context.correlationId, raw.deniedPathCount);
  const expanded = expandDiffPaths(paths, raw.changes, scope);
  const selection = await readSelectedDiffFiles(
    context,
    execution,
    scope,
    expanded.paths,
    raw.truncated || expanded.truncated,
  );
  if (
    (await readGitRevision(deps, "HEAD")) !== raw.headSha ||
    (await readGitIndexTreeDigest(deps)) !== raw.stagedTreeDigest
  )
    throw new Error("git-runtime-diff-drift");
  return {
    schemaVersion: "1",
    scope,
    files: selection.files,
    totalFiles: selection.files.length,
    totalBytes: selection.totalBytes,
    truncated: selection.truncated,
    maxBytes: GIT_EDITOR_DIFF_MAX_BYTES,
    maxFiles: GIT_EDITOR_DIFF_MAX_FILES,
  };
}
