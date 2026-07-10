import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  LANGUAGE_SERVICE_ERROR_CODES,
  LANGUAGE_RENAME_CHANGESET_SCHEMA_VERSION,
  MAX_LANGUAGE_FORMATTING_TAB_SIZE,
  LANGUAGE_SERVICE_OPERATIONS,
  LANGUAGE_SERVICE_SCHEMA_VERSION,
  isLanguageDiagnostic,
  isLanguageDocumentOverlay,
  isLanguageFormattingOptions,
  isLanguagePosition,
  isLanguageRange,
  parseLanguageServiceRequest,
  type LanguageDiagnostic,
  type LanguageDocumentOverlay,
  type LanguagePosition,
  type LanguageRenameChangeset,
  type LanguageRange,
} from "./language-service.js";

function overlay(): LanguageDocumentOverlay {
  return { path: "src/a.ts", languageId: "typescript", text: "const a = 1;\n" };
}

function position(): LanguagePosition {
  return { line: 0, character: 6 };
}

function range(): LanguageRange {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } };
}

function diagnostic(): LanguageDiagnostic {
  return {
    range: range(),
    severity: "error",
    message: "Missing import",
    source: "typescript",
    code: "2304",
  };
}

describe("language-service schema, operations, and error codes", () => {
  it("pins the schema version", () => {
    expect(LANGUAGE_SERVICE_SCHEMA_VERSION).toBe("1");
  });

  it("enumerates the governed operations in a fixed order", () => {
    expect(LANGUAGE_SERVICE_OPERATIONS).toEqual([
      "diagnostics",
      "completion",
      "hover",
      "symbols",
      "formatting",
      "definition",
      "typeDefinition",
      "implementation",
      "references",
      "callHierarchy",
      "inlayHints",
      "renamePrepare",
      "renameApply",
      "codeActions",
      "signatureHelp",
    ]);
  });

  it("enumerates the stable error codes in a fixed order", () => {
    expect(LANGUAGE_SERVICE_ERROR_CODES).toEqual([
      "INVALID_REQUEST",
      "UNSUPPORTED_LANGUAGE",
      "UNSUPPORTED_OPERATION",
      "DOCUMENT_TOO_LARGE",
      "DENIED",
      "CANCELLED",
      "TIMED_OUT",
    ]);
  });

  it("pins the default limit table", () => {
    expect(DEFAULT_LANGUAGE_SERVICE_LIMITS).toEqual({
      maxDocumentBytes: 1_000_000,
      maxCompletionItems: 256,
      maxDiagnostics: 512,
      maxSymbols: 512,
      maxFormattingEdits: 4_096,
      maxDefinitionLocations: 64,
      maxReferenceLocations: 512,
      maxCallHierarchyItems: 128,
      maxCallHierarchyCallSites: 512,
      maxInlayHints: 512,
      maxCodeActions: 32,
      maxSignatures: 32,
      maxRenameChangesetFiles: 128,
      maxRenameChangesetEdits: 4_096,
      maxHoverChars: 4_096,
      maxLabelChars: 256,
      maxDetailChars: 1_024,
      maxDocumentationChars: 4_096,
      maxMessageChars: 2_048,
      maxWorkspaceReadBytes: 4_000_000,
      maxWorkspaceReadFileBytes: 1_000_000,
      maxWorkspaceReadFiles: 256,
      deadlineMs: 2_000,
    });
  });
});

describe("isLanguageRange", () => {
  it("accepts a range with zero-based start and end positions", () => {
    expect(isLanguageRange(range())).toBe(true);
  });

  it("rejects missing or malformed positions", () => {
    expect(isLanguageRange({ start: position() })).toBe(false);
    expect(isLanguageRange({ start: position(), end: { line: -1, character: 0 } })).toBe(false);
    expect(
      isLanguageRange({ start: { line: 1, character: 0 }, end: { line: 0, character: 0 } }),
    ).toBe(false);
    expect(isLanguageRange("0:0-0:1")).toBe(false);
  });
});

