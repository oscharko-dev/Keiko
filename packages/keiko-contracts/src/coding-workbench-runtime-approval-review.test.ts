import { describe, expect, it } from "vitest";
import { mcpToolAction } from "./mcp-servers.js";

import {
  CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS,
  CODING_WORKBENCH_APPROVAL_REVIEW_PATH_MAX_CHARS,
  CODING_WORKBENCH_NATIVE_ACTION_REVIEW_MAX_RESOURCES,
  CODING_WORKBENCH_NATIVE_ACTION_REVIEW_RESOURCE_MAX_CHARS,
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
    ["bidi override", "src/visible\u202Espoof.ts"],
    ["zero-width character", "src/visible\u200Bspoof.ts"],
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

describe("C2 approval path member admission", () => {
  it("refuses a numeric path skipped by a caller-owned iterator", () => {
    const paths: unknown[] = [42];
    Object.defineProperty(paths, "forEach", { value: (): void => undefined });
    expect(
      validateCodingWorkbenchRuntimeApprovalReviewChannelPayload(activeReview({ paths })).ok,
    ).toBe(false);
  });
  it("retains canonical path and channel references", () => {
    const value = activeReview();
    const result = validateCodingWorkbenchRuntimeApprovalReviewChannelPayload(value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(value);
  });
});

describe("native action review (#3897)", () => {
  it("accepts a native action with or without contained paths", () => {
    expect(
      errorsFor({
        session: "active",
        pending: {
          requestId: "permission-1",
          nativeAction: { permission: "shell", resources: ["npm test"] },
          paths: [],
          pathsTruncated: false,
          fileCount: 0,
          addedLines: 0,
          deletedLines: 0,
        },
      }),
    ).toEqual([]);
    expect(
      errorsFor({
        session: "active",
        pending: {
          requestId: "permission-2",
          nativeAction: { permission: "edit", resources: ["src/a.ts"] },
          paths: ["src/a.ts"],
          pathsTruncated: false,
          fileCount: 1,
          addedLines: 0,
          deletedLines: 0,
        },
      }),
    ).toEqual([]);
  });

  it("rejects an unbounded, malformed or authority-bearing native action", () => {
    const base = {
      requestId: "permission-1",
      paths: [],
      pathsTruncated: false,
      fileCount: 0,
      addedLines: 0,
      deletedLines: 0,
    };
    for (const nativeAction of [
      "shell",
      { permission: "shell" },
      { permission: "shell", resources: ["x"], extra: 1 },
      { permission: "not a permission", resources: [] },
      { permission: "shell", resources: Array.from({ length: 65 }, () => "x") },
      { permission: "shell", resources: ["x".repeat(2049)] },
      { permission: "shell", resources: [1] },
    ]) {
      expect(errorsFor({ session: "active", pending: { ...base, nativeAction } })).not.toEqual([]);
    }
    expect(
      errorsFor({
        session: "active",
        pending: {
          ...base,
          nativeAction: { permission: "shell", resources: ["npm test"] },
          verifiedCommit: { result: {}, message: "x" },
        },
      }),
    ).not.toEqual([]);
  });
});

describe("native action review boundaries (#3897)", () => {
  const NATIVE_RESOURCES_ERROR = "nativeAction.resources must be a bounded array of display text";
  const NATIVE_PERMISSION_ERROR = "nativeAction.permission must be a bounded safe identifier";

  /** A pending review for a non-edit native action: no contained paths, no changeset counts. */
  function nativeReview(
    nativeAction: unknown,
    overrides: Readonly<Record<string, unknown>> = {},
  ): Readonly<Record<string, unknown>> {
    return activeReview({
      nativeAction,
      paths: [],
      fileCount: 0,
      addedLines: 0,
      deletedLines: 0,
      ...overrides,
    });
  }

  function shellAction(
    overrides: Readonly<Record<string, unknown>> = {},
  ): Readonly<Record<string, unknown>> {
    return { permission: "shell", resources: ["npm test"], ...overrides };
  }

  it("accepts a command review with no contained paths, which a plain edit review forbids", () => {
    expect(errorsFor(nativeReview(shellAction()))).toEqual([]);
    expect(errorsFor(activeReview({ paths: [], fileCount: 0 }))).toContain(
      "pendingApprovalReview.paths must be a non-empty array",
    );
  });

  it("accepts an action that names no resource", () => {
    expect(errorsFor(nativeReview(shellAction({ resources: [] })))).toEqual([]);
  });

  it("accepts an edit ask that carries its contained paths beside the action", () => {
    const review = nativeReview(
      { permission: "edit", resources: ["src/a.ts", "src/b.ts"] },
      { paths: ["src/a.ts", "src/b.ts"], fileCount: 2, addedLines: 4, deletedLines: 2 },
    );
    expect(errorsFor(review)).toEqual([]);
  });

  it("accepts a truncated path list whose declared file count exceeds what it carries", () => {
    const review = nativeReview(
      { permission: "edit", resources: ["src/a.ts"] },
      { paths: ["src/a.ts"], pathsTruncated: true, fileCount: 7 },
    );
    expect(errorsFor(review)).toEqual([]);
  });

  it("still checks the shared counts and truncation flag of a native review", () => {
    expect(errorsFor(nativeReview(shellAction(), { fileCount: 3 }))).toContain(
      "pendingApprovalReview.fileCount must match the carried path list",
    );
    expect(errorsFor(nativeReview(shellAction(), { pathsTruncated: "no" }))).toContain(
      "pendingApprovalReview.pathsTruncated must be a boolean",
    );
    expect(errorsFor(nativeReview(shellAction(), { addedLines: -1 }))).toContain(
      "pendingApprovalReview.addedLines must be a bounded non-negative integer",
    );
  });

  it.each([
    ["a string", "shell"],
    ["null", null],
    ["an array", ["shell", ["npm test"]]],
    ["a number", 1],
  ])("rejects a native action that is %s", (_label, nativeAction) => {
    expect(errorsFor(nativeReview(nativeAction))).toEqual(["nativeAction must be an object"]);
  });

  it("names an unknown key of the native action", () => {
    expect(errorsFor(nativeReview(shellAction({ command: "rm -rf /" })))).toContain(
      "nativeAction.command is not allowed",
    );
  });

  it("accepts a permission of 64 characters and rejects one of 65", () => {
    const atLimit = `p${"a".repeat(63)}`;
    expect(errorsFor(nativeReview(shellAction({ permission: atLimit })))).toEqual([]);
    expect(errorsFor(nativeReview(shellAction({ permission: `${atLimit}a` })))).toEqual([
      NATIVE_PERMISSION_ERROR,
    ]);
  });

  it("keeps the complete bounded MCP tool identity in the private action review", () => {
    const permission = mcpToolAction("s".repeat(64), "t".repeat(128));
    expect(errorsFor(nativeReview(shellAction({ permission })))).toEqual([]);
    expect(errorsFor(nativeReview(shellAction({ permission: `${permission}x` })))).toEqual([
      NATIVE_PERMISSION_ERROR,
    ]);
    expect(errorsFor(nativeReview(shellAction({ permission: `${"s".repeat(65)}_tool` })))).toEqual([
      NATIVE_PERMISSION_ERROR,
    ]);
  });

  it.each([
    ["absent", undefined],
    ["a number", 1],
    ["empty", ""],
    ["starting with a separator", "-shell"],
    ["containing a space", "not a permission"],
    ["containing a slash", "tool/shell"],
    ["containing markup", "<b>shell</b>"],
  ])("rejects a permission that is %s", (_label, permission) => {
    expect(errorsFor(nativeReview(shellAction({ permission })))).toEqual([NATIVE_PERMISSION_ERROR]);
  });

  it("accepts the maximum number of resources and rejects one more", () => {
    const resources = (count: number): string[] =>
      Array.from({ length: count }, (_unused, index) => `src/f${String(index)}.ts`);
    const max = CODING_WORKBENCH_NATIVE_ACTION_REVIEW_MAX_RESOURCES;
    expect(errorsFor(nativeReview(shellAction({ resources: resources(max) })))).toEqual([]);
    expect(errorsFor(nativeReview(shellAction({ resources: resources(max + 1) })))).toEqual([
      NATIVE_RESOURCES_ERROR,
    ]);
  });

  it("accepts a resource of the maximum length, and an empty one, and rejects one more character", () => {
    const max = CODING_WORKBENCH_NATIVE_ACTION_REVIEW_RESOURCE_MAX_CHARS;
    expect(errorsFor(nativeReview(shellAction({ resources: ["x".repeat(max), ""] })))).toEqual([]);
    expect(errorsFor(nativeReview(shellAction({ resources: ["x".repeat(max + 1)] })))).toEqual([
      NATIVE_RESOURCES_ERROR,
    ]);
  });

  it("keeps a multi-line command reviewable but refuses text that can spoof the display", () => {
    expect(
      errorsFor(nativeReview(shellAction({ resources: ["npm test\n\tnpm run lint"] }))),
    ).toEqual([]);
    for (const spoof of [
      "rm\u202E -rf",
      "ok\u200Bnot",
      "nul\0byte",
      "bell\u0007",
      "line\u2028sep",
    ]) {
      expect(errorsFor(nativeReview(shellAction({ resources: ["npm test", spoof] })))).toEqual([
        NATIVE_RESOURCES_ERROR,
      ]);
    }
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["a string", "npm test"],
    ["an object", { 0: "npm test" }],
    ["an array holding a number", ["npm test", 1]],
    ["an array holding null", [null]],
    ["an array holding an object", [{ command: "npm test" }]],
  ])("rejects resources that are %s", (_label, resources) => {
    expect(errorsFor(nativeReview(shellAction({ resources })))).toEqual([NATIVE_RESOURCES_ERROR]);
  });

  it.each([
    ["a delivery review", { draftDelivery: {} }],
    ["a verified commit", { verifiedCommit: { result: {}, message: "x" } }],
  ])("refuses a native action that also carries %s", (_label, authority) => {
    expect(errorsFor(nativeReview(shellAction(), authority))).toContain(
      "a native action review cannot carry delivery or commit authority",
    );
  });

  it("routes a review without a native action but with a delivery draft to delivery validation", () => {
    const errors = errorsFor(activeReview({ draftDelivery: {} }));
    expect(errors).toContain("draftDelivery must match the exact pending proposal");
    expect(errors).toContain("delivery review must not claim workspace edit counts");
    expect(errors).not.toContain(
      "a native action review cannot carry delivery or commit authority",
    );
  });

  it("rejects a native review whose path list is missing or not an array", () => {
    const { paths: _dropped, ...withoutPaths } = (
      nativeReview(shellAction()) as { readonly pending: Record<string, unknown> }
    ).pending;
    expect(errorsFor({ session: "active", pending: withoutPaths })).toContain(
      "pendingApprovalReview.paths must be an array",
    );
    expect(errorsFor(nativeReview(shellAction(), { paths: "src/a.ts" }))).toContain(
      "pendingApprovalReview.paths must be an array",
    );
    expect(errorsFor(nativeReview(shellAction(), { paths: null }))).toContain(
      "pendingApprovalReview.paths must be an array",
    );
  });

  it("holds the contained paths of a native review to the shared path rules", () => {
    const invalid = nativeReview(
      { permission: "edit", resources: ["../outside.ts"] },
      { paths: ["../outside.ts"], fileCount: 1 },
    );
    expect(errorsFor(invalid)).toContain(
      "pendingApprovalReview.paths[0] is not a contained relative path",
    );
    const duplicated = nativeReview(shellAction(), {
      paths: ["src/a.ts", "src/a.ts"],
      fileCount: 2,
    });
    expect(errorsFor(duplicated)).toContain("pendingApprovalReview.paths must be unique");
    const tooMany = Array.from(
      { length: CODING_WORKBENCH_APPROVAL_REVIEW_MAX_PATHS + 1 },
      (_value, index) => `src/f${String(index)}.ts`,
    );
    expect(
      errorsFor(nativeReview(shellAction(), { paths: tooMany, fileCount: tooMany.length })),
    ).toContain("pendingApprovalReview.paths exceeds the reviewable path cap");
  });
});
