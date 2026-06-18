import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE_SERVICE_LIMITS,
  type LanguageServiceLimits,
} from "@oscharko-dev/keiko-contracts";
import {
  sanitizeCompletion,
  sanitizeDiagnostics,
  sanitizeHover,
  sanitizeSymbols,
} from "./languageSanitize.js";

// A right-to-left override (bidi) and a zero-width space that must be stripped before display.
const BIDI = "\u202E";
const ZERO_WIDTH = "\u200B";

const tinyLimits: LanguageServiceLimits = {
  ...DEFAULT_LANGUAGE_SERVICE_LIMITS,
  maxLabelChars: 5,
  maxDetailChars: 5,
  maxDocumentationChars: 5,
  maxMessageChars: 5,
  maxHoverChars: 5,
};

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

describe("sanitizeCompletion", () => {
  it("strips unsafe characters and clips every string field", () => {
    const result = sanitizeCompletion(
      {
        items: [
          {
            label: `lbl${BIDI}abcdef`,
            kind: "function",
            detail: "detailabcdef",
            documentation: `doc${ZERO_WIDTH}abcdef`,
            insertText: "insertabcdef",
            sortText: "sortabcdef",
          },
        ],
        isIncomplete: false,
        truncated: false,
      },
      tinyLimits,
    );
    const [item] = result.items;
    expect(item?.label).toBe("lblab");
    expect(item?.label).not.toContain(BIDI);
    expect(item?.detail).toBe("detai");
    expect(item?.documentation).toBe("docab");
    expect(item?.documentation).not.toContain(ZERO_WIDTH);
    expect(item?.insertText).toBe("inser");
    expect(item?.sortText).toBe("sorta");
  });

  it("omits optional fields that are absent", () => {
    const result = sanitizeCompletion(
      { items: [{ label: "x", kind: "variable" }], isIncomplete: true, truncated: true },
      DEFAULT_LANGUAGE_SERVICE_LIMITS,
    );
    expect(result.items[0]).toEqual({ label: "x", kind: "variable" });
    expect(result.isIncomplete).toBe(true);
    expect(result.truncated).toBe(true);
  });
});

describe("sanitizeDiagnostics", () => {
  it("clips the message and preserves range, severity, and code", () => {
    const result = sanitizeDiagnostics(
      {
        diagnostics: [
          {
            range,
            severity: "error",
            message: `msg${BIDI}abcdef`,
            source: "typescript",
            code: "2322",
          },
        ],
        truncated: true,
      },
      tinyLimits,
    );
    expect(result.diagnostics[0]?.message).toBe("msgab");
    expect(result.diagnostics[0]?.message).not.toContain(BIDI);
    expect(result.diagnostics[0]?.severity).toBe("error");
    expect(result.diagnostics[0]?.code).toBe("2322");
    expect(result.truncated).toBe(true);
  });

  it("omits an absent diagnostic code", () => {
    const result = sanitizeDiagnostics(
      {
        diagnostics: [{ range, severity: "warning", message: "m", source: "typescript" }],
        truncated: false,
      },
      DEFAULT_LANGUAGE_SERVICE_LIMITS,
    );
    expect("code" in (result.diagnostics[0] ?? {})).toBe(false);
  });
});

describe("sanitizeHover", () => {
  it("clips non-null contents and keeps the range", () => {
    const result = sanitizeHover({ contents: `hov${BIDI}abcdef`, range }, tinyLimits);
    expect(result.contents).toBe("hovab");
    expect(result.range).toEqual(range);
  });

  it("passes a null hover through and omits the range when absent", () => {
    const result = sanitizeHover({ contents: null }, DEFAULT_LANGUAGE_SERVICE_LIMITS);
    expect(result).toEqual({ contents: null });
  });
});

describe("sanitizeSymbols", () => {
  it("clips the name, detail, and container name", () => {
    const result = sanitizeSymbols(
      {
        symbols: [
          {
            name: `nm${BIDI}abcdef`,
            kind: "function",
            range,
            detail: "detailabc",
            containerName: "containerabc",
          },
        ],
        truncated: false,
      },
      tinyLimits,
    );
    expect(result.symbols[0]?.name).toBe("nmabc");
    expect(result.symbols[0]?.detail).toBe("detai");
    expect(result.symbols[0]?.containerName).toBe("conta");
  });

  it("omits absent optional fields", () => {
    const result = sanitizeSymbols(
      { symbols: [{ name: "n", kind: "class", range }], truncated: false },
      DEFAULT_LANGUAGE_SERVICE_LIMITS,
    );
    expect(result.symbols[0]).toEqual({ name: "n", kind: "class", range });
  });
});
