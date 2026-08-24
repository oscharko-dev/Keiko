// KEIKO-0150 (#2901): a launch rejected by a backend used to be a bare Error whose message was the
// only carrier of the cause, caught by a `catch {}` in the orchestrator and reported as the single
// generic `authority-resolution-failed`. These pin the structured mapping that replaced it.

import { describe, expect, it } from "vitest";
import {
  CodingRuntimeLaunchRejectedError,
  CodingRuntimeLaunchResolutionError,
  classifyLaunchRejection,
  launchRejectionDiagnosticReason,
} from "./launchFailure.js";

describe("classifyLaunchRejection", () => {
  it("maps an adapter profile mismatch to the source-drift code the contract already defines", () => {
    const rejection = new CodingRuntimeLaunchRejectedError("adapter-profile-mismatch");
    expect(classifyLaunchRejection(rejection)).toBe("source-drift");
    expect(rejection.failureCode).toBe("adapter-profile-mismatch");
    expect(rejection.retryable).toBe(false);
    expect(launchRejectionDiagnosticReason(rejection)).toBe("adapter-profile-mismatch");
  });

  it("keeps model resolution failures closed and diagnostic without changing the wire fallback", () => {
    const rejection = new CodingRuntimeLaunchResolutionError("managed-model-unqualified");

    expect(rejection.reason).toBe("managed-model-unqualified");
    expect(classifyLaunchRejection(rejection)).toBe("authority-resolution-failed");
    expect(launchRejectionDiagnosticReason(rejection)).toBe("managed-model-unqualified");
  });

  it("keeps an unmapped structured rejection on the generic code rather than guessing a cause", () => {
    // A structured code with no wire-facing counterpart must not be reported as some other,
    // specific failure — reporting the wrong cause is worse than reporting a generic one.
    expect(classifyLaunchRejection(new CodingRuntimeLaunchRejectedError("spawn-failed"))).toBe(
      "authority-resolution-failed",
    );
  });

  it.each([
    ["a bare Error", new Error("opencode-backend-profile-mismatch")],
    ["a thrown string", "adapter-profile-mismatch"],
    ["a nullish throw", undefined],
    ["a lookalike object", { failureCode: "adapter-profile-mismatch" }],
  ])("does not trust %s to name its own failure code", (_label, thrown) => {
    // The message and shape are attacker- and accident-controlled; only the class is evidence.
    expect(classifyLaunchRejection(thrown)).toBe("authority-resolution-failed");
    expect(launchRejectionDiagnosticReason(thrown)).toBeUndefined();
  });
});
