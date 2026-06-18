import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  LANGUAGE_SERVICE_ERROR_CODES,
  LANGUAGE_SERVICE_OPERATIONS,
  LANGUAGE_SERVICE_SCHEMA_VERSION,
  isLanguageDocumentOverlay,
  isLanguagePosition,
  parseLanguageServiceRequest,
  type LanguageDocumentOverlay,
  type LanguagePosition,
} from "./language-service.js";

function overlay(): LanguageDocumentOverlay {
  return { path: "src/a.ts", languageId: "typescript", text: "const a = 1;\n" };
}

function position(): LanguagePosition {
  return { line: 0, character: 6 };
}

describe("language-service schema, operations, and error codes", () => {
  it("pins the schema version", () => {
    expect(LANGUAGE_SERVICE_SCHEMA_VERSION).toBe("1");
  });

  it("enumerates the governed operations in a fixed order", () => {
    expect(LANGUAGE_SERVICE_OPERATIONS).toEqual(["diagnostics", "completion", "hover", "symbols"]);
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
});
