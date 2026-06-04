import { describe, expect, it } from "vitest";

import { CaptureRejection, type RejectionReason } from "./errors.js";

describe("CaptureRejection", () => {
  it("carries the typed reason class on the error instance", () => {
    const error = new CaptureRejection("credential-shape", "matched a credential shape");
    expect(error.reason).toBe<RejectionReason>("credential-shape");
    expect(error.name).toBe("CaptureRejection");
    expect(error.message).toBe("matched a credential shape");
    expect(error).toBeInstanceOf(Error);
  });

  it("preserves each rejection reason as a discrete brand", () => {
    // Mutation witness: dropping or renaming a reason in the union breaks this assertion
    // because TypeScript would no longer accept the literal at the typed slot.
    const reasons: readonly RejectionReason[] = [
      "credential-shape",
      "private-credential-path",
      "customer-identifier",
      "empty-content",
      "exceeds-length-limit",
      "ambiguous-forget",
      "ambiguous-update",
      "restricted-sensitivity",
      "scope-not-resolvable",
    ];
    expect(reasons).toHaveLength(9);
  });
});
