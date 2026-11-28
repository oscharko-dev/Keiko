import { createHash } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { causeChain, errorKindOf, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogErrorKindOr,
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { isPortableWorkspaceRelativePath } from "@oscharko-dev/keiko-contracts/runtime/workspace-contract-primitives";
import type {
  CodingWorkbenchRuntimeRevertAction,
  CodingWorkbenchRuntimeRevertIndexOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type {
  CodingRuntimeRevertCounts,
  CodingRuntimeRevertRefusal,
  CodingRuntimeRevertResult,
  CodingRuntimeRevertState,
} from "./codingRuntimeRevert.js";
import { governedIndexRecord, resetGovernedIndexPaths } from "./governedIndexPaths.js";
import {
  beginTurnIndex,
  TURN_INDEX_START_BOUNDS,
  TurnIndexStartBoundError,
  restoreTurnIndex,
  settleTurnIndex,
  type TurnIndexRecord,
} from "./opencodeTurnIndex.js";
import { keikoContinuationOrigin } from "./opencodeTurnOrigin.js";
import type { OpenCodeV2FileDiff, OpenCodeV2HttpClient } from "./opencodeV2HttpClient.js";

/**
 * Turn revert for a live native OpenCode run (B3, S04), built on the producer's snapshots
 * (`snapshots: true`): `session.diff` reports what the newest turn changed, `session.revert.stage`
 * restores those files and rewinds the session to the turn's first user message, and
 * `session.revert.clear` re-applies them. Keiko stages and clears while the run is live, and
 * commits only an undo left staged when the post-completion undo window closes (see
 * `codingRuntimeRevert.ts`). Everything here is workspace-contained, human-initiated (the route
 * admits it behind the app session and the live authority guard) and body-free: the log carries
 * counts and closed words, never a path, a patch or a message.
 */

/** The refusals this port itself can produce; the dispatcher adds `unsupported` and `not-admitted`. */
const OPENCODE_REVERT_REFUSALS = [
  "already-staged",
  "interrupt-failed",
  "nothing-staged",
  "nothing-to-undo",
  "revert-failed",
  "run-unavailable",
  "turn-blocked",
  "turn-boundary-missing",
  "workspace-changed",
] as const satisfies readonly CodingRuntimeRevertRefusal[];

type OpenCodeRevertRefusal = (typeof OPENCODE_REVERT_REFUSALS)[number];
type OpenCodeRevertOperation = CodingWorkbenchRuntimeRevertAction | "state" | "submit" | "commit";

/** The closed index outcomes an undo reports (the contract's vocabulary). */
const REVERT_INDEX_OUTCOMES = [
  "restored",
  "partial",
  "changed-after-turn",
  "head-moved",
  "unavailable",
] as const satisfies readonly CodingWorkbenchRuntimeRevertIndexOutcome[];

const CODING_RUNTIME_REVERT_APPLIED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.revert.applied",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeRevert.recordRevertApplied",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    action: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["undo", "restore", "commit"],
    },
    fileCount: { type: "integer", dataClass: "count", required: true },
    additions: { type: "integer", dataClass: "count", required: true },
    deletions: { type: "integer", dataClass: "count", required: true },
    interrupted: { type: "boolean", dataClass: "closed-enum", required: true },
    // The user messages of the turn the undo reached: the human's request and Keiko's continuations.
    stepCount: { type: "integer", dataClass: "count", required: false },
    // What the undo did to the paths the turn staged; absent when the turn staged nothing.
    indexOutcome: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: REVERT_INDEX_OUTCOMES,
    },
    indexPathCount: { type: "integer", dataClass: "count", required: false },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-revert"],
  proofIds: ["coding-runtime.revert.applied.emitted-line"],
  releaseImpact: "patch",
});

