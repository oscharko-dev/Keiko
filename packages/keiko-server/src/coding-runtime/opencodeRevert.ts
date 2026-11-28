import { causeChain, errorKindOf, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogErrorKindOr,
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
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
  CodingRuntimeStagedRevertOutcome,
} from "./codingRuntimeRevert.js";
import { governedIndexRecord, resetGovernedIndexPaths } from "./governedIndexPaths.js";
import {
  beginTurnIndex,
  TURN_INDEX_START_BOUNDS,
  TurnIndexStartBoundError,
  countRestorableTurnIndexPaths,
  reapplyTurnIndexMoves,
  restoreTurnIndex,
  settleTurnIndex,
  type TurnIndexMoves,
  type TurnIndexRecord,
} from "./opencodeTurnIndex.js";
import { HumanWriteGateTimeoutError, NativeWriteGateTimeoutError } from "./nativeWriteGate.js";
import { keikoContinuationOrigin } from "./opencodeTurnOrigin.js";
import {
  fileSignatureSync,
  guardedNativeWrite,
  provenNotApplied,
  signatures,
  UNCERTAIN_REASONS,
  type RevertSettlement,
  type UncertainReason,
} from "./opencodeRevertGuard.js";
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
  "index-changed",
  "interrupt-failed",
  "nothing-staged",
  "nothing-to-undo",
  "outcome-uncertain",
  "revert-failed",
  "run-unavailable",
  "turn-blocked",
  "turn-boundary-missing",
  "workspace-changed",
  "write-gate-busy",
  "write-gate-timeout",
] as const satisfies readonly CodingRuntimeRevertRefusal[];

type OpenCodeRevertRefusal = (typeof OPENCODE_REVERT_REFUSALS)[number];
type OpenCodeRevertOperation =
  CodingWorkbenchRuntimeRevertAction | "state" | "submit" | "commit" | "write";

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
      values: ["undo", "restore", "commit", "cleared"],
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
    // How the runtime's own file write settled: `response-lost` when the files show the write but
    // its answer never arrived.
    settlement: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["clean", "response-lost"],
    },
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
      values: ["undo", "restore", "state", "submit", "commit", "write"],
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
    // A person's write that waited for a runtime revert write and was refused: the upper edge of
    // the wait bucket (`operation: write`, reason `write-gate-timeout`), never the wait itself.
    waitBucketMs: { type: "integer", dataClass: "count", required: false },
    // Why the runtime's own file write could not be settled from the files (`outcome-uncertain`).
    uncertainReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: UNCERTAIN_REASONS,
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
  index?: CodingWorkbenchRuntimeRevertIndexOutcome | undefined;
  /** The index transitions the undo made; a restore makes them again, or refuses when drifted. */
  indexMoves?: TurnIndexMoves | undefined;
  /** The files as the turn left them, which a Restore writes back: what its write must produce. */
  redo?: ReadonlyMap<string, string> | undefined;
  /**
   * The runtime's write ended in a state the files cannot settle. The record claims nothing: a later
   * Undo, Restore or the undo window's end read the files again and settle it when they now show a
   * known state; a new turn settles it as kept as it is (`settleUncertainRevert`). A Restore keeps
   * its index moves, so the index is either rolled back or finished with the files, never dropped.
   */
  uncertain?: UncertainRevert | undefined;
}

export interface UncertainRevert {
  readonly reason: UncertainReason;
  readonly during: "undo" | "restore";
  /** A Restore had already made the undo's index moves again when its write could not be settled. */
  readonly indexMoved: boolean;
  /**
   * The stage request was sent, so the runtime may hold a staged revert whatever the files show; an
   * Undo record settled as "not applied" must then clear that revert explicitly, never drop it.
   */
  readonly runtimeStaged: boolean;
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
  /**
   * Each file's fingerprint as the turn's first admitted native edit of it found it, read before
   * that edit ran: what an Undo must leave there (`absent` for a file the edit creates). A file only
   * a shell command changed has none.
   */
  readonly turnStart: Map<string, string>;
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

/** What the record-settling helpers need of the ports: only the log. */
export type OpenCodeRevertLogPort = Pick<OpenCodeRevertPorts, "activityLog">;

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
  readonly commitStagedRevert: (runId: string) => Promise<CodingRuntimeStagedRevertOutcome>;
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
): Promise<CodingRuntimeStagedRevertOutcome> {
  const run = ports.readyRun(runId);
  const staged = run?.revert;
  if (run === undefined || staged === undefined) return "none";
  const uncertain = staged.uncertain;
  if (uncertain !== undefined) {
    // Never finalized blindly: the files must show a known state first.
    const settled = await settleUncertainRevert(ports, run, runId);
    if (settled === "unknown") {
      recordRevertRefusal(ports, runId, "commit", "outcome-uncertain", undefined, undefined, {
        uncertainReason: uncertain.reason,
      });
      // Neither committed nor kept: the window closes and the run ends, which the closed window's
      // `unsettled` outcome reports as a warning.
      return "unsettled";
    }
    if (run.revert === undefined) return "none";
  }
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
    const outcome =
      action === "undo"
        ? await undoLastTurn(ports, run, correlationId ?? runId)
        : await restoreUndo(ports, run, correlationId ?? runId);
    if (!outcome.ok)
      return recordRevertRefusal(
        ports,
        runId,
        action,
        outcome.reason,
        correlationId,
        outcome.error,
        { uncertainReason: outcome.uncertainReason, errorKind: outcome.errorKind },
      );
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
  /** How the runtime's own file write settled. */
  readonly settlement?: RevertSettlement | undefined;
}

