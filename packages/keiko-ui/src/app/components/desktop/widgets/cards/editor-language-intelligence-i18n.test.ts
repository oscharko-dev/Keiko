import { describe, expect, it } from "vitest";

import {
  EDITOR_LANGUAGE_OPERATIONS,
  type EditorLanguageOperation,
} from "@oscharko-dev/keiko-editor";

import {
  editorLanguageIntelligenceStatus,
  operationMessageKey,
  translateEditorLanguageIntelligence,
  type EditorLanguageIntelligenceMessageKey,
} from "./editor-language-intelligence-i18n";

function translator(
  locale: "en" | "de",
): (key: EditorLanguageIntelligenceMessageKey, values?: Record<string, string | number>) => string {
  return (key, values) => translateEditorLanguageIntelligence(locale, key, values);
}

describe("operation catalog coverage", () => {
  // Derived from the editor package's own operation list rather than a hand-copied array: a new
  // Monaco bridge must not be able to reach the status bar with an untranslated `{operation}` hole.
  it("names every language-intelligence operation in both locales", () => {
    for (const operation of EDITOR_LANGUAGE_OPERATIONS) {
      const key = operationMessageKey(operation);
      expect(translateEditorLanguageIntelligence("en", key)).not.toBe("");
      expect(translateEditorLanguageIntelligence("de", key)).not.toBe("");
      expect(translateEditorLanguageIntelligence("de", key)).not.toContain("{");
    }
  });

  it("uses a distinct German label per operation", () => {
    const german = EDITOR_LANGUAGE_OPERATIONS.map((operation) =>
      translateEditorLanguageIntelligence("de", operationMessageKey(operation)),
    );
    expect(new Set(german).size).toBe(german.length);
  });
});

describe("editorLanguageIntelligenceStatus", () => {
  it("returns undefined when there is nothing to say", () => {
    expect(editorLanguageIntelligenceStatus(null, translator("en"))).toBeUndefined();
  });

  it("names a single failing operation in English", () => {
    const status = editorLanguageIntelligenceStatus(
      { status: "failed", operation: "hover", operationCount: 1 },
      translator("en"),
    );

    expect(status).toEqual({
      status: "failed",
      label: "Quick info unavailable",
      ariaLabel: "Quick info did not answer. Results shown may be incomplete or absent.",
    });
  });

  it("names a single failing operation in German", () => {
    const status = editorLanguageIntelligenceStatus(
      { status: "failed", operation: "hover", operationCount: 1 },
      translator("de"),
    );

    expect(status?.label).toBe("Kurzinfo nicht verfügbar");
    expect(status?.ariaLabel).toContain("Kurzinfo hat nicht geantwortet");
  });

  it("counts the remaining operations rather than listing them", () => {
    const status = editorLanguageIntelligenceStatus(
      { status: "failed", operation: "diagnostics", operationCount: 3 },
      translator("en"),
    );

    expect(status?.label).toBe("Problems and 2 more unavailable");
    expect(status?.ariaLabel).toContain("2 more language features did not answer");
  });

  it("distinguishes a capped result from a failure", () => {
    const capped = editorLanguageIntelligenceStatus(
      { status: "capped", operation: "references", operationCount: 1 },
      translator("en"),
    );

    expect(capped).toEqual({
      status: "capped",
      label: "Find references partial",
      ariaLabel: "Find references returned a partial result because a result limit was reached.",
    });
  });

  it("leaves no unresolved placeholder in any locale, status, or plurality", () => {
    const statuses: readonly ("failed" | "capped")[] = ["failed", "capped"];
    for (const locale of ["en", "de"] as const) {
      for (const status of statuses) {
        for (const operationCount of [1, 4]) {
          for (const operation of EDITOR_LANGUAGE_OPERATIONS satisfies readonly EditorLanguageOperation[]) {
            const rendered = editorLanguageIntelligenceStatus(
              { status, operation, operationCount },
              translator(locale),
            );
            expect(rendered?.label).not.toContain("{");
            expect(rendered?.ariaLabel).not.toContain("{");
          }
        }
      }
    }
  });
});
