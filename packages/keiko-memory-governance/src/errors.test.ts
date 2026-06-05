import { describe, expect, it } from "vitest";

import { GovernanceError, type GovernanceErrorCode } from "./errors.js";

describe("GovernanceError", () => {
  it("preserves code and message on the instance", () => {
    const err = new GovernanceError("envelope-validation-failed", "bad envelope");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GovernanceError);
    expect(err.code).toBe("envelope-validation-failed");
    expect(err.name).toBe("GovernanceError");
    expect(err.message).toContain("envelope-validation-failed");
    expect(err.message).toContain("bad envelope");
  });

  it("carries optional details when provided", () => {
    const err = new GovernanceError("illegal-status-transition", "no go", [
      "from: forgotten",
      "to: accepted",
    ]);
    expect(err.details).toEqual(["from: forgotten", "to: accepted"]);
  });

  it("omits details when not provided", () => {
    const err = new GovernanceError("idempotent-noop", "already pinned");
    expect(err.details).toBeUndefined();
  });

  it("admits every documented error code at the type level", () => {
    const codes: readonly GovernanceErrorCode[] = [
      "envelope-validation-failed",
      "illegal-status-transition",
      "invalid-resolution",
      "invalid-validity-window",
      "idempotent-noop",
      "unsupported-selector",
      "invalid-selector-input",
      "memory-not-eligible",
    ];
    for (const code of codes) {
      const err = new GovernanceError(code, "test");
      expect(err.code).toBe(code);
    }
  });
});