describe("isLanguagePosition", () => {
  it("accepts a zero-based position and the zero boundary", () => {
    expect(isLanguagePosition(position())).toBe(true);
    expect(isLanguagePosition({ line: 0, character: 0 })).toBe(true);
  });

  it("rejects negative, fractional, and missing offsets", () => {
    expect(isLanguagePosition({ line: -1, character: 0 })).toBe(false);
    expect(isLanguagePosition({ line: 0, character: 1.5 })).toBe(false);
    expect(isLanguagePosition({ line: 0 })).toBe(false);
    expect(isLanguagePosition("0:0")).toBe(false);
  });
});

describe("isLanguageDiagnostic", () => {
  it("accepts a well-formed diagnostic", () => {
    expect(isLanguageDiagnostic(diagnostic())).toBe(true);
  });

  it("rejects malformed nested fields", () => {
    expect(isLanguageDiagnostic({ ...diagnostic(), severity: "fatal" })).toBe(false);
    expect(isLanguageDiagnostic({ ...diagnostic(), range: { start: position() } })).toBe(false);
    expect(isLanguageDiagnostic({ ...diagnostic(), message: "" })).toBe(false);
    expect(isLanguageDiagnostic({ ...diagnostic(), code: 2304 })).toBe(false);
  });
});

describe("isLanguageDocumentOverlay", () => {
  it("accepts a well-formed overlay, including empty buffer text", () => {
    expect(isLanguageDocumentOverlay(overlay())).toBe(true);
    expect(isLanguageDocumentOverlay({ ...overlay(), text: "" })).toBe(true);
  });

  it("rejects an empty path, empty languageId, or non-string text", () => {
    expect(isLanguageDocumentOverlay({ ...overlay(), path: "" })).toBe(false);
    expect(isLanguageDocumentOverlay({ ...overlay(), languageId: "" })).toBe(false);
    expect(isLanguageDocumentOverlay({ ...overlay(), text: 1 })).toBe(false);
    expect(isLanguageDocumentOverlay(null)).toBe(false);
  });
});

