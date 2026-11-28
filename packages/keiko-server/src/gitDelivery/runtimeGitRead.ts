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
import {
  CODING_RUNTIME_GIT_MAX_PATHS,
  CODING_RUNTIME_GIT_MAX_STAGE_PATHS,
} from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { boundWorkspaceFs, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  inspectGitStageFile,
  isGitStageLargeFile,
} from "@oscharko-dev/keiko-workspace/internal/git-index";
import {
  readGitHeadState,
  sameGitHeadState,
  readGitIndexTreeDigest,
  gitBlobObjectId,
  blobIdOfLargeFile,
  readGitRawChangesAtHead,
  createGitStagedObjectIdPort,
  createGitReadSession,
  type GitStagedConversionEvidence,
  type NodeGitWorktreeReaderDeps,
  readGitIndexEntries,
  readGitTreeEntries,
  readGitBlobTextsWithin,
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
import { errorKindOf } from "@oscharko-dev/keiko-activity-log";
import { correlationIdOrUnknown } from "../correlation.js";
import { describeError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";
import {
  gitDeliveryActivityErrorKind,
  gitDeliveryTerminationHandler,
  type GitDeliveryExecutionSeams,
  type GitDeliveryTerminationLogSeam,
} from "./execution.js";
import type { VerifiedCommitRunContext } from "./verifiedCommitTypes.js";
import {
  RUNTIME_GIT_WORKSPACE_PATHSPEC,
  runtimeGitPaths,
} from "../coding-runtime/codingRuntimeGitIpc.js";

const DENIED_PATHS_EXCLUDED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.raw-status.denied-paths-excluded",
  category: "security",
  owner: "keiko-server",
  emitter: "gitDelivery/runtimeGitRead.logDeniedPathExclusion",
  fields: { deniedPathCount: { type: "integer", dataClass: "count", required: true } },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-denied-path-exclusion"],
  proofIds: ["git.raw-status.denied-paths-excluded.emitted-line"],
  releaseImpact: "patch",
});

// A file's size never ends a status read or a staging (owner decision 2026-11-24): a file above the
// inline bound is streamed, never held. The line names how many such files a read met and how many
// bytes were streamed for them, so a slow or cancelled read of a large repository is explainable
// from the log alone (counts only, no path or content).
const LARGE_FILES_STREAMED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.large-files-streamed",
  category: "process",
  owner: "keiko-server",
  emitter: "gitDelivery/runtimeGitRead.logLargeFilesStreamed",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["status", "stage-propose"],
    },
    largeFileCount: { type: "integer", dataClass: "count", required: true },
    streamedBytes: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-large-file-streaming"],
  proofIds: ["git.large-files-streamed.emitted-line"],
  releaseImpact: "patch",
});

const STAGED_CONVERSION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.raw-status.conversion-settled",
  category: "process",
  owner: "keiko-server",
  emitter: "gitDelivery/runtimeGitRead.logStagedConversion",
  fields: {
    convertible: { type: "integer", dataClass: "count", required: true },
    batches: { type: "integer", dataClass: "count", required: true },
    settledClean: { type: "integer", dataClass: "count", required: true },
    attributeSplitCount: { type: "integer", dataClass: "count", required: true },
    hashBudgetExhaustedCount: { type: "integer", dataClass: "count", required: true },
    listingMs: { type: "integer", dataClass: "duration", required: false },
    scanMs: { type: "integer", dataClass: "duration", required: false },
    settleMs: { type: "integer", dataClass: "duration", required: false },
    gitSpawnCount: { type: "integer", dataClass: "count", required: false },
    // Files a stage review or diff could not judge, so their counts are unavailable (#4491).
    unavailableCount: { type: "integer", dataClass: "count", required: false },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["answered", "undecidable", "unavailable"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["config-unreadable", "attributes-unreadable", "attributes-truncated", "hash-failed"],
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["git-raw-conversion-settlement"],
  proofIds: ["git.raw-status.conversion-settled.emitted-line"],
  releaseImpact: "patch",
});

