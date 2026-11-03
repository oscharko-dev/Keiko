import { describe, expect, it } from "vitest";

import {
  canPickReference,
  draftMentionsPath,
  fileMentionAtCursor,
  fileMentionText,
  fileReferenceOption,
  insertFileMention,
  referencesInDraft,
  removeFileMention,
  workspaceRelativeReferencePath,
} from "./codingWorkbenchPromptReferences";

describe("file mentions in the draft", () => {
  it("opens at an @ that starts the draft, follows whitespace or an opening bracket", () => {
    expect(fileMentionAtCursor("@app", 4)).toEqual({ start: 0, end: 4, query: "app" });
    expect(fileMentionAtCursor("look at @src/ap", 15)).toEqual({
      start: 8,
      end: 15,
      query: "src/ap",
    });
    expect(fileMentionAtCursor("(see @a", 7)).toEqual({ start: 5, end: 7, query: "a" });
    expect(fileMentionAtCursor("line one\n@x", 11)).toMatchObject({ query: "x" });
    expect(fileMentionAtCursor("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("never opens inside a word, past whitespace, or across a second @", () => {
    expect(fileMentionAtCursor("mail me@example.com", 19)).toBeNull();
    expect(fileMentionAtCursor("@app now", 8)).toBeNull();
    expect(fileMentionAtCursor("@a@b", 4)).toBeNull();
    expect(fileMentionAtCursor("no mention", 10)).toBeNull();
    expect(fileMentionAtCursor("", 0)).toBeNull();
  });

  it("clamps a caret outside the draft and reads only the text before the caret", () => {
    expect(fileMentionAtCursor("@abc def", 99)).toBeNull();
    expect(fileMentionAtCursor("@abc def", -5)).toBeNull();
    expect(fileMentionAtCursor("x @abc", 4)).toEqual({ start: 2, end: 4, query: "a" });
  });

  it("writes a path with whitespace quoted, so it stays one token", () => {
    expect(fileMentionText("src/app.ts")).toBe("@src/app.ts");
    expect(fileMentionText("docs/My Notes.md")).toBe('@"docs/My Notes.md"');
  });

  it("replaces the mention under the caret and places the caret behind it", () => {
    const mention = { start: 8, end: 13, query: "src/" };
    expect(insertFileMention("look at @src/ and more", mention, "src/app.ts")).toEqual({
      value: "look at @src/app.ts and more",
      cursor: 19,
    });
    // At the end of the draft a separating space is added; before punctuation none is.
    expect(insertFileMention("see @a", { start: 4, end: 6, query: "a" }, "a.ts")).toEqual({
      value: "see @a.ts ",
      cursor: 10,
    });
    expect(insertFileMention("see @a.", { start: 4, end: 6, query: "a" }, "a.ts").value).toBe(
      "see @a.ts.",
    );
  });

  it("recognizes a mention as a whole token only", () => {
    expect(draftMentionsPath("look at @src/app.ts please", "src/app.ts")).toBe(true);
    expect(draftMentionsPath("@src/app.ts", "src/app.ts")).toBe(true);
    expect(draftMentionsPath("and (@src/app.ts).", "src/app.ts")).toBe(true);
    expect(draftMentionsPath('@"docs/My Notes.md" too', "docs/My Notes.md")).toBe(true);
    expect(draftMentionsPath("look at @src/app.tsx", "src/app.ts")).toBe(false);
    expect(draftMentionsPath("look at xsrc/app.ts", "src/app.ts")).toBe(false);
    expect(draftMentionsPath("look at x@src/app.ts", "src/app.ts")).toBe(false);
    expect(draftMentionsPath("look at @src/appXts", "src/app.ts")).toBe(false);
    expect(draftMentionsPath("", "src/app.ts")).toBe(false);
  });

  it("removes only the named token and tidies the spacing", () => {
    expect(removeFileMention("look at @a.ts and @b.ts", "a.ts")).toBe("look at and @b.ts");
    expect(removeFileMention("@a.ts", "a.ts")).toBe("");
    expect(removeFileMention("keep @a.tsx", "a.ts")).toBe("keep @a.tsx");
  });
});

describe("references a draft sends", () => {
  it("sends the picked files the draft still names, once each, in the order picked", () => {
    expect(referencesInDraft("see @b.ts then @a.ts", ["a.ts", "b.ts", "a.ts", "gone.ts"])).toEqual([
      { path: "a.ts" },
      { path: "b.ts" },
    ]);
  });

  it("sends nothing for a file whose mention the human deleted, nor for an unpicked mention", () => {
    expect(referencesInDraft("no mention here", ["a.ts"])).toEqual([]);
    expect(referencesInDraft("typed @c.ts by hand", ["a.ts"])).toEqual([]);
    expect(referencesInDraft("@a.ts", [])).toEqual([]);
  });

  it("stops at the contract's bound of sixteen files", () => {
    const picked = Array.from({ length: 20 }, (_, index) => `f${String(index)}.ts`);
    const draft = picked.map((path) => `@${path}`).join(" ");
    expect(referencesInDraft(draft, picked)).toHaveLength(16);
    expect(canPickReference(picked.slice(0, 15), "next.ts")).toBe(true);
    expect(canPickReference(picked.slice(0, 16), "next.ts")).toBe(false);
  });

  it("refuses to pick a repeated file or a path the contract would refuse", () => {
    expect(canPickReference(["a.ts"], "a.ts")).toBe(false);
    for (const path of ["../a.ts", "/etc/hosts", "a//b", "a\\b", ""]) {
      expect(canPickReference([], path), path).toBe(false);
    }
  });
});

describe("search results as workspace-relative references", () => {
  it("keeps a path found in the searched root, tolerating trailing slashes", () => {
    expect(
      workspaceRelativeReferencePath("/work/space", { root: "/work/space", path: "a/b.ts" }),
    ).toBe("a/b.ts");
    expect(
      workspaceRelativeReferencePath("/work/space/", { root: "/work/space", path: "a.ts" }),
    ).toBe("a.ts");
  });

  it("joins a hit rebased onto a nested Git root back onto the searched root", () => {
    expect(
      workspaceRelativeReferencePath("/work/space", {
        root: "/work/space/packages/lib",
        path: "src/index.ts",
      }),
    ).toBe("packages/lib/src/index.ts");
  });

  it("drops a result outside the searched root or one the contract would refuse", () => {
    expect(
      workspaceRelativeReferencePath("/work/space", { root: "/work/other", path: "a.ts" }),
    ).toBeNull();
    expect(
      workspaceRelativeReferencePath("/work/space", { root: "/work/space-evil", path: "a.ts" }),
    ).toBeNull();
    expect(
      workspaceRelativeReferencePath("/work/space", { root: "/work/space", path: "../a.ts" }),
    ).toBeNull();
    expect(
      workspaceRelativeReferencePath("/work/space", { root: "/work/space", path: "/etc/hosts" }),
    ).toBeNull();
  });

  it("shapes the picker option from the workspace-relative path", () => {
    expect(
      fileReferenceOption("/work/space", {
        root: "/work/space/pkg",
        path: "src/app.ts",
        name: "app.ts",
      }),
    ).toEqual({ path: "pkg/src/app.ts", name: "app.ts", directory: "pkg/src" });
    expect(
      fileReferenceOption("/work/space", {
        root: "/work/space",
        path: "README.md",
        name: "README.md",
      }),
    ).toEqual({ path: "README.md", name: "README.md", directory: "" });
    expect(
      fileReferenceOption("/work/space", { root: "/x", path: "a.ts", name: "a.ts" }),
    ).toBeNull();
  });
});
