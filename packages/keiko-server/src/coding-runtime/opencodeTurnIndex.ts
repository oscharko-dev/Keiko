import { createGitProcessRunner, gitEnv } from "@oscharko-dev/keiko-git";
import type { GitProcessResult } from "@oscharko-dev/keiko-git";
import { isGovernedIndexPath, type GovernedIndexRecord } from "./governedIndexPaths.js";
import { withGitIndexTransaction } from "@oscharko-dev/keiko-workspace/internal/git-index";
import type { CodingWorkbenchRuntimeRevertIndexOutcome } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

/**
 * What an undo does to the Git index (U-34b). The runtime restores worktree files only, so a path
 * the turn staged through Keiko's governed staging stayed staged with the content the turn gave it:
 * a commit from the Git window would then commit exactly what Keiko had just said was undone.
 *
 * The index is read, never guessed, at three moments: when the human's turn starts (`start`), when
 * the turn settles (`settled`) and when the undo runs (the live index). A path is the turn's own
 * when its index state differs between the start and the settled image. The undo puts such a path
 * back to its turn-start state, under Git's own index lock and in a private copy that replaces the
 * live index only when every touched path still holds exactly the state the turn left (a person's
 * staging after the turn is never overwritten) and every restored path then verifiably holds its
 * turn-start state. A path the person staged before the turn keeps that staging, since the
 * turn-start entry is what is restored. Anything that cannot be proven changes nothing and says so
 * with a closed outcome. Restore leaves the index at the turn start: the files need staging again.
 */

/** The state of a path no staged change touches: its index entry is HEAD's own. */
const AT_HEAD = "=head";
const ABSENT_MODE = "000000";
const READ_MAX_BYTES = 16 * 1_024 * 1_024;
const GIT_TIMEOUT_MS = 60_000;
/** Paths restored by one `git restore` invocation, so the argument vector stays bounded. */
const RESTORE_BATCH = 200;
/** Paths a turn may leave staged and still be restored one by one (`update-index --cacheinfo`). */
const EXPLICIT_RESTORE_MAX = 64;

export interface TurnIndexImage {
  readonly headSha: string;
  /** Every path whose index entry differs from HEAD, with the entry the index holds. */
  readonly staged: ReadonlyMap<string, string>;
}

/** What the turn's index record holds: the start, and the settled image once the turn settled. */
export interface TurnIndexRecord {
  /**
   * `undefined` inside the promise when there is no index to read (not a repository, no commit);
   * `unreadable` when there is one that cannot be proven (a conflict, an intent-to-add entry).
   */
  readonly start: Promise<IndexRead>;
  /** Cleared when a continuation step begins: the image of an earlier step is stale from then on. */
  settled?: Promise<IndexRead> | undefined;
  /** The first error a read of this turn's index ended on, for the undo to put on the log. */
  failure?: unknown;
}

/** An index image, no index to read, or one that cannot be proven. */
export type IndexRead = TurnIndexImage | "unreadable" | undefined;

export interface TurnIndexRestoreResult {
  readonly outcome: CodingWorkbenchRuntimeRevertIndexOutcome | undefined;
  /** Paths the turn staged and the undo put back; a count, never a path. */
  readonly restoredCount: number;
}

type GitRun = (args: readonly string[]) => Promise<GitProcessResult>;

const NO_RESTORE: TurnIndexRestoreResult = { outcome: undefined, restoredCount: 0 };
const UNAVAILABLE: TurnIndexRestoreResult = { outcome: "unavailable", restoredCount: 0 };

function gitRunner(root: string, indexFile?: string): GitRun {
  const run = createGitProcessRunner(() => ({
    ...gitEnv(),
    GIT_LITERAL_PATHSPECS: "1",
    // A repository-configured filesystem monitor is a program; none runs for these reads.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    ...(indexFile === undefined ? {} : { GIT_INDEX_FILE: indexFile }),
  }));
  return (args) =>
    run(args, {
      cwd: root,
      maxBytes: READ_MAX_BYTES,
      timeoutMs: GIT_TIMEOUT_MS,
    });
}

function succeeded(result: GitProcessResult): boolean {
  return result.exitCode === 0 && !result.truncated;
}

/**
 * The staged changes of the index against HEAD, from `git diff-index --cached --raw`. An unmerged
 * path, a malformed record or a read that failed cannot be proven, so the whole image is `undefined`.
 */
async function readIndexImage(run: GitRun): Promise<IndexRead> {
  const head = await run(["rev-parse", "--verify", "-q", "HEAD"]);
  const headSha = head.stdout.trim();
  if (!succeeded(head) || headSha === "") return undefined;
  const raw = await run([
    "diff-index",
    "--cached",
    "-z",
    "--raw",
    "--no-renames",
    "--no-abbrev",
    headSha,
  ]);
  if (!succeeded(raw)) return "unreadable";
  const parsed = parseRawIndex(raw.stdout);
  if (parsed === undefined) return "unreadable";
  // An intent-to-add entry (`git add -N`) is recorded as an empty added file but cannot be put back
  // exactly, so an index holding one cannot be proven.
  if (await hasIntentToAdd(run, parsed.emptyAdditions)) return "unreadable";
  return { headSha, staged: parsed.staged };
}

