import { describe, expect, it } from "vitest";

import {
  evaluateWaiverScope,
  readSuppressedIds,
  shippedAdvisoryIds,
} from "../check-osv-waiver-scope.mjs";

const TOML = `# comment
[[IgnoredVulns]]
id = "GHSA-aaaa-bbbb-cccc"
ignoreUntil = 2026-10-25T00:00:00Z
reason = """
not shipped
"""

[[IgnoredVulns]]
id = "GHSA-dddd-eeee-ffff"
reason = "second"

[SomeOtherSection]
id = "GHSA-not-a-waiver"
`;

function auditReport(ids) {
  return JSON.stringify({
    vulnerabilities: Object.fromEntries(
      ids.map((id, index) => [
        `pkg-${String(index)}`,
        { via: [{ url: `https://github.com/advisories/${id}`, title: "x" }] },
      ]),
    ),
  });
}

describe("readSuppressedIds", () => {
  it("collects every id inside IgnoredVulns blocks", () => {
    expect(readSuppressedIds(TOML)).toEqual(["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"]);
  });

  it("ignores ids in other sections", () => {
    expect(readSuppressedIds(TOML)).not.toContain("GHSA-not-a-waiver");
  });

  it("returns nothing for a config without waivers", () => {
    expect(readSuppressedIds("# nothing here\n")).toEqual([]);
  });
});

describe("shippedAdvisoryIds", () => {
  it("extracts advisory ids from the npm audit report", () => {
    expect(shippedAdvisoryIds(auditReport(["GHSA-1111-2222-3333"]))).toEqual(
      new Set(["GHSA-1111-2222-3333"]),
    );
  });

  it("treats an empty report as no shipped advisories", () => {
    expect(shippedAdvisoryIds(JSON.stringify({}))).toEqual(new Set());
  });

  it("skips string via entries without inventing an id", () => {
    const report = JSON.stringify({ vulnerabilities: { a: { via: ["some-package"] } } });
    expect(shippedAdvisoryIds(report)).toEqual(new Set());
  });
});

describe("evaluateWaiverScope", () => {
  it("passes when no suppressed advisory reaches the shipped graph", () => {
    const shipped = shippedAdvisoryIds(auditReport(["GHSA-9999-9999-9999"]));
    expect(evaluateWaiverScope(readSuppressedIds(TOML), shipped)).toEqual([]);
  });

  // The whole point of the gate: an ID-wide suppression must not keep hiding the advisory once it
  // appears in something Keiko actually ships.
  it("fails when a suppressed advisory reaches a shipped dependency", () => {
    const shipped = shippedAdvisoryIds(auditReport(["GHSA-aaaa-bbbb-cccc"]));
    expect(evaluateWaiverScope(readSuppressedIds(TOML), shipped)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
  });

  it("reports every violating suppression, not just the first", () => {
    const shipped = shippedAdvisoryIds(auditReport(["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"]));
    expect(evaluateWaiverScope(readSuppressedIds(TOML), shipped)).toHaveLength(2);
  });
});
