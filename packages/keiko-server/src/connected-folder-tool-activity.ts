import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  ConnectedFolderToolFailureReason,
  ConnectedFolderToolView,
} from "@oscharko-dev/keiko-contracts/runtime/connected-folder-tool";
import { getServerLogger } from "./observability/index.js";

/**
 * Why a call of the connected-folder tool returned no content: the closed reasons of the workspace
 * tool, and the two this server adds. `authority-denied` is a call whose Chat authority or scope
 * was no longer current; `result-bound` is a result that did not fit the tool's byte bound.
 */
export type ConnectedFolderToolRefusal =
  ConnectedFolderToolFailureReason | "authority-denied" | "result-bound";

/** Which way a folder-only Chat's turn went; every `one-shot-*` value keeps the single retrieval. */
export type ConnectedFolderTurnSelection =
  | "tool-turn"
  | "one-shot-model-not-tool-ready"
  | "one-shot-scope-unavailable"
  | "one-shot-catalog-unavailable";

export type ConnectedFolderToolOutcome = "succeeded" | "failed" | "cancelled" | "timed-out";

/** Counts and closed values only: never a path, a query or file text. */
export interface ConnectedFolderToolActivity {
  /** `unknown` is a call whose view the model did not name. */
  readonly view: ConnectedFolderToolView | "unknown";
  /** `cancelled` and `timed-out` are calls the turn's stop or deadline ended; they return nothing. */
  readonly outcome: ConnectedFolderToolOutcome;
  readonly reason?: ConnectedFolderToolRefusal;
  readonly durationMs: number;
  /** UTF-8 bytes of paths and text the workspace returned, as charged to the turn's budget. */
  readonly resultBytes: number;
  /** UTF-8 bytes of the bounded JSON result the model received. */
  readonly payloadBytes: number;
  /** Entries, hits or excerpts the model received. */
  readonly returnedCount: number;
  readonly filesScanned?: number;
  readonly unavailableHitCount?: number;
  /** More exists than this result carries: another page, more matches or more lines. */
  readonly truncated: boolean;
  readonly turnCallCount: number;
  readonly turnSearchElapsedMs: number;
  readonly turnResultBytes: number;
}

const COUNT = { type: "integer", dataClass: "count", required: true } as const;
const TOOL_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "folder.files.operation",
  category: "search",
  owner: "keiko-server",
  emitter: "connected-folder-tool-activity.logConnectedFolderToolOperation",
  fields: {
    view: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["list", "search", "read", "unknown"] satisfies readonly (
        ConnectedFolderToolView | "unknown"
      )[],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "succeeded",
        "failed",
        "cancelled",
        "timed-out",
      ] satisfies readonly ConnectedFolderToolOutcome[],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "invalid-request",
        "scope-denied",
        "out-of-range",
        "not-text",
        "unreadable",
        "budget-exhausted",
        "failed",
        "authority-denied",
        "result-bound",
      ] satisfies readonly ConnectedFolderToolRefusal[],
    },
    resultBytes: COUNT,
    payloadBytes: COUNT,
    returnedCount: COUNT,
    filesScanned: { ...COUNT, required: false },
    unavailableHitCount: { ...COUNT, required: false },
    truncated: { type: "boolean", dataClass: "closed-enum", required: true },
    turnCallCount: COUNT,
    turnSearchElapsedMs: { type: "integer", dataClass: "duration", required: true },
    turnResultBytes: COUNT,
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["connected-folder-tool"],
  proofIds: ["folder.files.operation.line"],
  releaseImpact: "minor",
});

const TURN_SELECTION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "folder.files.turn-selected",
  category: "search",
  owner: "keiko-server",
  emitter: "connected-folder-tool-activity.logConnectedFolderTurnSelection",
  fields: {
    selection: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "tool-turn",
        "one-shot-model-not-tool-ready",
        "one-shot-scope-unavailable",
        "one-shot-catalog-unavailable",
      ] satisfies readonly ConnectedFolderTurnSelection[],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["connected-folder-tool"],
  proofIds: ["folder.files.turn-selected.line"],
  releaseImpact: "minor",
});

/** A failure of the tool itself, as opposed to a request the model can correct. */
export function isConnectedFolderToolFault(
  reason: ConnectedFolderToolRefusal | undefined,
): boolean {
  return reason === "failed" || reason === "unreadable";
}

export function logConnectedFolderToolOperation(
  correlationId: string,
  activity: ConnectedFolderToolActivity,
): void {
  const { durationMs, ...fields } = activity;
  const event = activityLogEvent(
    TOOL_OPERATION,
    { correlationId, durationMs: Math.max(0, Math.round(durationMs)) },
    { ...fields, completeness: "complete", loss: "none" },
  );
  const logger = getServerLogger();
  if (isConnectedFolderToolFault(activity.reason)) logger.warn(event);
  else logger.info(event);
}

export function logConnectedFolderTurnSelection(
  correlationId: string,
  selection: ConnectedFolderTurnSelection,
): void {
  getServerLogger().info(
    activityLogEvent(
      TURN_SELECTION,
      { correlationId },
      { selection, completeness: "complete", loss: "none" },
    ),
  );
}
