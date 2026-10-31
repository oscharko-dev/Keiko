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
  ["blocked", "selection-unreviewed"],
  ["blocked", "buffers-dirty"],
  ["blocked", "proposal-limit"],
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

// #3907 (owner decision 2026-10-31): the closed outcome of the governed task-branch tool.
describe("closed runtime Git branch result", () => {
  const branch = { kind: "branch", status: "succeeded", reason: "none", branch: "feature/x" };
  it.each([
    ["succeeded", "none"],
    ["blocked", "invalid-name"],
    ["blocked", "protected-name"],
    ["blocked", "branch-exists"],
    ["blocked", "not-on-base"],
    ["blocked", "not-local-checkout"],
    ["blocked", "executable-filters"],
    ["blocked", "authority-denied"],
    ["blocked", "policy-block"],
    ["blocked", "preflight-block"],
    ["failed", "execution-failed"],
    ["failed", "rebind-failed"],
    ["recovery-required", "execution-uncertain"],
  ] as const)("accepts exactly %s/%s", (status, reason) => {
    expect(isCodingRuntimeGitResult({ ...branch, status, reason })).toBe(true);
    expect(isCodingRuntimeGitResult({ kind: "branch", status, reason })).toBe(true);
  });
  it("rejects contradictory pairs, unsafe or option-like names and unreviewed fields", () => {
    expect(
      isCodingRuntimeGitResult({ ...branch, status: "succeeded", reason: "branch-exists" }),
    ).toBe(false);
    expect(isCodingRuntimeGitResult({ ...branch, status: "blocked", reason: "none" })).toBe(false);
    expect(isCodingRuntimeGitResult({ ...branch, status: "pending" })).toBe(false);
    for (const name of ["-D", "a b", "x..y", "", "a:b"])
      expect(isCodingRuntimeGitResult({ ...branch, branch: name })).toBe(false);
    expect(isCodingRuntimeGitResult({ ...branch, argv: ["branch"] })).toBe(false);
  });
});
