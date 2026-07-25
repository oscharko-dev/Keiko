import { describe, expect, it } from "vitest";

import { changedLintableFiles, resolveBaseRef, summarise } from "../check-sonar-rules.mjs";

describe("resolveBaseRef", () => {
  it("prefers an explicit --base argument", () => {
    expect(resolveBaseRef(["--base=feat/x"], {})).toBe("feat/x");
  });

  it("falls back to the environment, then to origin/dev", () => {
    expect(resolveBaseRef([], { KEIKO_NEW_CODE_BASE_REF: "origin/main" })).toBe("origin/main");
    expect(resolveBaseRef([], {})).toBe("origin/dev");
  });
});

describe("changedLintableFiles", () => {
  const all = () => true;

  it("keeps source files the rule engine can parse", () => {
    const names = ["src/a.ts", "src/b.tsx", "scripts/c.mjs", "src/d.js"].join("\n");
    expect(changedLintableFiles(names, all)).toEqual([
      "src/a.ts",
      "src/b.tsx",
      "scripts/c.mjs",
      "src/d.js",
    ]);
  });

  it("drops non-source paths SonarCloud does not analyse as code", () => {
    const names = ["README.md", "package-lock.json", "docs/adr/ADR-0156.md", ".github/ci.yml"];
    expect(changedLintableFiles(names.join("\n"), all)).toEqual([]);
  });

  // Sonar puts tests in its test scope, not its main scope, so a rule violation there does not move
  // the ratings the quality gate blocks on.
  it("drops test files, matching Sonar's main scope", () => {
    const names = ["src/a.test.ts", "scripts/__tests__/b.test.mjs", "src/keep.ts"].join("\n");
    expect(changedLintableFiles(names, all)).toEqual(["src/keep.ts"]);
  });

  // A file the diff deleted still appears in --name-only; linting it would crash the run.
  it("drops a path that no longer exists in the tree", () => {
    expect(
      changedLintableFiles("src/gone.ts\nsrc/here.ts", (path) => path === "src/here.ts"),
    ).toEqual(["src/here.ts"]);
  });

  it("tolerates an empty diff and blank lines", () => {
    expect(changedLintableFiles("\n\n  \n", all)).toEqual([]);
  });
});

describe("summarise", () => {
  const result = (messages) => ({ filePath: "/repo/src/a.ts", messages });

  it("keeps only SonarCloud rule findings", () => {
    const findings = summarise([
      result([
        { line: 3, message: "cognitive complexity", ruleId: "sonarjs/cognitive-complexity" },
        { line: 4, message: "unused", ruleId: "@typescript-eslint/no-unused-vars" },
        { line: 5, message: "parse error", ruleId: null },
      ]),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("sonarjs/cognitive-complexity");
    expect(findings[0].line).toBe(3);
  });

  it("returns nothing for a clean result", () => {
    expect(summarise([result([])])).toEqual([]);
  });

  it("carries the message through so the operator can act without opening SonarCloud", () => {
    const findings = summarise([
      result([{ line: 9, message: "super-linear runtime", ruleId: "sonarjs/super-linear-regex" }]),
    ]);
    expect(findings[0].message).toBe("super-linear runtime");
  });
});
