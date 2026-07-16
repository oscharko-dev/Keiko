import { describe, expect, it } from "vitest";

import { ATLASSIAN_AUTHORITY_FAILURE_REASON } from "./actionPolicy.js";

describe("Atlassian governed action authority mapping", () => {
  it("fails closed with the existing invalid-authority connector reason after revocation", () => {
    expect(ATLASSIAN_AUTHORITY_FAILURE_REASON.revoked).toBe("authority-invalid");
  });
});
