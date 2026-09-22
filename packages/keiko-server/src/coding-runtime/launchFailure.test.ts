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

  // #3565 Observation 17: the customer's start was refused with `authority-resolution-failed` and
  // nothing in the log named which check refused it. Each launch-path refusal now carries its own
  // code, maps to a wire code the Workbench can explain, and names its closed sub-reason.
  it.each([
    ["host-unavailable", "runtime-unavailable"],
    ["model-unavailable", "model-unavailable"],
    ["repository-unavailable", "workspace-unqualified"],
    ["workspace-unqualified", "workspace-unqualified"],
  ] as const)("maps %s to the wire code %s", (failureCode, wireCode) => {
    expect(classifyLaunchRejection(new CodingRuntimeLaunchRejectedError(failureCode))).toBe(
      wireCode,
    );
  });

  it("carries a closed sub-reason into the message and the diagnostic reason", () => {
    const rejection = new CodingRuntimeLaunchRejectedError(
      "model-unavailable",
      false,
      "tool-calling-unverified",
    );
    expect(rejection.reason).toBe("tool-calling-unverified");
    expect(rejection.message).toBe("model-unavailable:tool-calling-unverified");
    expect(launchRejectionDiagnosticReason(rejection)).toBe(
      "model-unavailable:tool-calling-unverified",
    );
  });

  it.each([
    ["free text with spaces", "the API key is sk-live-123"],
    ["a path", "/Users/someone/repo"],
    ["an over-long token", "a".repeat(65)],
    ["an empty string", ""],
  ])("drops %s as a sub-reason instead of carrying it into the message", (_label, reason) => {
    const rejection = new CodingRuntimeLaunchRejectedError("workspace-unqualified", false, reason);
    expect(rejection.reason).toBeUndefined();
    expect(rejection.message).toBe("workspace-unqualified");
    expect(launchRejectionDiagnosticReason(rejection)).toBe("workspace-unqualified");
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