const CODING_RUNTIME_REVERT_REFUSED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.revert.refused",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.opencodeRevert.recordRevertRefused",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    operation: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["undo", "restore", "state", "submit", "commit"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: OPENCODE_REVERT_REFUSALS,
    },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
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
    // Why the turn's index start was cut short, when that is what the undo's index read ended on.
    indexCaptureCause: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: TURN_INDEX_START_BOUNDS,
    },
  },
  causal: "correlation",
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  failureClasses: ["coding-runtime-revert"],
  proofIds: ["coding-runtime.revert.refused.emitted-line"],
  releaseImpact: "patch",
});

/** Each file's content fingerprint (`fileSignature`), or `unverifiable` for one that cannot be proven. */
export type OpenCodeRevertWitness = ReadonlyMap<string, string>;

/** What an undo remembers so a restore can prove the files are still as the undo left them. */
export interface OpenCodeStagedRevert extends CodingRuntimeRevertCounts {
  readonly files: readonly string[];
  /** `undefined` until the undo recorded its witness: such a revert cannot be proven unchanged. */
  witness: OpenCodeRevertWitness | undefined;
  /** What the undo did to the Git index of the paths the turn staged (U-34b). */
  readonly index?: CodingWorkbenchRuntimeRevertIndexOutcome | undefined;
}

/**
 * What Keiko proved about the files the newest turn's own native edits wrote (#3897 review): the
 * targets of each admitted `edit`/`write`/`patch` call, and each file's content fingerprint right
 * after the newest such call that wrote it settled. Reset when a turn starts.
 */
export interface OpenCodeAgentImages {
  /** The admitted edit calls' targets, until the runtime reports the call settled. */
  readonly pending: Map<string, readonly string[]>;
  /** Each file's fingerprint as the turn's own newest edit of it left it. */
  readonly files: Map<string, string>;
  /** The captures still running; a revert waits for them. */
  work: Promise<void>;
}

/** The run slice that records agent images; the composition's `PreparedRun` satisfies it. */
export interface OpenCodeAgentImageRun {
  readonly runId: string;
  readonly workspaceRoot: string;
  agentImages?: OpenCodeAgentImages | undefined;
}

/** Calls remembered between their admission and their settlement; the oldest is forgotten first. */
const AGENT_IMAGE_PENDING_MAX = 256;

/** The slice of a ready native run the revert needs; the composition's `ReadyRun` satisfies it. */
export interface OpenCodeRevertRun {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly client: Pick<
    OpenCodeV2HttpClient,
    "active" | "clearRevert" | "commitRevert" | "messages" | "sessionDiff" | "stageRevert"
  >;
  revert?: OpenCodeStagedRevert | undefined;
  /**
   * Counts the run's interrupts (`abortTask`): it advances when one begins and again when it ends,
   * so an odd value means a stop is interrupting the session now. A state read that fails while it
   * is odd, or that saw it advance, was overtaken by the stop (`revertState`).
   */
  interruptSeq?: number | undefined;
  /**
   * The newest turn's files as the turn left them, recorded when it settled
   * (`recordOpenCodeTurnImage`); `undefined` inside the promise when recording them failed.
   */
  turnImage?: Promise<OpenCodeRevertWitness | undefined> | undefined;
  agentImages?: OpenCodeAgentImages | undefined;
  /** The Git index as the human's turn started and settled (`beginOpenCodeTurnImages`). */
  turnIndex?: TurnIndexRecord | undefined;
}

export interface OpenCodeRevertPorts {
  readonly readyRun: (runId: string) => OpenCodeRevertRun | undefined;
  /** Interrupts the turn in flight and resolves once the session is idle (`abortTask`). */
  readonly abortTask: (runId: string) => Promise<boolean>;
  readonly activityLog: ServerLogSink | undefined;
}