interface RefusedRevert {
  readonly ok: false;
  readonly reason: OpenCodeRevertRefusal;
  /** The runtime's failure behind an uncertain outcome, logged with its frames. */
  readonly error?: unknown;
  readonly uncertainReason?: UncertainReason | undefined;
  /** The closed kind of a read failure behind an `unreadable` outcome. */
  readonly errorKind?: ActivityLogErrorKind | undefined;
}

type RevertOutcome = AppliedRevert | RefusedRevert;

// What the files show about an uncertain record: its write happened, did not, or cannot be told.
type UncertainSettlement = "applied" | "not-applied" | "unknown";

async function undoLastTurn(
  ports: OpenCodeRevertPorts,
  run: OpenCodeRevertRun,
  correlationId: string,
): Promise<RevertOutcome> {
  // An uncertain record is settled from the files first; only a record that is gone lets the undo go on.
  const held = run.revert?.uncertain;
  if (held !== undefined && (await settleUncertainRevert(ports, run, correlationId)) === "unknown")
    return { ok: false, reason: "outcome-uncertain", uncertainReason: held.reason };
  if (run.revert !== undefined) return { ok: false, reason: "already-staged" };
  // Every check precedes the interrupt: a request that cannot succeed never ends a working turn.
  const range = newestTurnRange(await run.client.messages(run.sessionId));
  const boundary = range?.from;
  const changed = await changedFiles(run, range);
  // A turn that only staged or unstaged files changed no worktree file but is still undoable.
  if (changed.length === 0 && (await indexPathCount(ports, run)) === 0)
    return { ok: false, reason: "nothing-to-undo" };
  if (boundary === undefined) return { ok: false, reason: "turn-boundary-missing" };
  const busy = Object.hasOwn(await run.client.active(), run.sessionId);
  // The runtime restores whole files, so a turn is undone only while every file it changed is
  // exactly as the turn itself left it: a human edit is never overwritten.
  const stopped = await provenBeforeStaging(ports, run, { range, changed, busy });
  if (!("proven" in stopped)) return stopped;
  const { files, proven } = stopped;
  return stageTurnRevert(ports, run, { boundary, range, busy, correlationId, files, proven });
}

/**
 * The files the turn changed with the contents proven for them. A turn in flight is stopped first
 * (the runtime refuses to rewind a busy session), and what it changed by the time it stopped is
 * proven once more.
 */
async function provenBeforeStaging(
  ports: OpenCodeRevertPorts,
  run: OpenCodeRevertRun,
  turn: {
    readonly range: TurnRange | undefined;
    readonly changed: readonly string[];
    readonly busy: boolean;
  },
): Promise<
  | { readonly files: readonly string[]; readonly proven: ReadonlyMap<string, string> }
  | RefusedRevert
> {
  const first = await provenTurnImage(run, turn.changed, turn.busy);
  if (first === undefined) return { ok: false, reason: "workspace-changed" };
  if (!turn.busy) return { files: turn.changed, proven: first };
  if (!(await ports.abortTask(run.runId))) return { ok: false, reason: "interrupt-failed" };
  const files = await changedFiles(run, turn.range);
  const proven = await provenTurnImage(run, files, true);
  return proven === undefined ? { ok: false, reason: "workspace-changed" } : { files, proven };
}

async function stageTurnRevert(
  ports: OpenCodeRevertPorts,
  run: OpenCodeRevertRun,
  turn: {
    readonly boundary: string;
    readonly range: TurnRange | undefined;
    readonly busy: boolean;
    readonly correlationId: string;
    /** The files the turn changed and the contents the turn itself left in them. */
    readonly files: readonly string[];
    readonly proven: ReadonlyMap<string, string>;
  },
): Promise<RevertOutcome> {
  const { boundary } = turn;
  // The runtime writes the files itself, so the write runs under the guard: inside the workspace's
  // native-write gate, with the proven contents read again right before the request and the files
  // read once more afterwards to settle the outcome.
  const guarded = await guardedNativeWrite({
    root: run.workspaceRoot,
    files: turn.files,
    before: turn.proven,
    call: () => run.client.stageRevert(run.sessionId, boundary),
  });
  if (guarded.kind === "changed") return { ok: false, reason: "workspace-changed" };
  if (guarded.kind === "failed") throw guarded.error;
  if (guarded.kind === "uncertain") return holdUncertainUndo(run, turn, guarded);
  const expected = expectedAfterUndo(run, guarded.result?.files ?? []);
  if (guarded.result === undefined || !landedAsExpected(expected, guarded.landed))
    return holdUncertainUndo(run, turn, {
      reason: "unexpected-content",
      error: undefined,
    });
  return recordStagedTurn(ports, run, guarded.result, {
    ...turn,
    landed: guarded.landed,
    expected,
    unknownStart: new Set(
      guarded.result.files
        .map((diff) => diff.file)
        .filter((file) => run.agentImages?.turnStart.get(file) === START_UNKNOWN),
    ),
  });
}

