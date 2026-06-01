// ADR-0018 D10 — typed failure modes for the UI terminal tool. Callers switch on `code`; messages
// are static strings that never leak filesystem paths or raw Node/OS error text into the HTTP
// response or SSE event payload.

export const TERMINAL_ERROR_CODES = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  COMMAND_DENIED: "COMMAND_DENIED",
  CWD_OUTSIDE_PROJECT: "CWD_OUTSIDE_PROJECT",
  CWD_DENIED: "CWD_DENIED",
  EXECUTION_NOT_FOUND: "EXECUTION_NOT_FOUND",
  EXECUTION_LIMIT_EXCEEDED: "EXECUTION_LIMIT_EXCEEDED",
  TIMEOUT: "TIMEOUT",
  CANCELLED: "CANCELLED",
  EXECUTABLE_NOT_FOUND: "EXECUTABLE_NOT_FOUND",
  EVIDENCE_WRITE_FAILED: "EVIDENCE_WRITE_FAILED",
  BAD_REQUEST: "BAD_REQUEST",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  INTERNAL: "INTERNAL",
} as const;

export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[keyof typeof TERMINAL_ERROR_CODES];

// HTTP status mapping per ADR-0018 D10. CANCELLED uses 499 ("Client Closed Request"), the
// Nginx-popularised convention also used by the harness for abort-driven cancellation.
const STATUS_MAP: Readonly<Record<TerminalErrorCode, number>> = {
  PROJECT_NOT_FOUND: 404,
  COMMAND_DENIED: 403,
  CWD_OUTSIDE_PROJECT: 403,
  CWD_DENIED: 403,
  EXECUTION_NOT_FOUND: 404,
  EXECUTION_LIMIT_EXCEEDED: 429,
  TIMEOUT: 408,
  CANCELLED: 499,
  EXECUTABLE_NOT_FOUND: 404,
  EVIDENCE_WRITE_FAILED: 500,
  BAD_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
};

export class TerminalToolError extends Error {
  public readonly code: TerminalErrorCode;
  public readonly status: number;

  public constructor(code: TerminalErrorCode, message: string) {
    super(message);
    this.name = "TerminalToolError";
    this.code = code;
    this.status = STATUS_MAP[code];
  }
}
