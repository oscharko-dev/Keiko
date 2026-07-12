import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_PROJECTIONS,
  codingWorkbenchProjectionForState,
} from "./codingWorkbenchProjection";

describe("codingWorkbenchProjectionForState", () => {
  it("returns the empty projection when state is undefined", () => {
    expect(codingWorkbenchProjectionForState(undefined)).toBe(CODING_WORKBENCH_PROJECTIONS.empty);
  });

  it("returns the empty projection for an unknown state string", () => {
    expect(codingWorkbenchProjectionForState("no-such-state")).toBe(
      CODING_WORKBENCH_PROJECTIONS.empty,
    );
  });

  // Covers each entry in the PROJECTION_BY_STATE Map — including the
  // supervised-stopped / autonomous-verification-failed / failed / completed
  // rows that were previously untouched by any test.
  it.each([
    ["running", "running"],
    ["approval-required", "approvalRequired"],
    ["supervised-approval-required", "supervisedApprovalRequired"],
    ["supervised-approved", "supervisedApproved"],
    ["supervised-denied", "supervisedDenied"],
    ["supervised-stopped", "supervisedStopped"],
    ["supervised-failed", "supervisedFailed"],
    ["blocked", "blocked"],
    ["governed-assist", "governedAssist"],
    ["governed-assist-blocked", "governedAssistBlocked"],
    ["autonomous-confirmed", "autonomousConfirmed"],
    ["autonomous-policy-blocked", "autonomousPolicyBlocked"],
    ["autonomous-verification-failed", "autonomousVerificationFailed"],
    ["autonomous-completed", "autonomousCompleted"],
    ["failed", "failed"],
    ["completed", "completed"],
  ] as const)("maps run state '%s' to the '%s' projection", (state, key) => {
    expect(codingWorkbenchProjectionForState(state)).toBe(
      CODING_WORKBENCH_PROJECTIONS[key as keyof typeof CODING_WORKBENCH_PROJECTIONS],
    );
  });
});
