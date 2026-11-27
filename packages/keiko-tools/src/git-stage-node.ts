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

/** Whether every configured filter driver can be overridden with `-c filter.<name>.<key>=`. */
export function filterDriversOverridable(names: readonly string[]): boolean {
  return names.every((name) => FILTER_DRIVER_NAME_OVERRIDABLE.test(name));
}

// Overrides of every configured filter driver (the read path's mechanism, keiko-git
// `filterNeutralizingArgs`): `--no-filters` alone would also drop the `core.autocrlf` conversion
// this path needs. A name that cannot be overridden, or an unreadable configuration, refuses.
async function filterNeutralizingArgs(ctx: GitStageEffectContext): Promise<readonly string[]> {
  const names = await ctx.filterDriverNames();
  if (names === undefined || !filterDriversOverridable(names))
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
  readonly autocrlf: "true" | "input" | "false";
  readonly path: string;
}
// Index line-break classes whose blob holds no CR, so Git applies its conversion (an absent entry
// counts as none), and classes whose blob holds a CR, so Git keeps the new bytes as they are
// (`has_crlf_in_index`). `-text` may or may not hold one, and anything else is unknown: refused
// whenever the conversion would change the bytes.
const INDEX_WITHOUT_CR = new Set(["lf", "none"]);
const INDEX_WITH_CR = new Set(["crlf", "mixed"]);
/**
 * How Git converts one path's line breaks, as `convert.c` decides it from the path's `text` and
 * `eol` attributes and the effective `core.autocrlf` (#4491: a repository with `* text=auto`, the
 * common GitHub default, refused every staging before this). `none`: Git stores and checks out the
 * bytes as they are. Otherwise Git normalizes CRLF to LF while staging; `auto` (`text=auto`, or no
 * attribute under `core.autocrlf`) keeps the bytes of a path whose index entry already holds a CR,
 * and `checkout` is the line break Git writes back: `crlf`, `lf`, or `unknown` when it depends on
 * `core.eol`, which this path does not read, so a conversion there is refused.
 */
type StagePlan =
  | { readonly kind: "none" }
  | { readonly kind: "convert"; readonly auto: boolean; readonly checkout: StageCheckout };
type StageCheckout = "crlf" | "lf" | "unknown";
export interface GitStageLineEndingAttributes {
  readonly text: string;
  readonly eol: string;
}
const NO_CONVERSION: StagePlan = { kind: "none" };
const AUTOCRLF_OF: Readonly<Record<GitStageLineEndings, StageConversion["autocrlf"]>> = {
  exact: "false",
  "autocrlf-true": "true",
  "autocrlf-input": "input",
};
function attributeEol(eol: string): StageCheckout | undefined {
  return eol === "lf" || eol === "crlf" ? eol : undefined;
}
function configuredCheckout(lineEndings: GitStageLineEndings): StageCheckout {
  if (lineEndings === "autocrlf-true") return "crlf";
  return lineEndings === "autocrlf-input" ? "lf" : "unknown";
}
function stagePlan(
  lineEndings: GitStageLineEndings,
  attributes: GitStageLineEndingAttributes,
): StagePlan {
  if (attributes.text === "unset") return NO_CONVERSION;
  const eol = attributeEol(attributes.eol);
  if (attributes.text === "set" || attributes.text === "auto")
    return {
      kind: "convert",
      auto: attributes.text === "auto",
      checkout: eol ?? configuredCheckout(lineEndings),
    };
  if (eol !== undefined) return { kind: "convert", auto: false, checkout: eol };
  if (lineEndings === "exact") return NO_CONVERSION;
  return { kind: "convert", auto: true, checkout: configuredCheckout(lineEndings) };
}
/**
 * Which object Git's own staging stores for bytes it would convert: `raw` when an `auto` path's
 * index entry already holds a CR, `converted` when the conversion is the exact LF form of an
 * all-CRLF file that checks out as CRLF again (so checkout reverses it byte for byte), otherwise
 * `undefined` (refused).
 */
async function convertedChoice(
  ctx: GitStageEffectContext,
  file: GitStageFile,
  plan: Extract<StagePlan, { kind: "convert" }>,
  converted: string,
  indexClass: string | undefined,
): Promise<"raw" | "converted" | undefined> {
  if (plan.auto && indexClass !== undefined && INDEX_WITH_CR.has(indexClass)) return "raw";
  if (plan.auto && indexClass !== undefined && !INDEX_WITHOUT_CR.has(indexClass)) return undefined;
  if (plan.checkout !== "crlf" || !allLineBreaksCrlf(file.bytes)) return undefined;
  return (await hashObject(ctx, withoutCrlf(file.bytes), false)) === converted
    ? "converted"
    : undefined;
}
/**
 * The object a verified file is staged as, or `undefined` when Git would store bytes whose checkout
 * differs from the verified ones. The attribute check has already ruled out every filter driver,
 * `ident`, a working-tree encoding and the legacy `crlf` attribute, so the only conversion left is
 * Git's built-in line-ending one, pinned here to the effective `core.autocrlf` and the path's `text`
 * and `eol` attributes. Only the object that is staged is written.
 */
