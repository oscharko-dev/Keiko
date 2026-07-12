import { describe, expect, it } from "vitest";

import { translateFilesWidget } from "./files-widget-i18n";

describe("files widget translations", () => {
  it("translates Git decoration labels in English and German", () => {
    expect(translateFilesWidget("en", "git.change.conflicted", { path: "src/app.ts" })).toBe(
      "Git conflict: src/app.ts",
    );
    expect(translateFilesWidget("de", "git.change.conflicted", { path: "src/app.ts" })).toBe(
      "Git-Konflikt: src/app.ts",
    );
    expect(translateFilesWidget("en", "git.folder.deleted", { count: 2 })).toBe(
      "Folder contains 2 Git changes, including deleted files",
    );
    expect(translateFilesWidget("de", "git.ignored")).toBe("Von Git ignoriert");
  });
});
