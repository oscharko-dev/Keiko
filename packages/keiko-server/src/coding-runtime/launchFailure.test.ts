// KEIKO-0150 (#2901): a launch rejected by a backend used to be a bare Error whose message was the
// only carrier of the cause, caught by a `catch {}` in the orchestrator and reported as the single
// generic `authority-resolution-failed`. These pin the structured mapping that replaced it.

import { describe, expect, it } from "vitest";
import {
  CodingRuntimeAgentUnsupportedError,
  CodingRuntimeInputsUnsupportedError,
  CodingRuntimeJiraPodRefusedError,
  CodingRuntimeLaunchRejectedError,
  CodingRuntimeLaunchResolutionError,
  classifyLaunchRejection,
  launchModelRefusalReason,
  launchRejectionDiagnosticReason,
  refusedLaunch,
} from "./launchFailure.js";

// #3603: a start refused because the chosen model's window cannot hold a coding run's prompt, or
// because the verification that could prove a larger window is still running, names that reason
// to the Workbench. Only these two, and only under model-unavailable.
describe("launchModelRefusalReason", () => {
  it.each(["model-context-window-insufficient", "model-verification-pending"] as const)(
    "names the %s model refusal",
    (reason) => {
      expect(
        launchModelRefusalReason(
          new CodingRuntimeLaunchRejectedError("model-unavailable", false, reason),
        ),
      ).toBe(reason);
    },
  );

  it.each([
    [
      "another model refusal",
      new CodingRuntimeLaunchRejectedError("model-unavailable", false, "tool-calling-unverified"),
    ],
    ["a model refusal without a reason", new CodingRuntimeLaunchRejectedError("model-unavailable")],
    [
      "the reason under another failure code",
      new CodingRuntimeLaunchRejectedError(
        "workspace-unqualified",
        false,
        "model-context-window-insufficient",
      ),
    ],
    ["a bare Error", new Error("model-context-window-insufficient")],
  ])("names no reason for %s", (_label, error) => {
    expect(launchModelRefusalReason(error)).toBeUndefined();
  });
});

describe("classifyLaunchRejection", () => {
  it("answers a primary agent the runtime cannot honour as an invalid intent with a closed reason", () => {
    const rejection = new CodingRuntimeAgentUnsupportedError("plan");
    expect(rejection.agent).toBe("plan");
    expect(rejection.message).toBe("agent-unsupported");
    expect(classifyLaunchRejection(rejection)).toBe("invalid-intent");
    expect(launchRejectionDiagnosticReason(rejection)).toBe("agent-unsupported");
    expect(launchModelRefusalReason(rejection)).toBeUndefined();
  });

  it("answers first-prompt inputs the runtime cannot take as an invalid intent with a closed reason", () => {
    const rejection = new CodingRuntimeInputsUnsupportedError();
    expect(rejection.message).toBe("inputs-unsupported");
    expect(rejection.name).toBe("CodingRuntimeInputsUnsupportedError");
    expect(classifyLaunchRejection(rejection)).toBe("invalid-intent");
    expect(launchRejectionDiagnosticReason(rejection)).toBe("inputs-unsupported");
    expect(launchModelRefusalReason(rejection)).toBeUndefined();
    expect(refusedLaunch(rejection)).toEqual({ ok: false, failureCode: "invalid-intent" });
  });

  it("answers a refused Jira Pod as an invalid intent with its closed reason and no identity", () => {
    const rejection = new CodingRuntimeJiraPodRefusedError("pod-not-ready");
    expect(rejection.name).toBe("CodingRuntimeJiraPodRefusedError");
    expect(rejection.message).toBe("jira-pod:pod-not-ready");
    expect(classifyLaunchRejection(rejection)).toBe("invalid-intent");
    expect(launchRejectionDiagnosticReason(rejection)).toBe("jira-pod:pod-not-ready");
    expect(refusedLaunch(rejection)).toEqual({ ok: false, failureCode: "invalid-intent" });
  });

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
