import { describe, expect, it } from "vitest";

import {
  mapWireToEditorDiagnosticsResponse,
  mapWireToEditorFormattingResponse,
  mapWireToEditorHoverResponse,
  mapWireToEditorSymbolsResponse,
} from "./editor-language";
import type { EditorRequestIdentity } from "@oscharko-dev/keiko-editor";
import type { LanguageRange } from "./types";

const REQUEST: EditorRequestIdentity = { requestId: "r", streamId: "s", sequence: 1 };

const range: LanguageRange = {
  start: { line: 1, character: 4 },
  end: { line: 1, character: 9 },
};

describe("mapWireToEditorDiagnosticsResponse", () => {
  it("maps diagnostics and converts character→column", () => {
    const response = mapWireToEditorDiagnosticsResponse(REQUEST, {
      diagnostics: [
        { range, severity: "error", message: "not assignable", source: "typescript", code: "2322" },
      ],
      truncated: false,
    });
    expect(response.request).toBe(REQUEST);
    expect(response.diagnostics[0]).toEqual({
      range: { start: { line: 1, column: 4 }, end: { line: 1, column: 9 } },
      severity: "error",
      message: "not assignable",
      source: "typescript",
      code: "2322",
    });
  });

  it("omits an absent diagnostic code", () => {
    const response = mapWireToEditorDiagnosticsResponse(REQUEST, {
      diagnostics: [{ range, severity: "warning", message: "w", source: "typescript" }],
      truncated: false,
    });
    expect("code" in (response.diagnostics[0] ?? {})).toBe(false);
  });
});

describe("mapWireToEditorHoverResponse", () => {
  it("maps contents and an optional range", () => {
    const response = mapWireToEditorHoverResponse(REQUEST, { contents: "x: number", range });
    expect(response.hover.contents).toBe("x: number");
    expect(response.hover.range).toEqual({
      start: { line: 1, column: 4 },
      end: { line: 1, column: 9 },
    });
  });

  it("passes through null contents and omits an absent range", () => {
    const response = mapWireToEditorHoverResponse(REQUEST, { contents: null });
    expect(response.hover.contents).toBeNull();
    expect("range" in response.hover).toBe(false);
  });
});

describe("mapWireToEditorSymbolsResponse", () => {
  it("maps symbols including kind, detail, and containerName", () => {
    const response = mapWireToEditorSymbolsResponse(REQUEST, {
      symbols: [
        { name: "foo", kind: "function", range },
        { name: "bar", kind: "method", range, detail: "(): void", containerName: "Baz" },
      ],
      truncated: false,
    });
    expect(response.symbols[0]).toEqual({
      name: "foo",
      kind: "function",
      range: { start: { line: 1, column: 4 }, end: { line: 1, column: 9 } },
    });
    expect(response.symbols[1]?.detail).toBe("(): void");
    expect(response.symbols[1]?.containerName).toBe("Baz");
  });
});

describe("mapWireToEditorFormattingResponse", () => {
  it("maps reformatting edits and converts character→column", () => {
    const response = mapWireToEditorFormattingResponse(REQUEST, {
      edits: [{ range, newText: " = " }],
      truncated: false,
    });
    expect(response.edits[0]).toEqual({
      range: { start: { line: 1, column: 4 }, end: { line: 1, column: 9 } },
      newText: " = ",
    });
  });
});
