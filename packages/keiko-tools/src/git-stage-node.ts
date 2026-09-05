import { createHash } from "node:crypto";
import {
  withGitIndexTransaction,
  readGitStageFile,
  type GitStageFile,
} from "@oscharko-dev/keiko-workspace/internal/git-index";
import type { CommandResult } from "./types.js";
import type { GitStageExecRequest } from "./git-mutation-adapter.js";

export interface GitStageEffectContext {
  readonly workspaceRoot: string;
  readonly check: () => Promise<boolean>;
  readonly authorized: () => boolean;
  readonly run: (
    argv: readonly string[],
    stdin?: Uint8Array | string,
    indexPath?: string,
  ) => Promise<CommandResult>;
}
function contentDigest(files: readonly GitStageFile[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        files.map((file) => [
          file.path,
          file.mode,
          createHash("sha256").update(file.bytes).digest("hex"),
        ]),
      ),
    )
    .digest("hex");
}
export async function readGitStageCandidate(
  root: string,
  paths: readonly string[],
): Promise<string> {
  return contentDigest(await readFiles(root, paths));
}
async function readFiles(root: string, paths: readonly string[]): Promise<readonly GitStageFile[]> {
  const files: GitStageFile[] = [];
  let size = 0;
  for (const path of paths) {
    const file = await readGitStageFile(root, path);
    size += file.bytes.length;
    if (size > 65_536) throw new Error("git-stage-candidate-too-large");
    files.push(file);
  }
  return files;
}
function objectId(result: CommandResult): string {
  const value = result.stdout.trim();
  if (result.exitCode !== 0 || result.truncated || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value))
    throw new Error("git-stage-object-unavailable");
  return value;
}
async function indexEntries(
  ctx: GitStageEffectContext,
  files: readonly GitStageFile[],
  hashLength: number,
): Promise<string> {
  const lines: string[] = [];
  for (const file of files) {
    const sha =
      file.mode === "0"
        ? "0".repeat(hashLength)
        : objectId(await ctx.run(["hash-object", "--no-filters", "-w", "--stdin"], file.bytes));
    lines.push(`${file.mode} ${sha}\t${file.path}\0`);
  }
  return lines.join("");
}
export async function gitStageAttributesSupported(
  ctx: GitStageEffectContext,
  paths: readonly string[],
): Promise<boolean> {
  const result = await ctx.run([
    "check-attr",
    "-z",
    "filter",
    "working-tree-encoding",
    "ident",
    "text",
    "eol",
    "--",
    ...paths,
  ]);
  if (result.exitCode !== 0 || result.truncated || !result.stdout.endsWith("\0")) return false;
  const fields = result.stdout.slice(0, -1).split("\0");
  return (
    fields.length === paths.length * 15 &&
    fields.every((value, index) => index % 3 !== 2 || value === "unspecified" || value === "unset")
  );
}
/** Raw object creation cannot invoke filters. Git still owns index parsing and serialization. */
export async function stageExactFiles(
  ctx: GitStageEffectContext,
  request: GitStageExecRequest,
): Promise<boolean> {
  const expected = request.verified;
  if (
    expected === undefined ||
    !ctx.authorized() ||
    request.pathspecs.length === 0 ||
    request.pathspecs.length > 50 ||
    new Set(request.pathspecs).size !== request.pathspecs.length
  )
    return false;
  return withGitIndexTransaction(
    ctx.workspaceRoot,
    async (transaction): Promise<boolean> => {
      if (!(await ctx.check()) || !(await gitStageAttributesSupported(ctx, request.pathspecs)))
        return false;
      const files = await readFiles(ctx.workspaceRoot, request.pathspecs);
      if (request.worktreeDigest !== undefined && contentDigest(files) !== request.worktreeDigest)
        return false;
      const entries = await indexEntries(ctx, files, expected.headSha.length);
      const result = await ctx.run(
        ["update-index", "-z", "--index-info"],
        entries,
        transaction.temporaryIndexPath,
      );
      return (
        result.exitCode === 0 && !result.truncated && transaction.check() && (await ctx.check())
      );
    },
    (result) => {
      if (result && !ctx.authorized()) throw new Error("git-stage-authority-denied");
      return result;
    },
  );
}