// A port failure leaves every file of the failed batch modified; the line carries the classified
// `errorKind` and the counts, so the refused commit proof is explainable from the log alone.
const STAGED_CONVERSION_FAILED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.raw-status.conversion-failed",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "gitDelivery/runtimeGitRead.logStagedConversion",
  fields: {
    convertible: { type: "integer", dataClass: "count", required: true },
    batches: { type: "integer", dataClass: "count", required: true },
    settledClean: { type: "integer", dataClass: "count", required: true },
    // Partial sums over the batches up to the failure.
    attributeSplitCount: { type: "integer", dataClass: "count", required: true },
    hashBudgetExhaustedCount: { type: "integer", dataClass: "count", required: true },
    listingMs: { type: "integer", dataClass: "duration", required: false },
    scanMs: { type: "integer", dataClass: "duration", required: false },
    settleMs: { type: "integer", dataClass: "duration", required: false },
    gitSpawnCount: { type: "integer", dataClass: "count", required: false },
    errorClass: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    frames: {
      type: "string-array",
      dataClass: "safe-platform-class",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["git-raw-conversion-settlement"],
  proofIds: ["git.raw-status.conversion-failed.emitted-line"],
  releaseImpact: "patch",
});

const DIFF_SEARCH_BOUNDED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "git.runtime-diff.search-bounded",
  category: "process",
  owner: "keiko-server",
  emitter: "gitDelivery/runtimeGitRead.searchLoggedLineChanges",
  fields: {
    bound: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["distance", "work"],
    },
    oldLines: { type: "integer", dataClass: "count", required: true },
    newLines: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "loss",
  analyzerProjection: "timeline",
  failureClasses: ["git-diff-search-bounded"],
  proofIds: ["git.runtime-diff.search-bounded.emitted-line"],
  releaseImpact: "patch",
});
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
  (seams.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      DENIED_PATHS_EXCLUDED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      { deniedPathCount },
    ),
  );
}
/** One line per read that met a file above the inline bound (nothing when it met none). */
export function logLargeFilesStreamed(
  seams: GitDeliveryTerminationLogSeam,
  correlationId: string | undefined,
  phase: "status" | "stage-propose",
  counts: { readonly largeFileCount: number; readonly streamedBytes: number },
): void {
  if (counts.largeFileCount === 0) return;
  (seams.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      LARGE_FILES_STREAMED_OPERATION,
      { correlationId: correlationIdOrUnknown(correlationId) },
      { phase, largeFileCount: counts.largeFileCount, streamedBytes: counts.streamedBytes },
    ),
  );
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
    (log.seams.activityLog ?? processServerLogSink()).write(
      activityLogEvent(
        DIFF_SEARCH_BOUNDED_OPERATION,
        { correlationId: correlationIdOrUnknown(log.correlationId) },
        { bound: search.bound, oldLines: before.lines.length, newLines: after.lines.length },
      ),
    );
  }
  return search.blocks;
}
// The structured failure path (AGENTS.md section 8): the closed error class and the bounded frames and
// cause chain of the failure, never its message.
function failureFields(error: unknown): Record<string, unknown> {
  const described = describeError(error);
  return {
    errorClass: described.errorClass,
    ...(described.frames === undefined ? {} : { frames: described.frames }),
    ...(described.causeChain === undefined ? {} : { causeChain: described.causeChain }),
  };
}
/**
 * One line per raw scan that offered stat-dirty files to the staged-conversion port (#4491): how many,
 * in how many batches, how many settled clean, and whether the port answered, could
 * not decide or failed. A scan whose files all stayed "modified" is reconstructable from it alone.
 */
