// Issue #2211 — typed failure modes for the editor verification runner. Mirrors
// command-runner-errors.ts's CodedHttpError pattern exactly: callers switch on `code`; messages are
// static strings that never leak filesystem paths or raw Node/OS error text into the HTTP response or
// SSE event payload.
//
// PRE-run governance failures surface as a thrown VerificationRunnerError (the route maps them to a
// 4xx/5xx envelope). Actual RUN outcomes stream over SSE as content-free lifecycle events; the
// terminal event carries the redacted VerificationReport.

import { CodedHttpError, httpStatusFor } from "@oscharko-dev/keiko-contracts";

export const VERIFICATION_RUNNER_ERROR_CODES = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  WORKSPACE_TRUST_REQUIRED: "WORKSPACE_TRUST_REQUIRED",
  NO_RUNNABLE_STEPS: "NO_RUNNABLE_STEPS",
  RUN_LIMIT_EXCEEDED: "RUN_LIMIT_EXCEEDED",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  BAD_REQUEST: "BAD_REQUEST",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  VERIFICATION_RUNNER_UNAVAILABLE: "VERIFICATION_RUNNER_UNAVAILABLE",
  // Issue #2211 fix-up (Epic #2092): the audit-evidence trail could not be written. Mirrors
  // command-runner-errors.ts's EVIDENCE_WRITE_FAILED — a governed execution surface must not run
  // silently unaudited.
  EVIDENCE_WRITE_FAILED: "EVIDENCE_WRITE_FAILED",
  INTERNAL: "INTERNAL",
} as const;

export type VerificationRunnerErrorCode =
  (typeof VERIFICATION_RUNNER_ERROR_CODES)[keyof typeof VERIFICATION_RUNNER_ERROR_CODES];

const STATUS_MAP: Readonly<Record<VerificationRunnerErrorCode, number>> = {
  PROJECT_NOT_FOUND: 404,
  // Script-backed kinds (test | typecheck | lint | build) run arbitrary package.json scripts and
  // require the same server-owned workspace-trust decision the command runner applies (403).
  WORKSPACE_TRUST_REQUIRED: 403,
  NO_RUNNABLE_STEPS: 422,
  RUN_LIMIT_EXCEEDED: 429,
  RUN_NOT_FOUND: 404,
  BAD_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  VERIFICATION_RUNNER_UNAVAILABLE: 503,
  EVIDENCE_WRITE_FAILED: 500,
  INTERNAL: 500,
};

export class VerificationRunnerError extends CodedHttpError {
  public readonly code: VerificationRunnerErrorCode;

  public constructor(code: VerificationRunnerErrorCode, message: string) {
    super(message, httpStatusFor(STATUS_MAP, code));
    this.code = code;
  }
}
