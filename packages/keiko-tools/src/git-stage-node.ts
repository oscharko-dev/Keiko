import { createHash } from "node:crypto";
import {
  assertGitStageFileUnchanged,
  inspectGitStageFile,
  isGitStageLargeFile,
  withGitIndexTransaction,
  type GitStageContent,
  type GitStageFile,
  type GitStageLargeFile,
} from "@oscharko-dev/keiko-workspace/internal/git-index";
import { lfFormBlobIdOfLargeFile, sha256OfLargeFile } from "./git-stage-stream.js";
import type { WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import type { CommandResult } from "./types.js";
import { gitHeadObjectIdLength } from "./git-head-state.js";
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
async function contentDigest(
  root: string,
  files: readonly GitStageContent[],
  fs: WorkspaceFs | undefined,
): Promise<string> {
  const entries: (readonly [string, string, string])[] = [];
  for (const file of files)
    entries.push([
      file.path,
      file.mode,
      isGitStageLargeFile(file)
        ? await sha256OfLargeFile(root, file, { fs }) // NOSONAR typescript:S9382 -- one streamed file at a time, one chunk in memory
        : createHash("sha256").update(file.bytes).digest("hex"),
    ]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
export async function readGitStageCandidate(
  root: string,
  paths: readonly string[],
  fs?: WorkspaceFs,
): Promise<string> {
  return contentDigest(root, await readFiles(root, paths, fs), fs);
}
// A file above the governed stdin contract is returned as a large handle (size and identity), never
// read whole: no selection size ends a staging, and memory holds at most the small files' bytes.
async function readFiles(
  root: string,
  paths: readonly string[],
  fs: WorkspaceFs | undefined,
): Promise<readonly GitStageContent[]> {
  const files: GitStageContent[] = [];
  for (const path of paths) files.push(await inspectGitStageFile(root, path, { fs })); // NOSONAR typescript:S9382 -- files are inspected one after the other
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
/**
 * Body-free counts a settlement reports about its own bounds: attribute reads that were split in
 * halves after a truncated answer, and paths a batch left undecided because the shared hash-run
 * budget ran out. They make a partly unsettled batch distinguishable from files that are dirty.
 */
export interface GitStagedConversionStats {
  attributeSplitCount: number;
  hashBudgetExhaustedCount: number;
  // Filled when present: the paths the port left unanswered because it could not JUDGE them (an
  // attribute, an index line-break class or a path form it does not settle, or a failed hash), as
  // opposed to paths where no conversion applies so the bytes are what staging stores. A caller
  // that must never state a wrong number treats these as unknown (#4491).
  cannotJudge?: Set<string>;
}
/** Why the staged-object port could not answer for a batch (a closed vocabulary for the log). */
export type GitStagedUndecidableReason =
  "config-unreadable" | "attributes-unreadable" | "attributes-truncated" | "hash-failed";
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
interface GitStageLineEndingAttributes {
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
// Git reads a large file by path (`hash-object -- <path>`, run in the workspace root), so its bytes
// never pass the bounded stdin and are never held in memory. The attributes, the filter-driver
// overrides and the line-ending pins are exactly the ones `hashObject` applies to stdin bytes.
async function hashLargeObject(
  ctx: GitStageEffectContext,
  file: GitStageLargeFile,
  write: boolean,
  conversion?: StageConversion,
): Promise<string> {
  const head =
    conversion === undefined
      ? ["hash-object", "--no-filters"]
      : [
          ...(await filterNeutralizingArgs(ctx)),
          "-c",
          `core.autocrlf=${conversion.autocrlf}`,
          "-c",
          "core.safecrlf=false",
          "hash-object",
        ];
  return objectId(await ctx.run([...head, ...(write ? ["-w"] : []), "--", file.path]));
}
// The streaming counterpart of `convertedChoice`: the LF form's blob id is hashed while the file is
// streamed, so a large all-CRLF text file is admitted exactly when the in-memory one would be.
async function convertedLargeChoice(
  ctx: GitStageEffectContext,
  file: GitStageLargeFile,
  plan: Extract<StagePlan, { kind: "convert" }>,
  converted: string,
  indexClass: string | undefined,
): Promise<"raw" | "converted" | undefined> {
  if (plan.auto && indexClass !== undefined && INDEX_WITH_CR.has(indexClass)) return "raw";
  if (plan.auto && indexClass !== undefined && !INDEX_WITHOUT_CR.has(indexClass)) return undefined;
  if (plan.checkout !== "crlf") return undefined;
  const lfForm = await lfFormBlobIdOfLargeFile(ctx.workspaceRoot, file, converted.length, {
    fs: ctx.fs,
  });
  return lfForm === converted ? "converted" : undefined;
}
async function stagedLargeObjectId(
  ctx: GitStageEffectContext,
  file: GitStageLargeFile,
  stage: FileStage,
  write: boolean,
): Promise<string | undefined> {
  const { plan, lineEndings, indexClass } = stage;
  if (plan.kind === "none") return hashLargeObject(ctx, file, write);
  const raw = await hashLargeObject(ctx, file, false);
  const conversion: StageConversion = { autocrlf: AUTOCRLF_OF[lineEndings], path: file.path };
  const converted = await hashLargeObject(ctx, file, false, conversion);
  const choice =
    converted === raw ? "raw" : await convertedLargeChoice(ctx, file, plan, converted, indexClass);
  if (choice === undefined) return undefined;
  if (!write) return choice === "raw" ? raw : converted;
  return hashLargeObject(ctx, file, true, choice === "raw" ? undefined : conversion);
}
// Git read the file by path: its object is accepted only if the file is exactly the one that was
// inspected and digested, so a swap or an edit meanwhile fails closed (`git-stage-file-changed`).
async function stagedContentObjectId(
  ctx: GitStageEffectContext,
  file: GitStageContent,
  stage: FileStage,
  write: boolean,
): Promise<string | undefined> {
  if (!isGitStageLargeFile(file)) return stagedObjectId(ctx, file, stage, write);
  const id = await stagedLargeObjectId(ctx, file, stage, write);
  assertGitStageFileUnchanged(ctx.workspaceRoot, file, { fs: ctx.fs });
  return id;
}
interface FileStage {
  readonly plan: StagePlan;
  readonly lineEndings: GitStageLineEndings;
  readonly indexClass: string | undefined;
}
// `git check-attr -z` answers one `path NUL attribute NUL value NUL` record per path and attribute,
// in the order asked. A failed, cut-short or misordered answer proves nothing: `undefined`. Git on
// macOS prints a decomposed (NFD) path precomposed (`core.precomposeunicode`), so paths are compared
// in NFC.
// One run is bounded on both sides: its output is capped (`DEFAULT_SANDBOX_POLICY.maxOutputBytes`,
// 256 KiB; a longer answer is cut short and proves nothing) and so is its stdin (a string input at
// 16 KiB, bytes at 64 KiB). `check-attr -z` answers `path NUL attribute NUL value NUL` for every path
// and attribute, so the paths are read in parts whose estimated answer and whose stdin both stay well
// below the caps, and the input travels as bytes.
const ATTRIBUTE_ANSWER_BUDGET_BYTES = 128 * 1024;
export const STDIN_BUDGET_BYTES = 48 * 1024;
const ATTRIBUTE_VALUE_ESTIMATE_BYTES = 16;
const utf8 = new TextEncoder();
// Splits `paths` so that no part's estimated answer or stdin (one `separator` byte per path) exceeds
// its budget; a path that alone exceeds a budget still forms its own part.
function boundedChunks(
  paths: readonly string[],
  answerBytes: (path: string) => number,
  maxPaths: number,
): readonly (readonly string[])[] {
  const chunks: string[][] = [];
  let answer = Infinity;
  let stdin = Infinity;
  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path) + 1;
    answer += answerBytes(path);
    stdin += pathBytes;
    const full =
      answer > ATTRIBUTE_ANSWER_BUDGET_BYTES ||
      stdin > STDIN_BUDGET_BYTES ||
      (chunks.at(-1)?.length ?? 0) >= maxPaths;
    if (full) {
      chunks.push([]);
      answer = answerBytes(path);
      stdin = pathBytes;
    }
    chunks.at(-1)?.push(path);
  }
  return chunks;
}
function attributeChunks(
  attributes: readonly string[],
  paths: readonly string[],
): readonly (readonly string[])[] {
  const perPathFixed = attributes.reduce(
    (sum, attribute) => sum + Buffer.byteLength(attribute) + ATTRIBUTE_VALUE_ESTIMATE_BYTES + 3,
    0,
  );
  return boundedChunks(
    paths,
    (path) => attributes.length * Buffer.byteLength(path) + perPathFixed,
    Infinity,
  );
}
type AttributeReadFailure = "attributes-unreadable" | "attributes-truncated";
async function readAttributeValuesOrReason(
  ctx: GitStageEffectContext,
  attributes: readonly string[],
  paths: readonly string[],
  stats?: GitStagedConversionStats,
): Promise<readonly (readonly string[])[] | AttributeReadFailure> {
  const rows: (readonly string[])[] = [];
  const splits: AttributeSplits = { remaining: ATTRIBUTE_SPLIT_BUDGET };
  let failure: AttributeReadFailure | undefined;
  for (const chunk of attributeChunks(attributes, paths)) {
    const part = await readAttributeChunkHalving(ctx, attributes, chunk, splits); // NOSONAR typescript:S9382 -- sequential parts keep each answer under the output cap
    if (typeof part === "string") {
      failure = part;
      break;
    }
    rows.push(...part);
  }
  if (stats !== undefined) stats.attributeSplitCount += ATTRIBUTE_SPLIT_BUDGET - splits.remaining;
  return failure ?? rows;
}
// A value is estimated at a few bytes, but a `.gitattributes` may give a `filter` or an encoding a
// value of kilobytes: an answer cut short at the output cap is read again in halves, within a bounded
// number of splits per read, before the chunk is given up.
export const ATTRIBUTE_SPLIT_BUDGET = 64;
interface AttributeSplits {
  remaining: number;
}
async function readAttributeChunkHalving(
  ctx: GitStageEffectContext,
  attributes: readonly string[],
  paths: readonly string[],
  splits: AttributeSplits,
): Promise<readonly (readonly string[])[] | AttributeReadFailure> {
  const answer = await readAttributeChunk(ctx, attributes, paths);
  if (answer !== "attributes-truncated" || paths.length < 2 || splits.remaining <= 0) return answer;
  splits.remaining -= 1;
  const middle = Math.ceil(paths.length / 2);
  const rows: (readonly string[])[] = [];
  for (const half of [paths.slice(0, middle), paths.slice(middle)]) {
    const part = await readAttributeChunkHalving(ctx, attributes, half, splits); // NOSONAR typescript:S9382 -- halves are read one after the other inside the split budget
    if (typeof part === "string") return part;
    rows.push(...part);
  }
  return rows;
}
async function readAttributeValues(
  ctx: GitStageEffectContext,
  attributes: readonly string[],
  paths: readonly string[],
): Promise<readonly (readonly string[])[] | undefined> {
  const rows = await readAttributeValuesOrReason(ctx, attributes, paths);
  return typeof rows === "string" ? undefined : rows;
}
async function readAttributeChunk(
  ctx: GitStageEffectContext,
  attributes: readonly string[],
  paths: readonly string[],
): Promise<readonly (readonly string[])[] | AttributeReadFailure> {
  // The paths travel on stdin (NUL separated), so a selection never meets the command-line limit.
  const result = await ctx.run(
    ["check-attr", "-z", ...attributes, "--stdin"],
    utf8.encode(paths.map((path) => `${path}\0`).join("")),
  );
  if (result.truncated) return "attributes-truncated";
  if (result.exitCode !== 0 || !result.stdout.endsWith("\0")) return "attributes-unreadable";
  const fields = result.stdout.slice(0, -1).split("\0");
  if (fields.length !== paths.length * attributes.length * 3) return "attributes-unreadable";
  const rows: string[][] = [];
  for (const [pathIndex, path] of paths.entries()) {
    const row: string[] = [];
    for (const [attributeIndex, attribute] of attributes.entries()) {
      const at = (pathIndex * attributes.length + attributeIndex) * 3;
      const value = recordValue(fields.slice(at, at + 3), path, attribute);
      if (value === undefined) return "attributes-unreadable";
      row.push(value);
    }
    rows.push(row);
  }
  return rows;
}
// The value of one `path NUL attribute NUL value` record, when it answers for this path (compared in
// NFC) and this attribute.
function recordValue(
  record: readonly string[],
  path: string,
  attribute: string,
): string | undefined {
  const [recordPath, recordAttribute, value] = record;
  if (recordPath?.normalize("NFC") !== path.normalize("NFC") || recordAttribute !== attribute)
    return undefined;
  return value;
}
// Each path's conversion under `lineEndings` and its `text`/`eol` attributes, plus the index
// line-break class an `auto` conversion depends on; `undefined` when the attributes cannot be read.
async function fileStages(
  ctx: GitStageEffectContext,
  files: readonly Pick<GitStageContent, "path">[],
  lineEndings: GitStageLineEndings,
): Promise<ReadonlyMap<string, FileStage> | undefined> {
  const paths = files.map((file) => file.path);
  const values = paths.length === 0 ? [] : await readAttributeValues(ctx, ["text", "eol"], paths);
  return values === undefined ? undefined : stagesOfValues(ctx, paths, lineEndings, values);
}
// `values` are the `text` and `eol` attribute values of each path, in order.
async function stagesOfValues(
  ctx: GitStageEffectContext,
  paths: readonly string[],
  lineEndings: GitStageLineEndings,
  values: readonly (readonly string[])[],
): Promise<ReadonlyMap<string, FileStage>> {
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
  files: readonly GitStageContent[],
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
          : await stagedContentObjectId(ctx, file, stage, true); // NOSONAR typescript:S9382 -- one Git object write at a time, stopping at the first refused file
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
    const sha = await stagedContentObjectId(ctx, file, stage, false); // NOSONAR typescript:S9382 -- one Git hash at a time, stopping at the first refused file
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
function attributeRowAdmitted(row: readonly string[]): boolean {
  return row.every((value, index) => ADMITTED_VALUES[index]?.has(value) === true);
}
export async function gitStageAttributesSupported(
  ctx: GitStageEffectContext,
  paths: readonly string[],
): Promise<boolean> {
  const values = await readAttributeValues(ctx, STAGE_ATTRIBUTES, paths);
  return values?.every(attributeRowAdmitted) ?? false;
}
// The only Git runs the read-only staged-object port may make: the attribute lookup and the object
// hash from stdin paths (never `-w`), after leading `-c` overrides that are exactly the filter-driver
// neutralisation and the line-ending pins. Only the arguments before a `--` are inspected: operands
// after it are paths, and a tracked file named `-w` is not an option.
const PORT_CONFIG_OVERRIDES: readonly RegExp[] = [
  /^filter\.[^=\n\r\0]+\.(?:clean|smudge|process)=$/u,
  /^filter\.[^=\n\r\0]+\.required=false$/u,
  /^core\.autocrlf=(?:true|input|false)$/u,
  /^core\.safecrlf=false$/u,
];
export function gitStagedObjectPortArgvAllowed(argv: readonly string[]): boolean {
  const separator = argv.indexOf("--");
  const options = separator < 0 ? argv : argv.slice(0, separator);
  let at = 0;
  while (options[at] === "-c") {
    if (!PORT_CONFIG_OVERRIDES.some((pattern) => pattern.test(options[at + 1] ?? ""))) return false;
    at += 2;
  }
  const command = options.slice(at).join("\0");
  return (
    command === ["hash-object", "--stdin-paths"].join("\0") ||
    command === ["check-attr", "-z", ...STAGE_ATTRIBUTES, "--stdin"].join("\0")
  );
}

// A path the reader can hand to `hash-object --stdin-paths`: one line, not C-quoted.
function stdinPathSafe(path: string): boolean {
  return !/[\n\r]/u.test(path) && !path.startsWith('"');
}
export const HASH_RUN_BUDGET = 32;
const HASH_BATCH_PATHS = 1000;
async function hashPathRun(
  ctx: GitStageEffectContext,
  lineEndings: GitStageLineEndings,
  paths: readonly string[],
): Promise<readonly string[] | undefined> {
  const result = await ctx.run(
    [
      ...(await filterNeutralizingArgs(ctx)),
      "-c",
      `core.autocrlf=${AUTOCRLF_OF[lineEndings]}`,
      "-c",
      "core.safecrlf=false",
      "hash-object",
      "--stdin-paths",
    ],
    utf8.encode(`${paths.join("\n")}\n`),
  );
  if (result.exitCode !== 0 || result.truncated) return undefined;
  const ids = result.stdout.split("\n").filter((line) => line !== "");
  return ids.length === paths.length &&
    ids.every((id) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(id))
    ? ids
    : undefined;
}
interface HashRuns {
  remaining: number;
  // Paths left unanswered because the budget ran out (not because their own run failed).
  skipped: number;
}
// One unreadable path (deleted, replaced by a directory, denied) fails the whole `hash-object` run.
// The failed run is halved until the offending path stands alone, within a bounded number of runs;
// that path, and anything the budget leaves unresolved, gets no answer and stays modified. The
// budget is shared by one call (one batch of the reader's scan); each part keeps its first run.
function unanswered(paths: readonly string[]): ReadonlyMap<string, string | undefined> {
  return new Map(paths.map((path) => [path, undefined]));
}
// The first run of every part is reserved: unreadable files in earlier parts cannot starve a later,
// healthy part. Only the halving that follows a failure draws from the shared budget.
function takeHashRun(runs: HashRuns, reserved: boolean): boolean {
  if (reserved) return true;
  if (runs.remaining <= 0) return false;
  runs.remaining -= 1;
  return true;
}
async function hashPathsBisecting(
  ctx: GitStageEffectContext,
  lineEndings: GitStageLineEndings,
  paths: readonly string[],
  runs: HashRuns,
  reserved = false,
): Promise<ReadonlyMap<string, string | undefined>> {
  if (paths.length === 0) return unanswered(paths);
  if (!takeHashRun(runs, reserved)) {
    runs.skipped += paths.length;
    return unanswered(paths);
  }
  const ids = await hashPathRun(ctx, lineEndings, paths);
  if (ids !== undefined) return new Map(paths.map((path, at) => [path, ids[at]]));
  if (paths.length === 1) return unanswered(paths);
  const answers = new Map<string, string | undefined>();
  const middle = Math.ceil(paths.length / 2);
  for (const half of [paths.slice(0, middle), paths.slice(middle)])
    for (const [path, id] of await hashPathsBisecting(ctx, lineEndings, half, runs))
      // NOSONAR typescript:S9382 -- halves run one after the other inside the run budget
      answers.set(path, id);
  return answers;
}
async function hashPathsUnderConversion(
  ctx: GitStageEffectContext,
  lineEndings: GitStageLineEndings,
  paths: readonly string[],
  stats?: GitStagedConversionStats,
): Promise<ReadonlyMap<string, string | undefined>> {
  const answers = new Map<string, string | undefined>();
  const runs: HashRuns = { remaining: HASH_RUN_BUDGET, skipped: 0 };
  // The answer is one short line per path, so the stdin bound decides the part size.
  for (const part of boundedChunks(paths, () => 0, HASH_BATCH_PATHS))
    for (const [path, id] of await hashPathsBisecting(ctx, lineEndings, part, runs, true))
      // NOSONAR typescript:S9382 -- sequential parts keep each run under the stdin and output caps
      answers.set(path, id);
  if (stats !== undefined) stats.hashBudgetExhaustedCount += runs.skipped;
  return answers;
}
// Whether Git's conversion of this file's bytes can equal an index object it did not already match
// raw: a regular file whose attributes staging admits, converted under `text`/`eol` or an `auto`
// path whose index entry holds no CR (Git keeps the bytes of one that does, so its raw hash already
// decided). Unlike staging, a conversion that does not check out byte for byte is still judged: the
// question is only whether Git would store the index object, as `git status` asks it.
function conversionCanSettle(
  file: Pick<GitStageFile, "path" | "mode">,
  row: readonly string[] | undefined,
  stage: FileStage | undefined,
): boolean {
  if (row === undefined || !attributeRowAdmitted(row) || stage?.plan.kind !== "convert")
    return false;
  if (file.mode === "0" || file.mode === "120000" || !stdinPathSafe(file.path)) return false;
  return (
    !stage.plan.auto || stage.indexClass === undefined || INDEX_WITHOUT_CR.has(stage.indexClass)
  );
}
// Why a file the settlement left unanswered has no object id: Git stores its bytes as they are
// (`none`: no conversion applies, or the index entry already holds a CR), or the settlement could
// not judge it (`cannot-judge`: an unadmitted attribute, an unknown index class, a path form
// `hash-object --stdin-paths` cannot carry, or a hash that failed).
function unsettledVerdict(
  file: GitStageFile,
  row: readonly string[] | undefined,
  stage: FileStage | undefined,
): "none" | "cannot-judge" {
  if (file.mode === "0") return "none";
  if (row === undefined || !attributeRowAdmitted(row) || stage === undefined) return "cannot-judge";
  if (file.mode === "120000" || stage.plan.kind === "none") return "none";
  return stage.plan.auto && indexKeepsBytes(stage.indexClass) ? "none" : "cannot-judge";
}
// An `auto` path whose index entry already holds a CR keeps its bytes as they are.
function indexKeepsBytes(indexClass: string | undefined): boolean {
  return indexClass !== undefined && INDEX_WITH_CR.has(indexClass);
}
/**
 * The object Git's own staging would store for each file's current bytes, without writing anything:
 * the raw reader's judgement of a regular file whose raw bytes differ from its index object while
 * the index carries no usable stat data (#4491). Git's `git status` asks the same question: does
 * its conversion of the working file equal the index object. One configuration read, one attribute
 * read, one line-break listing (in the reader's chunks) and one `hash-object --stdin-paths` serve the
 * whole batch, whatever its size. Every hash runs with all configured filter drivers overridden, so
 * no driver can run. An entry is `undefined` when conversion cannot settle the file (no conversion
 * applies, a filter, `ident` or encoding attribute, an unreadable class), so the caller keeps it
 * modified; the whole result is `undefined` when the attributes or the configuration cannot be read.
 */
export async function gitStagedObjectIdOf(
  ctx: GitStageEffectContext,
  lineEndings: GitStageLineEndings,
  files: readonly Pick<GitStageFile, "path" | "mode">[],
  stats?: GitStagedConversionStats,
): Promise<ReadonlyMap<string, string | undefined> | GitStagedUndecidableReason> {
  if (files.length === 0) return new Map();
  const names = await ctx.filterDriverNames();
  if (names === undefined || !filterDriversOverridable(names)) return "config-unreadable";
  const paths = files.map((file) => file.path);
  const values = await readAttributeValuesOrReason(ctx, STAGE_ATTRIBUTES, paths, stats);
  if (typeof values === "string") return values;
  const stages = await stagesOfValues(
    ctx,
    paths,
    lineEndings,
    values.map((row) => [row[4] ?? "unspecified", row[5] ?? "unspecified"]),
  );
  const settle = files.filter((file, at) =>
    conversionCanSettle(file, values[at], stages.get(file.path)),
  );
  const answers = await hashPathsUnderConversion(
    ctx,
    lineEndings,
    settle.map((file) => file.path),
    stats,
  );
  // Nothing could be hashed at all: the reason is the hash, not the files.
  if (settle.length > 0 && [...answers.values()].every((id) => id === undefined))
    return "hash-failed";
  files.forEach((file, at) => {
    if (
      answers.get(file.path) === undefined &&
      unsettledVerdict(file, values[at], stages.get(file.path)) === "cannot-judge"
    )
      stats?.cannotJudge?.add(file.path);
  });
  return new Map(paths.map((path) => [path, answers.get(path)]));
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
      if (
        request.worktreeDigest !== undefined &&
        (await contentDigest(ctx.workspaceRoot, files, ctx.fs)) !== request.worktreeDigest
      )
        return false;
      const entries = await indexEntries(
        ctx,
        files,
        gitHeadObjectIdLength(expected.head),
        lineEndings,
      );
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