export function logStagedConversion(
  seams: GitDeliveryTerminationLogSeam,
  correlationId: string | undefined,
  evidence: GitStagedConversionEvidence,
): void {
  const counts = {
    convertible: evidence.convertible,
    batches: evidence.batches,
    settledClean: evidence.settledClean,
    attributeSplitCount: evidence.attributeSplitCount,
    hashBudgetExhaustedCount: evidence.hashBudgetExhaustedCount,
    ...evidence.timing,
  };
  const correlation = { correlationId: correlationIdOrUnknown(correlationId) };
  const sink = seams.activityLog ?? processServerLogSink();
  if (evidence.outcome === "error") {
    sink.write(
      activityLogEvent(
        STAGED_CONVERSION_FAILED_OPERATION,
        {
          ...correlation,
          level: "warn",
          errorKind: gitDeliveryActivityErrorKind(errorKindOf(evidence.error)),
        },
        { ...counts, ...failureFields(evidence.error) },
      ),
    );
    return;
  }
  sink.write(
    activityLogEvent(STAGED_CONVERSION_OPERATION, correlation, {
      ...counts,
      ...(evidence.unavailableCount === undefined
        ? {}
        : { unavailableCount: evidence.unavailableCount }),
      outcome: evidence.outcome,
      ...(evidence.reason === undefined ? {} : { reason: evidence.reason }),
    }),
  );
}
/**
 * The raw reader judges a stat-dirty converted file through the staging's own conversion and reports
 * the settlement to the Activity Log under the run's correlation.
 */
export function withStagedConversion(
  base: NodeGitWorktreeReaderDeps,
  seams: GitDeliveryTerminationLogSeam,
  correlationId: string | undefined,
): NodeGitWorktreeReaderDeps {
  // One session per logical operation: its processes are counted and the promisor probe runs once.
  const scoped = { ...base, readSession: base.readSession ?? createGitReadSession() };
  return {
    ...scoped,
    stagedObjectIds: createGitStagedObjectIdPort(scoped),
    onStagedConversion: (evidence: GitStagedConversionEvidence): void => {
      logStagedConversion(seams, correlationId, evidence);
    },
  };
}
export function runtimeGitReadDeps(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
): Parameters<typeof readGitRawChangesAtHead>[0] {
  const base = {
    workspace: context.workspace,
    signal: context.signal,
    onTerminated: gitDeliveryTerminationHandler(execution, context.correlationId),
    ...(context.readSession === undefined ? {} : { readSession: context.readSession }),
  };
  return withStagedConversion(base, execution, context.correlationId);
}
/** The status answer from a raw read the caller already made (denied paths were logged by it). */
export function runtimeGitStatusOfRaw(
  raw: Awaited<ReturnType<typeof readGitRawChangesAtHead>>,
): CodingRuntimeGitStatus {
  return {
    kind: "status",
    ...(raw.head.kind === "born"
      ? { head: "born" as const, headSha: raw.head.sha }
      : { head: "unborn" as const }),
    stagedTreeDigest: raw.stagedTreeDigest,
    branch: raw.branch,
    changes: raw.changes.slice(0, 50),
    truncated: raw.truncated || raw.changes.length > 50,
  };
}
/**
 * The most bytes of one side the line diff reads (memory protection). A larger side is neither an
 * error nor a zero: the diff lists the file as truncated and a stage review says its counts are
 * unavailable.
 */
export const RUNTIME_GIT_SIDE_MAX_BYTES = 8 * 1024 * 1024;

