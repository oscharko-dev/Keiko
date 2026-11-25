// #4103: a debug session start that the governed DAP stack refuses for a closed reason used to reach
// the server's top-level catch and answer an opaque 500 INTERNAL, and a failed startup attempt left
// no evidence of which step failed. This module owns both closed vocabularies: the refusal a start
// route answers with, and the body-free Activity Log lines of a failed attempt and of a refused
// start. Unclassified errors stay errors and keep reaching the top-level catch with their frames.

import type { DebugProcessErrorCode } from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { isValidCorrelationId, UNKNOWN_CORRELATION_ID } from "../../correlation.js";

const DEBUG_PROCESS_ERROR_CODES = [
  "MALFORMED_HEADER",
  "PAYLOAD_TOO_LARGE",
  "MALFORMED_MESSAGE",
  "REQUEST_LIMIT",
  "REQUEST_TIMEOUT",
  "REQUEST_CANCELLED",
  "CLIENT_DISPOSED",
  "ADAPTER_REJECTED",
  "REVERSE_REQUEST_DENIED",
  "EXECUTABLE_NOT_FOUND",
  "CAPACITY",
  "EVIDENCE_PENDING",
  "SESSION_NOT_FOUND",
  "STARTUP_THROTTLED",
  "SESSION_TERMINATING",
  "TERMINATION_PENDING",
  "WRITE_FAILED",
  "UNEXPECTED_EOF",
  "INVALID_CAPSULE_PLAN",
  "PRIVATE_ENDPOINT_INVALID",
  "PRIVATE_ENDPOINT_UNSUPPORTED",
] as const satisfies readonly DebugProcessErrorCode[];

/**
 * Returns `codes` unchanged; the parameter type rejects a list that misses a contract code, so a
 * code added to `DebugProcessErrorCode` without being listed here fails to build.
 */
function everyDebugProcessErrorCode<const Codes extends readonly DebugProcessErrorCode[]>(
  codes: Codes &
    ([Exclude<DebugProcessErrorCode, Codes[number]>] extends [never] ? unknown : never),
): Codes {
  return codes;
}

const DEBUG_STARTUP_FAILURE_CODES = [...DEBUG_PROCESS_ERROR_CODES, "unclassified"] as const;

const CLOSED_CODES: ReadonlySet<string> = new Set(
  everyDebugProcessErrorCode(DEBUG_PROCESS_ERROR_CODES),
);

/** The step of one startup attempt that was running when it failed. */
const DEBUG_STARTUP_PHASES = [
  "capsule-launch",
  "capsule-attach",
  "endpoint-connect",
  "initialize",
  "initialized-event",
  "configure",
  "configuration-done",
  "launch-response",
  "mark-running",
] as const;
type DebugStartupPhase = (typeof DEBUG_STARTUP_PHASES)[number];

/** Mutable progress of one startup attempt, advanced before each awaited step. */
export interface DebugStartupProgress {
  phase: DebugStartupPhase;
}

/** The closed code an error carries, or undefined when it is not a closed DAP failure. */
export function debugStartFailureCode(error: unknown): DebugProcessErrorCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && CLOSED_CODES.has(code)
    ? (code as DebugProcessErrorCode)
    : undefined;
}

interface DebugStartRefusal {
  readonly status: 409 | 429 | 502 | 503;
  readonly message: string;
}

const START_REFUSALS: Readonly<Partial<Record<DebugProcessErrorCode, DebugStartRefusal>>> = {
  STARTUP_THROTTLED: {
    status: 503,
    message: "The debug adapter did not start after repeated attempts.",
  },
  CAPACITY: { status: 429, message: "Debug session capacity is full." },
  SESSION_TERMINATING: { status: 409, message: "A previous debug session is still ending." },
  TERMINATION_PENDING: { status: 409, message: "A previous debug session is still ending." },
  EVIDENCE_PENDING: { status: 409, message: "A previous debug session is still ending." },
  SESSION_NOT_FOUND: { status: 409, message: "The debug session ended while it was starting." },
  INVALID_CAPSULE_PLAN: { status: 409, message: "The debug target is no longer valid." },
  EXECUTABLE_NOT_FOUND: { status: 503, message: "The debug adapter is unavailable." },
  PRIVATE_ENDPOINT_UNSUPPORTED: { status: 503, message: "The debug adapter is unavailable." },
  CLIENT_DISPOSED: { status: 503, message: "The debug service is shutting down." },
};

const ADAPTER_START_FAILED: DebugStartRefusal = {
  status: 502,
  message: "The debug adapter did not start.",
};

