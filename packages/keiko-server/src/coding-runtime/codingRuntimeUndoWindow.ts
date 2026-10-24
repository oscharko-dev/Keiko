import { causeChain, keikoStackFrames, type ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { correlationIdOrUnknown } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { CodingRuntimeHoldResult } from "./codingRuntimeManager.js";
import type { CodingRuntimeRevertState } from "./codingRuntimeRevert.js";

/**
 * The post-completion undo window (#3904 AC3, owner decision 2026-10-24). A native run that
 * succeeded with an undoable newest turn keeps its original runtime process -- the session and the
 * runtime's own snapshot engine -- after the run settled, so the human can undo and restore that
 * turn as in standalone OpenCode. Every run authority is already revoked (`hold`): the process
 * answers only Keiko's undo and restore. The window closes when the next run starts, when its time
 * bound passes, or at shutdown; a staged undo is then committed, so the retained session matches
 * the workspace, and the process is stopped like any settled run.
 */
export const CODING_RUNTIME_UNDO_WINDOW_MS = 30 * 60 * 1_000;

export const UNDO_WINDOW_CLOSE_REASONS = [
  "next-run",
  "expired",
  "shutdown",
  "not-succeeded",
] as const;
export type UndoWindowCloseReason = (typeof UNDO_WINDOW_CLOSE_REASONS)[number];

/** What closing did with an undo the human left staged. */
export type UndoWindowStagedOutcome = "committed" | "none" | "failed";

const CODING_RUNTIME_UNDO_WINDOW_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.undo-window",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeUndoWindow.record",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    event: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["opened", "closed", "hold-failed"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: UNDO_WINDOW_CLOSE_REASONS,
    },
    stagedRevert: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["committed", "none", "failed"],
    },
    stopped: { type: "boolean", dataClass: "closed-enum", required: false },
    windowMs: { type: "integer", dataClass: "duration", required: false },
    openMs: { type: "integer", dataClass: "duration", required: false },
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
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-undo-window"],
  proofIds: ["coding-runtime.undo-window.emitted-line"],
  releaseImpact: "patch",
});

export interface CodingRuntimeUndoWindowDeps {
  /** Whether the runtime can be held and a staged undo committed at all. */
  readonly canHold: () => boolean;
  /** What the run's newest turn changed, or the undo staged for it. */
  readonly revertState: (runId: string) => Promise<CodingRuntimeRevertState | undefined>;
  /** Ends the run's authority but keeps its runtime (`CodingRuntimeManager.hold`). */
  readonly hold: (runId: string) => Promise<CodingRuntimeHoldResult>;
  /** Commits an undo the human left staged; `none` when nothing was staged. */
  readonly commitStagedRevert: (runId: string) => Promise<UndoWindowStagedOutcome>;
  /** Stops the held runtime like any settled run: reap, dispose, retain. */
  readonly stop: (runId: string) => Promise<boolean>;
  /** Runs the expiry on the orchestrator's serial lane. */
  readonly expire: (close: () => Promise<void>) => void;
  readonly now: () => number;
  readonly windowMs?: number | undefined;
  readonly activityLog?: ServerLogSink | undefined;
}

interface OpenWindow {
  readonly runId: string;
  readonly openedAtMs: number;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

interface ClosedWindowFacts {
  readonly runId: string;
  readonly reason: UndoWindowCloseReason;
  readonly stagedRevert: UndoWindowStagedOutcome;
  readonly stopped: boolean;
  readonly openMs: number;
  readonly failure: unknown;
}

/** How a succeeded run's settlement ended its runtime, when it was held for undo. */
export interface UndoWindowHoldOutcome {
  readonly stopped: boolean;
  readonly held: boolean;
}

export class CodingRuntimeUndoWindow {
  private window: OpenWindow | undefined;

  public constructor(private readonly deps: CodingRuntimeUndoWindowDeps) {}

  /**
   * Holds a succeeded run's runtime when its newest turn can be undone; `undefined` when it cannot,
   * and the caller stops the runtime as before. A hold that failed says so on the log.
   */
  public async hold(runId: string): Promise<UndoWindowHoldOutcome | undefined> {
    if (!this.deps.canHold() || !(await this.undoable(runId))) return undefined;
    try {
      const held = await this.deps.hold(runId);
      return { stopped: held.ok, held: held.ok && held.status === "held" };
    } catch (error) {
      recordUndoWindowHoldFailed(this.deps.activityLog, runId, error);
      return { stopped: false, held: false };
    }
  }