interface DiffSides {
  readonly tooLarge: boolean;
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly added: boolean;
  readonly deleted: boolean;
  readonly binary: boolean;
  // The worktree side holds line breaks Git's staging would convert and the conversion could not be
  // judged: the counts are unavailable, never a guess (#4491).
  readonly conversionUnknown: boolean;
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
  if (sides.tooLarge || sides.conversionUnknown)
    return {
      path: sides.path,
      layer: scope === "staged" ? "staged" : "worktree",
      status: binaryStatus(sides),
      binary: false,
      hunks: [],
      addedLines: 0,
      removedLines: 0,
      truncated: true,
    };
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

// The entry HEAD's tree holds for a path; an unborn HEAD has the empty tree, so no entry.
type SideEntry = Awaited<ReturnType<typeof readGitIndexEntries>>[number];

/**
 * What the sides of a whole selection are read from, gathered once: the index, HEAD's tree and the
 * text of every blob the selection names. Reading them per path started three or four Git processes
 * for each path, so a stage proposal of 300 files took fifteen seconds (PERF-GIT-1).
 */
interface SideSources {
  readonly index: ReadonlyMap<string, SideEntry>;
  readonly head: ReadonlyMap<string, SideEntry>;
  readonly blobs: ReadonlyMap<string, string | undefined>;
}

async function readSideSources(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
  paths: readonly string[],
  scope: GitEditorDiffScope,
): Promise<SideSources> {
  const deps = runtimeGitReadDeps(context, execution);
  const index = new Map((await readGitIndexEntries(deps)).map((entry) => [entry.path, entry]));
  const headState = scope === "staged" ? await readGitHeadState(deps) : undefined;
  const head = new Map(
    headState === undefined || headState.kind === "unborn"
      ? []
      : (await readGitTreeEntries(deps, headState.sha)).map((entry) => [entry.path, entry]),
  );
  const wanted = paths.flatMap((path) => [
    index.get(path)?.objectId,
    ...(scope === "staged" ? [head.get(path)?.objectId] : []),
  ]);
  const blobs = await readGitBlobTextsWithin(
    deps,
    wanted.filter((id): id is string => id !== undefined),
    RUNTIME_GIT_SIDE_MAX_BYTES,
  );
  return { index, head, blobs };
}

async function readSides(
  context: VerifiedCommitRunContext,
  sources: SideSources,
  path: string,
  scope: GitEditorDiffScope,
  conversions: WorkingConversions,
): Promise<DiffSides> {
  const index = sources.index.get(path);
  const base = scope === "staged" ? sources.head.get(path) : index;
  const before = objectSide(sources.blobs, base);
  const after =
    scope === "staged"
      ? objectSide(sources.blobs, index)
      : await workingSide(context, path, index?.objectId.length ?? 40, conversions);
  return {
    path,
    before: before.text,
    after: after.text,
    added: before.missing,
    deleted: after.missing,
    binary: before.binary || after.binary,
    tooLarge: before.tooLarge || after.tooLarge,
    conversionUnknown: after.conversionUnknown,
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
  readonly tooLarge: boolean;
  readonly conversionUnknown: boolean;
}
function objectSide(
  blobs: ReadonlyMap<string, string | undefined>,
  entry: { readonly objectId: string; readonly mode: string } | undefined,
): FileSide {
  if (entry === undefined)
    return {
      text: "",
      missing: true,
      binary: false,
      tooLarge: false,
      conversionUnknown: false,
      objectId: "",
      mode: "0",
    };
  const text = blobs.get(entry.objectId);
  if (text === undefined)
    return {
      text: "",
      missing: false,
      binary: false,
      tooLarge: true,
      conversionUnknown: false,
      mode: entry.mode,
      objectId: entry.objectId,
    };
  return {
    text,
    missing: false,
    tooLarge: false,
    conversionUnknown: false,
    binary: text.includes("\0") || text.includes("\uFFFD"),
    mode: entry.mode,
    objectId: entry.objectId,
  };
}
async function workingSide(
  context: VerifiedCommitRunContext,
  path: string,
  hashLength: number,
  conversions: WorkingConversions,
): Promise<FileSide> {
  const fs = runtimeWorkspaceFs(context);
  const file = await inspectGitStageFile(context.workspace.root, path, {
    fs,
    inlineMaxBytes: RUNTIME_GIT_SIDE_MAX_BYTES,
  });
  // A file above the side bound is never read whole: it is streamed for its object id and a NUL
  // probe, and the side is reported `tooLarge` (its text is not rendered), never as a failure.
  if (isGitStageLargeFile(file)) {
    const { objectId, hasNul } = await blobIdOfLargeFile(context.workspace.root, file, hashLength, {
      fs,
    });
    return {
      tooLarge: true,
      conversionUnknown: false,
      objectId,
      mode: file.mode,
      text: "",
      missing: false,
      binary: hasNul,
    };
  }
  const tooLarge = file.bytes.length > RUNTIME_GIT_SIDE_MAX_BYTES;
  const raw: FileSide = {
    tooLarge,
    conversionUnknown: false,
    objectId: file.mode === "0" ? "" : gitBlobObjectId(file.bytes, hashLength),
    mode: file.mode,
    text: tooLarge ? "" : Buffer.from(file.bytes).toString("utf8"),
    missing: file.mode === "0",
    binary: !isUtf8(file.bytes) || file.bytes.includes(0),
  };
  // Staging stores CRLF as LF under `core.autocrlf`, `core.eol` or a `text`/`eol` attribute, so a
  // CRLF worktree file is compared with its index blob as it would be stored, not byte for byte.
  return conversionCandidate(raw) ? sideStagedAs(raw, conversions.get(path), hashLength) : raw;
}

/**
 * What the staging would do with one worktree file that holds a CR (#4491): store its bytes as they
 * are, store them with every CRLF turned into LF (the object id Git answered), or something this
 * reader could not establish, which makes its counts unavailable and never a guessed number.
 */
type WorkingConversion =
  | { readonly kind: "as-is" }
  | { readonly kind: "converted"; readonly objectId: string }
  | { readonly kind: "unknown" };
type WorkingConversions = ReadonlyMap<string, WorkingConversion>;
const NO_WORKING_CONVERSIONS: WorkingConversions = new Map();
const CONVERSION_UNKNOWN: WorkingConversion = { kind: "unknown" };

// A readable, regular, in-bound UTF-8 text side that holds a CR: the only worktree content staging
// can change, since it turns CRLF into LF and never the other way on add.
function conversionCandidate(side: FileSide): boolean {
  return !side.missing && !side.binary && !side.tooLarge && side.text.includes("\r");
}
function sideStagedAs(
  raw: FileSide,
  conversion: WorkingConversion | undefined,
  hashLength: number,
): FileSide {
  if (conversion?.kind === "as-is") return raw;
  if (conversion?.kind === "converted") {
    const text = raw.text.replaceAll("\r\n", "\n");
    const objectId = gitBlobObjectId(Buffer.from(text, "utf8"), hashLength);
    // The file may have changed since Git answered: only the content Git hashed is counted.
    if (objectId === conversion.objectId) return { ...raw, text, objectId };
  }
  return { ...raw, conversionUnknown: true };
}

interface ConversionCandidate {
  readonly path: string;
  readonly mode: "100644" | "100755" | "120000";
  readonly rawObjectId: string;
  readonly convertedObjectId: string;
}
// The worktree files of one review or diff call that hold a CR, each with the two object ids Git
// could store for it. The bytes are dropped at once: the port hashes the files from the worktree.
function crTextBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length <= RUNTIME_GIT_SIDE_MAX_BYTES &&
    bytes.includes(0x0d) &&
    !bytes.includes(0) &&
    isUtf8(bytes)
  );
}
async function conversionCandidates(
  context: VerifiedCommitRunContext,
  paths: readonly string[],
  hashLengths: ReadonlyMap<string, number>,
): Promise<readonly ConversionCandidate[]> {
  const candidates: ConversionCandidate[] = [];
  for (const path of paths) {
    if (!context.stillAuthorized() || context.signal?.aborted === true)
      throw new Error("git-runtime-authority-denied");
    const file = await inspectGitStageFile(context.workspace.root, path, {
      fs: runtimeWorkspaceFs(context),
      inlineMaxBytes: RUNTIME_GIT_SIDE_MAX_BYTES,
    }); // NOSONAR typescript:S9382 -- authority and cancellation are checked again before each path is read
    // A file above the side bound is streamed elsewhere and never rendered, so it cannot be a CRLF candidate.
    if (isGitStageLargeFile(file)) continue;
    const bytes = file.bytes;
    if (file.mode === "0" || !crTextBytes(bytes)) continue;
    const length = hashLengths.get(path) ?? 40;
    const converted = Buffer.from(bytes).toString("utf8").replaceAll("\r\n", "\n");
    candidates.push({
      path,
      mode: file.mode,
      rawObjectId: gitBlobObjectId(bytes, length),
      convertedObjectId: gitBlobObjectId(Buffer.from(converted, "utf8"), length),
    });
  }
  return candidates;
}
function conversionOf(
  candidate: ConversionCandidate,
  stagedId: string | undefined,
  cannotJudge: ReadonlySet<string>,
): WorkingConversion {
  if (stagedId === undefined)
    return cannotJudge.has(candidate.path) ? CONVERSION_UNKNOWN : { kind: "as-is" };
  if (stagedId === candidate.rawObjectId) return { kind: "as-is" };
  return stagedId === candidate.convertedObjectId
    ? { kind: "converted", objectId: stagedId }
    : CONVERSION_UNKNOWN;
}
function settlementOutcome(
  settled: ReadonlyMap<string, WorkingConversion>,
): Pick<GitStagedConversionEvidence, "outcome" | "unavailableCount"> {
  const unavailableCount = [...settled.values()].filter((c) => c.kind === "unknown").length;
  return unavailableCount === 0
    ? { outcome: "answered" }
    : { outcome: "unavailable", unavailableCount };
}
function settledConversions(
  candidates: readonly ConversionCandidate[],
  answer: ReadonlyMap<string, string | undefined>,
  cannotJudge: ReadonlySet<string>,
): ReadonlyMap<string, WorkingConversion> {
  return new Map(
    candidates.map((candidate) => [
      candidate.path,
      conversionOf(candidate, answer.get(candidate.path), cannotJudge),
    ]),
  );
}
/**
 * One Git conversion read for all CR-bearing worktree files of a stage review or an unstaged diff
 * (#4491). Git decides: the staged-object port (the very conversion the verified staging and the raw
 * reader's settlement use, hashing every file in one `hash-object --stdin-paths`) answers the object
 * id Git would write, and the file is counted as whichever of its two possible contents hashes to
 * it. A file the port leaves unanswered because no conversion applies is counted as it is; one it
 * cannot judge (a filter, `ident` or encoding attribute, an unknown index class, a failed hash), an
 * answer matching neither content, or no answer at all is unknown. The settlement is one line on the
 * raw reader's conversion operation, with the count of unknown files and no path.
 */
