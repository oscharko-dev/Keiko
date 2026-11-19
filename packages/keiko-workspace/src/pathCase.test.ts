import { describe, expect, it } from "vitest";
import {
  parseGitCoreIgnoreCase,
  pathCaseFromGitIgnoreCase,
  pathCaseKey,
  pathGlobCaseSensitive,
  platformPathCase,
  workspacePathCase,
} from "./pathCase.js";

describe("platform path-case default (#4436)", () => {
  it("is case-insensitive on Windows and case-sensitive elsewhere", () => {
    expect(platformPathCase("win32")).toBe("case-insensitive");
    expect(platformPathCase("linux")).toBe("case-sensitive");
    expect(platformPathCase("darwin")).toBe("case-sensitive");
  });

  it("lets an explicit core.ignorecase win on every platform", () => {
    expect(pathCaseFromGitIgnoreCase(false, "win32")).toBe("case-sensitive");
    expect(pathCaseFromGitIgnoreCase(true, "linux")).toBe("case-insensitive");
    expect(pathCaseFromGitIgnoreCase(undefined, "win32")).toBe("case-insensitive");
    expect(pathCaseFromGitIgnoreCase(undefined, "linux")).toBe("case-sensitive");
  });

  it("prefers a workspace's recorded rule over the platform default", () => {
    expect(workspacePathCase({ pathCase: "case-sensitive" }, "win32")).toBe("case-sensitive");
    expect(workspacePathCase({ pathCase: "case-insensitive" }, "linux")).toBe("case-insensitive");
    expect(workspacePathCase({}, "win32")).toBe("case-insensitive");
    expect(workspacePathCase(undefined, "linux")).toBe("case-sensitive");
  });

  it("folds literal keys and glob sensitivity together", () => {
    expect(pathCaseKey("Docs/SCAN.PDF", "case-insensitive")).toBe("docs/scan.pdf");
    expect(pathCaseKey("Docs/SCAN.PDF", "case-sensitive")).toBe("Docs/SCAN.PDF");
    expect(pathGlobCaseSensitive("case-insensitive")).toBe(false);
    expect(pathGlobCaseSensitive("case-sensitive")).toBe(true);
  });
});

describe("parseGitCoreIgnoreCase", () => {
  it.each([
    ["[core]\n\tignorecase = true\n", true],
    ["[core]\n\tignorecase = false\n", false],
    ["[CORE]\n\tIgnoreCase = Yes\n", true],
    ["[core]\n\tignoreCase = off\n", false],
    ["[core]\n\tignorecase = 1\n", true],
    ["[core]\n\tignorecase = 0\n", false],
    ["[core]\n\tignorecase\n", true],
    ["[core]\n\tignorecase =\n", false],
    ['[core]\n\tignorecase = "true" # inline\n', true],
    ["[core]\n\tignorecase = false ; inline\n", false],
    ["[core] ignorecase = true\n", true],
    ["[core]\r\n\tignorecase = true\r\n", true],
    ["[core]\n\tignorecase = true\n[core]\n\tignorecase = false\n", false],
  ])("reads %j as %s", (text, expected) => {
    expect(parseGitCoreIgnoreCase(text)).toBe(expected);
  });

  it.each([
    ["", "an empty config"],
    ["[core]\n\tfilemode = false\n", "a config without the key"],
    ['[core "worktree"]\n\tignorecase = true\n', "a subsection"],
    ["[core.sub]\n\tignorecase = true\n", "a legacy subsection"],
    ["[user]\n\tignorecase = true\n", "another section"],
    ["ignorecase = true\n", "a key before any section"],
    ["[core]\n\t# ignorecase = true\n\t; ignorecase = true\n", "commented keys"],
    ["[core]\n\tignorecase = maybe\n", "an unparsable boolean"],
    ["[core]\n\tignorecasefoo = true\n\tx.ignorecase = true\n", "lookalike keys"],
    ["[include]\n\tpath = ignorecase.inc\n", "an include directive"],
    ["[core\n\tignorecase = true\n", "an unterminated header"],
  ])("states nothing for %j (%s)", (text) => {
    expect(parseGitCoreIgnoreCase(text)).toBeUndefined();
  });

  it("keeps the last valid assignment when a later one is unparsable", () => {
    expect(parseGitCoreIgnoreCase("[core]\n\tignorecase = false\n\tignorecase = ???\n")).toBe(
      false,
    );
  });

  it("stays linear on hostile long lines", () => {
    const hostile = `[core${" ".repeat(50_000)}\n\tignorecase = ${'"'.repeat(50_000)}\n`;
    const started = performance.now();
    expect(parseGitCoreIgnoreCase(hostile)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