async function stagedObjectId(
  ctx: GitStageEffectContext,
  file: GitStageFile,
  stage: FileStage,
  write: boolean,
): Promise<string | undefined> {
  const { plan, lineEndings, indexClass } = stage;
  if (plan.kind === "none" || file.mode === "120000") return hashObject(ctx, file.bytes, write);
  const raw = await hashObject(ctx, file.bytes, false);
  const conversion: StageConversion = { autocrlf: AUTOCRLF_OF[lineEndings], path: file.path };
  const converted = await hashObject(ctx, file.bytes, false, conversion);
  const choice =
    converted === raw ? "raw" : await convertedChoice(ctx, file, plan, converted, indexClass);
  if (choice === undefined) return undefined;
  if (!write) return choice === "raw" ? raw : converted;
  return hashObject(ctx, file.bytes, true, choice === "raw" ? undefined : conversion);
}
interface FileStage {
  readonly plan: StagePlan;
  readonly lineEndings: GitStageLineEndings;
  readonly indexClass: string | undefined;
}
// `git check-attr -z` answers one `path NUL attribute NUL value NUL` record per path and attribute,
// in the order asked. A failed, cut-short or misordered answer proves nothing: `undefined`.
async function readAttributeValues(
  ctx: GitStageEffectContext,
  attributes: readonly string[],
  paths: readonly string[],
): Promise<readonly (readonly string[])[] | undefined> {
  const result = await ctx.run(["check-attr", "-z", ...attributes, "--", ...paths]);
  if (result.exitCode !== 0 || result.truncated || !result.stdout.endsWith("\0")) return undefined;
  const fields = result.stdout.slice(0, -1).split("\0");
  if (fields.length !== paths.length * attributes.length * 3) return undefined;
  const rows: string[][] = [];
  for (const [pathIndex, path] of paths.entries()) {
    const row: string[] = [];
    for (const [attributeIndex, attribute] of attributes.entries()) {
      const at = (pathIndex * attributes.length + attributeIndex) * 3;
      const value = fields[at + 2];
      if (fields[at] !== path || fields[at + 1] !== attribute || value === undefined)
        return undefined;
      row.push(value);
    }
    rows.push(row);
  }
  return rows;
}
// Each path's conversion under `lineEndings` and its `text`/`eol` attributes, plus the index
// line-break class an `auto` conversion depends on; `undefined` when the attributes cannot be read.
async function fileStages(
  ctx: GitStageEffectContext,
  files: readonly GitStageFile[],
  lineEndings: GitStageLineEndings,
): Promise<ReadonlyMap<string, FileStage> | undefined> {
  const paths = files.map((file) => file.path);
  const values = paths.length === 0 ? [] : await readAttributeValues(ctx, ["text", "eol"], paths);
  if (values === undefined) return undefined;
  const plans = paths.map((path, index) => {
    const [text = "unspecified", eol = "unspecified"] = values[index] ?? [];
    return [path, stagePlan(lineEndings, { text, eol })] as const;
  });
  const indexed = plans.some(([, plan]) => plan.kind === "convert" && plan.auto);
  const classes = indexed ? await ctx.indexLineBreaks(paths) : new Map<string, string>();
  return new Map(
    plans.map(([path, plan]) => [path, { plan, lineEndings, indexClass: classes.get(path) }]),
  );
}
async function indexEntries(
  ctx: GitStageEffectContext,
  files: readonly GitStageFile[],
  hashLength: number,
  lineEndings: GitStageLineEndings,
): Promise<string | undefined> {
  const stages = await fileStages(ctx, files, lineEndings);
  if (stages === undefined) return undefined;
  const lines: string[] = [];
  for (const file of files) {
    const stage = stages.get(file.path);
    const sha =
      file.mode === "0"
        ? "0".repeat(hashLength)
        : stage === undefined
          ? undefined
          : await stagedObjectId(ctx, file, stage, true); // NOSONAR typescript:S9382 -- one Git object write at a time, stopping at the first refused file
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
  const stages = await fileStages(ctx, files, lineEndings);
  if (stages === undefined) return false;
  for (const file of files) {
    const stage = stages.get(file.path);
    if (file.mode === "0") continue;
    if (stage === undefined) return false;
    const sha = await stagedObjectId(ctx, file, stage, false); // NOSONAR typescript:S9382 -- one Git hash at a time, stopping at the first refused file
    if (sha === undefined) return false;
  }
  return true;
}
// Attribute values a verified staging admits: a filter driver, `ident`, a working-tree encoding and
// the legacy `crlf` attribute stay refused; `text` and `eol` may take any value Git's built-in
// conversion knows, because `stagedObjectId` admits a converted file only when it round-trips.
const STAGE_ATTRIBUTES = ["filter", "working-tree-encoding", "ident", "crlf", "text", "eol"];
const UNSET_VALUES: ReadonlySet<string> = new Set(["unspecified", "unset"]);
const ADMITTED_VALUES: readonly ReadonlySet<string>[] = [
  UNSET_VALUES,
  UNSET_VALUES,
  UNSET_VALUES,
  UNSET_VALUES,
  new Set(["unspecified", "unset", "set", "auto"]),
  new Set(["unspecified", "unset", "lf", "crlf"]),
];
export async function gitStageAttributesSupported(
  ctx: GitStageEffectContext,
  paths: readonly string[],
): Promise<boolean> {
  const values = await readAttributeValues(ctx, STAGE_ATTRIBUTES, paths);
  return (
    values?.every((row) =>
      row.every((value, index) => ADMITTED_VALUES[index]?.has(value) === true),
    ) ?? false
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
