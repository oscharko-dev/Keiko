// Issue #1387 — typed failure modes for the controlled command runner. Callers switch on `code`;
// messages are static strings that never leak filesystem paths or raw Node/OS error text into the
// HTTP response or SSE event payload. Mirrors the ADR-0018 terminal error model.
//
// PRE-spawn governance failures surface as a thrown CommandRunnerError (the route maps them to a
// 4xx/5xx envelope). Actual EXECUTION outcomes — non-zero exit, timeout, cancellation, denied spawn —
// are reported as a `CommandTaskRunResult` with a `failureReason`. The one post-execution exception is
// fail-closed evidence persistence: a settled run is not reported successful unless its content-free
// evidence manifest is durably written.

import { CodedHttpError, httpStatusFor } from "@oscharko-dev/keiko-contracts";

export const COMMAND_RUNNER_ERROR_CODES = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TASK_REQUIRES_TRUST: "TASK_REQUIRES_TRUST",
  EVIDENCE_WRITE_FAILED: "EVIDENCE_WRITE_FAILED",
  RUN_LIMIT_EXCEEDED: "RUN_LIMIT_EXCEEDED",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  BAD_REQUEST: "BAD_REQUEST",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  COMMAND_RUNNER_UNAVAILABLE: "COMMAND_RUNNER_UNAVAILABLE",
  INTERNAL: "INTERNAL",
} as const;

export type CommandRunnerErrorCode =
  (typeof COMMAND_RUNNER_ERROR_CODES)[keyof typeof COMMAND_RUNNER_ERROR_CODES];

const STATUS_MAP: Readonly<Record<CommandRunnerErrorCode, number>> = {
  PROJECT_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  TASK_REQUIRES_TRUST: 403,
  EVIDENCE_WRITE_FAILED: 500,
  RUN_LIMIT_EXCEEDED: 429,
  RUN_NOT_FOUND: 404,
  BAD_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  COMMAND_RUNNER_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class CommandRunnerError extends CodedHttpError {
  public readonly code: CommandRunnerErrorCode;

  public constructor(code: CommandRunnerErrorCode, message: string) {
    super(message, httpStatusFor(STATUS_MAP, code));
    this.code = code;
  }
}