/**
 * What the Undo must leave in each file, as far as the runtime and the turn tell: `absent` for a
 * file the stage reports as added, else the contents the turn's first native edit of it found.
 */
function expectedAfterUndo(
  run: OpenCodeRevertRun,
  staged: readonly OpenCodeV2FileDiff[],
): ReadonlyMap<string, string> {
  const expected = new Map<string, string>();
  for (const diff of staged) {
    const start = diff.status === "added" ? "absent" : run.agentImages?.turnStart.get(diff.file);
    if (start !== undefined && start !== START_UNKNOWN) expected.set(diff.file, start);
  }
  return expected;
}

function landedAsExpected(
  expected: ReadonlyMap<string, string>,
  landed: ReadonlyMap<string, string>,
): boolean {
  return [...expected].every(([file, start]) => !landed.has(file) || landed.get(file) === start);
}

/**
 * The runtime's write ended in a state Keiko cannot read as staged or untouched (its answer was
 * lost after the files changed, or the files hold neither the proven nor a settled content). The
 * revert may be staged in the runtime, so the record is held until the files settle it (a later
 * Undo or Restore, the window's end, or a new turn), but it claims nothing: no witness, no index work, so a Restore cannot write over
 * anything. `redo` holds the proven state, which tells a later look whether the files went back.
 */
function holdUncertainUndo(
  run: OpenCodeRevertRun,
  turn: { readonly files: readonly string[]; readonly proven: ReadonlyMap<string, string> },
  cause: {
    readonly reason: UncertainReason;
    readonly error?: unknown;
    readonly errorKind?: ActivityLogErrorKind | undefined;
  },
): RevertOutcome {
  run.revert = {
    fileCount: turn.files.length,
    additions: 0,
    deletions: 0,
    files: turn.files,
    witness: undefined,
    redo: turn.proven,
    uncertain: {
      reason: cause.reason,
      during: "undo",
      indexMoved: false,
      runtimeStaged: true,
    },
  };
  return {
    ok: false,
    reason: "outcome-uncertain",
    error: cause.error,
    uncertainReason: cause.reason,
    errorKind: cause.errorKind,
  };
}

