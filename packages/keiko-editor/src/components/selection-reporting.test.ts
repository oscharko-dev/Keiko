import { describe, expect, it } from "vitest";

import {
  monacoPositionToEditorPosition,
  monacoSelectionToEditorRange,
} from "./selection-reporting.js";

describe("monacoPositionToEditorPosition", () => {
  it("converts 1-based Monaco coordinates to 0-based contract coordinates", () => {
    expect(monacoPositionToEditorPosition({ lineNumber: 1, column: 1 })).toEqual({
      line: 0,
      column: 0,
    });
    expect(monacoPositionToEditorPosition({ lineNumber: 12, column: 7 })).toEqual({
      line: 11,
      column: 6,
    });
  });
});

function selection(args: {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  empty: boolean;
}): {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  isEmpty: () => boolean;
} {
  return {
    startLineNumber: args.startLineNumber,
    startColumn: args.startColumn,
    endLineNumber: args.endLineNumber,
    endColumn: args.endColumn,
    isEmpty: () => args.empty,
  };
}

describe("monacoSelectionToEditorRange", () => {
  it("returns null for an empty (collapsed) selection", () => {
    const result = monacoSelectionToEditorRange(
      selection({
        startLineNumber: 3,
        startColumn: 5,
        endLineNumber: 3,
        endColumn: 5,
        empty: true,
      }),
    );
    expect(result).toBeNull();
  });

  it("converts a non-empty selection to a 0-based range", () => {
    const result = monacoSelectionToEditorRange(
      selection({
        startLineNumber: 2,
        startColumn: 4,
        endLineNumber: 5,
        endColumn: 9,
        empty: false,
      }),
    );
    expect(result).toEqual({
      start: { line: 1, column: 3 },
      end: { line: 4, column: 8 },
    });
  });
});
