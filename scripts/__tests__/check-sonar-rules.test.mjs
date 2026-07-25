import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import {
  changedLintableFiles,
  createEngine,
  evaluate,
  existsInTree,
  resolveBaseRef,
  summarise,
} from "../check-sonar-rules.mjs";

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

describe("evaluate", () => {
  const run = (args) => (args[0] === "merge-base" ? "base\n" : "scripts/x.mjs\n");
  const anyFile = () => true;
  const neverLint = () => {
    throw new Error("the rule engine must never load for this input");
  };

  it("fails, with the fetch hint, when the base ref cannot be resolved", async () => {
    const verdict = await evaluate({
      exists: anyFile,
      lint: neverLint,
      run: () => {
        throw new Error("fatal: Not a valid object name");
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toContain('cannot resolve "origin/dev"');
    expect(verdict.failures[0]).toContain("--base=");
  });

  it("passes without loading the rule engine when the diff holds no lintable source", async () => {
    const verdict = await evaluate({
      exists: anyFile,
      lint: neverLint,
      run: (args) => (args[0] === "merge-base" ? "base\n" : "README.md\ndocs/adr/x.md\n"),
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.summary).toContain("no changed source files");
  });

  it("passes and counts the files when the rules find nothing", async () => {
    const verdict = await evaluate({
      exists: anyFile,
      lint: async () => [{ filePath: "scripts/x.mjs", messages: [] }],
      run,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
    expect(verdict.summary).toContain("1 changed file(s)");
  });

  it("fails with one line per finding and a closing count", async () => {
    const verdict = await evaluate({
      exists: anyFile,
      lint: async () => [
        {
          filePath: "scripts/x.mjs",
          messages: [{ line: 3, message: "too complex", ruleId: "sonarjs/cognitive-complexity" }],
        },
      ],
      run,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.summary).toBeUndefined();
    expect(verdict.failures[0]).toContain("scripts/x.mjs:3 sonarjs/cognitive-complexity");
    expect(verdict.failures[1]).toContain("1 violation(s)");
  });

  it("honours an explicit --base over the environment", async () => {
    const seen = [];
    await evaluate({
      argv: ["--base=feat/x"],
      env: { KEIKO_NEW_CODE_BASE_REF: "origin/main" },
      exists: anyFile,
      lint: neverLint,
      run: (args) => {
        seen.push(args.join(" "));
        return args[0] === "merge-base" ? "base\n" : "";
      },
    });
    expect(seen[0]).toBe("merge-base feat/x HEAD");
  });
});

// Real-git checks in the documentation-only entry point's style: HEAD's own tree is deterministic.
describe("existsInTree", () => {
  it("sees a file HEAD tracks", () => {
    expect(existsInTree("scripts/check-sonar-rules.mjs")).toBe(true);
  });

  it("rejects a path HEAD does not track", () => {
    expect(existsInTree("scripts/keiko-no-such-file.mjs")).toBe(false);
  });
});

describe("createEngine", () => {
  it("builds the engine the entry point lints with", () => {
    expect(createEngine()).toBeInstanceOf(ESLint);
  });
});
