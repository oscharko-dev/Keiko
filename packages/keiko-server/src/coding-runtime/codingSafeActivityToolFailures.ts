import { createHash } from "node:crypto";

import type { CodingSafeActivityToolFailureOrigin } from "@oscharko-dev/keiko-contracts";

// One run's failed tool calls, for the row that says a command "fails for the 3rd time" and for the
// body-free Activity Log line per failure. Commands are told apart by a digest held in memory only;
// neither the command nor its digest is ever logged.

/**
 * The bound of distinct commands and calls a run remembers; older ones are forgotten first. A
 * failure restated after its call was forgotten counts once more; the bound only protects memory in
 * a run of more than 4,096 failed calls, and the log line of a call is written once either way
 * while it is remembered.
 */
const MAX_REMEMBERED = 4_096;

/** The facts of one failure the ledger just counted, waiting for its log line. */
export interface ToolFailureFacts {
  readonly callId: string;
  readonly tool: string;
  readonly origin: CodingSafeActivityToolFailureOrigin;
  readonly exitCode: number | undefined;
  readonly failureCount: number;
}

export interface ToolFailureLedger {
  /** Failures per command digest in this run. */
  readonly byCommand: Map<string, number>;
  /** The failure count each failed call was given, so a restated failure is never counted twice. */
  readonly byCall: Map<string, number>;
  /** Calls whose failure line was written. */
  readonly logged: Set<string>;
  failedCalls: number;
  repeatedFailures: number;
  /** The failure the latest signal counted, taken once for its log line. */
  pending: ToolFailureFacts | undefined;
}

export function createToolFailureLedger(): ToolFailureLedger {
  return {
    byCommand: new Map(),
    byCall: new Map(),
    logged: new Set(),
    failedCalls: 0,
    repeatedFailures: 0,
    pending: undefined,
  };
}

/**
 * How many times this call's command has failed in the run, this call included; one for a call
 * without a command. A call already counted keeps its count.
 */
export function countToolFailure(
  ledger: ToolFailureLedger,
  callId: string,
  command: string | undefined,
): number {
  const known = ledger.byCall.get(callId);
  if (known !== undefined) return known;
  const key =
    command === undefined ? undefined : createHash("sha256").update(command).digest("hex");
  const count = key === undefined ? 1 : (ledger.byCommand.get(key) ?? 0) + 1;
  if (key !== undefined) remember(ledger.byCommand, key, count);
  remember(ledger.byCall, callId, count);
  ledger.failedCalls += 1;
  if (count > 1) ledger.repeatedFailures += 1;
  return count;
}

function remember(map: Map<string, number>, key: string, value: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_REMEMBERED) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Counts a call that did not succeed and keeps its facts for the log line. A stopped call is no
 * failure: Stop and takeover are recorded once per run, and the row says the call was stopped.
 * Returns the count the row shows, or undefined when nothing was counted.
 */
export function countFailedCall(
  ledger: ToolFailureLedger,
  call: { readonly callId: string; readonly tool: string },
  facts: {
    readonly origin: CodingSafeActivityToolFailureOrigin | undefined;
    readonly exitCode: number | undefined;
    readonly command: string | undefined;
  },
): number | undefined {
  if (facts.origin === undefined || facts.origin === "cancelled") return undefined;
  const failureCount = countToolFailure(ledger, call.callId, facts.command);
  ledger.pending = {
    callId: call.callId,
    tool: call.tool,
    origin: facts.origin,
    exitCode: facts.exitCode,
    failureCount,
  };
  return failureCount;
}

/** The closed class of a shell's exit status for the log; never the status of another tool. */
export type ExitCodeClass = "none" | "0" | "1" | "2" | "126" | "127" | "signal" | "other";

export const EXIT_CODE_CLASSES: readonly ExitCodeClass[] = [
  "none",
  "0",
  "1",
  "2",
  "126",
  "127",
  "signal",
  "other",
];

export function exitCodeClass(exitCode: number | undefined): ExitCodeClass {
  if (exitCode === undefined) return "none";
  const named = NAMED_EXIT_CODES.get(exitCode);
  if (named !== undefined) return named;
  return exitCode > 128 && exitCode < 256 ? "signal" : "other";
}

// 0: a call that failed although its process exited cleanly; 1 and 2: a command's own failure and
// misuse; 126 and 127: not executable and not found.
const NAMED_EXIT_CODES: ReadonlyMap<number, ExitCodeClass> = new Map([
  [0, "0"],
  [1, "1"],
  [2, "2"],
  [126, "126"],
  [127, "127"],
]);

/**
 * The latest counted failure whose line is not written yet, taken from the ledger so it is handed out
 * once. It comes from the signal itself, not from the bounded feed, so a call the feed dropped or
 * displaced still gets its line.
 */
export function takeUnloggedFailure(ledger: ToolFailureLedger): ToolFailureFacts | undefined {
  const { pending } = ledger;
  ledger.pending = undefined;
  if (pending === undefined || !markLogged(ledger, pending.callId)) return undefined;
  return pending;
}

/** Marks a call's failure line as written; false when it was written already. */
function markLogged(ledger: ToolFailureLedger, callId: string): boolean {
  if (ledger.logged.has(callId)) return false;
  ledger.logged.add(callId);
  if (ledger.logged.size > MAX_REMEMBERED) {
    const oldest = ledger.logged.values().next().value;
    if (oldest !== undefined) ledger.logged.delete(oldest);
  }
  return true;
}
