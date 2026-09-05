import { isUtf8 } from "node:buffer";
import type {
  CodingRuntimeGitStatus,
  GitEditorDiffFile,
  GitEditorDiffResponse,
  GitEditorDiffScope,
} from "@oscharko-dev/keiko-contracts";
import {
  GIT_EDITOR_DIFF_MAX_BYTES,
  GIT_EDITOR_DIFF_MAX_FILES,
} from "@oscharko-dev/keiko-contracts/runtime/git-editor";
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
import { gitDeliveryTerminationHandler, type GitDeliveryExecutionSeams } from "./execution.js";
import type { VerifiedCommitRunContext } from "./verifiedCommitTypes.js";
import { runtimeGitPaths } from "../coding-runtime/codingRuntimeGitIpc.js";
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
function textLines(text: string): readonly string[] {
  return text === "" ? [] : text.replace(/\n$/u, "").split("\n");
}
function rawPatch(sides: DiffSides): string {
  const before = textLines(sides.before);
  const after = textLines(sides.after);
  const a = JSON.stringify(`a/${sides.path}`);
  const b = JSON.stringify(`b/${sides.path}`);
  const headers = patchHeaders(sides, a, b);
  if (sides.before === sides.after) return `${headers.join("\n")}\n`;
  return [
    ...headers,
    `--- ${sides.added ? "/dev/null" : a}`,
    `+++ ${sides.deleted ? "/dev/null" : b}`,
    `@@ -${String(before.length === 0 ? 0 : 1)},${String(before.length)} +${String(after.length === 0 ? 0 : 1)},${String(after.length)} @@`,
    ...patchLines(sides.before, "-"),
    ...patchLines(sides.after, "+"),
    "",
  ].join("\n");
}
function patchLines(text: string, prefix: string): readonly string[] {
  const lines = textLines(text).map((line) => `${prefix}${line}`);
  if (text.length > 0 && !text.endsWith("\n")) lines.push(String.raw`\ No newline at end of file`);
  return lines;
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
function diffFile(sides: DiffSides, scope: GitEditorDiffScope): GitEditorDiffFile | undefined {
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
  return parseGitEditorUnifiedDiff(rawPatch(sides), {
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
  const file = await readGitStageFile(context.workspace.root, path);
  return {
    objectId: file.mode === "0" ? "" : gitBlobObjectId(file.bytes, hashLength),
    mode: file.mode,
    text: Buffer.from(file.bytes).toString("utf8"),
    missing: file.mode === "0",
    binary: !isUtf8(file.bytes) || file.bytes.includes(0),
  };
}

export async function runtimeGitDiff(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
  scope: GitEditorDiffScope,
  paths: readonly string[],
): Promise<GitEditorDiffResponse> {
  if (!runtimeGitPaths(paths)) throw new Error("git-runtime-paths-invalid");
  const deps = runtimeGitReadDeps(context, execution);
  const head = await readGitRevision(deps, "HEAD");
  const index = await readGitIndexTreeDigest(deps);
  const files: GitEditorDiffFile[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const path of paths) {
    if (!context.stillAuthorized() || context.signal?.aborted === true)
      throw new Error("git-runtime-authority-denied");
    const sides = await readSides(context, execution, path, scope);
    const file = diffFile(sides, scope);
    if (file === undefined) continue;
    totalBytes += Buffer.byteLength(JSON.stringify(file));
    if (totalBytes > 60_000) {
      truncated = true;
      break;
    }
    files.push(file);
  }
  if (
    (await readGitRevision(deps, "HEAD")) !== head ||
    (await readGitIndexTreeDigest(deps)) !== index
  )
    throw new Error("git-runtime-diff-drift");
  return {
    schemaVersion: "1",
    scope,
    files,
    totalFiles: files.length,
    totalBytes,
    truncated,
    maxBytes: GIT_EDITOR_DIFF_MAX_BYTES,
    maxFiles: GIT_EDITOR_DIFF_MAX_FILES,
  };
}