describe("parseLanguageServiceRequest", () => {
  it("parses a diagnostics request without a position", () => {
    const result = parseLanguageServiceRequest({
      operation: "diagnostics",
      root: "/repo",
      document: overlay(),
    });
    expect(result).toEqual({
      ok: true,
      value: { operation: "diagnostics", root: "/repo", document: overlay() },
    });
  });

  it("parses a completion request and retains the position", () => {
    const result = parseLanguageServiceRequest({
      operation: "completion",
      root: "/repo",
      document: overlay(),
      position: position(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        operation: "completion",
        root: "/repo",
        document: overlay(),
        position: position(),
      });
    }
  });

  it("parses the additive navigation and hierarchy position operations", () => {
    for (const operation of ["typeDefinition", "implementation", "callHierarchy"] as const) {
      const result = parseLanguageServiceRequest({
        operation,
        root: "/repo",
        document: overlay(),
        position: position(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toMatchObject({ operation, position: position() });
    }
  });

  it("parses an inlay-hints range request", () => {
    const result = parseLanguageServiceRequest({
      operation: "inlayHints",
      root: "/repo",
      document: overlay(),
      range: range(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ operation: "inlayHints", range: range() });
  });

  it("parses a hover request and a symbols request", () => {
    const hover = parseLanguageServiceRequest({
      operation: "hover",
      root: "/repo",
      document: overlay(),
      position: position(),
    });
    const symbols = parseLanguageServiceRequest({
      operation: "symbols",
      root: "/repo",
      document: overlay(),
    });
    expect(hover.ok).toBe(true);
    expect(symbols.ok).toBe(true);
  });

  it("does not retain a position for operations that do not use one", () => {
    const result = parseLanguageServiceRequest({
      operation: "diagnostics",
      root: "/repo",
      document: overlay(),
      position: position(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("position" in result.value).toBe(false);
    }
  });

  it("rejects an unknown operation with the allowed set in the message", () => {
    const result = parseLanguageServiceRequest({
      operation: "rename",
      root: "/repo",
      document: overlay(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain("operation must be one of");
    }
  });

  it("rejects a missing root and a malformed document together", () => {
    const result = parseLanguageServiceRequest({
      operation: "diagnostics",
      root: "",
      document: { path: "a.ts" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        "root must be a non-empty string",
        "document must be { path, languageId, text }",
      ]);
    }
  });

  it("requires a position for completion and hover", () => {
    const completion = parseLanguageServiceRequest({
      operation: "completion",
      root: "/repo",
      document: overlay(),
    });
    expect(completion.ok).toBe(false);
    if (!completion.ok) {
      expect(completion.errors).toContain("position must be { line, character }");
    }
    const hover = parseLanguageServiceRequest({
      operation: "hover",
      root: "/repo",
      document: overlay(),
    });
    expect(hover.ok).toBe(false);
    if (!hover.ok) {
      expect(hover.errors).toContain("position must be { line, character }");
    }
  });

  it("rejects a non-object payload", () => {
    expect(parseLanguageServiceRequest(null).ok).toBe(false);
    expect(parseLanguageServiceRequest("x").ok).toBe(false);
  });

  it("parses a formatting request without options (provider default)", () => {
    const result = parseLanguageServiceRequest({
      operation: "formatting",
      root: "/repo",
      document: overlay(),
    });
    expect(result).toEqual({
      ok: true,
      value: { operation: "formatting", root: "/repo", document: overlay() },
    });
  });

  it("parses a formatting request and retains well-typed options", () => {
    const result = parseLanguageServiceRequest({
      operation: "formatting",
      root: "/repo",
      document: overlay(),
      options: { tabSize: 4, insertSpaces: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        operation: "formatting",
        root: "/repo",
        document: overlay(),
        options: { tabSize: 4, insertSpaces: true },
      });
    }
  });

  it("rejects malformed formatting options", () => {
    const result = parseLanguageServiceRequest({
      operation: "formatting",
      root: "/repo",
      document: overlay(),
      options: { tabSize: 0 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("options must be { tabSize?, insertSpaces? }");
    }
  });

  it("does not require a position for formatting", () => {
    const result = parseLanguageServiceRequest({
      operation: "formatting",
      root: "/repo",
      document: overlay(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("position" in result.value).toBe(false);
    }
  });

  it.each([
    ["definition", { position: position() }],
    ["references", { position: position() }],
    ["renamePrepare", { position: position() }],
    ["signatureHelp", { position: position() }],
  ] as const)("parses a %s request and retains the position", (operation, fields) => {
    const result = parseLanguageServiceRequest({
      operation,
      root: "/repo",
      document: overlay(),
      ...fields,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ operation, root: "/repo", document: overlay(), ...fields });
    }
  });

  it("parses a renameApply request and retains the new name", () => {
    const result = parseLanguageServiceRequest({
      operation: "renameApply",
      root: "/repo",
      document: overlay(),
      position: position(),
      newName: "renamedSymbol",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        operation: "renameApply",
        root: "/repo",
        document: overlay(),
        position: position(),
        newName: "renamedSymbol",
      });
    }
  });

  it("parses a codeActions request and retains the range and diagnostics", () => {
    const result = parseLanguageServiceRequest({
      operation: "codeActions",
      root: "/repo",
      document: overlay(),
      range: range(),
      diagnostics: [diagnostic()],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        operation: "codeActions",
        root: "/repo",
        document: overlay(),
        range: range(),
        diagnostics: [diagnostic()],
      });
    }
  });

  it.each([
    ["definition", "position must be { line, character }"],
    ["references", "position must be { line, character }"],
    ["renamePrepare", "position must be { line, character }"],
    ["renameApply", "position must be { line, character }"],
    ["signatureHelp", "position must be { line, character }"],
  ] as const)("requires a position for %s", (operation, error) => {
    const result = parseLanguageServiceRequest({
      operation,
      root: "/repo",
      document: overlay(),
      newName: operation === "renameApply" ? "renamedSymbol" : undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(error);
    }
  });

  it("requires a non-empty newName for renameApply", () => {
    const result = parseLanguageServiceRequest({
      operation: "renameApply",
      root: "/repo",
      document: overlay(),
      position: position(),
      newName: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("newName must be a non-empty string");
    }
  });

  it("requires newName for renameApply", () => {
    const result = parseLanguageServiceRequest({
      operation: "renameApply",
      root: "/repo",
      document: overlay(),
      position: position(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("newName must be a non-empty string");
    }
  });

  it.each(["definition", "references", "renamePrepare", "renameApply", "signatureHelp"] as const)(
    "rejects a wrong-typed position for %s",
    (operation) => {
      const result = parseLanguageServiceRequest({
        operation,
        root: "/repo",
        document: overlay(),
        position: "not-an-object",
        newName: operation === "renameApply" ? "renamedSymbol" : undefined,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContain("position must be { line, character }");
      }
    },
  );

  it("rejects a wrong-typed newName for renameApply", () => {
    const result = parseLanguageServiceRequest({
      operation: "renameApply",
      root: "/repo",
      document: overlay(),
      position: position(),
      newName: 123,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("newName must be a non-empty string");
    }
  });

  it("requires a range and diagnostics for codeActions", () => {
    const result = parseLanguageServiceRequest({
      operation: "codeActions",
      root: "/repo",
      document: overlay(),
      range: { start: position() },
      diagnostics: [{ ...diagnostic(), severity: "fatal" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        "range must be { start, end }",
        "diagnostics must be an array of LanguageDiagnostic",
      ]);
    }
  });

  it("requires a range for codeActions", () => {
    const result = parseLanguageServiceRequest({
      operation: "codeActions",
      root: "/repo",
      document: overlay(),
      diagnostics: [diagnostic()],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("range must be { start, end }");
    }
  });

  it("requires diagnostics for codeActions", () => {
    const result = parseLanguageServiceRequest({
      operation: "codeActions",
      root: "/repo",
      document: overlay(),
      range: range(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("diagnostics must be an array of LanguageDiagnostic");
    }
  });

  it("rejects a wrong-typed range and a wrong-typed diagnostics list for codeActions", () => {
    const result = parseLanguageServiceRequest({
      operation: "codeActions",
      root: "/repo",
      document: overlay(),
      range: "0:0",
      diagnostics: "nope",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        "range must be { start, end }",
        "diagnostics must be an array of LanguageDiagnostic",
      ]);
    }
  });
});

describe("LanguageRenameChangeset", () => {
  it("constructs a two-file reviewable rename changeset with per-file content hashes", () => {
    const changeset: LanguageRenameChangeset = {
      schemaVersion: LANGUAGE_RENAME_CHANGESET_SCHEMA_VERSION,
      files: [
        {
          path: "src/a.ts",
          edits: [{ range: range(), newText: "renamedSymbol" }],
          expectedContentHash: "a".repeat(64),
        },
        {
          path: "src/b.ts",
          edits: [{ range: range(), newText: "renamedSymbol" }],
          expectedContentHash: "b".repeat(64),
        },
      ],
      truncated: false,
      filesTruncated: false,
      returnedFileCount: 2,
      totalFileCount: 2,
      returnedEditCount: 2,
      totalEditCount: 2,
    };

    expect(changeset.files).toHaveLength(2);
    expect(changeset.files[0]?.expectedContentHash).toHaveLength(64);
  });
});

describe("isLanguageFormattingOptions", () => {
  it("accepts an empty block and partial well-typed fields", () => {
    expect(isLanguageFormattingOptions({})).toBe(true);
    expect(isLanguageFormattingOptions({ tabSize: 2 })).toBe(true);
    expect(isLanguageFormattingOptions({ insertSpaces: false })).toBe(true);
    expect(isLanguageFormattingOptions({ tabSize: 8, insertSpaces: true })).toBe(true);
  });

  it("rejects a non-record, a zero/fractional/oversized tab size, and non-boolean insertSpaces", () => {
    expect(isLanguageFormattingOptions(null)).toBe(false);
    expect(isLanguageFormattingOptions({ tabSize: 0 })).toBe(false);
    expect(isLanguageFormattingOptions({ tabSize: 2.5 })).toBe(false);
    expect(isLanguageFormattingOptions({ tabSize: MAX_LANGUAGE_FORMATTING_TAB_SIZE + 1 })).toBe(
      false,
    );
    expect(isLanguageFormattingOptions({ insertSpaces: "yes" })).toBe(false);
  });
});
