import { describe, expect, it } from "vitest";

import { sseEventKeys } from "./coding-workbench-runtime-api-validation.js";

describe("coding workbench runtime SSE validation", () => {
  it("uses the closed event key set for auxiliary runtime events", () => {
    expect(sseEventKeys("runtime-event")).toContain("auxiliaryOutcome");
    expect(sseEventKeys("unknown")).not.toContain("auxiliaryOutcome");
  });
});

import { validateCodingWorkbenchIssueBinding } from "./coding-workbench-issue-binding.js";

describe("C2 issue-binding digest observation", () => {
  it("refuses a second digest admitted only through regex coercion", () => {
    const value = {
      schemaVersion: "1",
      repositoryId: "repo-1",
      issueNumber: 1,
      defaultBaseRef: "dev",
      remoteDigest: "a".repeat(64),
      issueIdDigest: "b".repeat(64),
      contentRevisionDigest: "c".repeat(64),
    };
    let reads = 0;
    Object.defineProperty(value, "bindingDigest", {
      enumerable: true,
      get: (): unknown => (++reads === 1 ? "1".repeat(64) : BigInt("1".repeat(64))),
    });
    expect(validateCodingWorkbenchIssueBinding(value).ok).toBe(false);
    expect(reads).toBe(2);
  });
});
