import { createHash } from "node:crypto";
import {
  GIT_STAGE_CANDIDATE_MAX_BYTES,
  withGitIndexTransaction,
  readGitStageFile,
  type GitStageFile,
} from "@oscharko-dev/keiko-workspace/internal/git-index";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type { CommandResult } from "./types.js";
import type { GitMutationArgvPlan, GitStageExecRequest } from "./git-mutation-adapter.js";

export interface GitStageEffectContext {
  readonly workspaceRoot: string;
  // The port the stage-file reads and the index transaction resolve containment through: the
  // owned-root port for a managed worktree below `.keiko`, the plain node port otherwise.
  readonly fs?: WorkspaceFs | undefined;
  readonly check: () => Promise<boolean>;
  readonly authorized: () => boolean;
  readonly run: (
    argv: readonly string[],
    stdin?: Uint8Array | string,
    indexPath?: string,
  ) => Promise<CommandResult>;
  // Every configured `filter.<name>` driver name, or `undefined` when the configuration cannot be
  // read. The conversion hash overrides each one, so no configured driver can run while staging.
  readonly filterDriverNames: () => Promise<readonly string[] | undefined>;
  // The line-break class of each named path's index entry as `git ls-files --eol` reports it
  // (`lf`, `crlf`, `mixed`, `none`, `-text`; absent: no entry). Git keeps the bytes of a path whose
  // staged blob already holds a CR, so the conversion depends on it.
  readonly indexLineBreaks: (paths: readonly string[]) => Promise<ReadonlyMap<string, string>>;
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
  fs?: WorkspaceFs,
): Promise<string> {
  return contentDigest(await readFiles(root, paths, fs));
}
async function readFiles(
  root: string,
  paths: readonly string[],
  fs: WorkspaceFs | undefined,
): Promise<readonly GitStageFile[]> {
  const files: GitStageFile[] = [];
  let size = 0;
  for (const path of paths) {
    const file = await readGitStageFile(root, path, { fs }); // NOSONAR typescript:S9382 -- the selection's byte bound is checked before the next file is read
    size += file.bytes.length;
    if (size > GIT_STAGE_CANDIDATE_MAX_BYTES) throw new Error("git-stage-candidate-too-large");
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
/**
 * The effective `core.autocrlf` a verified staging runs under. `exact`: no conversion is configured,
 * so the index takes the verified bytes as they are. Otherwise a file Git would convert while
 * staging is admitted only when Git's own built-in conversion of the verified bytes checks them out
 * again byte for byte (#4491): with `autocrlf=true`, a text file whose every line break is CRLF and
 * that holds no other CR. Git for Windows sets `autocrlf=true` for the whole system, so before this
 * every commit in an ordinary Windows checkout was refused.
 */
export type GitStageLineEndings = "exact" | "autocrlf-true" | "autocrlf-input";
const CR = 0x0d;
const LF = 0x0a;
// Every line break is CRLF, no other CR occurs, and there is at least one line break: the one form
// whose LF normalization `autocrlf=true` reverses exactly on checkout.
function allLineBreaksCrlf(bytes: Uint8Array): boolean {
  let breaks = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === CR && bytes[index + 1] !== LF) return false;
    if (byte === LF) {
      if (bytes[index - 1] !== CR) return false;
      breaks += 1;
    }
  }
  return breaks > 0;
}
function withoutCrlf(bytes: Uint8Array): Uint8Array {
  return bytes.filter((byte, index) => byte !== CR || bytes[index + 1] !== LF);
}
const FILTER_DRIVER_NAME_OVERRIDABLE = /^[^=\n\r\0]+$/u;

// Overrides of every configured filter driver (the read path's mechanism, keiko-git
// `filterNeutralizingArgs`): `--no-filters` alone would also drop the `core.autocrlf` conversion
// this path needs. A name that cannot be overridden, or an unreadable configuration, refuses.
async function filterNeutralizingArgs(ctx: GitStageEffectContext): Promise<readonly string[]> {
  const names = await ctx.filterDriverNames();
  if (!names?.every((name) => FILTER_DRIVER_NAME_OVERRIDABLE.test(name)))
    throw new Error("git-stage-filter-config-unavailable");
  return names.flatMap((name) => [
    "-c",
    `filter.${name}.clean=`,
    "-c",
    `filter.${name}.smudge=`,
    "-c",
    `filter.${name}.process=`,
    "-c",
    `filter.${name}.required=false`,
  ]);
}

