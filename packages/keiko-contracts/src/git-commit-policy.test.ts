// Behavioral tests for git-commit-policy.ts (Issue #475, Epic #470). Covers every violation code
// (produced AND absent), the default policy accepting a real conventional message, the cardinality
// pin, the issue-key rule (enabled/disabled/empty-pattern), the sign-off trailer, subject-length,
// every guard (positive AND negative), and the content-free invariant: the validation result carries
// only codes — never any fragment of the input message.

import { describe, expect, it } from "vitest";

import {
  GIT_COMMIT_MESSAGE_VIOLATION_CODES,
  GIT_COMMIT_POLICY_SCHEMA_VERSION,
  KEIKO_DEFAULT_COMMIT_MESSAGE_POLICY,
  isGitCommitMessagePolicy,
  isGitCommitMessageValidation,
  isGitCommitMessageViolationCode,
  validateGitCommitMessage,
} from "./git-commit-policy.js";
import type { GitCommitMessagePolicy, GitCommitMessageViolationCode } from "./git-commit-policy.js";

const DEFAULT = KEIKO_DEFAULT_COMMIT_MESSAGE_POLICY;

function violationsOf(
  message: string,
  policy: GitCommitMessagePolicy = DEFAULT,
): readonly string[] {
  const result = validateGitCommitMessage(message, policy);
  return result.ok ? [] : result.violations;
}

describe("git-commit-policy schema + vocabulary", () => {
  it("pins the schema version and the violation-code cardinality", () => {
    expect(GIT_COMMIT_POLICY_SCHEMA_VERSION).toBe("1");
    expect(GIT_COMMIT_MESSAGE_VIOLATION_CODES).toHaveLength(6);
    expect(new Set(GIT_COMMIT_MESSAGE_VIOLATION_CODES).size).toBe(
      GIT_COMMIT_MESSAGE_VIOLATION_CODES.length,
    );
    const expected: readonly GitCommitMessageViolationCode[] = [
      "empty-subject",
      "missing-conventional-prefix",
      "disallowed-type",
      "subject-too-long",
      "missing-issue-key",
      "missing-signoff",
    ];
    expect([...GIT_COMMIT_MESSAGE_VIOLATION_CODES]).toEqual([...expected]);
  });
});

describe("validateGitCommitMessage default-policy acceptance", () => {
  it("accepts a real conventional message", () => {
    const result = validateGitCommitMessage("feat(ui): add governed flow", DEFAULT);
    expect(result.ok).toBe(true);
  });

  it("accepts a bang-breaking type and a no-scope type", () => {
    expect(validateGitCommitMessage("fix!: drop legacy field", DEFAULT).ok).toBe(true);
    expect(validateGitCommitMessage("chore: bump deps", DEFAULT).ok).toBe(true);
  });
});

