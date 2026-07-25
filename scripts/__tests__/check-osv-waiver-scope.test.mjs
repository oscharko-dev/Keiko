import { describe, expect, it } from "vitest";

import { main } from "../check-osv-waiver-scope.mjs";
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

  // An EMPTY map is the legitimate "nothing found" answer; a MISSING map means the output was not
  // an audit report at all, and must not be read as an all-clear.
  it("treats an empty vulnerabilities map as no shipped advisories", () => {
    expect(shippedAdvisoryIds(JSON.stringify({ vulnerabilities: {} }))).toEqual(new Set());
  });

  it("refuses a report with no vulnerabilities map at all", () => {
    expect(() => shippedAdvisoryIds(JSON.stringify({}))).toThrow();
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

describe("readSuppressedIds — TOML shapes the hand-written reader must not miss", () => {
  it("reads a literal-string id", () => {
    expect(readSuppressedIds("[[IgnoredVulns]]\nid = 'GHSA-single-quoted'\n")).toEqual([
      "GHSA-single-quoted",
    ]);
  });

  it("reads an id carrying a trailing inline comment", () => {
    expect(readSuppressedIds('[[IgnoredVulns]]\nid = "GHSA-with-comment" # why\n')).toEqual([
      "GHSA-with-comment",
    ]);
  });

  it("ignores a section header written with an inline comment", () => {
    const toml =
      '[[IgnoredVulns]] # first\nid = "GHSA-aaa"\n[Other] # not a waiver\nid = "GHSA-bbb"\n';
    expect(readSuppressedIds(toml)).toEqual(["GHSA-aaa"]);
  });

  // A reason block can contain anything, including lines that look like TOML structure.
  it("never parses inside a multi-line reason block", () => {
    const toml = [
      "[[IgnoredVulns]]",
      'id = "GHSA-real"',
      'reason = """',
      "[[IgnoredVulns]]",
      'id = "GHSA-not-a-real-waiver"',
      '"""',
      "",
    ].join("\n");
    expect(readSuppressedIds(toml)).toEqual(["GHSA-real"]);
  });

  // The alternative — dropping it — would leave a suppression this gate never validates.
  it("fails closed on an id syntax it cannot decode", () => {
    expect(() => readSuppressedIds("[[IgnoredVulns]]\nid = { value = 'x' }\n")).toThrow(
      /unsupported id syntax/u,
    );
  });
});

describe("shippedAdvisoryIds — malformed audit output must not read as 'nothing shipped'", () => {
  it.each([
    ["a JSON array", "[]"],
    ["a JSON primitive", '"nope"'],
    ["JSON null", "null"],
    ["an object without a vulnerabilities map", '{"metadata":{}}'],
    ["a null vulnerabilities map", '{"vulnerabilities":null}'],
  ])("throws on %s", (_label, payload) => {
    expect(() => shippedAdvisoryIds(payload)).toThrow();
  });

  it("tolerates a malformed single advisory without losing the rest", () => {
    const report = JSON.stringify({
      vulnerabilities: {
        broken: null,
        alsoBroken: { via: "not-an-array" },
        good: { via: [{ url: "https://github.com/advisories/GHSA-good" }] },
      },
    });
    expect(shippedAdvisoryIds(report)).toEqual(new Set(["GHSA-good"]));
  });
});

// The gate's decision paths, driven through the exported entry point. Each one is a distinct answer
// the gate can give, and each one is the answer a real osv-scanner.toml can force.
describe("the waiver-scope gate decision", () => {
  const logs = [];
  const errors = [];
  const capture = {
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  };

  function run(overrides) {
    logs.length = 0;
    errors.length = 0;
    const exits = [];
    const original = { error: console.error, log: console.log };
    console.log = capture.log;
    console.error = capture.error;
    try {
      main({ exit: (code) => exits.push(code), ...overrides });
    } finally {
      console.log = original.log;
      console.error = original.error;
    }
    return { errors: [...errors], exits, logs: [...logs] };
  }

  it("passes when no configuration file exists", () => {
    const result = run({ configExists: () => false });
    expect(result.exits).toEqual([]);
    expect(result.logs.join("\n")).toContain("no osv-scanner.toml");
  });

  it("passes when the configuration records no suppression", () => {
    const result = run({ configExists: () => true, readConfig: () => "# nothing here\n" });
    expect(result.exits).toEqual([]);
    expect(result.logs.join("\n")).toContain("no suppressions recorded");
  });

  it("passes when a suppression covers only build-time dependencies", () => {
    const result = run({
      configExists: () => true,
      readConfig: () => '[[IgnoredVulns]]\nid = "GHSA-build-only"\n',
      runAudit: () => JSON.stringify({ vulnerabilities: {} }),
    });
    expect(result.exits).toEqual([]);
    expect(result.logs.join("\n")).toContain("1 suppression(s), none reaching the shipped graph");
  });

  it("fails when a suppression reaches the shipped graph", () => {
    const result = run({
      configExists: () => true,
      readConfig: () => '[[IgnoredVulns]]\nid = "GHSA-shipped"\n',
      runAudit: () =>
        JSON.stringify({
          vulnerabilities: {
            "some-package": {
              via: [{ source: 1, url: "https://github.com/advisories/GHSA-shipped" }],
            },
          },
        }),
    });
    expect(result.exits).toEqual([1]);
    expect(result.errors.join("\n")).toContain("GHSA-shipped is suppressed");
    expect(result.errors.join("\n")).toContain("reaches a SHIPPED");
  });
});
