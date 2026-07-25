import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isDocumentationOnlyChange } from "../lib/documentation-only-change.mjs";
import { main, resolveVerdict, verdictLine } from "../check-documentation-only-change.mjs";

describe("isDocumentationOnlyChange", () => {
  it("accepts prose, ADRs and root markdown", () => {
    expect(
      isDocumentationOnlyChange([
        "docs/qa/local-gates.md",
        "docs/adr/ADR-0156-measurement-and-verdict-separation.md",
        "AGENTS.md",
        "README.md",
      ]),
    ).toBe(true);
  });

  // Everything below must force the full matrix. Each entry is a way a "documentation" change could
  // otherwise smuggle in something that breaks the product.
  it.each([
    ["a source file", ["docs/qa/local-gates.md", "packages/keiko-ui/src/app/page.tsx"]],
    ["a workflow", ["README.md", ".github/workflows/ci.yml"]],
    ["a script", ["AGENTS.md", "scripts/check-perf-evidence.mjs"]],
    ["the lockfile", ["README.md", "package-lock.json"]],
    ["a manifest", ["README.md", "package.json"]],
    ["committed evidence", ["README.md", "docs/release/1209-perf-evidence.json"]],
    ["the coverage baseline", ["README.md", "docs/qa/package-coverage-baseline.json"]],
    ["a test", ["README.md", "tests/e2e/coding-workbench-1990.spec.ts"]],
    ["a config", ["README.md", "tsconfig.json"]],
    ["a dotfile", ["README.md", ".prettierignore"]],
    ["a non-markdown doc asset", ["docs/design-system/evidence/proof.png"]],
  ])("refuses a change set containing %s", (_label, paths) => {
    expect(isDocumentationOnlyChange(paths)).toBe(false);
  });

  it("refuses an empty change set — detection failed, so run everything", () => {
    expect(isDocumentationOnlyChange([])).toBe(false);
  });

  it("refuses a malformed change set rather than guessing", () => {
    expect(isDocumentationOnlyChange(undefined)).toBe(false);
    expect(isDocumentationOnlyChange(["README.md", ""])).toBe(false);
    expect(isDocumentationOnlyChange([null])).toBe(false);
  });
});

// Governance configuration may never buy a reduced matrix, however prose-like the file looks.
describe("governance configuration is not documentation", () => {
  it.each([
    ".github/CODEOWNERS",
    ".github/workflows/ci.yml",
    ".github/dependabot.yml",
    "docs/qa/package-coverage-baseline.json",
    "docs/release/1209-perf-evidence.json",
  ])("rejects %s", (path) => {
    expect(isDocumentationOnlyChange([path])).toBe(false);
    expect(isDocumentationOnlyChange(["README.md", path])).toBe(false);
  });
});

describe("resolveVerdict", () => {
  it("reports documentation-only for a prose change set", () => {
    const verdict = resolveVerdict("base", "head", () => ["README.md", "docs/qa/local-gates.md"]);
    expect(verdict.documentationOnly).toBe(true);
    expect(verdict.reason).toContain("2 changed path(s)");
  });

  it("reports false when the change set contains code", () => {
    const verdict = resolveVerdict("base", "head", () => ["README.md", "src/index.ts"]);
    expect(verdict.documentationOnly).toBe(false);
  });

  // Every way the decision can go wrong must land on "run everything".
  it("refuses without a base sha", () => {
    expect(resolveVerdict("", "head", () => ["README.md"])).toEqual({
      documentationOnly: false,
      reason: "no base sha supplied",
    });
  });

  it("refuses on a non-string base sha", () => {
    expect(resolveVerdict(undefined, "head", () => ["README.md"]).documentationOnly).toBe(false);
  });

  it("refuses when the change set cannot be resolved", () => {
    const verdict = resolveVerdict("base", "head", () => {
      throw new TypeError("git exploded");
    });
    expect(verdict.documentationOnly).toBe(false);
    expect(verdict.reason).toContain("TypeError");
  });

  it("refuses on an empty change set rather than assuming prose", () => {
    expect(resolveVerdict("base", "head", () => []).documentationOnly).toBe(false);
  });
});

describe("verdictLine", () => {
  it("names the full matrix whenever the answer is false", () => {
    expect(verdictLine({ documentationOnly: false, reason: "x" })).toContain(
      "running the full matrix",
    );
  });

  it("stays quiet about the matrix when the answer is true", () => {
    expect(verdictLine({ documentationOnly: true, reason: "x" })).not.toContain("full matrix");
  });
});

describe("the change-scope entry point", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves a real change set through git when no lister is injected", () => {
    // Exercises the production git path: HEAD against itself is empty, so the answer is "run
    // everything" for a reason the injected tests above cannot reach.
    expect(resolveVerdict("HEAD", "HEAD").documentationOnly).toBe(false);
  });

  it("reports false for an unresolvable ref rather than skipping the matrix", () => {
    const verdict = resolveVerdict("refs/keiko/no-such-ref-for-tests", "HEAD");
    expect(verdict.documentationOnly).toBe(false);
    expect(verdict.reason).toContain("could not resolve the change set");
  });

  it("writes the verdict to the step output when GitHub supplies one", () => {
    const outputPath = join(mkdtempSync(join(tmpdir(), "keiko-doc-scope-")), "output.txt");
    process.env.GITHUB_OUTPUT = outputPath;
    process.env.KEIKO_CHANGE_BASE_SHA = "HEAD";
    process.env.KEIKO_CHANGE_HEAD_SHA = "HEAD";

    main();

    expect(readFileSync(outputPath, "utf8")).toBe("documentation-only=false\n");
  });

  it("stays silent when no step output is configured", () => {
    delete process.env.GITHUB_OUTPUT;
    delete process.env.KEIKO_CHANGE_BASE_SHA;

    expect(() => {
      main();
    }).not.toThrow();
  });
});
