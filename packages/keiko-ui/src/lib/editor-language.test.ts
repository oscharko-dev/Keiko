import { describe, expect, it } from "vitest";

import {
  mapWireToEditorCodeActionsResponse,
  mapWireToEditorDefinitionResponse,
  mapWireToEditorDiagnosticsResponse,
  mapWireToEditorFormattingResponse,
  mapWireToEditorHoverResponse,
  mapWireToEditorReferencesResponse,
  mapWireToEditorSignatureHelpResponse,
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

describe("mapWireToEditorDefinitionResponse", () => {
  it("maps definition locations and converts character→column", () => {
    const response = mapWireToEditorDefinitionResponse(REQUEST, {
      locations: [{ path: "src/def.ts", range }],
      truncated: false,
    });
    expect(response.locations[0]).toEqual({
      path: "src/def.ts",
      range: { start: { line: 1, column: 4 }, end: { line: 1, column: 9 } },
    });
  });
});

describe("mapWireToEditorReferencesResponse", () => {
  it("maps references and includesDeclaration", () => {
    const response = mapWireToEditorReferencesResponse(REQUEST, {
      locations: [{ path: "src/ref.ts", range }],
      includesDeclaration: true,
      truncated: false,
    });
    expect(response.includesDeclaration).toBe(true);
    expect(response.locations[0]?.path).toBe("src/ref.ts");
  });
});

describe("mapWireToEditorCodeActionsResponse", () => {
  it("maps code actions and single-file edits", () => {
    const response = mapWireToEditorCodeActionsResponse(REQUEST, {
      actions: [{ title: "Fix", kind: "quickfix", edits: [{ range, newText: "x" }] }],
      truncated: false,
      returnedCount: 1,
      totalCount: 1,
    });
    expect(response.actions[0]).toEqual({
      title: "Fix",
      kind: "quickfix",
      edits: [
        {
          range: { start: { line: 1, column: 4 }, end: { line: 1, column: 9 } },
          newText: "x",
        },
      ],
    });
  });

  it("preserves null edits for non-applicable review-required actions", () => {
    const response = mapWireToEditorCodeActionsResponse(REQUEST, {
      actions: [{ title: "Multi-file", kind: "quickfix", edits: null }],
      truncated: false,
      returnedCount: 1,
      totalCount: 1,
    });
    expect(response.actions[0]?.edits).toBeNull();
  });
});

describe("mapWireToEditorSignatureHelpResponse", () => {
  it("maps signatures and active indexes", () => {
    const response = mapWireToEditorSignatureHelpResponse(REQUEST, {
      signatures: [
        {
          label: "fn(value: string): void",
          documentation: "call fn",
          parameters: [{ label: "value" }],
        },
      ],
      activeSignature: 0,
      activeParameter: 0,
      truncated: false,
      returnedCount: 1,
      totalCount: 1,
    });
    expect(response.signatures[0]).toEqual({
      label: "fn(value: string): void",
      documentation: "call fn",
      parameters: [{ label: "value" }],
    });
    expect(response.activeSignature).toBe(0);
    expect(response.activeParameter).toBe(0);
  });
});
