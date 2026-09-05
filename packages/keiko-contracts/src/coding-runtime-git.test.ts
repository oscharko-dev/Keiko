import { describe, expect, it } from "vitest";
import { isCodingRuntimeGitResult } from "./coding-runtime-git.js";
import { isCodingWorkbenchEvidenceSafeText } from "./coding-workbench-evidence.js";
const pairs = [
  ["ready", "none"],
  ["succeeded", "none"],
  ["approval-required", "approval-required"],
  ["blocked", "approval-invalid"],
  ["blocked", "authority-denied"],
  ["blocked", "scope-denied"],
  ["blocked", "policy-block"],
  ["blocked", "preflight-block"],
  ["blocked", "unsupported-transformation"],
  ["drift", "candidate-drift"],
  ["failed", "execution-failed"],
  ["recovery-required", "execution-uncertain"],
] as const;
const stage = { kind: "stage", proposalId: "stage-123", pathCount: 1 };
describe("closed runtime Git evidence", () => {
  it.each(pairs)("accepts exactly %s/%s", (status, reason) => {
    expect(isCodingRuntimeGitResult({ ...stage, status, reason })).toBe(true);
  });
  it("rejects every contradictory status/reason pair", () => {
    for (const status of new Set(pairs.map(([value]) => value))) {
      for (const reason of new Set(pairs.map(([, value]) => value))) {
        const valid = pairs.some(
          ([expectedStatus, expectedReason]) =>
            expectedStatus === status && expectedReason === reason,
        );
        expect(isCodingRuntimeGitResult({ ...stage, status, reason })).toBe(valid);
      }
    }
  });
  it.each(["message", "stdout", "token", "capability", "root", "argv", "env"])(
    "rejects unreviewed nested result data %s",
    (field) => {
      expect(
        isCodingRuntimeGitResult({
          ...stage,
          status: "succeeded",
          reason: "none",
          [field]: "untrusted",
        }),
      ).toBe(false);
    },
  );
  it("projects only the new inert stage event labels", () => {
    for (const value of ["stage-123", "event-stage-123", "stage-approval-required"])
      expect(isCodingWorkbenchEvidenceSafeText(value)).toBe(true);
    for (const value of [
      "stage-/etc/passwd",
      "stage-api-key=private",
      "stage-https://example.test",
      "stage-secret",
      "stage-customer-body",
    ])
      expect(isCodingWorkbenchEvidenceSafeText(value)).toBe(false);
  });
});
