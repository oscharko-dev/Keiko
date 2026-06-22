import { describe, expect, it } from "vitest";
import {
  buildTestGenerationContext,
  buildTestGenerationRequest,
  testGenerationMode,
  type TestGenerationTargetInput,
} from "./test-generation-context.js";
import type {
  EditorDocumentIdentity,
  EditorRange,
  EditorRequestIdentity,
  EditorSymbolRef,
} from "./types.js";

const DOCUMENT: EditorDocumentIdentity = {
  uri: "file:///src/a.ts",
  language: "typescript",
  version: 3,
};
const EMPTY_SELECTION: EditorRange = {
  start: { line: 2, column: 4 },
  end: { line: 2, column: 4 },
};
const SELECTION: EditorRange = { start: { line: 2, column: 4 }, end: { line: 6, column: 0 } };
const SYMBOL: EditorSymbolRef = { name: "add", range: SELECTION };
const REQUEST: EditorRequestIdentity = { requestId: "r1", streamId: "s1", sequence: 1 };

function input(overrides: Partial<TestGenerationTargetInput> = {}): TestGenerationTargetInput {
  return { document: DOCUMENT, ...overrides };
}

describe("testGenerationMode — precedence", () => {
  it("defaults to file with no scope and treats an empty selection as no selection", () => {
    expect(testGenerationMode(input())).toBe("file");
    expect(testGenerationMode(input({ selection: EMPTY_SELECTION }))).toBe("file");
  });

  it("derives selection, symbol, changed-file-set, and frontend-component modes", () => {
    expect(testGenerationMode(input({ selection: SELECTION }))).toBe("selection");
    expect(testGenerationMode(input({ symbol: SYMBOL }))).toBe("symbol");
    expect(testGenerationMode(input({ changedFiles: [DOCUMENT] }))).toBe("changed-file-set");
    expect(testGenerationMode(input({ component: { name: "Button" } }))).toBe("frontend-component");
  });

  it("prefers a changed-file set over component, symbol, and selection", () => {
    const result = testGenerationMode(
      input({
        changedFiles: [DOCUMENT],
        component: { name: "X" },
        symbol: SYMBOL,
        selection: SELECTION,
      }),
    );
    expect(result).toBe("changed-file-set");
  });
});

describe("buildTestGenerationContext", () => {
  it("builds the file context", () => {
    expect(buildTestGenerationContext(input())).toEqual({ kind: "file", document: DOCUMENT });
  });

  it("builds the selection context with its range", () => {
    expect(buildTestGenerationContext(input({ selection: SELECTION }))).toEqual({
      kind: "selection",
      document: DOCUMENT,
      range: SELECTION,
    });
  });

  it("builds the symbol context", () => {
    expect(buildTestGenerationContext(input({ symbol: SYMBOL }))).toEqual({
      kind: "symbol",
      document: DOCUMENT,
      symbol: SYMBOL,
    });
  });

  it("builds the changed-file-set and frontend-component contexts", () => {
    expect(buildTestGenerationContext(input({ changedFiles: [DOCUMENT] }))).toEqual({
      kind: "changed-file-set",
      files: [DOCUMENT],
    });
    expect(
      buildTestGenerationContext(input({ component: { name: "Button", range: SELECTION } })),
    ).toEqual({
      kind: "frontend-component",
      document: DOCUMENT,
      componentName: "Button",
      range: SELECTION,
    });
  });
});

describe("buildTestGenerationRequest", () => {
  it("assembles the content-free request and truncates the budget", () => {
    const request = buildTestGenerationRequest({
      request: REQUEST,
      target: input({ symbol: SYMBOL }),
      contextBudgetBytes: 1_024.7,
    });
    expect(request.request).toBe(REQUEST);
    expect(request.context).toEqual({ kind: "symbol", document: DOCUMENT, symbol: SYMBOL });
    expect(request.contextBudgetBytes).toBe(1_024);
  });

  it("clamps a negative budget to zero", () => {
    const request = buildTestGenerationRequest({
      request: REQUEST,
      target: input(),
      contextBudgetBytes: -5,
    });
    expect(request.contextBudgetBytes).toBe(0);
  });
});