async function settleWorkingConversions(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
  paths: readonly string[],
): Promise<WorkingConversions> {
  const deps = runtimeGitReadDeps(context, execution);
  const entries = await readGitIndexEntries(deps);
  const lengths = new Map(entries.map((entry) => [entry.path, entry.objectId.length]));
  const candidates = await conversionCandidates(context, paths, lengths);
  if (candidates.length === 0) return NO_WORKING_CONVERSIONS;
  const stats = {
    attributeSplitCount: 0,
    hashBudgetExhaustedCount: 0,
    cannotJudge: new Set<string>(),
  };
  const report = (
    more: Pick<GitStagedConversionEvidence, "outcome"> & Partial<GitStagedConversionEvidence>,
  ): void =>
    deps.onStagedConversion?.({
      convertible: candidates.length,
      batches: 1,
      settledClean: 0,
      attributeSplitCount: stats.attributeSplitCount,
      hashBudgetExhaustedCount: stats.hashBudgetExhaustedCount,
      ...more,
    });
  const unknown = new Map(candidates.map((candidate) => [candidate.path, CONVERSION_UNKNOWN]));
  try {
    const answer = await deps.stagedObjectIds?.(
      candidates.map((candidate) => ({
        path: candidate.path,
        mode: candidate.mode,
        bytes: new Uint8Array(0),
      })),
      stats,
    );
    if (!(answer instanceof Map)) {
      report({ outcome: "undecidable", ...(typeof answer === "string" ? { reason: answer } : {}) });
      return unknown;
    }
    const settled = settledConversions(candidates, answer, stats.cannotJudge);
    report(settlementOutcome(settled));
    return settled;
  } catch (error) {
    report({ outcome: "error", error });
    if (!context.stillAuthorized() || context.signal?.aborted === true) throw error;
    return unknown;
  }
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
  const conversions =
    scope === "staged"
      ? NO_WORKING_CONVERSIONS
      : await settleWorkingConversions(context, execution, paths);
  const sources = await readSideSources(context, execution, paths, scope);
  for (const path of paths) {
    if (!context.stillAuthorized() || context.signal?.aborted === true)
      throw new Error("git-runtime-authority-denied");
    const file = diffFile(await readSides(context, sources, path, scope, conversions), scope, {
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
  /** True when a side was too large to count: the line counts then cover only the other files. */
  readonly countsUnavailable?: true;
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
export function admitStageSelection(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
  paths: readonly string[],
  read?: RawChangesRead,
): Promise<readonly StageSelectionChange[] | undefined> {
  return admitSelection(
    context,
    execution,
    paths,
    {
      pending: (change) => change.unstaged || change.untracked,
      expandable: (change) => change.unstaged || change.untracked,
    },
    read,
  );
}

/**
 * Admits an unstage selection (#3902 AC2): every path must be one Git lists with a staged change
 * and no conflict, so the proposal can only give staged changes back to the worktree. Anything
 * else (unchanged, unstaged only, absent, in conflict, beyond a truncated list) refuses it whole.
 * A directory expands to the staged, unconflicted files below it (U-28).
 */
export function admitUnstageSelection(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
  paths: readonly string[],
  read?: RawChangesRead,
): Promise<readonly StageSelectionChange[] | undefined> {
  return admitSelection(
    context,
    execution,
    paths,
    {
      pending: (change) => (change.staged ? true : undefined),
      expandable: (change) => change.staged,
    },
    read,
  );
}

interface SelectionRules {
  /** An exactly named path: its `pending` flag, or `undefined` to refuse the whole selection. */
  readonly pending: (change: GitChangedFile) => boolean | undefined;
  /** A change a directory pathspec selects; every other change below it is left out. */
  readonly expandable: (change: GitChangedFile) => boolean;
}

// A directory pathspec (or "." for the whole workspace) selects the changes below it by the same
// prefix rule as the diff reader (`pathMatches`). A conflicted change is left for the person to
// resolve, and a change the raw reader excluded as denied never reaches this list at all.
function directoryChanges(
  requested: string,
  changes: readonly GitChangedFile[],
  rules: SelectionRules,
): readonly GitChangedFile[] {
  return changes.filter(
    (change) =>
      (requested === RUNTIME_GIT_WORKSPACE_PATHSPEC || pathMatches(requested, change.path)) &&
      !change.conflicted &&
      rules.expandable(change),
  );
}

/** The raw change list one read of the repository produced (`readGitRawChangesAtHead`). */
export type RawChangesRead = Awaited<ReturnType<typeof readGitRawChangesAtHead>>;

// Every path must be one Git's change list names without a conflict, and `pending` must admit it
// (its result is the path's `pending` flag), or a directory with at least one change to select;
// otherwise the whole selection is refused. A directory is never expanded from a truncated scan,
// which could silently leave files out, and the expansion is bounded only to protect memory. A
// caller that has just made the raw read the selection is judged against passes it (`read`, whose
// denied paths that read already logged), so one proposal reads the repository once; its redemption
// still re-verifies everything against a read of its own.
async function admitSelection(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
  paths: readonly string[],
  rules: SelectionRules,
  read: RawChangesRead | undefined,
): Promise<readonly StageSelectionChange[] | undefined> {
  const raw = read ?? (await readGitRawChangesAtHead(runtimeGitReadDeps(context, execution)));
  if (read === undefined)
    logDeniedPathExclusion(execution, context.correlationId, raw.deniedPathCount);
  const changes = new Map(raw.changes.map((change) => [change.path, change]));
  const admitted = new Map<string, StageSelectionChange>();
  for (const path of paths) {
    const entries = admitPath(path, changes.get(path), raw, rules);
    if (entries === undefined) return undefined;
    for (const entry of entries) admitted.set(entry.path, entry);
    if (admitted.size > CODING_RUNTIME_GIT_MAX_STAGE_PATHS) return undefined;
  }
  return [...admitted.values()];
}

// One requested path: an exactly named change `rules.pending` admits, or the changes below a
// directory; `undefined` refuses the whole selection.
function admitPath(
  path: string,
  exact: GitChangedFile | undefined,
  raw: RawChangesRead,
  rules: SelectionRules,
): readonly StageSelectionChange[] | undefined {
  if (exact !== undefined) {
    const admittedAs = exact.conflicted ? undefined : rules.pending(exact);
    return admittedAs === undefined ? undefined : [{ path, pending: admittedAs }];
  }
  const below = raw.truncated ? [] : directoryChanges(path, raw.changes, rules);
  return below.length === 0
    ? undefined
    : below.map((change) => ({ path: change.path, pending: true }));
}

// The changed lines of one path's two sides; `undefined` when there is nothing to count (binary or
// unchanged) and "unavailable" when a side was too large to read within its bound.
function sideCounts(
  sides: DiffSides,
  execution: GitDeliveryExecutionSeams,
  correlationId: string | undefined,
): { readonly added: number; readonly deleted: number } | "unavailable" | undefined {
  if (sides.tooLarge || sides.conversionUnknown) return "unavailable";
  if (sides.binary || sides.same) return undefined;
  const before = lineDiffSide(sides.before);
  const after = lineDiffSide(sides.after);
  const log = { seams: execution, correlationId };
  return lineChangeCounts(before, after, searchLoggedLineChanges(log, before, after));
}

/**
 * Line counts for an admitted selection: the changed lines of each pending path's two sides, from
 * the same line diff the diff reader renders but never limited by its response budget. A one-line
 * edit counts 1/1, not every line of both sides (CodeRabbit review, PR #3452). A fully staged path
 * contributes nothing to a stage review: there is no index-to-worktree change left to count. An
 * unstage review counts the staged side (HEAD to index) its proposal gives back.
 */
export async function reviewStageSelection(
  context: VerifiedCommitRunContext,
  execution: GitDeliveryExecutionSeams,
  selection: readonly StageSelectionChange[],
  scope: "unstaged" | "staged" = "unstaged",
): Promise<StageSelectionReview> {
  let addedLines = 0;
  let deletedLines = 0;
  let countsUnavailable = false;
  const pending = selection.filter((entry) => entry.pending);
  const pendingPaths = pending.map((entry) => entry.path);
  const conversions =
    scope === "staged"
      ? NO_WORKING_CONVERSIONS
      : await settleWorkingConversions(context, execution, pendingPaths);
  const sources = await readSideSources(context, execution, pendingPaths, scope);
  for (const change of pending) {
    if (!context.stillAuthorized() || context.signal?.aborted === true)
      throw new Error("git-runtime-authority-denied");
    const sides = await readSides(context, sources, change.path, scope, conversions); // NOSONAR typescript:S9382 -- authority and cancellation are checked again before each path is read
    const counts = sideCounts(sides, execution, context.correlationId);
    if (counts === "unavailable") countsUnavailable = true;
    else if (counts !== undefined) {
      addedLines += counts.added;
      deletedLines += counts.deleted;
    }
  }
  return {
    fileCount: selection.length,
    addedLines,
    deletedLines,
    ...(countsUnavailable ? { countsUnavailable: true as const } : {}),
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
  const raw = await readGitRawChangesAtHead(deps);
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
    !sameGitHeadState(await readGitHeadState(deps), raw.head) ||
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
