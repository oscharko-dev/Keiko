/**
 * Leaf module for the small set of runtime primitives `./api.ts` and
 * `./coding-workbench-lazy-fetchers.ts` both need at the value level: the `ApiError` class and the
 * bounded-input validators/constants several BFF response validators share. Neither `api.ts` nor
 * `coding-workbench-lazy-fetchers.ts` imports the other's runtime values through this module, so
 * `api.ts`'s `await import("./coding-workbench-lazy-fetchers")` (the dynamic-import boundary that
 * keeps the lazy fetchers' contract-validator weight out of the desktop shell's first-load chunk,
 * epic #3384 final-audit F18) is no longer load-order-sensitive on a static import back into
 * `api.ts` (review finding on the same audit). This file imports from neither sibling, by design.
 */

export class ApiError extends Error {
  // RB-6 (GEN-OBS-CORRELATION-103/601): the server-issued request correlation id for this failure,
  // when the response carried one (X-Keiko-Correlation-Id header or `error.correlationId`). Optional
  // and set after construction so the many `new ApiError(code, message, status)` call sites are
  // unchanged; error surfaces can show it as a copyable support id that ties the UI failure to exactly
  // one server-side diagnostic record.
  public correlationId?: string;

  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const GITHUB_ISSUE_BINDING_ID_MAX_CHARS = 128;
export const SHA256_HEX = /^[0-9a-f]{64}$/u;

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line no-control-regex -- the class IS the control range being refused
const CONTROL_CHARACTER = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "u");

export function isBoundedText(
  value: unknown,
  maxChars: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.trim().length > 0) &&
    value.length <= maxChars &&
    !CONTROL_CHARACTER.test(value)
  );
}