export interface OpenCodeRevertRunPort {
  readonly revertTurn: (
    runId: string,
    action: CodingWorkbenchRuntimeRevertAction,
    correlationId?: string,
  ) => Promise<CodingRuntimeRevertResult>;
  readonly revertState: (runId: string) => Promise<CodingRuntimeRevertState | undefined>;
  /**
   * Makes an undo the human left staged final (`session.revert.commit`) when the post-completion
   * undo window closes (#3904 AC3), so the session that is retained matches the workspace. The run
   * is settled by then and its history captured, so the rewound messages leave no live projection
   * behind. `none` when nothing is staged.
   */
  readonly commitStagedRevert: (runId: string) => Promise<"committed" | "none" | "failed">;
}

export function createOpenCodeRevertRunPort(ports: OpenCodeRevertPorts): OpenCodeRevertRunPort {
  return {
    revertTurn: (runId, action, correlationId) => revertTurn(ports, runId, action, correlationId),
    revertState: (runId) => revertState(ports, runId),
    commitStagedRevert: (runId) => commitStagedRevert(ports, runId),
  };
}

async function commitStagedRevert(
  ports: OpenCodeRevertPorts,
  runId: string,
): Promise<"committed" | "none" | "failed"> {
  const run = ports.readyRun(runId);
  const staged = run?.revert;
  if (run === undefined || staged === undefined) return "none";
  try {
    await run.client.commitRevert(run.sessionId);
    run.revert = undefined;
    recordRevertApplied(
      ports.activityLog,
      runId,
      "commit",
      { ...countsOf(staged), interrupted: false },
      undefined,
    );
    return "committed";
  } catch (error) {
    recordRevertRefusal(ports, runId, "commit", "revert-failed", undefined, error);
    return "failed";
  }
}

async function revertTurn(
  ports: OpenCodeRevertPorts,
  runId: string,
  action: CodingWorkbenchRuntimeRevertAction,
  correlationId: string | undefined,
): Promise<CodingRuntimeRevertResult> {
  const run = ports.readyRun(runId);
  if (run === undefined)
    return recordRevertRefusal(ports, runId, action, "run-unavailable", correlationId);
  try {
    const outcome = action === "undo" ? await undoLastTurn(ports, run) : await restoreUndo(run);
    if (!outcome.ok)
      return recordRevertRefusal(ports, runId, action, outcome.reason, correlationId);
    recordRevertApplied(ports.activityLog, runId, action, outcome, correlationId);
    return { ok: true, ...countsOf(outcome) };
  } catch (error) {
    // An undo the run's teardown overtook (a server stop disposes the runtime under it) is refused
    // like one asked after the teardown: the run is gone, the runtime did not fail (#4271).
    if (ports.readyRun(runId) !== run)
      return recordRevertRefusal(ports, runId, action, "run-unavailable", correlationId);
    return recordRevertRefusal(ports, runId, action, "revert-failed", correlationId, error);
  }
}

interface AppliedRevert extends CodingRuntimeRevertCounts {
  readonly ok: true;
  readonly interrupted: boolean;
  /** The turn's user messages the revert reached (undo only). */
  readonly steps?: number | undefined;
  readonly index?: CodingWorkbenchRuntimeRevertIndexOutcome | undefined;
  readonly indexPathCount?: number | undefined;
}

type RevertOutcome = AppliedRevert | { readonly ok: false; readonly reason: OpenCodeRevertRefusal };

