import { describe, expect, it } from "vitest";
import {
  CODING_RUNTIME_GIT_MAX_PATHS,
  CODING_RUNTIME_GIT_MAX_STAGE_PATHS,
  isCodingRuntimeGitResult,
} from "./coding-runtime-git.js";
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
  // U-28: the request carries at most CODING_RUNTIME_GIT_MAX_PATHS entries, but the proposal a
  // directory expands to binds up to CODING_RUNTIME_GIT_MAX_STAGE_PATHS files.
  it.each(["stage", "unstage"] as const)("bounds a %s proposal's expanded file count", (kind) => {
    const base = { ...stage, kind, proposalId: `${kind}-123`, status: "ready", reason: "none" };
    const accepted = (pathCount: number): boolean =>
      isCodingRuntimeGitResult({ ...base, pathCount });
    expect(accepted(CODING_RUNTIME_GIT_MAX_PATHS + 1)).toBe(true);
    expect(accepted(302)).toBe(true);
    expect(accepted(CODING_RUNTIME_GIT_MAX_STAGE_PATHS)).toBe(true);
    expect(accepted(CODING_RUNTIME_GIT_MAX_STAGE_PATHS + 1)).toBe(false);
    expect(accepted(0)).toBe(false);
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

// #4491: a fresh repository has no commit yet. The status says so with a closed `head` marker
// instead of an empty or missing sha, and a marker that contradicts the sha is refused.
describe("runtime Git status of a born and an unborn branch", () => {
  const body = {
    kind: "status",
    stagedTreeDigest: "a".repeat(64),
    branch: "main",
    changes: [],
    truncated: false,
  };
  it("accepts a born head with its commit and an unborn head without one", () => {
    expect(isCodingRuntimeGitResult({ ...body, head: "born", headSha: "b".repeat(40) })).toBe(true);
    expect(isCodingRuntimeGitResult({ ...body, head: "unborn" })).toBe(true);
  });
  it("refuses every contradictory or incomplete head", () => {
    expect(isCodingRuntimeGitResult({ ...body, head: "unborn", headSha: "b".repeat(40) })).toBe(
      false,
    );
    expect(isCodingRuntimeGitResult({ ...body, head: "born" })).toBe(false);
    expect(isCodingRuntimeGitResult({ ...body, head: "born", headSha: "" })).toBe(false);
    expect(isCodingRuntimeGitResult({ ...body, headSha: "b".repeat(40) })).toBe(false);
    expect(isCodingRuntimeGitResult(body)).toBe(false);
  });
});
