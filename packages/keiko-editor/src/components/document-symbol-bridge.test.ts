import { describe, expect, it } from "vitest";

import {
  createKeikoDocumentSymbolProvider,
  editorSymbolKindToMonaco,
  editorSymbolToMonaco,
  registerKeikoDocumentSymbolProvider,
  symbolsToMonaco,
  SYMBOLS_ELIGIBLE_LANGUAGES,
  type MonacoDocumentSymbolProvider,
  type MonacoDocumentSymbolModel,
  type MonacoDocumentSymbolRegistrar,
  type MonacoSymbolKinds,
} from "./document-symbol-bridge.js";
import type { MonacoCancellationToken } from "./completion-bridge.js";
import type { EditorDocumentSymbol, EditorSymbolKind, EditorSymbolsResolver } from "../types.js";

const KINDS: MonacoSymbolKinds = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  Struct: 22,
  EnumMember: 21,
  TypeParameter: 25,
};

function model(text = "export function foo() {}\n"): MonacoDocumentSymbolModel {
  return { getValue: () => text, uri: { toString: () => "inmemory://model/1" } };
}

function token(cancelled = false): MonacoCancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  };
}

function symbol(overrides: Partial<EditorDocumentSymbol> = {}): EditorDocumentSymbol {
  return {
    name: "foo",
    kind: "function",
    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 24 } },
    ...overrides,
  };
}

describe("kind mapping", () => {
  it("maps every editor symbol kind to a Monaco SymbolKind", () => {
    const kinds: EditorSymbolKind[] = [
      "file",
      "module",
      "namespace",
      "class",
      "method",
      "property",
      "field",
      "constructor",
      "enum",
      "interface",
      "function",
      "variable",
      "constant",
      "struct",
      "enumMember",
      "typeParameter",
    ];
    for (const kind of kinds) {
      expect(typeof editorSymbolKindToMonaco(kind, KINDS)).toBe("number");
    }
    expect(editorSymbolKindToMonaco("class", KINDS)).toBe(KINDS.Class);
    expect(editorSymbolKindToMonaco("function", KINDS)).toBe(KINDS.Function);
  });
});

describe("editorSymbolToMonaco", () => {
  it("maps a symbol to a Monaco document symbol with range as selection range", () => {
    const mapped = editorSymbolToMonaco(symbol(), KINDS);
    expect(mapped).toEqual({
      name: "foo",
      detail: "",
      kind: KINDS.Function,
      tags: [],
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 25 },
      selectionRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 25 },
    });
  });

  it("carries detail and containerName when present", () => {
    const mapped = editorSymbolToMonaco(
      symbol({ kind: "method", detail: "(): void", containerName: "Bar" }),
      KINDS,
    );
    expect(mapped.detail).toBe("(): void");
    expect(mapped.containerName).toBe("Bar");
    expect(mapped.kind).toBe(KINDS.Method);
  });

  it("maps a flat list of symbols", () => {
    const mapped = symbolsToMonaco([symbol(), symbol({ name: "Bar", kind: "class" })], KINDS);
    expect(mapped.map((s) => s.name)).toEqual(["foo", "Bar"]);
    expect(mapped[1]?.kind).toBe(KINDS.Class);
  });
});

function provider(resolve: EditorSymbolsResolver): MonacoDocumentSymbolProvider {
  return createKeikoDocumentSymbolProvider({
    resolve,
    symbolKinds: KINDS,
    documentLanguage: "typescript",
    streamId: "stream",
    newRequestId: () => "req",
  });
}

describe("createKeikoDocumentSymbolProvider", () => {
  it("resolves and maps document symbols for the outline", async () => {
    const resolve: EditorSymbolsResolver = (query) =>
      Promise.resolve({
        request: query.request.request,
        symbols: [symbol(), symbol({ name: "Bar", kind: "class" })],
      });
    const symbols = await provider(resolve).provideDocumentSymbols(model(), token());
    expect(symbols.map((s) => s.name)).toEqual(["foo", "Bar"]);
  });

  it("passes the live buffer text to the resolver", async () => {
    let seenText = "";
    const resolve: EditorSymbolsResolver = (query) => {
      seenText = query.documentText;
      return Promise.resolve({ request: query.request.request, symbols: [] });
    };
    await provider(resolve).provideDocumentSymbols(model("buffer"), token());
    expect(seenText).toBe("buffer");
  });

  it("returns an empty list on resolver failure (outline never breaks)", async () => {
    const resolve: EditorSymbolsResolver = () => Promise.reject(new Error("boom"));
    expect(await provider(resolve).provideDocumentSymbols(model(), token())).toEqual([]);
  });

  it("aborts the resolver when the cancellation token is already cancelled", async () => {
    let aborted = false;
    const resolve: EditorSymbolsResolver = (query, signal) => {
      aborted = signal.aborted;
      return Promise.resolve({ request: query.request.request, symbols: [] });
    };
    await provider(resolve).provideDocumentSymbols(model(), token(true));
    expect(aborted).toBe(true);
  });
});

interface FakeSymbolRegistrar {
  readonly registrar: MonacoDocumentSymbolRegistrar;
  readonly registered: () => readonly (string | readonly string[])[];
  readonly disposeCount: () => number;
}

function buildRegistrar(): FakeSymbolRegistrar {
  const registered: (string | readonly string[])[] = [];
  let disposed = 0;
  const registrar: MonacoDocumentSymbolRegistrar = {
    SymbolKind: KINDS,
    registerDocumentSymbolProvider: (selector): { dispose: () => void } => {
      registered.push(selector);
      return {
        dispose: (): void => {
          disposed += 1;
        },
      };
    },
  };
  return { registrar, registered: () => registered, disposeCount: () => disposed };
}

describe("registerKeikoDocumentSymbolProvider", () => {
  it("registers a provider per governed language and disposes all on teardown", () => {
    const fake = buildRegistrar();
    const resolve: EditorSymbolsResolver = (query) =>
      Promise.resolve({ request: query.request.request, symbols: [] });
    const disposable = registerKeikoDocumentSymbolProvider({
      languages: fake.registrar,
      resolve,
      documentLanguages: SYMBOLS_ELIGIBLE_LANGUAGES,
      streamId: "s",
      newRequestId: () => "r",
    });
    expect(fake.registered()).toEqual(["typescript", "javascript"]);
    disposable.dispose();
    expect(fake.disposeCount()).toBe(2);
  });

  it("exposes the governed eligible languages", () => {
    expect(SYMBOLS_ELIGIBLE_LANGUAGES).toEqual(["typescript", "javascript"]);
  });
});