async function undoLastTurn(
  ports: OpenCodeRevertPorts,
  run: OpenCodeRevertRun,
): Promise<RevertOutcome> {
  if (run.revert !== undefined) return { ok: false, reason: "already-staged" };
  // Every check precedes the interrupt: a request that cannot succeed never ends a working turn.
  const range = newestTurnRange(await run.client.messages(run.sessionId));
  const boundary = range?.from;
  const changed = await changedFiles(run, range);
  if (changed.length === 0) return { ok: false, reason: "nothing-to-undo" };
  if (boundary === undefined) return { ok: false, reason: "turn-boundary-missing" };
  const busy = Object.hasOwn(await run.client.active(), run.sessionId);
  // The runtime restores whole files, so a turn is undone only while every file it changed is
  // exactly as the turn itself left it: a human edit is never overwritten.
  if (!(await turnUnchanged(run, changed, busy))) return { ok: false, reason: "workspace-changed" };
  if (busy) {
    // The runtime refuses to rewind a busy session, so a turn in flight is stopped first; what it
    // changed by the time it stopped is then proven once more.
    if (!(await ports.abortTask(run.runId))) return { ok: false, reason: "interrupt-failed" };
    if (!(await turnUnchanged(run, await changedFiles(run, range), true)))
      return { ok: false, reason: "workspace-changed" };
  }
  return stageTurnRevert(ports, run, boundary, range, busy);
}

async function stageTurnRevert(
  ports: OpenCodeRevertPorts,
  run: OpenCodeRevertRun,
  boundary: string,
  range: TurnRange | undefined,
  busy: boolean,
): Promise<RevertOutcome> {
  const staged = await run.client.stageRevert(run.sessionId, boundary);
  const files = staged.files.map((diff) => diff.file);
  // The worktree is back at the turn start; the paths the turn staged leave the index with it.
  const index = await restoreIndexOrReport(ports, run);
  const record: OpenCodeStagedRevert = {
    ...diffCounts(staged.files),
    files,
    witness: undefined,
    ...(index.outcome === undefined ? {} : { index: index.outcome }),
  };
  // Recorded before the witness: the revert is in place from here on, even if proving it fails.
  run.revert = record;
  record.witness = await captureWitness(run.workspaceRoot, record.files);
  return {
    ok: true,
    interrupted: busy,
    steps: range?.steps,
    indexPathCount: index.restoredCount,
    ...countsOf(record),
    ...(record.index === undefined ? {} : { index: record.index }),
  };
}

/**
 * Puts the paths the turn staged back in the Git index. An error (an index that cannot be locked, a
 * Git that cannot run) never fails the undo that already restored the files: it is logged with its
 * frames and the undo reports the index as `unavailable`.
 */
async function restoreIndexOrReport(
  ports: OpenCodeRevertPorts,
  run: OpenCodeRevertRun,
): Promise<Awaited<ReturnType<typeof restoreTurnIndex>>> {
  try {
    const restored = await restoreTurnIndex(
      run.workspaceRoot,
      run.turnIndex,
      governedIndexRecord(run.runId),
    );
    const failure: unknown = run.turnIndex?.failure;
    if (failure !== undefined) reportIndexFailure(ports, run, failure);
    return restored;
  } catch (error) {
    reportIndexFailure(ports, run, error);
    return { outcome: "unavailable", restoredCount: 0 };
  }
}

function reportIndexFailure(
  ports: OpenCodeRevertPorts,
  run: OpenCodeRevertRun,
  error: unknown,
): void {
  recordRevertRefused(ports.activityLog, {
    runId: run.runId,
    operation: "undo",
    reason: "revert-failed",
    correlationId: undefined,
    error,
  });
}

async function restoreUndo(run: OpenCodeRevertRun): Promise<RevertOutcome> {
  const staged = run.revert;
  if (staged === undefined) return { ok: false, reason: "nothing-staged" };
  // `clear` writes the turn's files back over whatever is there now, so it only runs while the
  // files are exactly as the undo left them: a human edit in between is never overwritten.
  if (!(await witnessHolds(run.workspaceRoot, staged.files, staged.witness))) {
    return { ok: false, reason: "workspace-changed" };
  }
  await run.client.clearRevert(run.sessionId);
  run.revert = undefined;
  return { ok: true, interrupted: false, ...countsOf(staged) };
}

