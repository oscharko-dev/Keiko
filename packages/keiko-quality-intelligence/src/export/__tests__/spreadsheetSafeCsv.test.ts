// Spreadsheet-safe CSV cell encoder tests (Epic #270, Issue #283).
//
// These tests are the mutation-robustness gate for the formula-injection mitigation
// primitive. Every dangerous lead character must get the `'` prefix; RFC-4180 quoting
// must compose correctly with the prefix; and the whitespace-bypass path (L1) must be
// guarded so a cell like " =1+1" or a NBSP-prefixed formula is caught.

import { describe, expect, it } from "vitest";
import {
  encodeSpreadsheetSafeCell,
  encodeSpreadsheetSafeRow,
  startsWithFormulaLead,
} from "../adapters/spreadsheetSafeCsv.js";

// ---------------------------------------------------------------------------
// startsWithFormulaLead
// ---------------------------------------------------------------------------

describe("startsWithFormulaLead", () => {
  it("returns false for an empty string", () => {
    expect(startsWithFormulaLead("")).toBe(false);
  });

  it("returns false for a plain value that does not start with a formula lead", () => {
    expect(startsWithFormulaLead("hello")).toBe(false);
  });

  it("returns true for '=' lead", () => {
    expect(startsWithFormulaLead("=SUM(A1)")).toBe(true);
  });

  it("returns true for '+' lead", () => {
    expect(startsWithFormulaLead("+CMD")).toBe(true);
  });

  it("returns true for '-' lead", () => {
    expect(startsWithFormulaLead("-1")).toBe(true);
  });

  it("returns true for '@' lead", () => {
    expect(startsWithFormulaLead("@SUM")).toBe(true);
  });

  it("returns true for TAB lead", () => {
    expect(startsWithFormulaLead("\tvalue")).toBe(true);
  });

  it("returns true for CR lead", () => {
    expect(startsWithFormulaLead("\rvalue")).toBe(true);
  });

  it("returns true for LF lead", () => {
    expect(startsWithFormulaLead("\nvalue")).toBe(true);
  });

  // L1: whitespace-bypass path — a leading whitespace run before a formula lead
  it("L1: returns true for space-prefixed '=' formula (whitespace bypass)", () => {
    expect(startsWithFormulaLead(" =1+1")).toBe(true);
  });

  it("L1: returns true for NBSP-prefixed '=' formula", () => {
    // NBSP is U+00A0
    expect(startsWithFormulaLead(" =SUM(A1)")).toBe(true);
  });

  it("L1: returns true for multiple spaces before '+'", () => {
    expect(startsWithFormulaLead("   +CMD")).toBe(true);
  });

  it("L1: returns true for figure-space (U+2007) before '@'", () => {
    expect(startsWithFormulaLead(" @func")).toBe(true);
  });

  it("L1: returns false for a value that is all whitespace", () => {
    // All whitespace — no formula lead after whitespace
    expect(startsWithFormulaLead("   ")).toBe(false);
  });

  it("L1: returns false when whitespace is followed by a safe character", () => {
    expect(startsWithFormulaLead(" hello")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// encodeSpreadsheetSafeCell — formula-injection mitigation
// ---------------------------------------------------------------------------

describe("encodeSpreadsheetSafeCell — formula lead prefixing", () => {
  it("prefixes '=' with single quote", () => {
    expect(encodeSpreadsheetSafeCell("=SUM")).toBe("'=SUM");
  });

  it("prefixes '+' with single quote", () => {
    expect(encodeSpreadsheetSafeCell("+CMD")).toBe("'+CMD");
  });

  it("prefixes '-' with single quote", () => {
    expect(encodeSpreadsheetSafeCell("-1")).toBe("'-1");
  });

  it("prefixes '@' with single quote", () => {
    expect(encodeSpreadsheetSafeCell("@SUM")).toBe("'@SUM");
  });

  it("prefixes TAB-lead with single quote", () => {
    expect(encodeSpreadsheetSafeCell("\tvalue")).toBe("'\tvalue");
  });

  it("prefixes CR-lead with single quote and wraps in quotes (RFC-4180)", () => {
    // '\r' is both a formula lead AND a character requiring quoting
    const result = encodeSpreadsheetSafeCell("\rvalue");
    expect(result.startsWith('"')).toBe(true);
    expect(result.endsWith('"')).toBe(true);
    expect(result).toContain("'");
    expect(result).toContain("value");
  });

  it("prefixes LF-lead with single quote and wraps in quotes (RFC-4180)", () => {
    const result = encodeSpreadsheetSafeCell("\nvalue");
    expect(result.startsWith('"')).toBe(true);
    expect(result.endsWith('"')).toBe(true);
    expect(result).toContain("'");
    expect(result).toContain("value");
  });

  // L1: whitespace-bypass guard
  it("L1: prefixes ' =1+1' (space before '=') with single quote", () => {
    expect(encodeSpreadsheetSafeCell(" =1+1")).toBe("' =1+1");
  });

  it("L1: prefixes NBSP-prefixed formula with single quote", () => {
    expect(encodeSpreadsheetSafeCell(" =SUM")).toBe("' =SUM");
  });

  it("does not modify a plain safe value", () => {
    expect(encodeSpreadsheetSafeCell("plain value")).toBe("plain value");
  });

  it("does not modify an empty string", () => {
    expect(encodeSpreadsheetSafeCell("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// encodeSpreadsheetSafeCell — RFC-4180 quoting
// ---------------------------------------------------------------------------

describe("encodeSpreadsheetSafeCell — RFC-4180 quoting", () => {
  it("wraps a value containing a comma in double quotes", () => {
    expect(encodeSpreadsheetSafeCell("a,b")).toBe('"a,b"');
  });

  it('wraps a value containing an embedded double-quote and doubles it (RFC-4180)', () => {
    expect(encodeSpreadsheetSafeCell('say "hello"')).toBe('"say ""hello"""');
  });

  it("composes formula-prefix and RFC-4180 quoting: =cmd|\"calc\" becomes \"'=cmd|\"\"calc\"\"\"", () => {
    // The cell starts with '=' → gets the ' prefix, then contains '"' → gets wrapped+doubled
    expect(encodeSpreadsheetSafeCell('=cmd|"calc"')).toBe('"\'=cmd|""calc"""');
  });

  it("wraps a value containing CR in double quotes", () => {
    const result = encodeSpreadsheetSafeCell("line1\rline2");
    expect(result.startsWith('"')).toBe(true);
    expect(result.endsWith('"')).toBe(true);
    expect(result).toContain("line1");
    expect(result).toContain("line2");
  });

  it("wraps a value containing LF in double quotes", () => {
    const result = encodeSpreadsheetSafeCell("line1\nline2");
    expect(result.startsWith('"')).toBe(true);
    expect(result.endsWith('"')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// encodeSpreadsheetSafeRow
// ---------------------------------------------------------------------------

describe("encodeSpreadsheetSafeRow", () => {
  it("joins cells with commas and terminates with CRLF", () => {
    expect(encodeSpreadsheetSafeRow(["a", "b", "c"])).toBe("a,b,c\r\n");
  });

  it("encodes individual cells within the row", () => {
    expect(encodeSpreadsheetSafeRow(["=SUM", "plain"])).toBe("'=SUM,plain\r\n");
  });

  it("encodes a cell with comma inside a row (RFC-4180 composition)", () => {
    expect(encodeSpreadsheetSafeRow(["a,b", "c"])).toBe('"a,b",c\r\n');
  });

  it("produces a single CRLF-terminated row for an empty cell list", () => {
    expect(encodeSpreadsheetSafeRow([])).toBe("\r\n");
  });

  it("produces a single-cell row with CRLF", () => {
    expect(encodeSpreadsheetSafeRow(["only"])).toBe("only\r\n");
  });
});