const RAW_RECORD = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/u;
/** The object ids of the empty blob (SHA-1 and SHA-256 repositories). */
const EMPTY_BLOB_IDS: ReadonlySet<string> = new Set([
  "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813",
]);
const INTENT_TO_ADD_FLAG = 0x20000000;
const INTENT_TO_ADD_BATCH = 200;

interface ParsedRaw {
  readonly staged: ReadonlyMap<string, string>;
  /** Added paths holding the empty blob: the only entries that can be intent-to-add. */
  readonly emptyAdditions: readonly string[];
}

function parseRawIndex(stdout: string): ParsedRaw | undefined {
  if (stdout === "") return { staged: new Map(), emptyAdditions: [] };
  if (!stdout.endsWith("\0")) return undefined;
  const fields = stdout.slice(0, -1).split("\0");
  if (fields.length % 2 !== 0) return undefined;
  const staged = new Map<string, string>();
  const emptyAdditions: string[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const entry = parseRawRecord(fields[index], fields[index + 1]);
    if (entry === undefined) return undefined;
    staged.set(entry.path, entry.state);
    if (entry.emptyAddition) emptyAdditions.push(entry.path);
  }
  return { staged, emptyAdditions };
}

function parseRawRecord(
  header: string | undefined,
  path: string | undefined,
): { readonly path: string; readonly state: string; readonly emptyAddition: boolean } | undefined {
  const match = RAW_RECORD.exec(header ?? "");
  if (match === null || path === undefined || path === "" || match[5] === "U") return undefined;
  const emptyAddition = match[1] === ABSENT_MODE && EMPTY_BLOB_IDS.has(match[4] ?? "");
  return { path, state: `${match[2] ?? ""} ${match[4] ?? ""}`, emptyAddition };
}

/** Reads the extended index flags of the candidates; a path whose flags cannot be read counts as one. */
async function hasIntentToAdd(run: GitRun, paths: readonly string[]): Promise<boolean> {
  for (let offset = 0; offset < paths.length; offset += INTENT_TO_ADD_BATCH) {
    const batch = paths.slice(offset, offset + INTENT_TO_ADD_BATCH);
    const listing = await run(["ls-files", "--stage", "--debug", "--", ...batch]);
    if (!succeeded(listing)) return true;
    const flags = [...listing.stdout.matchAll(/^\s+size: \d+\s+flags: ([0-9a-f]+)$/gmu)];
    if (flags.length !== batch.length) return true;
    if (flags.some((flag) => (Number.parseInt(flag[1] ?? "0", 16) & INTENT_TO_ADD_FLAG) !== 0))
      return true;
  }
  return false;
}

/** Reads the index of the workspace; `undefined` when it is not a repository with a commit. */
export function captureTurnIndex(root: string): Promise<IndexRead> {
  return readIndexImage(gitRunner(root));
}

// A read that ended on an error leaves no image; the error waits on the record until the undo logs it.
function captureInto(root: string, record: { failure?: unknown }): Promise<IndexRead> {
  return captureTurnIndex(root).catch((error: unknown) => {
    record.failure ??= error;
    return undefined;
  });
}

/** A new human turn begins: its index start is read now. */
export function beginTurnIndex(root: string): TurnIndexRecord {
  const record: TurnIndexRecord = { start: Promise.resolve(undefined) };
  return Object.assign(record, { start: captureInto(root, record) });
}

/** A continuation step begins: the image the turn settled on before it no longer describes it. */
export function reopenTurnIndex(record: TurnIndexRecord | undefined): void {
  if (record !== undefined) record.settled = undefined;
}

/** The turn settled: the index as the turn left it is read now. */
export function settleTurnIndex(root: string, record: TurnIndexRecord): void {
  record.settled = captureInto(root, record);
}

function stateOf(image: TurnIndexImage, path: string): string {
  return image.staged.get(path) ?? AT_HEAD;
}

function touchedPaths(start: TurnIndexImage, left: TurnIndexImage): readonly string[] {
  const paths = new Set([...start.staged.keys(), ...left.staged.keys()]);
  return [...paths].filter((path) => stateOf(start, path) !== stateOf(left, path)).sort();
}

/**
 * Puts the index entries of the paths the undone turn staged through governed staging
 * (`governed`) back to their turn-start state. A read or an index transaction that throws
 * propagates; the caller logs it as `unavailable`.
 */
export async function restoreTurnIndex(
  root: string,
  record: TurnIndexRecord | undefined,
  governed: GovernedIndexRecord,
): Promise<TurnIndexRestoreResult> {
  const start = await record?.start;
  if (record === undefined || start === undefined) return NO_RESTORE;
  const live = await captureTurnIndex(root);
  // The turn's end state is the settled image, or the live index for a turn still running when it
  // was undone: its interrupt has ended by now, so the live index is what the turn left.
  const left = (await record.settled) ?? live;
  const images = provenImages(start, live, left);
  if (images === undefined) return UNAVAILABLE;
  if (images.live.headSha !== images.start.headSha || images.left.headSha !== images.start.headSha)
    return { outcome: "head-moved", restoredCount: 0 };
  return await restoreTouched(root, images, governed);
}

