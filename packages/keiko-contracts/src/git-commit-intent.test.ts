// Behavioral tests for git-commit-intent.ts (Issue #475, Epic #470). Covers every quality-warning
// code (produced AND absent), the deterministic suggestion heuristics (dominant scope, tests/docs
// type, subject-prefix scaffold), the threshold override, the cardinality pin, and every guard
// (positive AND negative). The analyzer is pure and deterministic — no model call.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LARGE_CHANGE_THRESHOLD,
  GIT_COMMIT_INTENT_SCHEMA_VERSION,
  GIT_COMMIT_QUALITY_WARNING_CODES,
  analyzeGitCommitIntent,
  isGitCommitChangeSummary,
  isGitCommitIntentAnalysis,
  isGitCommitQualityWarningCode,
} from "./git-commit-intent.js";
import type { GitCommitChangeSummary, GitCommitQualityWarningCode } from "./git-commit-intent.js";

function summary(over: Partial<GitCommitChangeSummary> = {}): GitCommitChangeSummary {
  return {
    stagedFileCount: 1,
    areaCount: 1,
    areas: ["keiko-ui"],
    touchesTests: false,
    ...over,
  };
}

describe("git-commit-intent schema + vocabulary", () => {
  it("pins the schema version, threshold default, and warning-code cardinality", () => {
    expect(GIT_COMMIT_INTENT_SCHEMA_VERSION).toBe("1");
    expect(DEFAULT_LARGE_CHANGE_THRESHOLD).toBe(20);
    expect(GIT_COMMIT_QUALITY_WARNING_CODES).toHaveLength(5);
    expect(new Set(GIT_COMMIT_QUALITY_WARNING_CODES).size).toBe(
      GIT_COMMIT_QUALITY_WARNING_CODES.length,
    );
    const expected: readonly GitCommitQualityWarningCode[] = [
      "mixed-scope",
      "wip-marker",
      "large-change",
      "empty-body",
      "non-conventional-subject",
    ];
    expect([...GIT_COMMIT_QUALITY_WARNING_CODES]).toEqual([...expected]);
  });
});

describe("analyzeGitCommitIntent warnings", () => {
  it("mixed-scope iff areaCount > 1", () => {
    const mixed = analyzeGitCommitIntent({
      summary: summary({ areaCount: 2, areas: ["keiko-ui", "keiko-server"] }),
    });
    expect(mixed.mixedScope).toBe(true);
    expect(mixed.warnings).toContain("mixed-scope");
    const single = analyzeGitCommitIntent({ summary: summary() });
    expect(single.mixedScope).toBe(false);
    expect(single.warnings).not.toContain("mixed-scope");
  });

  it("wip-marker iff the subject has a WIP token (word-bounded, case-insensitive)", () => {
    const wip = analyzeGitCommitIntent({ summary: summary(), message: "WIP: half done" });
    expect(wip.isWip).toBe(true);
    expect(wip.warnings).toContain("wip-marker");
    // "swiping" must NOT match the \bwip\b boundary.
    const noWip = analyzeGitCommitIntent({ summary: summary(), message: "feat(ui): swiping fix" });
    expect(noWip.isWip).toBe(false);
    expect(noWip.warnings).not.toContain("wip-marker");
  });

  it("large-change uses the default threshold and a per-call override", () => {
    const big = analyzeGitCommitIntent({ summary: summary({ stagedFileCount: 21 }) });
    expect(big.warnings).toContain("large-change");
    const atDefault = analyzeGitCommitIntent({ summary: summary({ stagedFileCount: 20 }) });
    expect(atDefault.warnings).not.toContain("large-change");
    const overridden = analyzeGitCommitIntent({
      summary: summary({ stagedFileCount: 5 }),
      largeChangeThreshold: 4,
    });
    expect(overridden.warnings).toContain("large-change");
  });

  it("empty-body iff a message is present with no body", () => {
    const noBody = analyzeGitCommitIntent({
      summary: summary(),
      message: "feat(ui): subject only",
    });
    expect(noBody.warnings).toContain("empty-body");
    const withBody = analyzeGitCommitIntent({
      summary: summary(),
      message: "feat(ui): subject\n\nA real body paragraph.",
    });
    expect(withBody.warnings).not.toContain("empty-body");
    // No message at all → no message-derived warnings (empty-body / non-conventional / wip absent).
    const noMessage = analyzeGitCommitIntent({ summary: summary() });
    expect(noMessage.warnings).not.toContain("empty-body");
    expect(noMessage.warnings).not.toContain("non-conventional-subject");
    expect(noMessage.warnings).not.toContain("wip-marker");
  });

  it("non-conventional-subject iff a message subject lacks a type: prefix", () => {
    const bad = analyzeGitCommitIntent({ summary: summary(), message: "added a thing" });
    expect(bad.warnings).toContain("non-conventional-subject");
    const good = analyzeGitCommitIntent({
      summary: summary(),
      message: "feat(ui): add a thing\n\nbody",
    });
    expect(good.warnings).not.toContain("non-conventional-subject");
  });
});

