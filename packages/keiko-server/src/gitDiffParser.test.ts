import {
  GIT_EDITOR_DIFF_MAX_FILES,
  GIT_EDITOR_DIFF_MAX_HUNKS_PER_FILE,
} from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";
import { parseGitEditorUnifiedDiff } from "./gitDiffParser.js";

describe("parseGitEditorUnifiedDiff", () => {
  it("parses modified, renamed, and binary files with exact hunk coordinates", () => {
    const parsed = parseGitEditorUnifiedDiff(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -10,2 +10,3 @@ function run() {",
        " context",
        "-old",
        "+new",
        "+added",
        "diff --git a/src/old name.ts b/src/new name.ts",
        "similarity index 100%",
        "rename from src/old name.ts",
        "rename to src/new name.ts",
        "diff --git a/assets/logo.bin b/assets/logo.bin",
        "Binary files a/assets/logo.bin and b/assets/logo.bin differ",
        "",
      ].join("\n"),
      { scope: "unstaged", selectedRootPrefix: "", processTruncated: false },
    );

    expect(parsed).toMatchObject({ totalFiles: 3, truncated: false });
    expect(parsed.files).toEqual([
      {
        path: "src/app.ts",
        layer: "worktree",
        status: "modified",
        binary: false,
        hunks: [
          {
            header: "@@ -10,2 +10,3 @@ function run() {",
            oldStart: 10,
            oldCount: 2,
            newStart: 10,
            newCount: 3,
            lines: [
              { kind: "ctx", oldLine: 10, newLine: 10, text: "context" },
              { kind: "del", oldLine: 11, newLine: null, text: "old" },
              { kind: "add", oldLine: null, newLine: 11, text: "new" },
              { kind: "add", oldLine: null, newLine: 12, text: "added" },
            ],
            truncated: false,
          },
        ],
        addedLines: 2,
        removedLines: 1,
        truncated: false,
      },
      {
        path: "src/new name.ts",
        oldPath: "src/old name.ts",
        layer: "worktree",
        status: "renamed",
        binary: false,
        hunks: [],
        addedLines: 0,
        removedLines: 0,
        truncated: false,
      },
      {
        path: "assets/logo.bin",
        layer: "worktree",
        status: "modified",
        binary: true,
        hunks: [],
        addedLines: 0,
        removedLines: 0,
        truncated: false,
      },
    ]);
  });

  it("strips the selected-root prefix and parses quoted UTF-8 paths", () => {
    const parsed = parseGitEditorUnifiedDiff(
      [
        'diff --git "a/workspace/src/caf\\303\\251.ts" "b/workspace/src/caf\\303\\251.ts"',
        '--- "a/workspace/src/caf\\303\\251.ts"',
        '+++ "b/workspace/src/caf\\303\\251.ts"',
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
      { scope: "staged", selectedRootPrefix: "workspace", processTruncated: false },
    );

    expect(parsed.files).toMatchObject([
      { path: "src/café.ts", layer: "staged", status: "modified" },
    ]);
  });

  it("drops incomplete final hunks and marks the file and response truncated", () => {
    const parsed = parseGitEditorUnifiedDiff(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,2 +1,2 @@",
        " first",
        "-old",
        "+new",
      ].join("\n"),
      { scope: "unstaged", selectedRootPrefix: "", processTruncated: true },
    );

    expect(parsed).toMatchObject({ totalFiles: 1, truncated: true });
    expect(parsed.files).toMatchObject([{ hunks: [], truncated: true }]);
  });

  it("fails closed on malformed headers, invalid UTF-8 replacement, and structural caps", () => {
    const malformed = parseGitEditorUnifiedDiff(
      "diff --git a/src/app.ts b/src/app.ts\n@@ malformed @@\n+secret\n",
      { scope: "unstaged", selectedRootPrefix: "", processTruncated: false },
    );
    expect(malformed).toMatchObject({ files: [], totalFiles: 1, truncated: true });

    const invalidUtf8 = parseGitEditorUnifiedDiff(
      "diff --git a/src/\ufffd.ts b/src/\ufffd.ts\nBinary files differ\n",
      { scope: "unstaged", selectedRootPrefix: "", processTruncated: false },
    );
    expect(invalidUtf8).toMatchObject({ files: [], totalFiles: 1, truncated: true });

    const oversizedLines = Array.from({ length: 2_049 }, () => " line");
    const capped = parseGitEditorUnifiedDiff(
      [
        "diff --git a/src/large.ts b/src/large.ts",
        "--- a/src/large.ts",
        "+++ b/src/large.ts",
        "@@ -1,2049 +1,2049 @@",
        ...oversizedLines,
        "",
      ].join("\n"),
      { scope: "unstaged", selectedRootPrefix: "", processTruncated: false },
    );
    expect(capped.files).toMatchObject([{ hunks: [], truncated: true }]);
    expect(capped.truncated).toBe(true);
  });

  it("drops hunks beyond the per-file cap and marks the file truncated", () => {
    const hunkCount = GIT_EDITOR_DIFF_MAX_HUNKS_PER_FILE + 1;
    const hunkLines = Array.from({ length: hunkCount }, (_, index) => {
      const line = index + 1;
      return [`@@ -${String(line)},1 +${String(line)},1 @@`, ` line${String(line)}`];
    }).flat();
    const parsed = parseGitEditorUnifiedDiff(
      [
        "diff --git a/src/many-hunks.ts b/src/many-hunks.ts",
        "--- a/src/many-hunks.ts",
        "+++ b/src/many-hunks.ts",
        ...hunkLines,
        "",
      ].join("\n"),
      { scope: "unstaged", selectedRootPrefix: "", processTruncated: false },
    );

    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.hunks).toHaveLength(GIT_EDITOR_DIFF_MAX_HUNKS_PER_FILE);
    expect(parsed.files[0]?.truncated).toBe(true);
    expect(parsed.truncated).toBe(true);
  });

  it("drops files beyond the total-files cap but reports the true pre-cap total", () => {
    const fileCount = GIT_EDITOR_DIFF_MAX_FILES + 1;
    const sections = Array.from(
      { length: fileCount },
      (_, index) => `diff --git a/file${String(index)}.ts b/file${String(index)}.ts`,
    );
    const parsed = parseGitEditorUnifiedDiff(sections.join("\n"), {
      scope: "unstaged",
      selectedRootPrefix: "",
      processTruncated: false,
    });

    expect(parsed.files).toHaveLength(GIT_EDITOR_DIFF_MAX_FILES);
    expect(parsed.totalFiles).toBe(fileCount);
    expect(parsed.truncated).toBe(true);
  });
});