async function revertState(
  ports: OpenCodeRevertPorts,
  runId: string,
): Promise<CodingRuntimeRevertState | undefined> {
  const run = ports.readyRun(runId);
  if (run === undefined) return undefined;
  if (run.revert !== undefined)
    return {
      staged: true,
      ...countsOf(run.revert),
      ...(run.revert.index === undefined ? {} : { index: run.revert.index }),
    };
  const interrupts = run.interruptSeq ?? 0;
  try {
    return { staged: false, ...diffCounts(await turnDiff(run)) };
  } catch (error) {
    // A read the run's teardown overtook (a server stop disposes the runtime under it) ends like a
    // read of a run that is gone: no counts and no failure, since nothing was reverted (#4119). So
    // does a read the stop's interrupt of the still streaming session overtook, before the disposal
    // (#3907).
    if (ports.readyRun(runId) !== run || interruptOvertook(run, interrupts)) return undefined;
    recordRevertRefusal(ports, runId, "state", "revert-failed", undefined, error);
    return undefined;
  }
}

/** Whether an interrupt was running, or began and ended, since the run's `interruptSeq` was `seen`. */
function interruptOvertook(run: OpenCodeRevertRun, seen: number): boolean {
  const now = run.interruptSeq ?? 0;
  return now !== seen || now % 2 === 1;
}

/**
 * The first user message of the newest turn. A turn runs from the first prompt after the session
 * was last idle until its idle marker, so a prompt steered into a busy turn belongs to the same
 * turn and the boundary is the earliest user message after the previous idle marker; the markers
 * that end the newest turn itself (a restore appends one more) are skipped. A turn Keiko started to
 * continue the human's request (its automatic verification continuation) is part of that request,
 * so the boundary reaches back across it to the human's own turn (#3904 AC3).
 */
export function newestTurnBoundary(
  messages: readonly Readonly<Record<string, unknown>>[],
): string | undefined {
  return newestTurnRange(messages)?.from;
}

/** The newest turn's span: its human request and the last user message that belongs to it. */
export interface TurnRange {
  readonly from: string;
  /** User messages of the turn: the human's request plus its continuations and steered prompts. */
  readonly steps: number;
  /** The newest user message of the turn when it is not `from` (a continuation or steered prompt). */
  readonly to?: string;
}

/**
 * The newest turn's whole span. The runtime's `session.diff` reports only the turn of `from`
 * unless it is given `to`, so a turn Keiko continued (verification, delivery) would report just its
 * first step; `to` names the newest user message so the range runs through every step (U-34).
 */
export function newestTurnRange(
  messages: readonly Readonly<Record<string, unknown>>[],
): TurnRange | undefined {
  const from = newestTurnStart(messages);
  if (from === undefined) return undefined;
  const newest = newestUserMessageId(messages);
  const steps = userMessagesFrom(messages, from);
  return newest === undefined || newest === from ? { from, steps } : { from, to: newest, steps };
}

function userMessagesFrom(
  messages: readonly Readonly<Record<string, unknown>>[],
  from: string,
): number {
  const start = messages.findIndex((message) => message.id === from);
  return messages.slice(Math.max(0, start)).filter((message) => message.type === "user").length;
}

function newestUserMessageId(
  messages: readonly Readonly<Record<string, unknown>>[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === "user" && typeof message.id === "string") return message.id;
  }
  return undefined;
}

function newestTurnStart(
  messages: readonly Readonly<Record<string, unknown>>[],
): string | undefined {
  let boundary: { readonly id: string; readonly continuation: boolean } | undefined;
  let inTurn = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.type === "idle") {
      if (inTurn && boundary?.continuation !== true) break;
      inTurn = false;
      continue;
    }
    inTurn = true;
    if (message.type === "user" && typeof message.id === "string")
      boundary = { id: message.id, continuation: continuesRequest(message) };
  }
  return boundary?.id;
}

function continuesRequest(message: Readonly<Record<string, unknown>>): boolean {
  return keikoContinuationOrigin(message.metadata) !== undefined;
}

