// GEN-DUP-NEAR-008 — BrowserToolError now derives its HTTP status through the shared
// CodedHttpError mechanism (contracts). This coverage pins that the status per code is UNCHANGED
// by the refactor: the per-domain STATUS_MAP still drives every mapping, and the class remains an
// instanceof Error / CodedHttpError with the concrete subclass name.

import { describe, expect, it } from "vitest";
import { CodedHttpError } from "@oscharko-dev/keiko-contracts";
import { BROWSER_ERROR_CODES, BrowserToolError, type BrowserErrorCode } from "./errors.js";

const EXPECTED_STATUS: Readonly<Record<BrowserErrorCode, number>> = {
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
  BROWSER_PROFILE_NOT_EPHEMERAL: 403,
  BAD_PORT: 400,
  BAD_URL: 400,
  BAD_REQUEST: 400,
  NO_PENDING_SCREENSHOT: 409,
  PAYLOAD_TOO_LARGE: 413,
  SIDE_FILE_WRITER_MISSING: 500,
};

describe("BrowserToolError (GEN-DUP-NEAR-008)", () => {
  it("derives the documented HTTP status for every code", () => {
    for (const code of Object.values(BROWSER_ERROR_CODES)) {
      expect(new BrowserToolError(code, "m").status).toBe(EXPECTED_STATUS[code]);
    }
  });

  it("maps SESSION_NOT_FOUND to 404 and PAYLOAD_TOO_LARGE to 413", () => {
    expect(new BrowserToolError("SESSION_NOT_FOUND", "gone").status).toBe(404);
    expect(new BrowserToolError("PAYLOAD_TOO_LARGE", "big").status).toBe(413);
  });

  it("exposes the concrete code and message", () => {
    const err = new BrowserToolError("ORIGIN_NOT_ALLOWED", "nope");
    expect(err.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(err.message).toBe("nope");
  });

  it("is an instanceof Error and CodedHttpError with the concrete subclass name", () => {
    const err = new BrowserToolError("CDP_TIMEOUT", "slow");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CodedHttpError);
    expect(err.name).toBe("BrowserToolError");
  });
});
