import { describe, expect, it } from "vitest";
import { detectConventions, isTestPath } from "../../../src/workflows/unit-tests/conventions.js";
import { makeEntry, makePack, makeWorkspaceInfo } from "./_support.js";

describe("isTestPath (AC #9 production-code guard, D6)", () => {
  const ws = makeWorkspaceInfo({ testDirs: ["tests", "__tests__"] });

  it("passes a dot-segment .test file (sibling)", () => {
    expect(isTestPath(ws, "src/add.test.ts")).toBe(true);
  });

  it("passes a dot-segment .spec file", () => {
    expect(isTestPath(ws, "src/add.spec.ts")).toBe(true);
  });

  it("passes a multi-segment name with an embedded .test segment", () => {
    expect(isTestPath(ws, "src/add.test.utils.ts")).toBe(true);
  });

  it("FAILS a prefix-only 'test' name (testUtils.ts)", () => {
    expect(isTestPath(ws, "src/testUtils.ts")).toBe(false);
  });

  it("FAILS a plain source file", () => {
    expect(isTestPath(ws, "src/add.ts")).toBe(false);
  });

  it("passes any path under a configured testDir even without a .test segment", () => {
    expect(isTestPath(ws, "tests/add.ts")).toBe(true);
    expect(isTestPath(ws, "__tests__/nested/add.ts")).toBe(true);
  });

  it("rejects a production source path (the prompt-injection blast-radius case)", () => {
    expect(isTestPath(ws, "src/auth.ts")).toBe(false);
  });

  it("handles Windows-style backslash separators", () => {
    expect(isTestPath(ws, "tests\\add.ts")).toBe(true);
    expect(isTestPath(ws, "src\\add.test.ts")).toBe(true);
  });

  // Security regression: a `..` segment makes a path that lexically starts with `tests/` resolve
  // (via #6 resolveWithinWorkspace) to a production file. Reject traversal fail-closed (D6 bypass).
  it("FAILS a traversal path that escapes the testDir back into src", () => {
    expect(isTestPath(ws, "tests/../src/auth.ts")).toBe(false);
  });

  it("FAILS a traversal path that escapes the workspace entirely", () => {
    expect(isTestPath(ws, "tests/../../etc/passwd")).toBe(false);
  });

  it("FAILS an absolute path even with a .test segment", () => {
    expect(isTestPath(ws, "/abs/tests/x.test.ts")).toBe(false);
  });

  it("FAILS a diff-prefix-style traversal (b/tests/../src/auth.ts)", () => {
    // The b/ prefix is stripped by the #6 parser; the guard still sees the traversal in the rest.
    expect(isTestPath(ws, "tests/../src/auth.ts")).toBe(false);
    expect(isTestPath(ws, "../src/auth.ts")).toBe(false);
  });
});

describe("detectConventions (AC #5, D7)", () => {
  it("reports the workspace's detected framework verbatim", () => {
    const ws = makeWorkspaceInfo({ testFramework: "jest" });
    const conv = detectConventions(ws, makePack([]));
    expect(conv.framework).toBe("jest");
    expect(conv.testDirs).toEqual(["tests"]);
  });

  it("detects mirrored naming when a test sample lives under a testDir", () => {
    const ws = makeWorkspaceInfo({ testDirs: ["tests"] });
    const pack = makePack([
      makeEntry({ path: "src/add.ts", selectionReason: "source" }),
      makeEntry({ path: "tests/add.test.ts", selectionReason: "test" }),
    ]);
    expect(detectConventions(ws, pack).fileNamingStyle).toBe("mirrored");
  });

  it("detects sibling naming when a test sample sits next to its source", () => {
    const ws = makeWorkspaceInfo({ testDirs: ["tests"] });
    const pack = makePack([makeEntry({ path: "src/add.test.ts", selectionReason: "test" })]);
    expect(detectConventions(ws, pack).fileNamingStyle).toBe("sibling");
  });

  it("falls back to unknown when there is neither a testDir nor a sample", () => {
    const ws = makeWorkspaceInfo({ testDirs: [] });
    expect(detectConventions(ws, makePack([])).fileNamingStyle).toBe("unknown");
  });

  it("samples up to 2 redacted test excerpts, ignoring non-test entries", () => {
    const ws = makeWorkspaceInfo();
    const pack = makePack([
      makeEntry({ path: "src/add.ts", selectionReason: "source", excerpt: "SOURCE" }),
      makeEntry({ path: "tests/a.test.ts", selectionReason: "test", excerpt: "A" }),
      makeEntry({ path: "tests/b.test.ts", selectionReason: "test", excerpt: "B" }),
      makeEntry({ path: "tests/c.test.ts", selectionReason: "test", excerpt: "C" }),
    ]);
    const samples = detectConventions(ws, pack).assertionStyleSamples;
    expect(samples).toEqual(["A", "B"]);
  });
});