async function recordStagedTurn(
  ports: OpenCodeRevertPorts,
  run: OpenCodeRevertRun,
  staged: Awaited<ReturnType<OpenCodeRevertRun["client"]["stageRevert"]>>,
  turn: {
    readonly range: TurnRange | undefined;
    readonly busy: boolean;
    readonly correlationId: string;
    readonly proven: ReadonlyMap<string, string>;
    readonly landed: ReadonlyMap<string, string>;
    readonly expected: ReadonlyMap<string, string>;
    /** Files whose start could not be read when their native edit was admitted. */
    readonly unknownStart: ReadonlySet<string>;
  },
): Promise<RevertOutcome> {
  const { range, busy, correlationId } = turn;
  const files = staged.files.map((diff) => diff.file);
  // The worktree is back at the turn start; the paths the turn staged leave the index with it.
  let indexMoves: TurnIndexMoves | undefined;
  const index = await restoreIndexOrReport(
    ports,
    run,
    (moves) => {
      indexMoves = moves;
    },
    correlationId,
  );
  const record: OpenCodeStagedRevert = {
    ...diffCounts(staged.files),
    files,
    witness: undefined,
    redo: new Map(files.flatMap((file) => provenEntry(turn.proven, file))),
    ...(index.outcome === undefined ? {} : { index: index.outcome }),
    ...(indexMoves === undefined ? {} : { indexMoves }),
  };
  // Recorded before the witness: the revert is in place from here on, even if proving it fails.
  run.revert = record;
  // The files as the guard read them inside the gate right after the write; a file the guard did not
  // cover is read now.
  record.witness = new Map(files.map((file) => [file, undoWitness(file, turn)] as const));
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
 * What a later Restore may prove for one file of the Undo. A file the guard read as the runtime's
 * stage expects it, or one the stage left exactly as it was proven, is proven by what the guard read
 * inside the gate. A changed file no expectation covers (a file only a shell command changed) could
 * hold a program's edit as well as the runtime's stage, so it stays `unverifiable`: a later Restore
 * refuses it instead of writing the turn's content over it.
 */
function undoWitness(
  file: string,
  turn: {
    readonly proven: ReadonlyMap<string, string>;
    readonly landed: ReadonlyMap<string, string>;
    readonly expected: ReadonlyMap<string, string>;
    readonly unknownStart: ReadonlySet<string>;
  },
): string {
  // A file whose start was unknown cannot be checked against one, even when the stage left it
  // untouched: like a file only a shell command changed, it is never proven for a Restore.
  if (turn.unknownStart.has(file) && !turn.expected.has(file)) return "unverifiable";
  // A file the guard did not read inside the gate (it was not among the files proven before the
  // request) could have been changed by anyone since: nothing proves it, so it stays unverifiable.
  const landed = turn.landed.get(file);
  if (landed === undefined) return "unverifiable";
  return turn.expected.has(file) || landed === turn.proven.get(file) ? landed : "unverifiable";
}

/**
 * Puts the paths the turn staged back in the Git index. An error (an index that cannot be locked, a
 * Git that cannot run) never fails the undo that already restored the files: it is logged with its
 * frames and the undo reports the index as `unavailable`.
 */
async function restoreIndexOrReport(
  ports: OpenCodeRevertPorts,
  run: OpenCodeRevertRun,
  onRestored: (moves: TurnIndexMoves) => void,
  correlationId: string,
): Promise<Awaited<ReturnType<typeof restoreTurnIndex>>> {
  try {
    const restored = await restoreTurnIndex(
      run.workspaceRoot,
      run.turnIndex,
      governedIndexRecord(run.runId),
      onRestored,
      correlationId,
    );
    const failure: unknown = run.turnIndex?.failure;
    if (failure !== undefined) reportIndexFailure(ports, run, failure);
    return restored;
  } catch (error) {
    reportIndexFailure(ports, run, error);
    return { outcome: "unavailable", restoredCount: 0 };
  }
}

/** Index paths of the newest turn an undo can take back; an unreadable index counts as none. */
async function indexPathCount(ports: OpenCodeRevertPorts, run: OpenCodeRevertRun): Promise<number> {
  try {
    return await countRestorableTurnIndexPaths(
      run.workspaceRoot,
      run.turnIndex,
      governedIndexRecord(run.runId),
    );
  } catch (error) {
    reportIndexFailure(ports, run, error);
    return 0;
  }
}

function reportIndexFailure(
  ports: OpenCodeRevertLogPort,
  run: OpenCodeRevertRun,
  error: unknown,
  correlationId?: string,
  operation: "undo" | "restore" = "undo",
): void {
  recordRevertRefused(ports.activityLog, {
    runId: run.runId,
    operation,
    reason: "revert-failed",
    correlationId,
    error,
  });
}

/** How many index paths an undo put back and a restore can make again; absent when none. */
function stagedIndexPaths(staged: OpenCodeStagedRevert): { indexPathCount?: number } {
  const count = staged.indexMoves?.entries.length ?? 0;
  return count > 0 ? { indexPathCount: count } : {};
}

/**
 * A Restore asked of an uncertain record reads the files first: `undefined` lets the ordinary
 * Restore go on (the files went back to the proven state), anything else is its answer.
 */
async function restoreFromUncertain(
  ports: OpenCodeRevertPorts,
  run: OpenCodeRevertRun,
  staged: OpenCodeStagedRevert,
  correlationId: string,
): Promise<RevertOutcome | undefined> {
  const uncertain = staged.uncertain;
  if (uncertain === undefined) return undefined;
  const settled = await settleUncertainRevert(ports, run, correlationId);
  if (settled === "unknown")
    return { ok: false, reason: "outcome-uncertain", uncertainReason: uncertain.reason };
  if (run.revert === undefined && settled === "not-applied")
    return { ok: false, reason: "nothing-staged" };
  if (settled === "not-applied") return undefined;
  return {
    ok: true,
    interrupted: false,
    settlement: "response-lost",
    ...countsOf(staged),
    ...restoredIndex(uncertain.indexMoved ? "restored" : "none", staged),
  };
}

async function restoreUndo(
  ports: OpenCodeRevertPorts,
  run: OpenCodeRevertRun,
  correlationId: string,
): Promise<RevertOutcome> {
  const staged = run.revert;
  if (staged === undefined) return { ok: false, reason: "nothing-staged" };
  const fromUncertain = await restoreFromUncertain(ports, run, staged, correlationId);
  if (fromUncertain !== undefined) return fromUncertain;
  // `clear` writes the turn's files back over whatever is there now, so it only runs while the
  // files are exactly as the undo left them: a human edit in between is never overwritten.
  if (!(await witnessHolds(run.workspaceRoot, staged.files, staged.witness))) {
    return { ok: false, reason: "workspace-changed" };
  }
  const moved = await reapplyIndexMoves(run, staged, correlationId);
  if (moved === "changed") return { ok: false, reason: "index-changed" };
  if (moved === "failed") return { ok: false, reason: "revert-failed" };
  const cleared = await clearOrRollBack(ports, run, staged, moved, correlationId);
  if (!cleared.ok) return cleared;
  run.revert = undefined;
  return {
    ok: true,
    interrupted: false,
    settlement: cleared.settlement,
    ...countsOf(staged),
    ...restoredIndex(moved, staged),
  };
}

/**
 * What the index part of a Restore reports: `restored` when its moves were made again, otherwise the
 * outcome the retained undo kept when the index could not be put back (a dropped rollback), so the
 * result never reads as a complete restore of an index that may mix the turn's and the person's.
 */
function restoredIndex(
  moved: "restored" | "none",
  staged: OpenCodeStagedRevert,
): Pick<AppliedRevert, "index" | "indexPathCount"> {
  if (moved === "restored" && staged.indexMoves !== undefined)
    return { index: "restored", indexPathCount: staged.indexMoves.entries.length };
  const kept = staged.index;
  return kept === "changed-after-turn" || kept === "unavailable" ? { index: kept } : {};
}

/**
 * The last step before the runtime writes the turn's files back, run under the guard. The index
 * work before it took time the first witness check did not cover, so the guard proves the files
 * once more, byte for byte, as the last step before the request, inside the workspace's
 * native-write gate (a save a person makes through Keiko waits for it). Keiko cannot make the
 * runtime's own write (`DELETE /api/session/{id}/revert`) conditional, so the files are read again
 * afterwards and the outcome is settled from them alone:
 *
 * - a file not as proven before the request refuses with `workspace-changed`, nothing is written
 *   and the index returns to the undone state;
 * - a request that failed with the files still undone is a failure: the index returns and the undo
 *   stays staged;
 * - a request whose answer was lost after the files show the write is a success (`response-lost`),
 *   with the index finished along with it;
 * - files that show neither state are `outcome-uncertain`. The index stays as it is, with its moves
 *   kept, so a later look at the files rolls it back or finishes it (`settleUncertainRevert`).
 */
async function clearOrRollBack(
  ports: OpenCodeRevertPorts,
  run: OpenCodeRevertRun,
  staged: OpenCodeStagedRevert,
  moved: "restored" | "none",
  correlationId: string,
): Promise<{ readonly ok: true; readonly settlement: RevertSettlement } | RefusedRevert> {
  const guarded = await guardedNativeWrite({
    root: run.workspaceRoot,
    files: staged.files,
    before: staged.witness ?? new Map<string, string>(),
    after: staged.redo,
    call: () => run.client.clearRevert(run.sessionId),
  });
  if (guarded.kind === "done") return { ok: true, settlement: guarded.settlement };
  if (guarded.kind === "uncertain") {
    staged.uncertain = {
      reason: guarded.reason,
      during: "restore",
      indexMoved: moved === "restored",
      runtimeStaged: true,
    };
    return {
      ok: false,
      reason: "outcome-uncertain",
      error: guarded.error,
      uncertainReason: guarded.reason,
      errorKind: guarded.errorKind,
    };
  }
  // The files stay undone, so the index goes back to the undone state with them.
  if (moved === "restored") await rollBackIndex(ports, run, staged, correlationId);
  if (guarded.kind === "failed") throw guarded.error;
  return { ok: false, reason: "workspace-changed" };
}

function filesShow(
  files: readonly string[],
  now: readonly (string | undefined)[],
  image: ReadonlyMap<string, string> | undefined,
): boolean {
  return (
    image !== undefined &&
    files.every((file, index) => {
      const expected = image.get(file);
      return expected !== undefined && expected !== "unverifiable" && now[index] === expected;
    })
  );
}

/**
 * Settles an uncertain record from the files as they are now, with no guessing:
 * - `applied`: a Restore's files show the turn's content, so its write happened; the record ends and
 *   the index stays as the Restore made it;
 * - `not-applied`: the files show the state before the write. A Restore's record becomes an
 *   ordinary staged undo again after its index returns to the undone state; an Undo's record ends;
 * - `unknown`: the files show neither, so nothing is claimed and nothing is written.
 */
async function settleUncertainRevert(
  ports: OpenCodeRevertLogPort,
  run: OpenCodeRevertRun,
  correlationId: string,
): Promise<UncertainSettlement> {
  const staged = run.revert;
  const uncertain = staged?.uncertain;
  if (staged === undefined || uncertain === undefined) return "unknown";
  let now: readonly (string | undefined)[];
  try {
    now = await signatures(run.workspaceRoot, staged.files);
  } catch (error) {
    reportIndexFailure(ports, run, error, correlationId, "restore");
    return "unknown";
  }
  return endUncertainRecord(
    ports,
    run,
    staged,
    uncertainVerdict(staged, uncertain, now),
    correlationId,
  );
}

/** What each verdict does to the record; an answered Undo clears the runtime's revert first. */
async function endUncertainRecord(
  ports: OpenCodeRevertLogPort,
  run: OpenCodeRevertRun,
  staged: OpenCodeStagedRevert,
  verdict: UncertainSettlement,
  correlationId: string,
): Promise<UncertainSettlement> {
  const uncertain = staged.uncertain;
  if (verdict === "unknown" || uncertain === undefined) return "unknown";
  if (verdict === "applied") {
    run.revert = undefined;
    return verdict;
  }
  if (uncertain.during === "undo") {
    if (uncertain.runtimeStaged && !(await clearRuntimeStage(ports, run, staged, correlationId)))
      return "unknown";
    run.revert = undefined;
    return verdict;
  }
  if (uncertain.indexMoved) await rollBackIndex(ports, run, staged, correlationId);
  staged.uncertain = undefined;
  return verdict;
}

/**
 * An Undo the runtime answered holds a staged revert even when its files show nothing changed, and
 * the next prompt would finalize it. Before the record ends, the runtime's revert is cleared
 * explicitly, under the guard (the files are proven as they are, then read again); a clear that
 * fails or settles nothing leaves the record in place and says so on the log.
 */
async function clearRuntimeStage(
  ports: OpenCodeRevertLogPort,
  run: OpenCodeRevertRun,
  staged: OpenCodeStagedRevert,
  correlationId: string,
): Promise<boolean> {
  const guarded = await guardedNativeWrite({
    root: run.workspaceRoot,
    files: staged.files,
    before: staged.redo ?? new Map<string, string>(),
    after: staged.redo,
    call: () => run.client.clearRevert(run.sessionId),
  });
  // A clear the runtime refused (a client error) means it held nothing staged: the record can end.
  if (guarded.kind === "failed" && provenNotApplied(guarded.error)) {
    run.revert = undefined;
    return true;
  }
  if (guarded.kind !== "done") {
    const error =
      guarded.kind === "failed" || guarded.kind === "uncertain" ? guarded.error : undefined;
    recordRevertRefusal(ports, run.runId, "restore", "outcome-uncertain", correlationId, error, {
      uncertainReason: staged.uncertain?.reason,
      errorKind: guarded.kind === "uncertain" ? guarded.errorKind : undefined,
    });
    return false;
  }
  run.revert = undefined;
  recordRevertApplied(
    ports.activityLog,
    run.runId,
    "cleared",
    { ...countsOf(staged), interrupted: false, settlement: guarded.settlement },
    correlationId,
  );
  return true;
}

function uncertainVerdict(
  staged: OpenCodeStagedRevert,
  uncertain: UncertainRevert,
  now: readonly (string | undefined)[],
): UncertainSettlement {
  if (uncertain.during === "restore" && filesShow(staged.files, now, staged.redo)) return "applied";
  const before = uncertain.during === "restore" ? staged.witness : staged.redo;
  return filesShow(staged.files, now, before) ? "not-applied" : "unknown";
}

/**
 * A turn admitted while an uncertain record is held first tries to settle it from the files. Only a
 * record the files cannot settle ends here, as it is: the person moved on, the files are not
 * touched, the index stays as it is and the runtime finalizes whatever it holds on the next prompt.
 * Logged, so the support timeline shows the turn went on past an unsettled revert. A record the
 * files settled into an ordinary staged undo keeps blocking the turn, as any staged undo does.
 */
export async function settleUncertainRevertOnTurn(
  activityLog: ServerLogSink | undefined,
  run: OpenCodeRevertRun,
  correlationId: string,
): Promise<void> {
  const uncertain = run.revert?.uncertain;
  if (uncertain === undefined) return;
  const settled = await settleUncertainRevert({ activityLog }, run, correlationId);
  if (settled !== "unknown") return;
  run.revert = undefined;
  writeRefusal(activityLog, run.runId, "submit", "outcome-uncertain", correlationId, undefined, {
    uncertainReason: uncertain.reason,
  });
}

/**
 * Makes the undo's index transitions again, under the same drift checks. `changed` when a person's
 * staging or a commit changed one of the paths since the undo (nothing is overwritten), `failed`
 * when the index could not be changed, `none` when the undo moved no index path. A throw propagates
 * to the caller, which logs it with its frames.
 */
async function reapplyIndexMoves(
  run: OpenCodeRevertRun,
  staged: OpenCodeStagedRevert,
  correlationId: string,
): Promise<"restored" | "none" | "changed" | "failed"> {
  const moves = staged.indexMoves;
  if (moves === undefined || moves.entries.length === 0) return "none";
  const result = await reapplyTurnIndexMoves(run.workspaceRoot, moves, correlationId);
  if (result === "restored") return "restored";
  return result === "changed-after-turn" ? "changed" : "failed";
}

/**
 * Puts the index back to the undone state after a restore that cannot finish. A rollback that is
 * refused (a person restaged a path since) or fails leaves staged effects of the turn behind, so
 * the retained undo no longer claims `restored`: the outcome it keeps says the index changed or
 * could not be proven, and the refusal is on the log. The person's own staging is never
 * overwritten, and the moves are dropped: the index is theirs now, so a later Restore still
 * brings the files back without it instead of refusing every retry as `index-changed`.
 */
async function rollBackIndex(
  ports: OpenCodeRevertLogPort,
  run: OpenCodeRevertRun,
  staged: OpenCodeStagedRevert,
  correlationId: string,
): Promise<void> {
  const moves = staged.indexMoves;
  if (moves === undefined) return;
  try {
    const result = await reapplyInverse(run.workspaceRoot, moves, correlationId);
    if (result === "restored") return;
    staged.index = result === "changed-after-turn" ? "changed-after-turn" : "unavailable";
    staged.indexMoves = undefined;
    recordRevertRefused(ports.activityLog, {
      runId: run.runId,
      operation: "restore",
      reason: result === "changed-after-turn" ? "index-changed" : "revert-failed",
      correlationId,
      error: undefined,
    });
  } catch (error) {
    staged.index = "unavailable";
    staged.indexMoves = undefined;
    reportIndexFailure(ports, run, error, correlationId, "restore");
  }
}

/** Attempts at the rollback: one transient failure (a busy `index.lock`) is retried once. */
const ROLLBACK_ATTEMPTS = 2;
const ROLLBACK_RETRY_MS = 50;

/**
 * Makes the undo's index moves in reverse. An index that is busy or cannot be changed for a moment
 * (`unavailable`, or a throw) gets one more attempt after a short pause; a refusal because a person
 * restaged a path is final, and the last attempt's failure propagates to the caller.
 */
async function reapplyInverse(
  root: string,
  moves: TurnIndexMoves,
  correlationId: string,
): Promise<"restored" | "changed-after-turn" | "unavailable"> {
  const inverse = {
    headSha: moves.headSha,
    entries: moves.entries.map(({ path, from, to }) => ({ path, from: to, to: from })),
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await reapplyTurnIndexMoves(root, inverse, correlationId); // NOSONAR typescript:S9382 -- a retry runs only after the previous attempt failed
      if (result !== "unavailable" || attempt >= ROLLBACK_ATTEMPTS) return result;
    } catch (error) {
      if (attempt >= ROLLBACK_ATTEMPTS) throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ROLLBACK_RETRY_MS)); // NOSONAR typescript:S9382 -- the pause separates two attempts
  }
}