describe("validateGitCommitMessage per-violation cases", () => {
  it("empty-subject for an empty or whitespace-only first line", () => {
    expect(violationsOf("")).toEqual(["empty-subject"]);
    expect(violationsOf("   \n\nbody")).toEqual(["empty-subject"]);
  });

  it("missing-conventional-prefix when there is no type: prefix", () => {
    expect(violationsOf("just a plain subject")).toContain("missing-conventional-prefix");
    expect(violationsOf("just a plain subject")).not.toContain("disallowed-type");
  });

  it("disallowed-type when the type is not in the allow-list", () => {
    const v = violationsOf("wip(ui): work in progress");
    expect(v).toContain("disallowed-type");
    expect(v).not.toContain("missing-conventional-prefix");
  });

  it("subject-too-long when the subject exceeds the ceiling", () => {
    const longSubject = `feat(ui): ${"x".repeat(80)}`;
    expect(violationsOf(longSubject)).toContain("subject-too-long");
    // A 72-char subject (the ceiling) is accepted; 73 is rejected.
    const atCeiling = `feat: ${"x".repeat(66)}`; // "feat: " = 6 chars + 66 = 72
    expect(atCeiling.length).toBe(72);
    expect(violationsOf(atCeiling)).not.toContain("subject-too-long");
    expect(violationsOf(`${atCeiling}x`)).toContain("subject-too-long");
  });

  it("missing-issue-key only when the issue-key rule is enabled with a pattern", () => {
    const policy: GitCommitMessagePolicy = {
      ...DEFAULT,
      requireIssueKey: { enabled: true, pattern: "#\\d+" },
    };
    expect(violationsOf("feat(ui): add flow", policy)).toContain("missing-issue-key");
    expect(violationsOf("feat(ui): add flow\n\nRefs #475", policy)).not.toContain(
      "missing-issue-key",
    );
    // Disabled rule, or enabled-but-empty pattern → never produced.
    expect(violationsOf("feat(ui): add flow", DEFAULT)).not.toContain("missing-issue-key");
    const emptyPattern: GitCommitMessagePolicy = {
      ...DEFAULT,
      requireIssueKey: { enabled: true, pattern: "" },
    };
    expect(violationsOf("feat(ui): add flow", emptyPattern)).not.toContain("missing-issue-key");
  });

  it("stays total and fails closed when an enabled issue-key pattern is not a valid regex", () => {
    const brokenPattern: GitCommitMessagePolicy = {
      ...DEFAULT,
      requireIssueKey: { enabled: true, pattern: "[unterminated(" },
    };
    // A pure validator must never throw on a well-typed input; an unparseable enabled pattern blocks.
    expect(() => validateGitCommitMessage("feat(ui): add flow #475", brokenPattern)).not.toThrow();
    expect(violationsOf("feat(ui): add flow #475", brokenPattern)).toContain("missing-issue-key");
  });

  it("missing-signoff only when sign-off is required", () => {
    const policy: GitCommitMessagePolicy = { ...DEFAULT, requireSignoff: true };
    expect(violationsOf("feat(ui): add flow", policy)).toContain("missing-signoff");
    expect(
      violationsOf("feat(ui): add flow\n\nSigned-off-by: Dev <dev@example.com>", policy),
    ).not.toContain("missing-signoff");
    expect(violationsOf("feat(ui): add flow", DEFAULT)).not.toContain("missing-signoff");
  });

  it("collects multiple independent violations in one pass", () => {
    const policy: GitCommitMessagePolicy = {
      ...DEFAULT,
      requireSignoff: true,
      requireIssueKey: { enabled: true, pattern: "#\\d+" },
    };
    const v = violationsOf("nope just words", policy);
    expect(v).toContain("missing-conventional-prefix");
    expect(v).toContain("missing-issue-key");
    expect(v).toContain("missing-signoff");
  });

  it("returns ONLY codes — no fragment of the message is retained", () => {
    const secretish = "feat(ui): TOKEN-abc123-LEAK should never appear";
    const tooLong = `${secretish} ${"y".repeat(80)}`;
    const result = validateGitCommitMessage(tooLong, DEFAULT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const code of result.violations) {
        expect(GIT_COMMIT_MESSAGE_VIOLATION_CODES).toContain(code);
      }
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("TOKEN-abc123-LEAK");
      expect(serialized).not.toContain("yyyy");
    }
  });
});

describe("git-commit-policy guards", () => {
  it("isGitCommitMessageViolationCode accepts known codes and rejects others", () => {
    expect(isGitCommitMessageViolationCode("empty-subject")).toBe(true);
    expect(isGitCommitMessageViolationCode("missing-signoff")).toBe(true);
    expect(isGitCommitMessageViolationCode("nonsense")).toBe(false);
    expect(isGitCommitMessageViolationCode(7)).toBe(false);
  });

  it("isGitCommitMessagePolicy round-trips the default and rejects malformed shapes", () => {
    expect(isGitCommitMessagePolicy(DEFAULT)).toBe(true);
    expect(isGitCommitMessagePolicy({ ...DEFAULT, subjectMaxLength: -1 })).toBe(false);
    expect(isGitCommitMessagePolicy({ ...DEFAULT, conventionalCommit: { enabled: true } })).toBe(
      false,
    );
    expect(isGitCommitMessagePolicy({ ...DEFAULT, requireIssueKey: { enabled: true } })).toBe(
      false,
    );
    expect(isGitCommitMessagePolicy(null)).toBe(false);
  });

  it("isGitCommitMessageValidation round-trips both discriminants", () => {
    expect(isGitCommitMessageValidation({ ok: true })).toBe(true);
    expect(isGitCommitMessageValidation({ ok: false, violations: ["empty-subject"] })).toBe(true);
    expect(isGitCommitMessageValidation({ ok: false, violations: ["bogus"] })).toBe(false);
    expect(isGitCommitMessageValidation({ ok: false })).toBe(false);
    expect(isGitCommitMessageValidation({ ok: "maybe" })).toBe(false);
    expect(isGitCommitMessageValidation(null)).toBe(false);
  });

  it("round-trips a real validator result through its guard", () => {
    expect(isGitCommitMessageValidation(validateGitCommitMessage("feat(ui): ok", DEFAULT))).toBe(
      true,
    );
    expect(isGitCommitMessageValidation(validateGitCommitMessage("nope", DEFAULT))).toBe(true);
  });
});