/** What the newest turn changed, from its human request on: Keiko's continuations included. */
async function turnDiff(run: OpenCodeRevertRun): Promise<readonly OpenCodeV2FileDiff[]> {
  const range = newestTurnRange(await run.client.messages(run.sessionId));
  return rangeDiff(run, range);
}

function diffCounts(files: readonly OpenCodeV2FileDiff[]): CodingRuntimeRevertCounts {
  return {
    fileCount: files.length,
    additions: files.reduce((total, diff) => total + diff.additions, 0),
    deletions: files.reduce((total, diff) => total + diff.deletions, 0),
  };
}

function countsOf(source: CodingRuntimeRevertCounts): CodingRuntimeRevertCounts {
  return {
    fileCount: source.fileCount,
    additions: source.additions,
    deletions: source.deletions,
  };
}

const NO_FOLLOW_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** Files fingerprinted at once, so a turn that changed many files never exhausts descriptors. */
const WITNESS_BATCH = 16;

/**
 * A content-bound fingerprint of one workspace file (#3897 review): the SHA-256 of its bytes, read
 * through a descriptor that follows no link and is the file the metadata probe saw, or `absent`.
 * `undefined` for a path that cannot be proven: outside the portable workspace grammar, a link or
 * anything but a regular file. Size and timestamps are no witness: a same-size copy that puts the
 * old modification time back would pass them. The digest never leaves this module.
 */
async function fileSignature(root: string, relative: string): Promise<string | undefined> {
  if (!isPortableWorkspaceRelativePath(relative)) return undefined;
  const path = join(root, ...relative.split("/"));
  const probed = lstatSync(path, { throwIfNoEntry: false });
  if (probed === undefined) return "absent";
  if (!probed.isFile()) return undefined;
  const handle = await open(path, NO_FOLLOW_READ);
  try {
    const opened = await handle.stat();
    const same = opened.isFile() && opened.ino === probed.ino && opened.dev === probed.dev;
    return same ? `sha256:${await contentDigest(handle)}` : undefined;
  } finally {
    await handle.close();
  }
}

