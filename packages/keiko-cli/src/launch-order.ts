// The order of Keiko's starts and the folder launcher's Stops (ADR-0121 D9, PR #4464).
//
// A start of a package folder runs `keiko start --launch-order <ms>`: the wall-clock time at which
// that start began to take its folder's lock. Any other start (the standalone folder package's,
// a person's own `keiko start`) is ordered by the time its command began under the lifecycle guard.
// A Stop runs `keiko stop --unless-launched-after <ms>`: the time it was pressed. Both commands run
// under the UI lifecycle guard of the state directory, so the check whether a start came after the
// Stop and the stop itself are one step at the lifecycle owner: no start that uses this state
// directory, of whatever folder or form, can open Keiko between them.
//
// The record keeps the latest order of the starts since the last stop, so a slower start that
// began earlier never hides a later one, and a record that cannot be read is never replaced: it may
// hold a later order. Only the closed outcome is logged, never an order value.

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  emitSecurityLogEvent,
  securityErrorKind,
  type SecurityLogSink,
} from "@oscharko-dev/keiko-security";
import { atomicPublishRename } from "@oscharko-dev/keiko-security/fs-atomic-rename";
import {
  RUNTIME_STATE_FILE_MODE,
  UI_LAUNCH_ORDER_FILE,
  assertRegularSingleLinkFile,
  openPidFileNoFollow,
} from "./state-paths.js";

/** Exit code of a fenced stop that left Keiko open because a start came after the fence. */
export const STOP_SUPERSEDED_EXIT_CODE = 3;

const ORDER_PATTERN = /^\d{1,16}$/u;
const RECORD_MAX_BYTES = 64;

export type LaunchOrderOutcome =
  | "recorded"
  | "kept"
  | "record-failed"
  | "proceeded"
  | "superseded"
  | "unreadable"
  | "clear-failed";

const FAILURE_OUTCOMES = ["record-failed", "unreadable", "clear-failed"] as const;

const LAUNCH_ORDER_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "cli.lifecycle.launch-order",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "launch-order.emitLaunchOrder",
  fields: {
    command: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["start", "stop"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "recorded",
        "kept",
        "record-failed",
        "proceeded",
        "superseded",
        "unreadable",
        "clear-failed",
      ],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "process-lifecycle",
  diagnosticWhen: [{ field: "outcome", values: [...FAILURE_OUTCOMES] }],
  failureClasses: ["launch-order-fence"],
  proofIds: ["cli.lifecycle.launch-order.outcome"],
  releaseImpact: "minor",
});

function isFailureOutcome(outcome: LaunchOrderOutcome): boolean {
  return (FAILURE_OUTCOMES as readonly string[]).includes(outcome);
}

/** Records the closed outcome of a start's order record or a fenced stop, never an order value. */
export function emitLaunchOrder(
  sink: SecurityLogSink | undefined,
  command: "start" | "stop",
  outcome: LaunchOrderOutcome,
  error?: unknown,
): void {
  const failureKind = error === undefined ? undefined : securityErrorKind(error);
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      LAUNCH_ORDER_OPERATION,
      isFailureOutcome(outcome) ? { level: "warn", errorKind: "unavailable" } : { level: "info" },
      { command, outcome, ...(failureKind === undefined ? {} : { failureKind }) },
    ),
  );
}

