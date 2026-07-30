import { describe, expect, it } from "vitest";

import {
  CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS,
  CODING_WORKBENCH_APPROVAL_REVIEW_PATH_MAX_CHARS,
  unpairedCodingWorkbenchRuntimeApprovalReviewChannelPayload,
  validateCodingWorkbenchRuntimeApprovalReviewChannelPayload,
} from "./coding-workbench-runtime-approval-review.js";

function activeReview(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    session: "active",
    pending: {
      requestId: "permission-42",
      paths: ["src/a.ts"],
      pathsTruncated: false,
      fileCount: 1,
      addedLines: 3,
      deletedLines: 1,
      ...overrides,
    },
  };
}

function errorsFor(value: unknown): readonly string[] {
  const validation = validateCodingWorkbenchRuntimeApprovalReviewChannelPayload(value);
  return validation.ok ? [] : validation.errors;
}

describe("coding workbench runtime approval review channel", () => {
  it("accepts a bounded, workspace-relative review", () => {
    expect(validateCodingWorkbenchRuntimeApprovalReviewChannelPayload(activeReview()).ok).toBe(
      true,
    );
  });

  it("projects one constant content-free payload for an unpaired caller", () => {
    const payload = unpairedCodingWorkbenchRuntimeApprovalReviewChannelPayload();
    expect(payload).toEqual({ session: "unpaired" });
    expect(validateCodingWorkbenchRuntimeApprovalReviewChannelPayload(payload).ok).toBe(true);
  });

  it("rejects review state carried on an unpaired payload", () => {
    expect(errorsFor({ ...activeReview(), session: "unpaired" })).toContain(
      "approvalReviewChannelPayload.pending must be absent when the session is unpaired",
    );
  });

  it("rejects a non-object, an unknown key and an invalid session", () => {
    expect(errorsFor("nope")).toEqual(["approval review channel payload must be an object"]);
    expect(errorsFor({ session: "active", extra: 1 })).toContain(
      "approvalReviewChannelPayload.extra is not allowed",
    );
    expect(errorsFor({ session: "paired" })).toContain(
      "approvalReviewChannelPayload.session is invalid",
    );
  });

  it.each([
    ["absolute", "/etc/passwd"],
    ["parent escape", "../outside.ts"],
    ["embedded parent escape", "src/../../outside.ts"],
    ["home anchored", "~/secrets.env"],
    ["drive anchored", "C:/Windows/system32"],
    ["backslash", "src\\a.ts"],
    ["current directory segment", "./src/a.ts"],
    ["empty segment", "src//a.ts"],
    ["alternate data stream", "src/a.ts:stream"],
    ["empty", ""],
  ])("rejects a %s path", (_label, path) => {
    expect(errorsFor(activeReview({ paths: [path] }))).toContain(
      "pendingApprovalReview.paths[0] is not a contained relative path",
    );
  });

  it("rejects an empty, oversized, duplicated or over-long path list", () => {
    expect(errorsFor(activeReview({ paths: [] }))).toContain(
      "pendingApprovalReview.paths must be a non-empty array",
    );
    const tooMany = Array.from(
      { length: CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS + 1 },
      (_value, index) => `src/f${String(index)}.ts`,
    );
    expect(errorsFor(activeReview({ paths: tooMany, fileCount: tooMany.length }))).toContain(
      "pendingApprovalReview.paths exceeds the reviewable path cap",
    );
    expect(errorsFor(activeReview({ paths: ["src/a.ts", "src/a.ts"], fileCount: 2 }))).toContain(
      "pendingApprovalReview.paths must be unique",
    );
    const longPath = `src/${"a".repeat(CODING_WORKBENCH_APPROVAL_REVIEW_PATH_MAX_CHARS)}.ts`;
    expect(errorsFor(activeReview({ paths: [longPath] }))).toContain(
      "pendingApprovalReview.paths[0] is not a contained relative path",
    );
  });

  it("rejects counts that are negative, fractional or unbounded", () => {
    expect(errorsFor(activeReview({ addedLines: -1 }))).toContain(
      "pendingApprovalReview.addedLines must be a bounded non-negative integer",
    );
    expect(errorsFor(activeReview({ deletedLines: 1.5 }))).toContain(
      "pendingApprovalReview.deletedLines must be a bounded non-negative integer",
    );
    expect(errorsFor(activeReview({ fileCount: Number.MAX_SAFE_INTEGER }))).toContain(
      "pendingApprovalReview.fileCount must be a bounded non-negative integer",
    );
  });

  it("refuses a file count that misstates the blast radius of the carried list", () => {
    expect(errorsFor(activeReview({ fileCount: 9 }))).toContain(
      "pendingApprovalReview.fileCount must match the carried path list",
    );
    expect(
      validateCodingWorkbenchRuntimeApprovalReviewChannelPayload(
        activeReview({ fileCount: 9, pathsTruncated: true }),
      ).ok,
    ).toBe(true);
    expect(errorsFor(activeReview({ fileCount: 0, pathsTruncated: true }))).toContain(
      "pendingApprovalReview.fileCount must match the carried path list",
    );
  });

  it("rejects a missing key, an extra key and a non-boolean truncation flag", () => {
    expect(errorsFor(activeReview({ pathsTruncated: "no" }))).toContain(
      "pendingApprovalReview.pathsTruncated must be a boolean",
    );
    expect(errorsFor(activeReview({ patch: "diff --git a b" }))).toContain(
      "pendingApprovalReview.patch is not allowed",
    );
    expect(errorsFor({ session: "active", pending: { paths: ["src/a.ts"] } })).toContain(
      "pendingApprovalReview.requestId must be a bounded safe identifier",
    );
  });
});