/** The typed answer to a start that failed with `code`. */
export function debugStartRefusal(code: DebugProcessErrorCode): DebugStartRefusal {
  return START_REFUSALS[code] ?? ADAPTER_START_FAILED;
}

const ERROR_KINDS: Readonly<Partial<Record<DebugProcessErrorCode, ActivityLogErrorKind>>> = {
  REQUEST_TIMEOUT: "timeout",
  REQUEST_CANCELLED: "cancelled",
  CAPACITY: "rate-limited",
  STARTUP_THROTTLED: "rate-limited",
  SESSION_TERMINATING: "conflict",
  TERMINATION_PENDING: "conflict",
  EVIDENCE_PENDING: "conflict",
  SESSION_NOT_FOUND: "conflict",
  INVALID_CAPSULE_PLAN: "conflict",
  WRITE_FAILED: "write-failed",
  MALFORMED_HEADER: "validation-failed",
  MALFORMED_MESSAGE: "validation-failed",
  PAYLOAD_TOO_LARGE: "validation-failed",
  PRIVATE_ENDPOINT_INVALID: "unsafe-target",
};

/** The Activity Log error kind of a closed DAP failure; the exact code travels in its own field. */
function errorKindOf(code: DebugProcessErrorCode | "unclassified"): ActivityLogErrorKind {
  if (code === "unclassified") return "internal";
  return ERROR_KINDS[code] ?? "unavailable";
}

const DAP_START_OPERATION_BASE = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  category: "process",
  owner: "keiko-server",
  causal: "correlation",
  failureClasses: ["debug-session-start"],
  releaseImpact: "patch",
} as const;

const DAP_STARTUP_ATTEMPT_FAILED_OPERATION = defineActivityLogOperation({
  ...DAP_START_OPERATION_BASE,
  op: "dap.debug-session.startup-attempt-failed",
  emitter: "editor.dap.dapStartupActivity.recordStartupAttemptFailed",
  fields: {
    attempt: { type: "integer", dataClass: "count", required: true },
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: DEBUG_STARTUP_PHASES,
    },
    failureCode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: DEBUG_STARTUP_FAILURE_CODES,
    },
    retry: { type: "boolean", dataClass: "closed-enum", required: true },
  },
  lifecycle: "state",
  analyzerProjection: "timeline",
  proofIds: ["dap.debug-session.startup-attempt-failed.line"],
});

const DAP_START_REFUSED_OPERATION = defineActivityLogOperation({
  ...DAP_START_OPERATION_BASE,
  op: "dap.debug-session.start-refused",
  emitter: "editor.dap.dapStartupActivity.recordStartRefused",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: DEBUG_PROCESS_ERROR_CODES,
    },
  },
  lifecycle: "failure",
  analyzerProjection: "failure-cluster",
  proofIds: ["dap.debug-session.start-refused.line"],
});

function correlationOf(correlationId: string | undefined): string {
  return correlationId !== undefined && isValidCorrelationId(correlationId)
    ? correlationId
    : UNKNOWN_CORRELATION_ID;
}

interface DebugStartupAttemptFailure {
  readonly correlationId: string | undefined;
  readonly attempt: number;
  readonly phase: DebugStartupPhase;
  readonly error: unknown;
  readonly retry: boolean;
  readonly durationMs: number;
}

/** Records which step of a startup attempt failed, with its closed code, body-free. */
export function recordStartupAttemptFailed(
  activityLog: ServerLogSink | undefined,
  failure: DebugStartupAttemptFailure,
): void {
  const failureCode = debugStartFailureCode(failure.error) ?? "unclassified";
  activityLog?.write(
    activityLogEvent(
      DAP_STARTUP_ATTEMPT_FAILED_OPERATION,
      {
        level: "warn",
        correlationId: correlationOf(failure.correlationId),
        durationMs: Math.max(0, Math.round(failure.durationMs)),
        errorKind: errorKindOf(failureCode),
      },
      { attempt: failure.attempt, phase: failure.phase, failureCode, retry: failure.retry },
    ),
  );
}

/** Records the closed reason a start route refused with, body-free. */
export function recordStartRefused(
  activityLog: ServerLogSink | undefined,
  correlationId: string | undefined,
  reason: DebugProcessErrorCode,
  status: number,
): void {
  activityLog?.write(
    activityLogEvent(
      DAP_START_REFUSED_OPERATION,
      {
        level: "warn",
        correlationId: correlationOf(correlationId),
        status,
        errorKind: errorKindOf(reason),
      },
      { reason },
    ),
  );
}
