// Tests for fixture loading, shape validation, and materialization (ADR-0012 D3/AC#1).
// Covers: ALL_FIXTURES shape invariants, suite selection helpers, fixtureByName, and
// materializeFixture (temp dir creation + file writing + cleanup). No network or live model.

import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALL_FIXTURES,
  SUITE_NAMES,
  fixtureByName,
  fixturesForSuite,
  isSuiteName,
  EVALUATION_DIMENSIONS,
} from "../../src/evaluations/index.js";
import { materializeFixture, recordingWriter } from "../../src/evaluations/runner-support.js";
import type { EvaluationFixture } from "../../src/evaluations/types.js";
import { must } from "./_support.js";

// ─── Shape invariants for every declared fixture ────────────────────────────────

describe("ALL_FIXTURES", () => {
  it("contains exactly 6 fixtures", () => {
    expect(ALL_FIXTURES).toHaveLength(6);
  });

  it("includes 3 unit-tests fixtures and 3 bug-investigation fixtures", () => {
    const unitCount = ALL_FIXTURES.filter((f) => f.workflowKind === "unit-tests").length;
    const bugCount = ALL_FIXTURES.filter((f) => f.workflowKind === "bug-investigation").length;
    expect(unitCount).toBe(3);
    expect(bugCount).toBe(3);
  });

  it("has unique names within each workflow kind", () => {
    for (const kind of ["unit-tests", "bug-investigation"] as const) {
      const names = ALL_FIXTURES.filter((f) => f.workflowKind === kind).map((f) => f.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("every fixture has a non-empty name (kebab-case, no whitespace)", () => {
    for (const fixture of ALL_FIXTURES) {
      expect(fixture.name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("every fixture declares at least one dimension", () => {
    for (const fixture of ALL_FIXTURES) {
      expect(fixture.dimensions.size).toBeGreaterThan(0);
    }
  });

  it("every dimension declared by a fixture is a valid EvaluationDimension", () => {
    for (const fixture of ALL_FIXTURES) {
      for (const dim of fixture.dimensions) {
        expect(EVALUATION_DIMENSIONS).toContain(dim);
      }
    }
  });

  it("every fixture has a non-empty mockTranscript", () => {
    for (const fixture of ALL_FIXTURES) {
      expect(fixture.mockTranscript.length).toBeGreaterThan(0);
    }
  });

  it("every fixture's workspaceFiles has at least one entry", () => {
    for (const fixture of ALL_FIXTURES) {
      expect(Object.keys(fixture.workspaceFiles).length).toBeGreaterThan(0);
    }
  });

  it("every fixture's workspaceFiles contains a package.json", () => {
    for (const fixture of ALL_FIXTURES) {
      expect(Object.keys(fixture.workspaceFiles)).toContain("package.json");
    }
  });

  it("every fixture's oracle has non-negative maxExpectedChangedFiles and maxExpectedPatchBytes", () => {
    for (const fixture of ALL_FIXTURES) {
      expect(fixture.oracle.maxExpectedChangedFiles).toBeGreaterThanOrEqual(0);
      expect(fixture.oracle.maxExpectedPatchBytes).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── Specific expected fixtures ────────────────────────────────────────────────

describe("unit-tests fixtures", () => {
  function ut(name: string): EvaluationFixture {
    const f = ALL_FIXTURES.find((x) => x.workflowKind === "unit-tests" && x.name === name);
    if (f === undefined) throw new Error(`fixture unit-tests/${name} not found`);
    return f;
  }

  it("happy-path: apply=true, expectPatch=true, has test-pass-rate dimension", () => {
    const f = ut("happy-path");
    expect(f.apply).toBe(true);
    expect(f.oracle.expectPatch).toBe(true);
    expect(f.dimensions.has("test-pass-rate")).toBe(true);
  });

  it("unsafe-action: no apply, has unsafe-action-rejection dimension, expectPatch=false", () => {
    const f = ut("unsafe-action");
    expect(f.apply).toBeFalsy();
    expect(f.dimensions.has("unsafe-action-rejection")).toBe(true);
    expect(f.oracle.expectPatch).toBe(false);
  });

  it("unsafe-action: oracle expectedStatuses = ['rejected']", () => {
    const f = ut("unsafe-action");
    expect(f.oracle.expectedStatuses).toEqual(["rejected"]);
  });

  it("retry-then-accept: two-entry transcript (source-edit then valid diff)", () => {
    const f = ut("retry-then-accept");
    expect(f.mockTranscript).toHaveLength(2);
  });
});

describe("bug-investigation fixtures", () => {
  function bug(name: string): EvaluationFixture {
    const f = ALL_FIXTURES.find((x) => x.workflowKind === "bug-investigation" && x.name === name);
    if (f === undefined) throw new Error(`fixture bug-investigation/${name} not found`);
    return f;
  }

  it("happy-path: apply=true, expectPatch=true, has test-pass-rate dimension", () => {
    const f = bug("happy-path");
    expect(f.apply).toBe(true);
    expect(f.oracle.expectPatch).toBe(true);
    expect(f.dimensions.has("test-pass-rate")).toBe(true);
  });

  it("unsafe-action: has unsafe-action-rejection, expectPatch=false, no apply", () => {
    const f = bug("unsafe-action");
    expect(f.dimensions.has("unsafe-action-rejection")).toBe(true);
    expect(f.oracle.expectPatch).toBe(false);
    expect(f.apply).toBeFalsy();
  });

  it("investigation-only: no expectPatch, has task-completion dimension", () => {
    const f = bug("investigation-only");
    expect(f.oracle.expectPatch).toBe(false);
    expect(f.dimensions.has("task-completion")).toBe(true);
  });

  it("investigation-only: oracle expectedStatuses includes investigation-only", () => {
    const f = bug("investigation-only");
    expect(f.oracle.expectedStatuses).toContain("investigation-only");
  });
});

// ─── Suite selection helpers ─────────────────────────────────────────────────────

describe("SUITE_NAMES", () => {
  it("contains unit-tests, bug-investigation, and all", () => {
    expect(SUITE_NAMES).toContain("unit-tests");
    expect(SUITE_NAMES).toContain("bug-investigation");
    expect(SUITE_NAMES).toContain("all");
  });
});

describe("isSuiteName", () => {
  it("returns true for valid suite names", () => {
    expect(isSuiteName("unit-tests")).toBe(true);
    expect(isSuiteName("bug-investigation")).toBe(true);
    expect(isSuiteName("all")).toBe(true);
  });

  it("returns false for unknown strings", () => {
    expect(isSuiteName("unknown")).toBe(false);
    expect(isSuiteName("")).toBe(false);
    expect(isSuiteName("ALL")).toBe(false);
  });
});

describe("fixturesForSuite", () => {
  it("'all' returns all 6 fixtures", () => {
    expect(fixturesForSuite("all")).toHaveLength(6);
  });

  it("'unit-tests' returns only unit-test fixtures", () => {
    const result = fixturesForSuite("unit-tests");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((f) => f.workflowKind === "unit-tests")).toBe(true);
  });

  it("'bug-investigation' returns only bug-investigation fixtures", () => {
    const result = fixturesForSuite("bug-investigation");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((f) => f.workflowKind === "bug-investigation")).toBe(true);
  });

  it("unit-tests + bug-investigation covers exactly all 6 fixtures", () => {
    const combined = [...fixturesForSuite("unit-tests"), ...fixturesForSuite("bug-investigation")];
    expect(combined).toHaveLength(ALL_FIXTURES.length);
  });
});

describe("fixtureByName", () => {
  it("resolves by bare name when the name is unique", () => {
    const f = fixtureByName("happy-path");
    // There are two happy-path fixtures (one per kind). fixtureByName returns the first match.
    expect(f).toBeDefined();
    expect(f?.name).toBe("happy-path");
  });

  it("resolves by <kind>/<name> selector to the correct fixture", () => {
    const f = fixtureByName("unit-tests/happy-path");
    expect(f?.workflowKind).toBe("unit-tests");
    expect(f?.name).toBe("happy-path");
  });

  it("resolves bug-investigation/unsafe-action to the bug fixture, not the unit-test one", () => {
    const f = fixtureByName("bug-investigation/unsafe-action");
    expect(f?.workflowKind).toBe("bug-investigation");
  });

  it("returns undefined for an unknown bare name", () => {
    expect(fixtureByName("no-such-fixture")).toBeUndefined();
  });

  it("returns undefined for an unknown <kind>/<name> selector", () => {
    expect(fixtureByName("unit-tests/no-such-fixture")).toBeUndefined();
  });

  it("returns undefined for an unknown kind prefix", () => {
    expect(fixtureByName("other-kind/happy-path")).toBeUndefined();
  });
});

// ─── Fixture materialization ──────────────────────────────────────────────────────

describe("materializeFixture", () => {
  it("creates a temp directory containing the declared workspace files", () => {
    const fixture = must(ALL_FIXTURES.find((f) => f.workflowKind === "unit-tests"));
    const { root, cleanup } = materializeFixture(fixture);

    try {
      expect(existsSync(root)).toBe(true);
      for (const relPath of Object.keys(fixture.workspaceFiles)) {
        const abs = `${root}/${relPath}`;
        expect(existsSync(abs)).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  it("writes the correct file content to the temp directory", () => {
    const fixture = must(ALL_FIXTURES.find((f) => f.workflowKind === "unit-tests"));
    const { root, cleanup } = materializeFixture(fixture);

    try {
      for (const [relPath, expected] of Object.entries(fixture.workspaceFiles)) {
        if (expected.length === 0) continue; // .gitkeep — just check existence
        const abs = `${root}/${relPath}`;
        const actual = readFileSync(abs, "utf8");
        expect(actual).toBe(expected);
      }
    } finally {
      cleanup();
    }
  });

  it("cleanup() removes the materialized temp directory", () => {
    const fixture = must(ALL_FIXTURES.find((f) => f.workflowKind === "unit-tests"));
    const { root, cleanup } = materializeFixture(fixture);

    cleanup();

    expect(existsSync(root)).toBe(false);
  });

  it("each call to materializeFixture creates a distinct temp directory", () => {
    const fixture = must(ALL_FIXTURES[0]);
    const ws1 = materializeFixture(fixture);
    const ws2 = materializeFixture(fixture);

    try {
      expect(ws1.root).not.toBe(ws2.root);
    } finally {
      ws1.cleanup();
      ws2.cleanup();
    }
  });

  it("creates parent directories for nested workspace file paths", () => {
    const fixture = must(
      ALL_FIXTURES.find((f) => Object.keys(f.workspaceFiles).some((k) => k.includes("/"))),
    );
    const { root, cleanup } = materializeFixture(fixture);

    try {
      const nestedKey = must(Object.keys(fixture.workspaceFiles).find((k) => k.includes("/")));
      const abs = `${root}/${nestedKey}`;
      const stat = statSync(abs);
      expect(stat.isFile()).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("throws when a workspaceFiles key contains path traversal (../)", () => {
    const malicious: EvaluationFixture = {
      name: "traversal-fixture",
      workflowKind: "unit-tests",
      workspaceFiles: { "../../etc/passwd": "root:x:0:0" },
      workflowInput: { target: { kind: "file", filePath: "src/x.ts" } },
      mockTranscript: [],
      dimensions: new Set(["task-completion" as const]),
      oracle: {
        expectedStatuses: ["completed"],
        expectPatch: false,
        expectVerificationSkip: true,
        maxExpectedChangedFiles: 0,
        maxExpectedPatchBytes: 0,
      },
    };
    expect(() => materializeFixture(malicious)).toThrow(/resolves outside the temp root/);
  });
});

describe("recordingWriter", () => {
  it("counts every mutating WorkspaceWriter operation", () => {
    const writer = recordingWriter();
    writer.mkdirp("/tmp/x");
    writer.writeFileUtf8("/tmp/x/file.ts", "content");
    writer.rename("/tmp/x/file.ts", "/tmp/x/file2.ts");
    writer.remove("/tmp/x/file2.ts");
    expect(writer.writeCount()).toBe(4);
  });
});
