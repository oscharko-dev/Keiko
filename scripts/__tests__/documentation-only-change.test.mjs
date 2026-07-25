import { describe, expect, it } from "vitest";

import { isDocumentationOnlyChange } from "../lib/documentation-only-change.mjs";

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
