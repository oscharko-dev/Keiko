import { describe, expect, it } from "vitest";

import {
  EDITOR_BUILTIN_CAPABILITIES,
  EDITOR_BUILTIN_CAPABILITY_BY_LANGUAGE,
  editorBuiltinCapability,
  editorBuiltinDocumentFormatting,
  isBuiltinFormattingAvailable,
  type EditorBuiltinFormattingSource,
} from "./editor-builtin-capabilities.js";
import { EDITOR_LANGUAGE_MODE_IDS, EDITOR_LANGUAGE_MODE_MAP } from "./editor-language-mode-map.js";

const LEGAL_SOURCES: readonly EditorBuiltinFormattingSource[] = [
  "monaco-builtin",
  "keiko-language-service",
  "none",
];

function idsWithFormatting(source: EditorBuiltinFormattingSource): readonly string[] {
  return EDITOR_BUILTIN_CAPABILITIES.filter(
    (capability) => capability.documentFormatting === source,
  )
    .map((capability) => capability.languageId)
    .sort((a, b) => a.localeCompare(b));
}

describe("EDITOR_BUILTIN_CAPABILITIES exhaustiveness (ADR-0068 D6)", () => {
  it("covers exactly the source-language universe — no missing id, no stray id", () => {
    const registryIds = [...EDITOR_BUILTIN_CAPABILITIES.map((c) => c.languageId)].sort((a, b) =>
      a.localeCompare(b),
    );
    const modeMapIds = [...EDITOR_LANGUAGE_MODE_IDS].sort((a, b) => a.localeCompare(b));
    expect(registryIds).toEqual(modeMapIds);
  });

  it("has no duplicate language ids", () => {
    const ids = EDITOR_BUILTIN_CAPABILITIES.map((c) => c.languageId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("intentionally excludes plaintext (ADR-0067 D5 fallback)", () => {
    expect(editorBuiltinCapability("plaintext")).toBeNull();
  });
});

describe("EDITOR_BUILTIN_CAPABILITIES syntax + bracket invariants", () => {
  it("marks every language syntaxHighlighting:true, matching the mode map", () => {
    const modeMapHighlight = new Map(
      EDITOR_LANGUAGE_MODE_MAP.map((mode) => [mode.languageId, mode.syntaxHighlighting]),
    );
    for (const capability of EDITOR_BUILTIN_CAPABILITIES) {
      expect(capability.syntaxHighlighting).toBe(true);
      expect(capability.syntaxHighlighting).toBe(modeMapHighlight.get(capability.languageId));
    }
  });

  it("marks every language bracketMatching:true (global Monaco bracket config)", () => {
    for (const capability of EDITOR_BUILTIN_CAPABILITIES) {
      expect(capability.bracketMatching).toBe(true);
    }
  });

  it("declares only legal documentFormatting sources", () => {
    for (const capability of EDITOR_BUILTIN_CAPABILITIES) {
      expect(LEGAL_SOURCES).toContain(capability.documentFormatting);
    }
  });
});

describe("documentFormatting split (ADR-0068 D1 truth table)", () => {
  it("routes exactly ts/js through the Keiko language service", () => {
    expect(idsWithFormatting("keiko-language-service")).toEqual(["javascript", "typescript"]);
  });

  it("routes exactly json/css/scss/less/html through Monaco's bundled workers", () => {
    expect(idsWithFormatting("monaco-builtin")).toEqual(["css", "html", "json", "less", "scss"]);
  });

  it("leaves the remaining languages with no reachable browser formatter", () => {
    expect(idsWithFormatting("none")).toEqual([
      "go",
      "java",
      "markdown",
      "python",
      "rust",
      "shell",
      "sql",
      "yaml",
    ]);
  });

  it("partitions the whole universe — the three sets are disjoint and total", () => {
    const total =
      idsWithFormatting("keiko-language-service").length +
      idsWithFormatting("monaco-builtin").length +
      idsWithFormatting("none").length;
    expect(total).toBe(EDITOR_BUILTIN_CAPABILITIES.length);
    expect(total).toBe(EDITOR_LANGUAGE_MODE_IDS.length);
  });
});

describe("EDITOR_BUILTIN_CAPABILITY_BY_LANGUAGE", () => {
  it("derives an entry for every registry language, identity-equal to the table entry", () => {
    expect(
      Object.keys(EDITOR_BUILTIN_CAPABILITY_BY_LANGUAGE).sort((a, b) => a.localeCompare(b)),
    ).toEqual(
      [...EDITOR_BUILTIN_CAPABILITIES.map((c) => c.languageId)].sort((a, b) => a.localeCompare(b)),
    );
    for (const capability of EDITOR_BUILTIN_CAPABILITIES) {
      expect(EDITOR_BUILTIN_CAPABILITY_BY_LANGUAGE[capability.languageId]).toBe(capability);
    }
  });
});

describe("editorBuiltinCapability", () => {
  it("returns the capability for a known id", () => {
    expect(editorBuiltinCapability("typescript")).toEqual({
      languageId: "typescript",
      syntaxHighlighting: true,
      bracketMatching: true,
      documentFormatting: "keiko-language-service",
    });
  });

  it("returns null for an unknown id and for the empty string", () => {
    expect(editorBuiltinCapability("cobol")).toBeNull();
    expect(editorBuiltinCapability("")).toBeNull();
    expect(editorBuiltinCapability("plaintext")).toBeNull();
  });
});

describe("editorBuiltinDocumentFormatting", () => {
  it("reports the source for known ids", () => {
    expect(editorBuiltinDocumentFormatting("json")).toBe("monaco-builtin");
    expect(editorBuiltinDocumentFormatting("javascript")).toBe("keiko-language-service");
    expect(editorBuiltinDocumentFormatting("yaml")).toBe("none");
  });

  it("returns 'none' for unknown ids (safe-degrade)", () => {
    expect(editorBuiltinDocumentFormatting("cobol")).toBe("none");
    expect(editorBuiltinDocumentFormatting("plaintext")).toBe("none");
    expect(editorBuiltinDocumentFormatting("")).toBe("none");
  });
});

describe("isBuiltinFormattingAvailable", () => {
  it("is true for monaco-builtin and keiko-language-service languages", () => {
    expect(isBuiltinFormattingAvailable("css")).toBe(true);
    expect(isBuiltinFormattingAvailable("typescript")).toBe(true);
  });

  it("is false for 'none' languages and unknown ids", () => {
    expect(isBuiltinFormattingAvailable("markdown")).toBe(false);
    expect(isBuiltinFormattingAvailable("python")).toBe(false);
    expect(isBuiltinFormattingAvailable("cobol")).toBe(false);
    expect(isBuiltinFormattingAvailable("plaintext")).toBe(false);
  });
});

describe("deep immutability (frozen registry)", () => {
  it("freezes the table array and every entry", () => {
    expect(Object.isFrozen(EDITOR_BUILTIN_CAPABILITIES)).toBe(true);
    for (const capability of EDITOR_BUILTIN_CAPABILITIES) {
      expect(Object.isFrozen(capability)).toBe(true);
    }
    expect(Object.isFrozen(EDITOR_BUILTIN_CAPABILITY_BY_LANGUAGE)).toBe(true);
  });

  it("rejects mutation of an entry in strict mode", () => {
    const [first] = EDITOR_BUILTIN_CAPABILITIES;
    expect(first).toBeDefined();
    expect(() => {
      (first as { documentFormatting: EditorBuiltinFormattingSource }).documentFormatting = "none";
    }).toThrow(TypeError);
  });

  it("rejects mutation of the derived index in strict mode", () => {
    expect(() => {
      (EDITOR_BUILTIN_CAPABILITY_BY_LANGUAGE as Record<string, unknown>).cobol = {};
    }).toThrow(TypeError);
  });
});
