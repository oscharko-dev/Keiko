import { describe, expect, it } from "vitest";

import { SUPPORTED_EDITOR_LANGUAGES, isSupportedEditorLanguage } from "./languages.js";

describe("SUPPORTED_EDITOR_LANGUAGES", () => {
  it("lists the v1 first-class source languages plus plaintext", () => {
    expect([...SUPPORTED_EDITOR_LANGUAGES]).toEqual(["typescript", "javascript", "plaintext"]);
  });
});

describe("isSupportedEditorLanguage", () => {
  it("accepts every supported language", () => {
    for (const language of SUPPORTED_EDITOR_LANGUAGES) {
      expect(isSupportedEditorLanguage(language)).toBe(true);
    }
  });

  it("rejects an unsupported language", () => {
    expect(isSupportedEditorLanguage("python")).toBe(false);
  });

  it("rejects a non-language string", () => {
    expect(isSupportedEditorLanguage("")).toBe(false);
  });
});