function contentDigest(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const stream = handle.createReadStream({ autoClose: false, start: 0 });
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

async function signatures(
  root: string,
  files: readonly string[],
): Promise<readonly (string | undefined)[]> {
  const head = await Promise.all(
    files.slice(0, WITNESS_BATCH).map((file) => fileSignature(root, file)),
  );
  if (files.length <= WITNESS_BATCH) return head;
  return [...head, ...(await signatures(root, files.slice(WITNESS_BATCH)))];
}

async function captureWitness(
  root: string,
  files: readonly string[],
): Promise<OpenCodeRevertWitness> {
  const current = await signatures(root, files);
  // A path the runtime named outside the portable workspace grammar cannot be proven.
  return new Map(files.map((file, index) => [file, current[index] ?? "unverifiable"]));
}

async function witnessHolds(
  root: string,
  files: readonly string[],
  witness: OpenCodeRevertWitness | undefined,
): Promise<boolean> {
  if (witness === undefined) return false;
  const current = await signatures(root, files);
  return files.every((file, index) => {
    const recorded = witness.get(file);
    return recorded !== undefined && recorded !== "unverifiable" && current[index] === recorded;
  });
}

async function changedFiles(
  run: OpenCodeRevertRun,
  range: TurnRange | undefined,
): Promise<readonly string[]> {
  return (await rangeDiff(run, range)).map((diff) => diff.file);
}

/** The runtime's diff of the turn's whole range; `to` is sent only when the turn has several steps. */
function rangeDiff(
  run: OpenCodeRevertRun,
  range: TurnRange | undefined,
): Promise<readonly OpenCodeV2FileDiff[]> {
  return range?.to === undefined
    ? run.client.sessionDiff(run.sessionId, undefined, range?.from)
    : run.client.sessionDiff(run.sessionId, undefined, range.from, range.to);
}

/**
 * Whether every file the turn changed is as the turn left it. A file one of the turn's own native
 * edits wrote is proven by that edit's image. Any other file (one a shell command changed, say) is
 * proven only by the image the settled turn left; a turn still in flight has none, so such a file
 * cannot be proven and the undo is refused rather than guessing who changed it.
 */
async function turnUnchanged(
  run: OpenCodeRevertRun,
  files: readonly string[],
  busy: boolean,
): Promise<boolean> {
  await run.agentImages?.work;
  const agent = run.agentImages?.files;
  const settled = busy ? undefined : await run.turnImage;
  const current = await signatures(run.workspaceRoot, files);
  return files.every((file, index) => {
    const recorded = agent?.get(file) ?? settled?.get(file);
    return recorded !== undefined && recorded !== "unverifiable" && current[index] === recorded;
  });
}

/** The identity of one native tool call, as both its permission check and its settlement name it. */
export function openCodeNativeCallKey(messageId: string, callId: string): string {
  return `${messageId}\u0000${callId}`;
}

function freshAgentImages(): OpenCodeAgentImages {
  return { pending: new Map(), files: new Map(), work: Promise.resolve() };
}

/** A new turn starts: neither the last turn's settled image nor its edits prove anything now. */
export function beginOpenCodeTurnImages(run: OpenCodeRevertRun): void {
  resetGovernedIndexPaths(run.runId);
  run.turnIndex = beginTurnIndex(run.workspaceRoot);
  run.turnImage = undefined;
  run.agentImages = freshAgentImages();
}

/** Remembers the targets of an admitted native edit call until the runtime reports it settled. */
export function noteOpenCodeEditTargets(
  run: OpenCodeAgentImageRun,
  callKey: string,
  files: readonly string[],
): void {
  if (files.length === 0) return;
  run.agentImages ??= freshAgentImages();
  const { pending } = run.agentImages;
  pending.delete(callKey);
  pending.set(callKey, files);
  const oldest = pending.size > AGENT_IMAGE_PENDING_MAX ? pending.keys().next().value : undefined;
  if (oldest !== undefined) pending.delete(oldest);
}

/**
 * A native edit call completed: its targets' contents now are what the turn itself wrote, so they
 * become the files' agent images. A failed capture leaves them unproven, which refuses an undo.
 */
export function recordOpenCodeEditSettled(
  run: OpenCodeAgentImageRun,
  callKey: string,
  activityLog: ServerLogSink | undefined,
): void {
  const images = run.agentImages;
  const files = images?.pending.get(callKey);
  if (images === undefined || files === undefined) return;
  images.pending.delete(callKey);
  images.work = images.work
    .then(async () => {
      const current = await signatures(run.workspaceRoot, files);
      files.forEach((file, index) => images.files.set(file, current[index] ?? "unverifiable"));
    })
    .catch((error: unknown) => {
      for (const file of files) images.files.set(file, "unverifiable");
      recordRevertRefused(activityLog, {
        runId: run.runId,
        operation: "state",
        reason: "revert-failed",
        correlationId: undefined,
        error,
      });
    });
}

/**
 * Records the newest turn's files as the turn left them, once it settled, so a later undo can
 * prove a human has not changed them since (#3897 review). A failure leaves no image, and an undo
 * of a settled turn without one is refused as `workspace-changed`: nothing proves it safe.
 */
export function recordOpenCodeTurnImage(
  run: OpenCodeRevertRun,
  activityLog: ServerLogSink | undefined,
): void {
  if (run.turnIndex !== undefined) settleTurnIndex(run.workspaceRoot, run.turnIndex);
  run.turnImage = turnImage(run).catch((error: unknown) => {
    recordRevertRefused(activityLog, {
      runId: run.runId,
      operation: "state",
      reason: "revert-failed",
      correlationId: undefined,
      error,
    });
    return undefined;
  });
}

async function turnImage(run: OpenCodeRevertRun): Promise<OpenCodeRevertWitness> {
  const files = (await turnDiff(run)).map((diff) => diff.file);
  return captureWitness(run.workspaceRoot, files);
}

/** True while an undo is staged: a new turn would make the runtime commit it and rewrite history. */
export function openCodeRevertBlocksTurn(run: { readonly revert?: unknown }): boolean {
  return run.revert !== undefined;
}

export function recordRevertTurnBlocked(
  activityLog: ServerLogSink | undefined,
  runId: string,
): void {
  writeRefusal(activityLog, runId, "submit", "turn-blocked", undefined, undefined);
}

function recordRevertRefusal(
  ports: OpenCodeRevertPorts,
  runId: string,
  operation: OpenCodeRevertOperation,
  reason: OpenCodeRevertRefusal,
  correlationId: string | undefined,
  error?: unknown,
): { readonly ok: false; readonly reason: OpenCodeRevertRefusal } {
  writeRefusal(ports.activityLog, runId, operation, reason, correlationId, error);
  return { ok: false, reason };
}

function recordRevertApplied(
  activityLog: ServerLogSink | undefined,
  runId: string,
  action: CodingWorkbenchRuntimeRevertAction | "commit",
  outcome: CodingRuntimeRevertCounts &
    Pick<AppliedRevert, "index" | "indexPathCount" | "steps"> & {
      readonly interrupted: boolean;
    },
  correlationId: string | undefined,
): void {
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      CODING_RUNTIME_REVERT_APPLIED_OPERATION,
      { level: "info", correlationId: correlationIdOrUnknown(correlationId ?? runId) },
      {
        runId,
        action,
        fileCount: outcome.fileCount,
        additions: outcome.additions,
        deletions: outcome.deletions,
        interrupted: outcome.interrupted,
        ...(outcome.steps === undefined ? {} : { stepCount: outcome.steps }),
        ...(outcome.index === undefined
          ? {}
          : { indexOutcome: outcome.index, indexPathCount: outcome.indexPathCount ?? 0 }),
      },
    ),
  );
}