/**
 * The state of a record the run holds. An uncertain record claims no undo: the wire has no status
 * for it, so it reads as nothing staged (the files may or may not be undone) and never offers a
 * Restore that would be refused.
 */
function heldRevertState(
  staged: OpenCodeStagedRevert | undefined,
): CodingRuntimeRevertState | undefined {
  if (staged === undefined) return undefined;
  if (staged.uncertain !== undefined)
    return { staged: false, fileCount: 0, additions: 0, deletions: 0 };
  return {
    staged: true,
    ...countsOf(staged),
    ...(staged.index === undefined ? {} : { index: staged.index }),
    ...stagedIndexPaths(staged),
  };
}

async function revertState(
  ports: OpenCodeRevertPorts,
  runId: string,
): Promise<CodingRuntimeRevertState | undefined> {
  const run = ports.readyRun(runId);
  if (run === undefined) return undefined;
  const held = heldRevertState(run.revert);
  if (held !== undefined) return held;
  const interrupts = run.interruptSeq ?? 0;
  try {
    const counts = diffCounts(await turnDiff(run));
    const indexPaths = await indexPathCount(ports, run);
    return { staged: false, ...counts, ...(indexPaths > 0 ? { indexPathCount: indexPaths } : {}) };
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
 * The contents of the files the turn changed when every one is as the turn left it, else
 * `undefined`. A file one of the turn's own native edits wrote is proven by that edit's image. Any
 * other file (one a shell command changed, say) is proven only by the image the settled turn left; a
 * turn still in flight has none, so such a file cannot be proven and the undo is refused rather than
 * guessing who changed it.
 */
async function provenTurnImage(
  run: OpenCodeRevertRun,
  files: readonly string[],
  busy: boolean,
): Promise<ReadonlyMap<string, string> | undefined> {
  await run.agentImages?.work;
  const agent = run.agentImages?.files;
  const settled = busy ? undefined : await run.turnImage;
  const current = await signatures(run.workspaceRoot, files);
  const image = new Map<string, string>();
  for (const [index, file] of files.entries()) {
    const recorded = agent?.get(file) ?? settled?.get(file);
    if (!provenBy(recorded, current[index])) return undefined;
    image.set(file, recorded);
  }
  return image;
}

function provenBy(recorded: string | undefined, now: string | undefined): recorded is string {
  return recorded !== undefined && recorded !== "unverifiable" && now === recorded;
}

function provenEntry(
  proven: ReadonlyMap<string, string>,
  file: string,
): readonly (readonly [string, string])[] {
  const signature = proven.get(file);
  return signature === undefined ? [] : [[file, signature]];
}

/** The identity of one native tool call, as both its permission check and its settlement name it. */
export function openCodeNativeCallKey(messageId: string, callId: string): string {
  return `${messageId}\u0000${callId}`;
}

/** The `turnStart` marker for a file whose start could not be read when its edit was admitted. */
const START_UNKNOWN = "unverifiable";

/**
 * The file's fingerprint at admission, or the explicit `START_UNKNOWN` marker when it cannot be
 * read or proven (a read error, a link, a non-file, an oversized file). An unknown start is no
 * expectation: the file is treated like one only a shell command changed, so the Undo cannot check
 * it and a later Restore of it is refused. Leaving no entry would read as "nothing to check".
 */
function fileSignatureOrUnknown(root: string, file: string): string {
  try {
    return fileSignatureSync(root, file) ?? START_UNKNOWN;
  } catch {
    return START_UNKNOWN;
  }
}

function freshAgentImages(): OpenCodeAgentImages {
  return { pending: new Map(), files: new Map(), turnStart: new Map(), work: Promise.resolve() };
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
  const { pending, turnStart } = run.agentImages;
  for (const file of files) {
    if (turnStart.has(file)) continue;
    turnStart.set(file, fileSignatureOrUnknown(run.workspaceRoot, file));
  }
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

const GATE_WAIT_BUCKETS_MS = [1_000, 5_000, 15_000, 30_000, 60_000] as const;

/**
 * A person's write that waited too long for a runtime revert write and was refused (a retryable
 * answer): one body-free line on the revert refusal operation, with the wait as a bucket.
 */
export function recordWriteGateTimeout(
  activityLog: ServerLogSink | undefined,
  waitedMs: number,
  correlationId: string | undefined,
): void {
  const edge =
    GATE_WAIT_BUCKETS_MS.find((bucket) => waitedMs <= bucket) ?? GATE_WAIT_BUCKETS_MS.at(-1);
  recordRevertRefused(activityLog, {
    runId: correlationIdOrUnknown(correlationId),
    operation: "write",
    reason: "write-gate-timeout",
    correlationId,
    error: undefined,
    errorKind: "timeout",
    waitBucketMs: edge,
  });
}

/**
 * A synchronous write of a person (an Editor agent changeset commit, a branch switch) that cannot
 * wait in the gate and was refused because a runtime revert write of the workspace was running.
 */
export function recordWriteGateBusy(
  activityLog: ServerLogSink | undefined,
  correlationId: string | undefined,
): void {
  recordRevertRefused(activityLog, {
    runId: correlationIdOrUnknown(correlationId),
    operation: "write",
    reason: "write-gate-busy",
    correlationId,
    error: undefined,
    errorKind: "conflict",
  });
}

/**
 * True while an undo is staged: a new turn would make the runtime commit it and rewrite history. An
 * uncertain record does not block: the turn settles it from the files first, or ends it as it is
 * (`settleUncertainRevertOnTurn`).
 */
export function openCodeRevertBlocksTurn(run: {
  readonly revert?: OpenCodeStagedRevert | undefined;
}): boolean {
  return run.revert !== undefined && run.revert.uncertain === undefined;
}

export function recordRevertTurnBlocked(
  activityLog: ServerLogSink | undefined,
  runId: string,
): void {
  writeRefusal(activityLog, runId, "submit", "turn-blocked", undefined, undefined);
}

// What an uncertain refusal adds to its line: why the outcome is uncertain and the closed error kind.
interface RefusalDetail {
  readonly uncertainReason?: UncertainReason | undefined;
  readonly errorKind?: ActivityLogErrorKind | undefined;
}

function recordRevertRefusal(
  ports: OpenCodeRevertLogPort,
  runId: string,
  operation: OpenCodeRevertOperation,
  reason: OpenCodeRevertRefusal,
  correlationId: string | undefined,
  error?: unknown,
  detail: RefusalDetail = {},
): { readonly ok: false; readonly reason: OpenCodeRevertRefusal } {
  writeRefusal(ports.activityLog, runId, operation, reason, correlationId, error, detail);
  return { ok: false, reason };
}

function recordRevertApplied(
  activityLog: ServerLogSink | undefined,
  runId: string,
  action: CodingWorkbenchRuntimeRevertAction | "commit" | "cleared",
  outcome: CodingRuntimeRevertCounts &
    Pick<AppliedRevert, "index" | "indexPathCount" | "settlement" | "steps"> & {
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
        ...(outcome.settlement === undefined ? {} : { settlement: outcome.settlement }),
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
    readonly uncertainReason?: UncertainReason | undefined;
    readonly waitBucketMs?: number | undefined;
    /** A closed kind the caller already knows, instead of one derived from an error. */
    readonly errorKind?: ActivityLogErrorKind | undefined;
  },
): void {
  const failed = input.error !== undefined;
  (activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      CODING_RUNTIME_REVERT_REFUSED_OPERATION,
      {
        level: "warn",
        correlationId: correlationIdOrUnknown(input.correlationId ?? input.runId),
        errorKind: input.errorKind ?? refusalErrorKind(input.reason, input.error),
      },
      {
        runId: input.runId,
        operation: input.operation,
        reason: input.reason,
        ...(failed
          ? { frames: keikoStackFrames(input.error), causeChain: causeChain(input.error) }
          : {}),
        ...(input.uncertainReason === undefined ? {} : { uncertainReason: input.uncertainReason }),
        ...(input.waitBucketMs === undefined ? {} : { waitBucketMs: input.waitBucketMs }),
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
  detail: RefusalDetail = {},
): void {
  recordRevertRefused(activityLog, {
    runId,
    operation,
    reason,
    correlationId,
    error,
    uncertainReason: detail.uncertainReason,
    errorKind: detail.errorKind,
  });
}

function isGateTimeout(error: unknown): boolean {
  return (
    error instanceof NativeWriteGateTimeoutError || error instanceof HumanWriteGateTimeoutError
  );
}

function refusalErrorKind(reason: OpenCodeRevertRefusal, error: unknown): ActivityLogErrorKind {
  if (error === undefined) {
    // A revert that failed without a throw is an index that could not be changed.
    return reason === "run-unavailable" ||
      reason === "revert-failed" ||
      reason === "outcome-uncertain"
      ? "unavailable"
      : "conflict";
  }
  if (isGateTimeout(error)) return "timeout";
  const classified = errorKindOf(error);
  const registered = activityLogErrorKindOr(classified, "unavailable");
  if (registered !== "unavailable" || classified === "unavailable") return registered;
  const normalized = classified.toLowerCase();
  if (/timeout|timedout/u.test(normalized)) return "timeout";
  return /abort|cancel/u.test(normalized) ? "cancelled" : "unavailable";
}
