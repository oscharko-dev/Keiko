import { describe, expect, it } from "vitest";

import {
  evaluateRequiredChecks,
  latestCheckRunsByName,
  parseRequiredChecks,
  requiredChecksFromBranchProtection,
  resolveSkippedWithTreeEvidence,
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

// ADR-0178: an integration run may reuse the required matrix's verdict when this commit's tree is
// byte-identical to a pull-request head that matrix already proved. The reused gate then reports
// `skipped` on the release commit while its evidence binds the tree-identical head. The release
// binds a tree, not a sha, so that evidence counts — but ONLY for `skipped`, and only after the
// trees were confirmed equal. A gate that ran and FAILED here must never be rescued by it.
describe("resolveSkippedWithTreeEvidence", () => {
  const skippedResult = () => ({
    failed: [{ name: "ui", source: "check-run", state: "skipped" }],
    missing: [],
    ok: false,
    passed: ["ci"],
    pending: [],
  });
  const green = (name) => ({ name, status: "completed", conclusion: "success" });

  it("accepts a skipped check an identical tree already proved green", () => {
    const resolved = resolveSkippedWithTreeEvidence(skippedResult(), [green("ui")]);
    expect(resolved.ok).toBe(true);
    expect(resolved.failed).toEqual([]);
    expect(resolved.passed).toContain("ui");
  });

  it("never rescues a check that ran and failed on this commit", () => {
    const failed = {
      failed: [{ name: "ui", source: "check-run", state: "failure" }],
      missing: [],
      ok: false,
      passed: [],
      pending: [],
    };
    const resolved = resolveSkippedWithTreeEvidence(failed, [green("ui")]);
    expect(resolved.ok).toBe(false);
    expect(resolved.failed).toEqual(failed.failed);
  });

  it("never rescues a check the identical tree did not prove", () => {
    const resolved = resolveSkippedWithTreeEvidence(skippedResult(), [green("Core quality")]);
    expect(resolved.ok).toBe(false);
    expect(resolved.failed).toHaveLength(1);
  });

  it("ignores tree evidence that did not itself conclude success", () => {
    for (const run of [
      { name: "ui", status: "completed", conclusion: "skipped" },
      { name: "ui", status: "completed", conclusion: "failure" },
      { name: "ui", status: "in_progress", conclusion: null },
    ]) {
      expect(resolveSkippedWithTreeEvidence(skippedResult(), [run]).ok).toBe(false);
    }
  });

  it("leaves the verdict untouched when there is no tree evidence at all", () => {
    for (const evidence of [[], undefined, null]) {
      expect(resolveSkippedWithTreeEvidence(skippedResult(), evidence)).toEqual(skippedResult());
    }
  });

  it("keeps the run red while something else is still missing or pending", () => {
    const mixed = { ...skippedResult(), missing: ["workflow hygiene"] };
    const resolved = resolveSkippedWithTreeEvidence(mixed, [green("ui")]);
    expect(resolved.ok).toBe(false);
    expect(resolved.missing).toEqual(["workflow hygiene"]);
  });
});
