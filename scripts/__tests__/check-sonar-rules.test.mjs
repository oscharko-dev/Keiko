import { rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import sonarjs from "eslint-plugin-sonarjs";
import { describe, expect, it } from "vitest";

import {
  changedLintableFiles,
  createEngine,
  evaluate,
  existsInTree,
  isUiTypeScriptFile,
  profileRules,
  QUALITY_PROFILE,
  resolveBaseRef,
  sonarRuleKey,
  summarise,
} from "../check-sonar-rules.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
  const result = (messages, source = "\n".repeat(20)) => ({
    filePath: "/outside-the-repository/src/a.ts",
    messages,
    source,
  });

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

  // SonarCloud raises nothing on a line carrying NOSONAR, so neither may the gate (#4525).
  it("drops a finding on a NOSONAR line and keeps one on the next line", () => {
    const source = ["const a = 1;", "x = 1; // NOSONAR typescript:S1874 -- reason", "y = 2;"];
    const findings = summarise([
      result(
        [
          { line: 2, message: "deprecated", ruleId: "sonarjs/deprecation" },
          { line: 3, message: "deprecated", ruleId: "sonarjs/deprecation" },
        ],
        source.join("\n"),
      ),
    ]);
    expect(findings.map((finding) => finding.line)).toEqual([3]);
  });

  // SonarCloud suppresses only a line that carries a NOSONAR comment; the word in a string literal
  // or a template suppresses nothing.
  it("keeps a finding whose line holds NOSONAR only inside a string", () => {
    const source = [
      'legacy(); const label = "NOSONAR";',
      "const text = `NOSONAR ${label}`;",
      "/* NOSONAR",
      "   spans lines */ legacy();",
      "legacy(); // NOSONAR",
    ];
    const findings = summarise([
      result(
        [1, 2, 3, 4, 5].map((line) => ({ line, message: "m", ruleId: "sonarjs/x" })),
        source.join("\n"),
      ),
    ]);
    expect(findings.map((finding) => finding.line)).toEqual([1, 2, 4]);
  });

  it("reads the file when the engine omitted its source", () => {
    const reads = [];
    const findings = summarise(
      [
        {
          filePath: "/outside-the-repository/src/a.ts",
          messages: [{ line: 1, message: "m", ruleId: "sonarjs/x" }],
        },
      ],
      (path) => {
        reads.push(path);
        return "f(); // NOSONAR";
      },
    );
    expect(reads).toEqual(["/outside-the-repository/src/a.ts"]);
    expect(findings).toEqual([]);
  });

  // A file the engine could not parse was never analysed; a silent pass would hide all of it.
  it("fails a file the engine could not parse, even on a NOSONAR line", () => {
    const findings = summarise([
      result(
        [{ fatal: true, line: 1, message: "Parsing error: not found", ruleId: null }],
        "// NOSONAR",
      ),
    ]);
    expect(findings).toEqual([
      {
        line: 1,
        message: "Parsing error: not found",
        path: "/outside-the-repository/src/a.ts",
        rule: "parse-error",
      },
    ]);
  });
});

describe("the SonarCloud quality profile (#4525)", () => {
  it("reads a rule's SonarCloud key from its documentation link", () => {
    expect(sonarRuleKey(sonarjs.rules["no-redundant-optional"])).toBe("S4782");
    expect(sonarRuleKey({ meta: { docs: { url: "https://example.test/no-key" } } })).toBe(
      undefined,
    );
    expect(sonarRuleKey(undefined)).toBe(undefined);
  });

  it("keeps only the recommended rules the profile activates for the language", () => {
    const typescript = profileRules("typescript");
    // Active in SonarCloud's TypeScript profile.
    expect(typescript["sonarjs/no-redundant-optional"]).toBeDefined();
    expect(typescript["sonarjs/deprecation"]).toBeDefined();
    // Recommended by the plugin, inactive in SonarCloud's TypeScript profile.
    for (const inactive of ["no-unused-vars", "function-return-type", "different-types-comparison"])
      expect(typescript[`sonarjs/${inactive}`], inactive).toBeUndefined();
    expect(profileRules("javascript")["sonarjs/no-unused-vars"]).toBeDefined();
  });

  it("drops a recommended rule that is off, has no key, or is outside the profile", () => {
    const plugin = {
      configs: {
        recommended: {
          rules: { "sonarjs/a": "error", "sonarjs/b": "off", "sonarjs/c": 0, "sonarjs/d": "error" },
        },
      },
      rules: {
        a: { meta: { docs: { url: "https://rules.test/S1/javascript" } } },
        b: { meta: { docs: { url: "https://rules.test/S1/javascript" } } },
        c: { meta: { docs: { url: "https://rules.test/S1/javascript" } } },
        d: { meta: { docs: { url: "https://rules.test/S2/javascript" } } },
      },
    };
    expect(profileRules("typescript", plugin, { typescript: ["S1"] })).toEqual({
      "sonarjs/a": "error",
    });
  });

  it("records the profile it was taken from and both languages", () => {
    expect(QUALITY_PROFILE.profile).toBe("Sonar way comprehensive");
    expect(QUALITY_PROFILE.typescript).toContain("S4782");
    expect(QUALITY_PROFILE.javascript.length).toBeGreaterThan(100);
  });

  it("gives type information to UI TypeScript files only", () => {
    expect(isUiTypeScriptFile(resolve(repoRoot, "packages/keiko-ui/src/a.tsx"))).toBe(true);
    expect(isUiTypeScriptFile(resolve(repoRoot, "packages/keiko-ui/src/a.ts"))).toBe(true);
    expect(isUiTypeScriptFile(resolve(repoRoot, "packages/keiko-ui/next.config.mjs"))).toBe(false);
    expect(isUiTypeScriptFile(resolve(repoRoot, "packages/keiko-uix/src/a.ts"))).toBe(false);
    expect(isUiTypeScriptFile(resolve(repoRoot, "packages/keiko-cli/src/a.ts"))).toBe(false);
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
          source: "a\nb\nc\n",
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

  // #4525: the UI's own ESLint config is untyped, so S4782 could not see exactOptionalPropertyTypes
  // and reported every `?: T | undefined`, and the plugin's recommended set added rules SonarCloud's
  // profile leaves inactive. A UI file must report what SonarCloud reports, and nothing else.
  it("reports in a UI file what SonarCloud reports, and nothing it would not", async () => {
    const path = resolve(repoRoot, "packages/keiko-ui/src/lib/sonar-rules-gate-probe.ts");
    const code = [
      "export interface Probe {",
      "  readonly label?: string | undefined;",
      "}",
      "",
      "export function probe(flag: boolean): number {",
      "  const unused = 1;",
      "  if (flag) {",
      "    return 1;",
      "  } else {",
      "    return 1;",
      "  }",
      "}",
      "",
    ].join("\n");
    writeFileSync(path, code);
    try {
      const findings = summarise(await createEngine().lintFiles([path]));
      expect(findings.map((finding) => `${finding.rule}@${String(finding.line)}`).sort()).toEqual([
        "sonarjs/no-all-duplicated-branches@7",
        "sonarjs/no-invariant-returns@5",
      ]);
    } finally {
      rmSync(path, { force: true });
    }
  }, 120_000);
});
