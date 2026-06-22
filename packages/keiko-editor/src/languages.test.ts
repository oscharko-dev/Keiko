import { describe, expect, it } from "vitest";

import { SUPPORTED_EDITOR_LANGUAGES, isSupportedEditorLanguage } from "./languages.js";

describe("SUPPORTED_EDITOR_LANGUAGES", () => {
  it("lists the Monaco-renderable languages exposed by the editor host contract", () => {
    expect([...SUPPORTED_EDITOR_LANGUAGES]).toEqual([
      "typescript",
      "javascript",
      "json",
      "css",
      "scss",
      "less",
      "html",
      "markdown",
      "yaml",
      "python",
      "java",
      "go",
      "rust",
      "sql",
      "shell",
      "plaintext",
    ]);
  });
});

describe("isSupportedEditorLanguage", () => {
  it("accepts every supported language", () => {
    for (const language of SUPPORTED_EDITOR_LANGUAGES) {
      expect(isSupportedEditorLanguage(language)).toBe(true);
    }
  });

  it("rejects an unsupported language", () => {
    expect(isSupportedEditorLanguage("ruby")).toBe(false);
  });

  it("rejects a non-language string", () => {
    expect(isSupportedEditorLanguage("")).toBe(false);
  });
});
