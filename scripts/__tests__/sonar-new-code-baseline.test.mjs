import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const baseline = JSON.parse(
  readFileSync(resolve(root, "docs/qa/sonarcloud-new-code-baseline-2026-07-13.json"), "utf8"),
);

function countsBy(items, key) {
  return Object.fromEntries(
    Object.entries(Object.groupBy(items, (item) => item[key])).map(([value, group]) => [
      value,
      group.length,
    ]),
  );
}

describe("Sonar new-code remediation baseline", () => {
  it("pins the exact pre-scope analysis identity and leak-period mode", () => {
    expect(baseline.newCodeDefinition).toBe("previous_version");
    expect(baseline.analysis).toEqual({
      date: "2026-07-13T07:28:16+0000",
      key: "9b60e076-5b5c-401a-aec6-bc5c2da0bc72",
      revision: "a5c7157e5a59e55bb6c9acd98b549f48271a3783",
      version: "0.2.15",
    });
    expect(baseline.sourceSnapshotSha256).toBe(
      "78eff24e3920e6a9814523712cef4d857fb11cf31df140b1eb607ad7e823a0e1",
    );
  });

  it("pins all 102 unique finding keys and their ordered remediation families", () => {
    expect(baseline.totals).toEqual({ all: 102, bugs: 13, codeSmells: 83, vulnerabilities: 6 });
    expect(baseline.issues).toHaveLength(102);
    expect(new Set(baseline.issues.map((issue) => issue.key)).size).toBe(102);
    expect(countsBy(baseline.issues, "type")).toEqual({
      BUG: 13,
      CODE_SMELL: 83,
      VULNERABILITY: 6,
    });
    expect(countsBy(baseline.issues, "rule")).toMatchObject({
      "javascript:S2871": 7,
      "shell:S5332": 5,
      "typescript:S1874": 28,
      "typescript:S6582": 30,
      "typescript:S6606": 8,
      "typescript:S7755": 8,
    });
  });
});