/** A launch order or fence as the launcher passes it: whole milliseconds, a safe integer. */
export function parseLaunchOrder(raw: string): number | null {
  if (!ORDER_PATTERN.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * What the record holds: nothing, an order, or content that names no order. Only Keiko's command
 * line writes it, in one rename, so content without an order was never one of its records.
 */
type StoredOrder =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "order"; readonly value: number };

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function malformedRecord(): TypeError {
  return new TypeError("malformed launch order record");
}

// The record's text, or undefined when it is too long to be one.
function readRecordText(path: string): string | undefined {
  const fd = openPidFileNoFollow(path, fsConstants.O_RDONLY);
  try {
    assertRegularSingleLinkFile(fd, path);
    const buffer = Buffer.alloc(RECORD_MAX_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return length > RECORD_MAX_BYTES ? undefined : buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// A record that exists but cannot be read (permissions, a link, an I/O error) throws, and each
// caller records that through the launch-order operation.
function readStoredOrder(stateDir: string): StoredOrder {
  const path = join(stateDir, UI_LAUNCH_ORDER_FILE);
  let text: string | undefined;
  try {
    text = readRecordText(path);
  } catch (error) {
    if (isMissing(error)) return { kind: "absent" };
    throw error;
  }
  const value = text === undefined ? null : parseLaunchOrder(text.trim());
  return value === null ? { kind: "malformed" } : { kind: "order", value };
}

function publishRecord(stateDir: string, order: number, sink: SecurityLogSink | undefined): void {
  const path = join(stateDir, UI_LAUNCH_ORDER_FILE);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = openSync(temporary, "wx", RUNTIME_STATE_FILE_MODE);
    try {
      writeSync(fd, `${String(order)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    atomicPublishRename(temporary, path, sink === undefined ? {} : { securityLogSink: sink });
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Called under the lifecycle guard by a start that opened Keiko (or found it running): the record
 * keeps the latest order since the last stop. A malformed record is reported and replaced; a record
 * that cannot be read is reported and left as it is, because it may hold a later order.
 */
export function recordLaunchOrder(
  stateDir: string,
  order: number,
  sink: SecurityLogSink | undefined,
): LaunchOrderOutcome {
  let stored: StoredOrder;
  try {
    stored = readStoredOrder(stateDir);
  } catch (error) {
    emitLaunchOrder(sink, "start", "record-failed", error);
    return "record-failed";
  }
  if (stored.kind === "order" && stored.value >= order) {
    emitLaunchOrder(sink, "start", "kept");
    return "kept";
  }
  if (stored.kind === "malformed") emitLaunchOrder(sink, "start", "unreadable", malformedRecord());
  try {
    publishRecord(stateDir, order, sink);
  } catch (error) {
    emitLaunchOrder(sink, "start", "record-failed", error);
    return "record-failed";
  }
  emitLaunchOrder(sink, "start", "recorded");
  return "recorded";
}

// The record as a fenced stop needs it, or undefined (reported) when it names no order it can trust.
function orderForFence(
  stateDir: string,
  sink: SecurityLogSink | undefined,
): StoredOrder | undefined {
  let stored: StoredOrder;
  try {
    stored = readStoredOrder(stateDir);
  } catch (error) {
    emitLaunchOrder(sink, "stop", "unreadable", error);
    return undefined;
  }
  if (stored.kind !== "malformed") return stored;
  emitLaunchOrder(sink, "stop", "unreadable", malformedRecord());
  return undefined;
}

/**
 * Called under the lifecycle guard by a fenced stop before it stops anything. `superseded` means a
 * start whose order is later than the fence opened Keiko: the stop leaves it open. A record that
 * cannot be read stops nothing either: whether a later start opened Keiko is then unknown.
 */
export function checkStopFence(
  stateDir: string,
  fence: number,
  sink: SecurityLogSink | undefined,
): LaunchOrderOutcome {
  const stored = orderForFence(stateDir, sink);
  if (stored === undefined) return "unreadable";
  const outcome = stored.kind === "order" && stored.value > fence ? "superseded" : "proceeded";
  emitLaunchOrder(sink, "stop", outcome);
  return outcome;
}

/**
 * A stop that ended with no Keiko running clears the record: no start since then is ordered. A
 * record that cannot be removed is reported and the stop still succeeds: an order left behind is
 * older than any Stop pressed from now on, so it holds no later start back.
 */
export function clearLaunchOrder(stateDir: string, sink: SecurityLogSink | undefined): void {
  try {
    rmSync(join(stateDir, UI_LAUNCH_ORDER_FILE), { force: true });
  } catch (error) {
    emitLaunchOrder(sink, "stop", "clear-failed", error);
  }
}
