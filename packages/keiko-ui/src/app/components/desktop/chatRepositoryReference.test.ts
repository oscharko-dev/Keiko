// GEN-MAINT-COMPLEXITY-003 — unit coverage for the pure repository-reference string helpers extracted
// from ChatWindow. All pure functions of string args; no DOM, so this runs under node/jsdom.

import { describe, expect, it } from "vitest";
import {
  appendRepositoryReference,
  escapeRegExp,
  normalizedRepositoryPath,
  normalizedRepositoryRoot,
  omitAncestorRepositoryRoots,
  removeRepositoryReferenceFromDraft,
  repositoryReferenceId,
  repositoryReferenceMentionPaths,
  repositoryReferenceMentionPattern,
  repositoryRootContains,
} from "./chatRepositoryReference";

describe("normalizedRepositoryRoot", () => {
  it("converts backslashes to forward slashes and trims trailing slashes", () => {
    expect(normalizedRepositoryRoot("C:\\repo\\")).toBe("C:/repo");
    expect(normalizedRepositoryRoot("/a/b///")).toBe("/a/b");
  });
});

describe("repositoryRootContains", () => {
  it("is true only for a strict descendant path", () => {
    expect(repositoryRootContains("/a", "/a/b")).toBe(true);
    expect(repositoryRootContains("/a", "/a")).toBe(false);
    expect(repositoryRootContains("/a", "/ab")).toBe(false);
    expect(repositoryRootContains("", "/a/b")).toBe(false);
  });
});

describe("omitAncestorRepositoryRoots", () => {
  it("drops a parent root when a descendant is also present", () => {
    expect(omitAncestorRepositoryRoots(["/a", "/a/b"])).toEqual(["/a/b"]);
  });
  it("dedupes, trims, and drops blanks while keeping independent roots", () => {
    expect(omitAncestorRepositoryRoots([" /a ", "/a", "/c", ""])).toEqual(["/a", "/c"]);
  });
});

describe("normalizedRepositoryPath", () => {
  it("normalizes separators and strips leading/trailing slashes", () => {
    expect(normalizedRepositoryPath("\\src\\a.ts\\")).toBe("src/a.ts");
    expect(normalizedRepositoryPath("/src/a.ts")).toBe("src/a.ts");
  });
});

describe("appendRepositoryReference", () => {
  it("appends an @mention to a trimmed draft", () => {
    expect(appendRepositoryReference("hello", "src/a.ts")).toBe("hello @src/a.ts");
    expect(appendRepositoryReference("", "src/a.ts")).toBe("@src/a.ts");
    expect(appendRepositoryReference("hi ", "src/a.ts")).toBe("hi @src/a.ts");
  });
  it("does not duplicate an already-present mention", () => {
    expect(appendRepositoryReference("look @src/a.ts here", "src/a.ts")).toBe(
      "look @src/a.ts here",
    );
  });
});

describe("repositoryReferenceId", () => {
  it("joins root and path with a control-char separator so paths cannot collide", () => {
    expect(repositoryReferenceId("/r", "a/b.ts")).toBe("/r\u0001a/b.ts");
    expect(repositoryReferenceId("/r/a", "b.ts")).not.toBe(repositoryReferenceId("/r", "a/b.ts"));
  });
});

describe("escapeRegExp / repositoryReferenceMentionPattern", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegExp("a.b+c")).toBe("a\\.b\\+c");
  });
  it("builds a pattern that matches the exact bounded mention", () => {
    const pattern = repositoryReferenceMentionPattern("src/a.ts");
    // $1 preserves the boundary whitespace captured before the mention.
    expect("see @src/a.ts done".replace(pattern, "$1X")).toBe("see X done");
    // A path with a shared prefix must not match.
    expect(repositoryReferenceMentionPattern("a").test("@ab")).toBe(false);
  });
});

describe("removeRepositoryReferenceFromDraft", () => {
  it("removes the mention and collapses the resulting whitespace", () => {
    expect(removeRepositoryReferenceFromDraft("look @src/a.ts here", "src/a.ts")).toBe("look here");
    expect(removeRepositoryReferenceFromDraft("@src/a.ts", "src/a.ts")).toBe("");
  });
});

describe("repositoryReferenceMentionPaths", () => {
  it("extracts unique, normalized file mentions with an extension", () => {
    expect(repositoryReferenceMentionPaths("edit @src/a.ts and @src/a.ts and @b.md")).toEqual([
      "src/a.ts",
      "b.md",
    ]);
  });
  it("ignores an @mention without a file extension", () => {
    expect(repositoryReferenceMentionPaths("@someone hello")).toEqual([]);
  });
});
