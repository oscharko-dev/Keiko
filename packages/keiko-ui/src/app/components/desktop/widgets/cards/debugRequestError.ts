// #4103: the governed debug routes answer a refused start with a closed code (for example
// STARTUP_THROTTLED or CAPACITY) instead of an opaque 500. This module keeps that code on the
// request error and reduces it to the few start failures the Debug panel can explain to a person.

const REFUSAL_CODE = /^[A-Z][A-Z_]{0,63}$/u;

/** A rejected governed-debug request with the closed refusal code its response named, if any. */
export class DebugRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super("Debug request was rejected.");
    this.name = "DebugRequestError";
  }
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** The closed `error.code` of a refusal body, or undefined for any other shape. */
export function refusalCodeOf(body: unknown): string | undefined {
  const code = recordOf(recordOf(body)?.error)?.code;
  return typeof code === "string" && REFUSAL_CODE.test(code) ? code : undefined;
}

/** Why a debug session did not start, in the terms the Debug panel explains. */
export type DebugStartFailure = "adapter" | "busy" | "capacity" | "target" | "unavailable";

const START_FAILURES: Readonly<Record<string, DebugStartFailure>> = {
  STARTUP_THROTTLED: "adapter",
  SESSION_NOT_FOUND: "adapter",
  REQUEST_TIMEOUT: "adapter",
  REQUEST_CANCELLED: "adapter",
  ADAPTER_REJECTED: "adapter",
  UNEXPECTED_EOF: "adapter",
  WRITE_FAILED: "adapter",
  MALFORMED_HEADER: "adapter",
  MALFORMED_MESSAGE: "adapter",
  PAYLOAD_TOO_LARGE: "adapter",
  REQUEST_LIMIT: "adapter",
  REVERSE_REQUEST_DENIED: "adapter",
  PRIVATE_ENDPOINT_INVALID: "adapter",
  CAPACITY: "capacity",
  SESSION_TERMINATING: "busy",
  TERMINATION_PENDING: "busy",
  EVIDENCE_PENDING: "busy",
  INVALID_CAPSULE_PLAN: "target",
  EXECUTABLE_NOT_FOUND: "unavailable",
  PRIVATE_ENDPOINT_UNSUPPORTED: "unavailable",
  CLIENT_DISPOSED: "unavailable",
};

/** The explained start failure of `error`, or undefined when the panel has no specific reason. */
export function debugStartFailure(error: unknown): DebugStartFailure | undefined {
  if (!(error instanceof DebugRequestError) || error.code === undefined) return undefined;
  return Object.hasOwn(START_FAILURES, error.code) ? START_FAILURES[error.code] : undefined;
}
