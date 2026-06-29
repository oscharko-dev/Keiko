// Issue #1387 — typed failure modes for the controlled command runner. Callers switch on `code`;
// messages are static strings that never leak filesystem paths or raw Node/OS error text into the
// HTTP response or SSE event payload. Mirrors the ADR-0018 terminal error model.
//
// Only PRE-spawn governance failures surface as a thrown CommandRunnerError (the route maps them to a
// 4xx/5xx envelope). Every actual EXECUTION outcome — non-zero exit, timeout, cancellation, denied
// spawn — is reported as a `CommandTaskRunResult` with a `failureReason`, never as an error.

export const COMMAND_RUNNER_ERROR_CODES = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
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
  RUN_LIMIT_EXCEEDED: 429,
  RUN_NOT_FOUND: 404,
  BAD_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  COMMAND_RUNNER_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class CommandRunnerError extends Error {
  public readonly code: CommandRunnerErrorCode;
  public readonly status: number;

  public constructor(code: CommandRunnerErrorCode, message: string) {
    super(message);
    this.name = "CommandRunnerError";
    this.code = code;
    this.status = STATUS_MAP[code];
  }
}