  private async undoable(runId: string): Promise<boolean> {
    try {
      const state = await this.deps.revertState(runId);
      return state !== undefined && (state.staged || state.fileCount > 0);
    } catch (error) {
      // A turn whose changes cannot be read offers no undo; the run is stopped as before.
      recordUndoWindowHoldFailed(this.deps.activityLog, runId, error);
      return false;
    }
  }

  /** The settled run whose runtime is held for undo, if any. */
  public heldRunId(): string | undefined {
    return this.window?.runId;
  }

  /** Opens the window for a held run; it closes after its time bound unless something closes it first. */
  public open(runId: string): void {
    const windowMs = this.deps.windowMs ?? CODING_RUNTIME_UNDO_WINDOW_MS;
    const timer = setTimeout(() => {
      this.deps.expire(() => this.close("expired"));
    }, windowMs);
    timer.unref();
    this.window = { runId, openedAtMs: this.deps.now(), timer };
    recordUndoWindowOpened(this.deps.activityLog, runId, windowMs);
  }

  /** Closes the open window, if any: commits a staged undo, then stops the held runtime. */
  public async close(reason: UndoWindowCloseReason): Promise<void> {
    const window = this.window;
    if (window === undefined) return;
    this.window = undefined;
    clearTimeout(window.timer);
    await this.end(window, reason);
  }

  /** Stops a held runtime whose run did not settle as succeeded: no window is ever opened for it. */
  public async release(runId: string, reason: UndoWindowCloseReason): Promise<void> {
    await this.end({ runId, openedAtMs: this.deps.now(), timer: undefined }, reason);
  }

  private async end(window: OpenWindow, reason: UndoWindowCloseReason): Promise<void> {
    let stagedRevert: UndoWindowStagedOutcome = "failed";
    let stopped = false;
    const facts = (): Omit<ClosedWindowFacts, "failure"> => ({
      runId: window.runId,
      reason,
      stagedRevert,
      stopped,
      openMs: Math.max(0, this.deps.now() - window.openedAtMs),
    });
    try {
      stagedRevert = await this.deps.commitStagedRevert(window.runId);
      stopped = await this.deps.stop(window.runId);
    } catch (error) {
      recordUndoWindowClosed(this.deps.activityLog, { ...facts(), failure: error });
      return;
    }
    recordUndoWindowClosed(this.deps.activityLog, { ...facts(), failure: undefined });
  }
}

function undoWindowLog(activityLog: ServerLogSink | undefined): ServerLogSink {
  return activityLog ?? processServerLogSink();
}

function recordUndoWindowHoldFailed(
  activityLog: ServerLogSink | undefined,
  runId: string,
  error: unknown,
): void {
  undoWindowLog(activityLog).write(
    activityLogEvent(
      CODING_RUNTIME_UNDO_WINDOW_OPERATION,
      { level: "warn", correlationId: correlationIdOrUnknown(runId), errorKind: "internal" },
      {
        runId,
        event: "hold-failed",
        frames: keikoStackFrames(error),
        causeChain: causeChain(error),
      },
    ),
  );
}

function recordUndoWindowOpened(
  activityLog: ServerLogSink | undefined,
  runId: string,
  windowMs: number,
): void {
  undoWindowLog(activityLog).write(
    activityLogEvent(
      CODING_RUNTIME_UNDO_WINDOW_OPERATION,
      { level: "info", correlationId: correlationIdOrUnknown(runId) },
      { runId, event: "opened", windowMs },
    ),
  );
}

function recordUndoWindowClosed(
  activityLog: ServerLogSink | undefined,
  facts: ClosedWindowFacts,
): void {
  const healthy = facts.failure === undefined && facts.stopped && facts.stagedRevert !== "failed";
  undoWindowLog(activityLog).write(
    activityLogEvent(
      CODING_RUNTIME_UNDO_WINDOW_OPERATION,
      healthy
        ? { level: "info", correlationId: correlationIdOrUnknown(facts.runId) }
        : {
            level: "warn",
            correlationId: correlationIdOrUnknown(facts.runId),
            errorKind: "internal",
          },
      {
        runId: facts.runId,
        event: "closed",
        reason: facts.reason,
        stagedRevert: facts.stagedRevert,
        stopped: facts.stopped,
        openMs: facts.openMs,
        ...(facts.failure === undefined
          ? {}
          : { frames: keikoStackFrames(facts.failure), causeChain: causeChain(facts.failure) }),
      },
    ),
  );
}