interface ProvenImages {
  readonly start: TurnIndexImage;
  readonly live: TurnIndexImage;
  readonly left: TurnIndexImage;
}

/** The three images, or `undefined` when any of them is missing or cannot be proven. */
function provenImages(
  start: IndexRead,
  live: IndexRead,
  left: IndexRead,
): ProvenImages | undefined {
  if (typeof start !== "object" || typeof live !== "object" || typeof left !== "object")
    return undefined;
  return { start, live, left };
}

async function restoreTouched(
  root: string,
  images: ProvenImages,
  governed: GovernedIndexRecord,
): Promise<TurnIndexRestoreResult> {
  const { start, live, left } = images;
  const changed = touchedPaths(start, left);
  const touched = changed.filter((path) => isGovernedIndexPath(path, governed.paths));
  // A changed path the record does not name is the person's own staging, or the turn's when the
  // record was forgotten, cut or lost with a restart. It stays, and the outcome says so.
  const unrecorded = unrecordedOutcome(changed.length > touched.length, governed);
  // An undo asked again after a restore finds the index already at the turn start: nothing to do.
  if (touched.length === 0 || touched.every((path) => stateOf(live, path) === stateOf(start, path)))
    return { outcome: unrecorded, restoredCount: 0 };
  const result = await restoreInTransaction(root, { start, left, touched });
  return result.outcome === "restored" && unrecorded !== undefined
    ? { outcome: unrecorded, restoredCount: result.restoredCount }
    : result;
}

function unrecordedOutcome(
  any: boolean,
  governed: GovernedIndexRecord,
): TurnIndexRestoreResult["outcome"] {
  if (!any) return undefined;
  return governed.truncated ? "unavailable" : "partial";
}

interface RestorePlan {
  readonly start: TurnIndexImage;
  readonly left: TurnIndexImage;
  readonly touched: readonly string[];
}

type TransactionResult = "applied" | "changed" | "failed";

async function restoreInTransaction(
  root: string,
  plan: RestorePlan,
): Promise<TurnIndexRestoreResult> {
  // A path the person had staged is put back one process at a time; beyond the bound the rest stay.
  let explicitSeen = 0;
  const restorable = plan.touched.filter(
    (path) => stateOf(plan.start, path) === AT_HEAD || ++explicitSeen <= EXPLICIT_RESTORE_MAX,
  );
  const bounded: RestorePlan = { ...plan, touched: restorable };
  // An index that cannot be locked or copied throws: the caller logs it and reports `unavailable`.
  const result = await withGitIndexTransaction(
    root,
    (transaction) => restoreCopy(root, transaction.temporaryIndexPath, bounded),
    (applied) => applied === "applied",
  );
  if (result === "changed") return { outcome: "changed-after-turn", restoredCount: 0 };
  if (result === "failed") return { outcome: "unavailable", restoredCount: 0 };
  return {
    outcome: restorable.length < plan.touched.length ? "partial" : "restored",
    restoredCount: restorable.length,
  };
}

async function restoreCopy(
  root: string,
  indexFile: string,
  plan: RestorePlan,
): Promise<TransactionResult> {
  const run = gitRunner(root, indexFile);
  const inside = await readIndexImage(run);
  if (inside === undefined || inside === "unreadable") return "failed";
  // Under the lock, on the copy that will replace the index: every touched path still holds
  // exactly what the turn left, so a person's staging after the turn is never overwritten.
  if (inside.headSha !== plan.left.headSha) return "changed";
  if (plan.touched.some((path) => stateOf(inside, path) !== stateOf(plan.left, path)))
    return "changed";
  if (!(await applyStartState(run, plan))) return "failed";
  const after = await readIndexImage(run);
  const held =
    typeof after === "object" &&
    after.headSha === plan.start.headSha &&
    plan.touched.every((path) => stateOf(after, path) === stateOf(plan.start, path));
  return held ? "applied" : "failed";
}

async function applyStartState(run: GitRun, plan: RestorePlan): Promise<boolean> {
  const atHead = plan.touched.filter((path) => stateOf(plan.start, path) === AT_HEAD);
  for (let offset = 0; offset < atHead.length; offset += RESTORE_BATCH) {
    const batch = atHead.slice(offset, offset + RESTORE_BATCH);
    const restored = await run(["restore", "--staged", "--source=HEAD", "--", ...batch]);
    if (!succeeded(restored)) return false;
  }
  for (const path of plan.touched) {
    const state = stateOf(plan.start, path);
    if (state === AT_HEAD) continue;
    if (!(await restoreExplicit(run, path, state))) return false;
  }
  return true;
}

/** Puts one path back to the exact entry the person had staged (`mode oid`), or out of the index. */
async function restoreExplicit(run: GitRun, path: string, state: string): Promise<boolean> {
  const [mode, oid] = state.split(" ");
  if (mode === undefined || oid === undefined) return false;
  const args =
    mode === ABSENT_MODE
      ? ["update-index", "--force-remove", "--", path]
      : ["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`];
  return succeeded(await run(args));
}
