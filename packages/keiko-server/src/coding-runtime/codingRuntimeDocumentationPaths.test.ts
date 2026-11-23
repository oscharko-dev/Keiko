import { describe, expect, it } from "vitest";
import { editNeedsVerification, isDocumentationPath } from "./codingRuntimeDocumentationPaths.js";

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
