import { describe, expect, it } from "vitest";

import {
  evaluateRequiredChecks,
  latestCheckRunsByName,
  parseRequiredChecks,
  requiredChecksFromBranchProtection,
} from "../verify-release-required-checks.mjs";

describe("parseRequiredChecks", () => {
  it("accepts JSON, comma, and newline lists", () => {
    expect(parseRequiredChecks('["ci","ui"]')).toEqual(["ci", "ui"]);
    expect(parseRequiredChecks("ci, ui\nBuild")).toEqual(["ci", "ui", "Build"]);
  });

  it("deduplicates checks while preserving order", () => {
    expect(parseRequiredChecks('["ci","ui","ci"]')).toEqual(["ci", "ui"]);
  });
});

describe("requiredChecksFromBranchProtection", () => {
  it("reads legacy contexts and modern required check entries", () => {
    expect(
      requiredChecksFromBranchProtection({
        required_status_checks: {
          checks: [{ context: "ci" }, { context: "ui" }],
          contexts: ["actionlint", "ci"],
        },
      }),
    ).toEqual(["actionlint", "ci", "ui"]);
  });
});

describe("latestCheckRunsByName", () => {
  it("keeps the newest run for duplicate check names", () => {
    const latest = latestCheckRunsByName([
      { completed_at: "2026-06-22T08:00:00Z", id: 1, name: "ci" },
      { completed_at: "2026-06-22T08:01:00Z", id: 2, name: "ci" },
    ]);

    expect(latest.get("ci")?.id).toBe(2);
  });
});

describe("evaluateRequiredChecks", () => {
  it("passes when every required check succeeded as a check run or commit status", () => {
    const result = evaluateRequiredChecks(
      ["ci", "external/status"],
      [{ conclusion: "success", name: "ci", status: "completed" }],
      [{ context: "external/status", state: "success" }],
    );

    expect(result).toMatchObject({
      failed: [],
      missing: [],
      ok: true,
      passed: ["ci", "external/status"],
      pending: [],
    });
  });

  it("separates pending, failed, and missing checks", () => {
    const result = evaluateRequiredChecks(
      ["ci", "ui", "actionlint", "dependency-review"],
      [
        { conclusion: "success", name: "ci", status: "completed" },
        { conclusion: "failure", name: "ui", status: "completed" },
        { conclusion: null, name: "actionlint", status: "in_progress" },
      ],
      [],
    );

    expect(result.ok).toBe(false);
    expect(result.passed).toEqual(["ci"]);
    expect(result.failed).toEqual([{ name: "ui", source: "check-run", state: "failure" }]);
    expect(result.pending).toEqual([
      { name: "actionlint", source: "check-run", state: "in_progress" },
    ]);
    expect(result.missing).toEqual(["dependency-review"]);
  });
});
