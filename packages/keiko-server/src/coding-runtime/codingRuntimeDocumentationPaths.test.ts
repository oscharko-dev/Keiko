import { describe, expect, it } from "vitest";
import {
  CODE_READ_DIRECTORIES,
  CONVENTIONAL_DOCUMENTATION_STEMS,
  STRICT_CODE_READ_DIRECTORIES,
  editNeedsVerification,
  isDocumentationPath,
} from "./codingRuntimeDocumentationPaths.js";

describe("the closed sets of the rule", () => {
  const STRICT = [
    "__fixtures__",
    "__mocks__",
    "__snapshots__",
    "__tests__",
    "fixtures",
    "mocks",
    "prompts",
    "resources",
    "skills",
    "snapshots",
    "spec",
    "specs",
    "templates",
    "test",
    "test-data",
    "testdata",
    "tests",
  ];
  const BROAD = [".claude", ".github", "data", "i18n", "locales", "src"];

  it("holds exactly the strict and the broad directories, with none of the documentation-heavy ones", () => {
    expect([...STRICT_CODE_READ_DIRECTORIES].sort()).toEqual([...STRICT].sort());
    expect([...CODE_READ_DIRECTORIES].sort()).toEqual([...STRICT, ...BROAD].sort());
    for (const dir of ["app", "lib", "assets", "public", "static", "docs"])
      expect(CODE_READ_DIRECTORIES.has(dir)).toBe(false);
  });

  it("holds exactly the conventional documentation names", () => {
    expect([...CONVENTIONAL_DOCUMENTATION_STEMS].sort()).toEqual(
      [
        "authors",
        "changelog",
        "changes",
        "code_of_conduct",
        "contributing",
        "history",
        "licence",
        "license",
        "notice",
        "readme",
        "security",
        "support",
      ].sort(),
    );
  });
});

describe("isDocumentationPath", () => {
  it.each([
    "README.md",
    "docs/guide/setup.MDX",
    "notes.markdown",
    "a/b/c/changelog.txt",
    "manual.rst",
    "spec.adoc",
    "book.asciidoc",
    "LICENSE",
    "sub\\folder\\NOTICE",
    "CONTRIBUTING",
    "docs/architecture/overview.md",
    "handbook/notes.txt",
    // Conventional documentation names stay documentation under broad segments and elsewhere.
    "src/foo/README.md",
    "lib/CHANGELOG.md",
    "packages/a/src/CONTRIBUTING",
    "data/SECURITY.md",
    // Folders that hold plenty of plain documentation are not code-read directories.
    "docs/assets/x.md",
    "static/guide.mdx",
    "app/overview.md",
    "public/notes.txt",
  ])("treats %s as documentation", (path) => {
    expect(isDocumentationPath(path)).toBe(true);
  });

  it.each([
    "src/main.ts",
    "pom.xml",
    "package.json",
    // A docs folder is not documentation by itself: code in it is covered by checks.
    "docs/conf.py",
    "docs/examples/Main.java",
    "CMakeLists.txt",
    "native/cmakelists.TXT",
    "requirements.txt",
    "requirements-dev.txt",
    "constraints.txt",
    "scripts/readme-check.mjs",
    ".md",
    "Makefile",
    "",
    "docs/",
    // Prose extensions that code or tests read: golden files, prompts, templates, skills.
    "src/test/resources/expected.txt",
    "tests/fixtures/answer.md",
    "app/prompts/system.md",
    "SRC/Main/Notes.MD",
    "packages/a/skills/review/SKILL.md",
    ".github/pull_request_template.md",
    ".claude/commands/review.md",
    "docs\\tests\\expected.txt",
    // A conventional name under a strict segment is a golden file or fixture.
    "src/test/resources/README.md",
    "tests/fixtures/CHANGELOG.md",
    "prompts/LICENSE",
    "data/input.txt",
    "src/notes.md",
  ])("treats %s as code", (path) => {
    expect(isDocumentationPath(path)).toBe(false);
  });
});

describe("editNeedsVerification", () => {
  it("requires no check when every changed path is documentation", () => {
    expect(editNeedsVerification(["README.md", "docs/a.md"])).toBe(false);
  });

  it("requires a check when any changed path is code", () => {
    expect(editNeedsVerification(["README.md", "src/a.ts"])).toBe(true);
  });

  it("requires a check when the edit names no path: absent evidence never relaxes it", () => {
    expect(editNeedsVerification(undefined)).toBe(true);
    expect(editNeedsVerification([])).toBe(true);
  });
});