async function hashObject(
  ctx: GitStageEffectContext,
  bytes: Uint8Array,
  write: boolean,
  conversion?: StageConversion,
): Promise<string> {
  const argv =
    conversion === undefined
      ? ["hash-object", "--no-filters", ...(write ? ["-w"] : []), "--stdin"]
      : [
          ...(await filterNeutralizingArgs(ctx)),
          "-c",
          `core.autocrlf=${conversion.autocrlf}`,
          "-c",
          "core.safecrlf=false",
          "hash-object",
          ...(write ? ["-w"] : []),
          "--stdin",
          `--path=${conversion.path}`,
        ];
  return objectId(await ctx.run(argv, bytes));
}
interface StageConversion {
  readonly autocrlf: "true" | "input";
  readonly path: string;
}
// Index line-break classes whose blob holds no CR, so Git applies its conversion (an absent entry
// counts as none), and classes whose blob holds a CR, so Git keeps the new bytes as they are
// (`has_crlf_in_index`). `-text` may or may not hold one, and anything else is unknown: refused
// whenever the conversion would change the bytes.
const INDEX_WITHOUT_CR = new Set(["lf", "none"]);
const INDEX_WITH_CR = new Set(["crlf", "mixed"]);
/**
 * Which object Git's own staging stores for bytes it would convert: `raw` when the index entry
 * already holds a CR, `converted` when the conversion is the exact LF form of an all-CRLF file under
 * `autocrlf=true` (which checkout reverses byte for byte), otherwise `undefined` (refused).
 */
async function convertedChoice(
  ctx: GitStageEffectContext,
  file: GitStageFile,
  conversion: StageConversion,
  converted: string,
  indexClass: string | undefined,
): Promise<"raw" | "converted" | undefined> {
  if (indexClass !== undefined && INDEX_WITH_CR.has(indexClass)) return "raw";
  if (indexClass !== undefined && !INDEX_WITHOUT_CR.has(indexClass)) return undefined;
  if (conversion.autocrlf !== "true" || !allLineBreaksCrlf(file.bytes)) return undefined;
  return (await hashObject(ctx, withoutCrlf(file.bytes), false)) === converted
    ? "converted"
    : undefined;
}
/**
 * The object a verified file is staged as, or `undefined` when Git would store bytes whose checkout
 * differs from the verified ones. The attribute check has already ruled out every filter driver,
 * `ident`, a working-tree encoding and `text`/`eol`/`crlf` attributes, so the only conversion left
 * is Git's built-in line-ending one, pinned here to the effective `core.autocrlf`. Only the object
 * that is staged is written.
 */
