// Typed failure modes for the browser tool (ADR-0017 D10). Callers switch on `code`, never on
// message — messages are static strings that never leak filesystem paths or raw Chrome diagnostics
// to the UI.

export const BROWSER_ERROR_CODES = {
  CHROME_UNREACHABLE: "CHROME_UNREACHABLE",
  CHROME_VERSION_MISMATCH: "CHROME_VERSION_MISMATCH",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_LIMIT_EXCEEDED: "SESSION_LIMIT_EXCEEDED",
  ORIGIN_NOT_ALLOWED: "ORIGIN_NOT_ALLOWED",
  SCHEME_NOT_ALLOWED: "SCHEME_NOT_ALLOWED",
  TARGET_CLOSED: "TARGET_CLOSED",
  CDP_TIMEOUT: "CDP_TIMEOUT",
  SCREENSHOT_TOO_LARGE: "SCREENSHOT_TOO_LARGE",
  CONTENT_TOO_LARGE: "CONTENT_TOO_LARGE",
  CDP_METHOD_FORBIDDEN: "CDP_METHOD_FORBIDDEN",
  CDP_TRANSPORT_REFUSED: "CDP_TRANSPORT_REFUSED",
  BAD_PORT: "BAD_PORT",
  BAD_URL: "BAD_URL",
  BAD_REQUEST: "BAD_REQUEST",
  NO_PENDING_SCREENSHOT: "NO_PENDING_SCREENSHOT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  // Issue #162: the BFF must inject a side-file writer when evidenceStore is set. Without one,
  // applyScreenshot refuses to drop binary evidence on the floor — fail-closed.
  SIDE_FILE_WRITER_MISSING: "SIDE_FILE_WRITER_MISSING",
} as const;

export type BrowserErrorCode = (typeof BROWSER_ERROR_CODES)[keyof typeof BROWSER_ERROR_CODES];

// HTTP status mapping per ADR-0017 D10. The two pure-input codes (BAD_PORT, BAD_URL, BAD_REQUEST)
// always map to 400; SESSION_LIMIT_EXCEEDED to 429; ORIGIN_NOT_ALLOWED to 403; SCHEME_NOT_ALLOWED
// to 400; TARGET_CLOSED to 410; CDP_TIMEOUT to 504; size-cap codes to 413; FORBIDDEN to 500
// (server bug); SESSION_NOT_FOUND to 404; CHROME_UNREACHABLE to 503; CHROME_VERSION_MISMATCH to 400.
const STATUS_MAP: Readonly<Record<BrowserErrorCode, number>> = {
  CHROME_UNREACHABLE: 503,
  CHROME_VERSION_MISMATCH: 400,
  SESSION_NOT_FOUND: 404,
  SESSION_LIMIT_EXCEEDED: 429,
  ORIGIN_NOT_ALLOWED: 403,
  SCHEME_NOT_ALLOWED: 400,
  TARGET_CLOSED: 410,
  CDP_TIMEOUT: 504,
  SCREENSHOT_TOO_LARGE: 413,
  CONTENT_TOO_LARGE: 413,
  CDP_METHOD_FORBIDDEN: 500,
  CDP_TRANSPORT_REFUSED: 503,
  BAD_PORT: 400,
  BAD_URL: 400,
  BAD_REQUEST: 400,
  NO_PENDING_SCREENSHOT: 409,
  PAYLOAD_TOO_LARGE: 413,
  // BFF configuration error (impossible if BFF correctly wires the writer port). 500 reflects
  // the server-side misconfiguration, never reaches the UI in normal operation.
  SIDE_FILE_WRITER_MISSING: 500,
};

export class BrowserToolError extends Error {
  public readonly code: BrowserErrorCode;
  public readonly status: number;

  public constructor(code: BrowserErrorCode, message: string) {
    super(message);
    this.name = "BrowserToolError";
    this.code = code;
    this.status = STATUS_MAP[code];
  }
}
