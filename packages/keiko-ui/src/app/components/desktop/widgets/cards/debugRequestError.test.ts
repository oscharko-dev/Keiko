import { describe, expect, it } from "vitest";
import { DebugRequestError, debugStartFailure, refusalCodeOf } from "./debugRequestError";

describe("refusalCodeOf", () => {
  it("reads the closed code of a refusal body", () => {
    expect(refusalCodeOf({ error: { code: "STARTUP_THROTTLED", message: "x" } })).toBe(
      "STARTUP_THROTTLED",
    );
  });

  it.each([
    { label: "a lower-case code", body: { error: { code: "startup_throttled" } } },
    { label: "a code with spaces", body: { error: { code: "A B" } } },
    { label: "an over-long code", body: { error: { code: "A".repeat(65) } } },
    { label: "a numeric code", body: { error: { code: 503 } } },
    { label: "a string error", body: { error: "conflict" } },
    { label: "an array error", body: { error: ["CAPACITY"] } },
    { label: "no error", body: {} },
    { label: "null", body: null },
    { label: "an array body", body: [] },
    { label: "a string body", body: "CAPACITY" },
  ])("ignores $label", ({ body }) => {
    expect(refusalCodeOf(body)).toBeUndefined();
  });
});

describe("debugStartFailure", () => {
  it.each([
    { code: "STARTUP_THROTTLED", failure: "adapter" },
    { code: "REQUEST_TIMEOUT", failure: "adapter" },
    { code: "SESSION_NOT_FOUND", failure: "adapter" },
    { code: "CAPACITY", failure: "capacity" },
    { code: "SESSION_TERMINATING", failure: "busy" },
    { code: "TERMINATION_PENDING", failure: "busy" },
    { code: "EVIDENCE_PENDING", failure: "busy" },
    { code: "INVALID_CAPSULE_PLAN", failure: "target" },
    { code: "EXECUTABLE_NOT_FOUND", failure: "unavailable" },
    { code: "CLIENT_DISPOSED", failure: "unavailable" },
  ])("explains $code as $failure", ({ code, failure }) => {
    expect(debugStartFailure(new DebugRequestError(503, code))).toBe(failure);
  });

  it.each([
    { label: "an unknown code", error: new DebugRequestError(409, "STALE_ACTIVATION") },
    { label: "an inherited property name", error: new DebugRequestError(500, "TO_STRING") },
    { label: "a missing code", error: new DebugRequestError(500, undefined) },
    { label: "another error", error: new Error("STARTUP_THROTTLED") },
    { label: "a non-error", error: { code: "CAPACITY" } },
  ])("has no explanation for $label", ({ error }) => {
    expect(debugStartFailure(error)).toBeUndefined();
  });
});