async function stagedObjectId(
  ctx: GitStageEffectContext,
  file: GitStageFile,
  lineEndings: GitStageLineEndings,
  indexClass: string | undefined,
  write: boolean,
): Promise<string | undefined> {
  if (lineEndings === "exact" || file.mode === "120000") return hashObject(ctx, file.bytes, write);
  const raw = await hashObject(ctx, file.bytes, false);
  const conversion: StageConversion = {
    autocrlf: lineEndings === "autocrlf-true" ? "true" : "input",
    path: file.path,
  };
  const converted = await hashObject(ctx, file.bytes, false, conversion);
  const choice =
    converted === raw ? "raw" : await convertedChoice(ctx, file, conversion, converted, indexClass);
  if (choice === undefined) return undefined;
  if (!write) return choice === "raw" ? raw : converted;
  return hashObject(ctx, file.bytes, true, choice === "raw" ? undefined : conversion);
}
function stageIndexClasses(
  ctx: GitStageEffectContext,
  files: readonly GitStageFile[],
  lineEndings: GitStageLineEndings,
): Promise<ReadonlyMap<string, string>> {
  if (lineEndings === "exact") return Promise.resolve(new Map());
  return ctx.indexLineBreaks(files.map((file) => file.path));
}
async function indexEntries(
  ctx: GitStageEffectContext,
  files: readonly GitStageFile[],
  hashLength: number,
  lineEndings: GitStageLineEndings,
): Promise<string | undefined> {
  const classes = await stageIndexClasses(ctx, files, lineEndings);
  const lines: string[] = [];
  for (const file of files) {
    const sha =
      file.mode === "0"
        ? "0".repeat(hashLength)
        : await stagedObjectId(ctx, file, lineEndings, classes.get(file.path), true); // NOSONAR typescript:S9382 -- one Git object write at a time, stopping at the first refused file
    if (sha === undefined) return undefined;
    lines.push(`${file.mode} ${sha}\t${file.path}\0`);
  }
  return lines.join("");
}
/** Whether every named file can be staged under `lineEndings` (the proposal's admission check). */
export async function gitStageFilesSupported(
  ctx: GitStageEffectContext,
  paths: readonly string[],
  lineEndings: GitStageLineEndings,
): Promise<boolean> {
  const files = await readFiles(ctx.workspaceRoot, paths, ctx.fs);
  const classes = await stageIndexClasses(ctx, files, lineEndings);
  for (const file of files) {
    if (file.mode === "0") continue;
    const sha = await stagedObjectId(ctx, file, lineEndings, classes.get(file.path), false); // NOSONAR typescript:S9382 -- one Git hash at a time, stopping at the first refused file
    if (sha === undefined) return false;
  }
  return true;
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
    "crlf",
    "--",
    ...paths,
  ]);
  if (result.exitCode !== 0 || result.truncated || !result.stdout.endsWith("\0")) return false;
  const fields = result.stdout.slice(0, -1).split("\0");
  return (
    fields.length === paths.length * 18 &&
    fields.every((value, index) => index % 3 !== 2 || value === "unspecified" || value === "unset")
  );
}
/**
 * Objects are created from the verified bytes without any filter driver; the only conversion is
 * Git's built-in line-ending one under `lineEndings`, admitted only when it round-trips exactly. Git
 * still owns index parsing and serialization.
 */
export async function stageExactFiles(
  ctx: GitStageEffectContext,
  request: GitStageExecRequest,
  lineEndings: GitStageLineEndings = "exact",
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
  return await withGitIndexTransaction(
    ctx.workspaceRoot,
    async (transaction): Promise<boolean> => {
      if (!(await ctx.check()) || !(await gitStageAttributesSupported(ctx, request.pathspecs)))
        return false;
      const files = await readFiles(ctx.workspaceRoot, request.pathspecs, ctx.fs);
      if (request.worktreeDigest !== undefined && contentDigest(files) !== request.worktreeDigest)
        return false;
      const entries = await indexEntries(ctx, files, expected.headSha.length, lineEndings);
      if (entries === undefined) return false;
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
    ctx.fs,
  );
}

/**
 * Restores the reviewed paths' index entries from HEAD (`git restore --staged`, as the plan builder
 * validated it) in a private copy of the index under its lock. The copy replaces the live index only
 * when the reviewed head, base and staged tree still held before and after, and the run's authority
 * holds at the swap (#3902 AC2).
 */
export async function unstageExactFiles(
  ctx: GitStageEffectContext,
  plan: GitMutationArgvPlan,
): Promise<boolean> {
  const [argv] = plan;
  if (argv === undefined || plan.length !== 1 || !ctx.authorized()) return false;
  return await withGitIndexTransaction(
    ctx.workspaceRoot,
    async (transaction): Promise<boolean> => {
      if (!(await ctx.check())) return false;
      const result = await ctx.run(argv, undefined, transaction.temporaryIndexPath);
      return (
        result.exitCode === 0 && !result.truncated && transaction.check() && (await ctx.check())
      );
    },
    (result) => {
      if (result && !ctx.authorized()) throw new Error("git-unstage-authority-denied");
      return result;
    },
    ctx.fs,
  );
}