function recordRevertRefused(
  activityLog: ServerLogSink | undefined,
  input: {
    readonly runId: string;
    readonly operation: OpenCodeRevertOperation;
    readonly reason: OpenCodeRevertRefusal;
    readonly correlationId: string | undefined;
    readonly error: unknown;
  },
): void {
  const failed = input.error !== undefined;
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      CODING_RUNTIME_REVERT_REFUSED_OPERATION,
      {
        level: "warn",
        correlationId: correlationIdOrUnknown(input.correlationId ?? input.runId),
        errorKind: refusalErrorKind(input.reason, input.error),
      },
      {
        runId: input.runId,
        operation: input.operation,
        reason: input.reason,
        ...(failed
          ? { frames: keikoStackFrames(input.error), causeChain: causeChain(input.error) }
          : {}),
        ...(input.error instanceof TurnIndexStartBoundError
          ? { indexCaptureCause: input.error.bound }
          : {}),
      },
    ),
  );
}

function writeRefusal(
  activityLog: ServerLogSink | undefined,
  runId: string,
  operation: OpenCodeRevertOperation,
  reason: OpenCodeRevertRefusal,
  correlationId: string | undefined,
  error: unknown,
): void {
  recordRevertRefused(activityLog, { runId, operation, reason, correlationId, error });
}

function refusalErrorKind(reason: OpenCodeRevertRefusal, error: unknown): ActivityLogErrorKind {
  if (error === undefined) return reason === "run-unavailable" ? "unavailable" : "conflict";
  const classified = errorKindOf(error);
  const registered = activityLogErrorKindOr(classified, "unavailable");
  if (registered !== "unavailable" || classified === "unavailable") return registered;
  const normalized = classified.toLowerCase();
  if (/timeout|timedout/u.test(normalized)) return "timeout";
  return /abort|cancel/u.test(normalized) ? "cancelled" : "unavailable";
}
