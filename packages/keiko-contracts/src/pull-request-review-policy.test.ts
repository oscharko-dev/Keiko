// The operator review configuration and the review settings contracts (Issue #4137): every
// invalid explicit value is a closed issue that fails the policy closed, never a thrown load error
// and never a silently substituted default.

import { describe, expect, it } from "vitest";

import { REVIEW_OPERATOR_ENV_VARIABLES } from "./pull-request-review.js";
import {
  isReviewRulesFilePath,
  parseReviewOperatorConfig,
  validateReviewPairQualificationStartRequest,
  validateReviewSettingsDocument,
  validateReviewSettingsUpdateRequest,
} from "./pull-request-review-validation.js";

describe("parseReviewOperatorConfig", () => {
  it("defaults to a disabled, unlocked, unrestricted area without a section", () => {
    expect(parseReviewOperatorConfig(undefined)).toEqual({
      enabled: false,
      lockModelPolicy: false,
      repositories: {},
      issues: [],
    });
  });

  it("parses a complete section", () => {
    const parsed = parseReviewOperatorConfig({
      enabled: true,
      reviewerModelId: "model-a",
      counterCheckerModelId: "model-b",
      allowedReviewModelIds: ["model-a", "model-b"],
      lockModelPolicy: true,
      rulesFilePath: "docs/review-rules.md",
      repositories: { repo_0123456789abcdef: { rulesFilePath: ".keiko/rules.md" } },
    });
    expect(parsed).toEqual({
      enabled: true,
      reviewerModelId: "model-a",
      counterCheckerModelId: "model-b",
      allowedReviewModelIds: ["model-a", "model-b"],
      lockModelPolicy: true,
      rulesFilePath: "docs/review-rules.md",
      repositories: { repo_0123456789abcdef: { rulesFilePath: ".keiko/rules.md" } },
      issues: [],
    });
  });

  it("lets a set environment variable win over the file value", () => {
    const parsed = parseReviewOperatorConfig(
      { enabled: false, reviewerModelId: "model-a" },
      {
        [REVIEW_OPERATOR_ENV_VARIABLES.enabled]: "true",
        [REVIEW_OPERATOR_ENV_VARIABLES.reviewerModelId]: "model-c",
        [REVIEW_OPERATOR_ENV_VARIABLES.allowedReviewModelIds]: "model-c, model-d",
        [REVIEW_OPERATOR_ENV_VARIABLES.lockModelPolicy]: "  ",
      },
    );
    expect(parsed.enabled).toBe(true);
    expect(parsed.reviewerModelId).toBe("model-c");
    expect(parsed.allowedReviewModelIds).toEqual(["model-c", "model-d"]);
    expect(parsed.lockModelPolicy).toBe(false);
    expect(parsed.issues).toEqual([]);
  });

  it.each([
    [{ enabled: "yes" }, "enabled", "file"],
    [{ reviewerModelId: "" }, "reviewerModelId", "file"],
    [{ counterCheckerModelId: 7 }, "counterCheckerModelId", "file"],
    [{ allowedReviewModelIds: [] }, "allowedReviewModelIds", "file"],
    [{ allowedReviewModelIds: ["a", "a"] }, "allowedReviewModelIds", "file"],
    [{ lockModelPolicy: 1 }, "lockModelPolicy", "file"],
    [{ rulesFilePath: "../outside.md" }, "rulesFilePath", "file"],
    [{ rulesFilePath: "/etc/rules.md" }, "rulesFilePath", "file"],
    [{ repositories: { "bad id": {} } }, "repositories", "file"],
    [{ repositories: { repo_1: { rulesFilePath: "a/../b" } } }, "repositories", "file"],
    [{ allowedModelIds: ["a"] }, "review", "file"],
  ] as const)("refuses %j as an invalid %s value", (section, key, source) => {
    const parsed = parseReviewOperatorConfig(section);
    expect(parsed.issues).toContainEqual({ key, source });
  });

  it("refuses a default outside the allowlist without substituting another model", () => {
    const parsed = parseReviewOperatorConfig({
      reviewerModelId: "model-z",
      allowedReviewModelIds: ["model-a"],
    });
    expect(parsed.reviewerModelId).toBeUndefined();
    expect(parsed.issues).toEqual([{ key: "reviewerModelId", source: "file" }]);
  });

  it("reads an invalid switch as its strict value and names the environment source", () => {
    const parsed = parseReviewOperatorConfig(undefined, {
      [REVIEW_OPERATOR_ENV_VARIABLES.enabled]: "on",
      [REVIEW_OPERATOR_ENV_VARIABLES.lockModelPolicy]: "maybe",
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.lockModelPolicy).toBe(true);
    expect(parsed.issues).toEqual([
      { key: "enabled", source: "environment" },
      { key: "lockModelPolicy", source: "environment" },
    ]);
  });

  it("refuses a section that is not an object", () => {
    expect(parseReviewOperatorConfig("on").issues).toEqual([{ key: "review", source: "file" }]);
  });
});

describe("isReviewRulesFilePath", () => {
  it.each([".keiko/review-rules.md", "docs/rules/review.md", "REVIEW.md"])("admits %s", (path) => {
    expect(isReviewRulesFilePath(path)).toBe(true);
  });

  it.each([
    "",
    "../rules.md",
    "docs/../rules.md",
    "./rules.md",
    "/abs/rules.md",
    "C:/rules.md",
    "~/rules.md",
    "docs\\rules.md",
    "docs//rules.md",
    "rules\u0000.md",
    "rules\u202e.md",
    7,
  ])("refuses %j", (path) => {
    expect(isReviewRulesFilePath(path)).toBe(false);
  });
});

describe("review settings wire validation", () => {
  it("accepts a partial update, clears with null and refuses unknown keys", () => {
    expect(validateReviewSettingsUpdateRequest({ reviewerModelId: null }).ok).toBe(true);
    expect(
      validateReviewSettingsUpdateRequest({
        expectedRevision: 3,
        counterCheckerModelId: "model-b",
        rulesFilePath: "docs/rules.md",
      }).ok,
    ).toBe(true);
    const unknown = validateReviewSettingsUpdateRequest({ lockModelPolicy: false });
    expect(unknown.ok ? [] : unknown.issues).toEqual([
      { code: "unknown-field", path: "lockModelPolicy" },
    ]);
  });

  it("names the rules path and the revision when they are invalid", () => {
    const result = validateReviewSettingsUpdateRequest({
      rulesFilePath: "../x.md",
      expectedRevision: -1,
    });
    expect(result.ok ? [] : result.issues).toEqual([
      { code: "invalid-number", path: "expectedRevision" },
      { code: "invalid-path", path: "rulesFilePath" },
    ]);
  });

  it("trusts a stored document only when it validates", () => {
    const stored = {
      schemaVersion: 1,
      repositoryId: "repo_0123456789abcdef",
      revision: 2,
      reviewerModelId: "model-a",
      updatedAt: "2026-10-31T00:00:00.000Z",
    };
    expect(validateReviewSettingsDocument(stored).ok).toBe(true);
    expect(validateReviewSettingsDocument({ ...stored, revision: 0 }).ok).toBe(false);
    expect(validateReviewSettingsDocument({ ...stored, schemaVersion: 2 }).ok).toBe(false);
    expect(validateReviewSettingsDocument({ ...stored, rulesFilePath: "../x" }).ok).toBe(false);
  });

  it("closes the pair qualification start request", () => {
    expect(
      validateReviewPairQualificationStartRequest({
        reviewerModelId: "model-a",
        counterCheckerModelId: "model-b",
      }).ok,
    ).toBe(true);
    expect(
      validateReviewPairQualificationStartRequest({
        reviewerModelId: "model-a",
        counterCheckerModelId: "model-b",
        swapRoles: true,
      }).ok,
    ).toBe(false);
  });
});