describe("analyzeGitCommitIntent suggestions (deterministic)", () => {
  it("suggests the dominant single area as scope and scaffolds a docs prefix", () => {
    const docs = analyzeGitCommitIntent({ summary: summary({ areas: ["docs"] }) });
    expect(docs.suggestedScope).toBe("docs");
    expect(docs.suggestedType).toBe("docs");
    expect(docs.suggestedSubjectPrefix).toBe("docs(docs): ");
  });

  it("suggests test type when the change touches tests in a single area", () => {
    const tests = analyzeGitCommitIntent({
      summary: summary({ areas: ["keiko-ui"], touchesTests: true }),
    });
    expect(tests.suggestedScope).toBe("keiko-ui");
    expect(tests.suggestedType).toBe("test");
    expect(tests.suggestedSubjectPrefix).toBe("test(keiko-ui): ");
  });

  it("omits scope/type/prefix for a mixed-scope change", () => {
    const mixed = analyzeGitCommitIntent({
      summary: summary({ areaCount: 2, areas: ["keiko-ui", "keiko-server"] }),
    });
    expect(mixed.suggestedScope).toBeUndefined();
    expect(mixed.suggestedType).toBeUndefined();
    expect(mixed.suggestedSubjectPrefix).toBeUndefined();
  });

  it("suggests a scope but no type/prefix when no type heuristic fires", () => {
    const plain = analyzeGitCommitIntent({ summary: summary({ areas: ["keiko-ui"] }) });
    expect(plain.suggestedScope).toBe("keiko-ui");
    expect(plain.suggestedType).toBeUndefined();
    expect(plain.suggestedSubjectPrefix).toBeUndefined();
  });

  it("is deterministic: identical input yields identical output", () => {
    const input = {
      summary: summary({ areas: ["docs"], touchesTests: false }),
      message: "added docs",
    };
    expect(analyzeGitCommitIntent(input)).toEqual(analyzeGitCommitIntent(input));
  });
});

describe("git-commit-intent guards", () => {
  it("isGitCommitQualityWarningCode accepts known codes and rejects others", () => {
    expect(isGitCommitQualityWarningCode("mixed-scope")).toBe(true);
    expect(isGitCommitQualityWarningCode("non-conventional-subject")).toBe(true);
    expect(isGitCommitQualityWarningCode("nope")).toBe(false);
    expect(isGitCommitQualityWarningCode(3)).toBe(false);
  });

  it("isGitCommitChangeSummary round-trips a valid summary and rejects malformed ones", () => {
    expect(isGitCommitChangeSummary(summary())).toBe(true);
    expect(isGitCommitChangeSummary({ ...summary(), stagedFileCount: -1 })).toBe(false);
    expect(isGitCommitChangeSummary({ ...summary(), areas: [1, 2] })).toBe(false);
    expect(isGitCommitChangeSummary({ ...summary(), touchesTests: "yes" })).toBe(false);
    expect(isGitCommitChangeSummary(null)).toBe(false);
  });

  it("isGitCommitIntentAnalysis round-trips analyzer output and rejects malformed ones", () => {
    expect(isGitCommitIntentAnalysis(analyzeGitCommitIntent({ summary: summary() }))).toBe(true);
    expect(
      isGitCommitIntentAnalysis(
        analyzeGitCommitIntent({ summary: summary({ areas: ["docs"] }), message: "added docs" }),
      ),
    ).toBe(true);
    expect(
      isGitCommitIntentAnalysis({ warnings: ["bogus"], mixedScope: false, isWip: false }),
    ).toBe(false);
    expect(isGitCommitIntentAnalysis({ warnings: [], mixedScope: "no", isWip: false })).toBe(false);
    expect(
      isGitCommitIntentAnalysis({
        warnings: [],
        mixedScope: false,
        isWip: false,
        suggestedType: 5,
      }),
    ).toBe(false);
    expect(isGitCommitIntentAnalysis(null)).toBe(false);
  });
});
