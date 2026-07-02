// Issue #1388 (Epic #1491, ADR-0070) — typed failure modes for the governed container runner.
// Callers switch on `code`; messages are static strings that never leak filesystem paths, raw
// engine/OS error text, or the constructed argv into the HTTP response or SSE payload. Mirrors the
// #1387 command-runner error model.
//
// PRE-spawn GOVERNANCE failures surface as a thrown ContainerRunnerError (the route maps each to a
// 4xx/5xx envelope) — most importantly CONTAINER_ENGINE_UNAVAILABLE, thrown BEFORE any run id is
// minted so there is no run/event/evidence for a run that never started. Actual EXECUTION outcomes
// (non-zero exit, timeout, cancellation, image-missing, denied spawn) are reported as a
// ContainerRunResult with a `failureReason`. The one post-execution exception is fail-closed evidence
// persistence: a settled run is not reported successful unless its content-free evidence manifest is
// durably written.

export const CONTAINER_RUNNER_ERROR_CODES = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  IMAGE_NOT_ALLOWED: "IMAGE_NOT_ALLOWED",
  EVIDENCE_WRITE_FAILED: "EVIDENCE_WRITE_FAILED",
  RUN_LIMIT_EXCEEDED: "RUN_LIMIT_EXCEEDED",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  BAD_REQUEST: "BAD_REQUEST",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  CONTAINER_ENGINE_UNAVAILABLE: "CONTAINER_ENGINE_UNAVAILABLE",
  INTERNAL: "INTERNAL",
} as const;

export type ContainerRunnerErrorCode =
  (typeof CONTAINER_RUNNER_ERROR_CODES)[keyof typeof CONTAINER_RUNNER_ERROR_CODES];

const STATUS_MAP: Readonly<Record<ContainerRunnerErrorCode, number>> = {
  PROJECT_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  IMAGE_NOT_ALLOWED: 403,
  EVIDENCE_WRITE_FAILED: 500,
  RUN_LIMIT_EXCEEDED: 429,
  RUN_NOT_FOUND: 404,
  BAD_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  CONTAINER_ENGINE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class ContainerRunnerError extends Error {
  public readonly code: ContainerRunnerErrorCode;
  public readonly status: number;

  public constructor(code: ContainerRunnerErrorCode, message: string) {
    super(message);
    this.name = "ContainerRunnerError";
    this.code = code;
    this.status = STATUS_MAP[code];
  }
}
