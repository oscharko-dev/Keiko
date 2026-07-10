import { describe, expect, it } from "vitest";
import {
  LOCAL_KNOWLEDGE_FILE_FILTERS,
  LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS,
} from "./local-knowledge-file-selection.js";
import {
  NATIVE_FILE_DIALOG_MAX_EXTENSIONS_PER_FILTER,
  NATIVE_FILE_DIALOG_MAX_FILTERS,
} from "./native-file-dialog.js";

describe("Local Knowledge file-selection contract", () => {
  it("keeps every native picker filter within the dialog contract", () => {
    expect(LOCAL_KNOWLEDGE_FILE_FILTERS.length).toBeLessThanOrEqual(NATIVE_FILE_DIALOG_MAX_FILTERS);
    for (const filter of LOCAL_KNOWLEDGE_FILE_FILTERS) {
      expect(filter.extensions.length).toBeGreaterThan(0);
      expect(filter.extensions.length).toBeLessThanOrEqual(
        NATIVE_FILE_DIALOG_MAX_EXTENSIONS_PER_FILTER,
      );
    }
  });

  it("lists each supported extension once and keeps textual parser extensions selectable", () => {
    const extensions = LOCAL_KNOWLEDGE_FILE_FILTERS.flatMap((filter) => filter.extensions);
    expect(new Set(extensions).size).toBe(extensions.length);
    for (const extension of LOCAL_KNOWLEDGE_TEXT_FILE_EXTENSIONS) {
      expect(extensions).toContain(extension);
    }
  });
});
