/**
 * Monaco document-symbol bridge (Issue #1201, ADR-0042 D4).
 *
 * Bridges Monaco's `languages.registerDocumentSymbolProvider` to the host-injected
 * {@link EditorSymbolsResolver} so the editor's Outline/breadcrumb and "Go to Symbol" navigation are
 * served by the deterministic server language service. The bridge is pure wiring: it maps a Monaco
 * document-symbol call to a content-free {@link EditorSymbolsRequest}, hands the host the request plus
 * the live buffer text, and maps the returned {@link EditorDocumentSymbol}s back to Monaco document
 * symbols. It computes no symbols, calls no model, and performs no I/O (ADR-0042 D4).
 *
 * Monaco re-requests symbols on content change and cancels a superseded call through its own token, so
 * the bridge wires that token to an {@link AbortSignal} rather than re-implementing supersession.
 *
 * Monaco is reached only through the small structural interfaces below (never a value import of
 * `monaco-editor`), so the mappers are unit-testable without a browser and the module stays
 * import-side-effect-free.
 */
import type { EditorLanguageId } from "../languages.js";
import type {
  EditorDocumentSymbol,
  EditorRequestIdentity,
  EditorSymbolKind,
  EditorSymbolsQuery,
  EditorSymbolsRequest,
  EditorSymbolsResolver,
} from "../types.js";
import {
  editorRangeToMonaco,
  type MonacoCancellationToken,
  type MonacoDisposable,
  type MonacoRange,
} from "./completion-bridge.js";

// ─── Minimal structural Monaco surface (no value import of `monaco-editor`) ─────────────────────

/** The subset of Monaco's `SymbolKind` enum (name → numeric id) the bridge maps onto. */
export interface MonacoSymbolKinds {
  readonly File: number;
  readonly Module: number;
  readonly Namespace: number;
  readonly Class: number;
  readonly Method: number;
  readonly Property: number;
  readonly Field: number;
  readonly Constructor: number;
  readonly Enum: number;
  readonly Interface: number;
  readonly Function: number;
  readonly Variable: number;
  readonly Constant: number;
  readonly Struct: number;
  readonly EnumMember: number;
  readonly TypeParameter: number;
}

export interface MonacoDocumentSymbolModel {
  getValue(): string;
  readonly uri: { toString(): string };
}

/** A Monaco `DocumentSymbol`: `range` spans the whole symbol, `selectionRange` the name. */
export interface MonacoDocumentSymbol {
  readonly name: string;
  readonly detail: string;
  readonly kind: number;
  readonly tags: readonly number[];
  readonly range: MonacoRange;
  readonly selectionRange: MonacoRange;
  readonly containerName?: string;
}

export interface MonacoDocumentSymbolProvider {
  provideDocumentSymbols(
    model: MonacoDocumentSymbolModel,
    token: MonacoCancellationToken,
  ): Promise<readonly MonacoDocumentSymbol[]>;
}

/** The slice of the live `monaco.languages` namespace the symbol bridge consumes. */
export interface MonacoDocumentSymbolRegistrar {
  readonly SymbolKind: MonacoSymbolKinds;
  registerDocumentSymbolProvider(
    languageSelector: string | readonly string[],
    provider: MonacoDocumentSymbolProvider,
  ): MonacoDisposable;
}

// ─── Pure mappers ───────────────────────────────────────────────────────────────────────────────

// Editor symbol kind → the `MonacoSymbolKinds` member name. A total map (every editor kind has a 1:1
// Monaco kind), so the lookup is exhaustive without a high-complexity switch.
const EDITOR_SYMBOL_KIND_TO_MONACO: Readonly<Record<EditorSymbolKind, keyof MonacoSymbolKinds>> = {
  file: "File",
  module: "Module",
  namespace: "Namespace",
  class: "Class",
  method: "Method",
  property: "Property",
  field: "Field",
  constructor: "Constructor",
  enum: "Enum",
  interface: "Interface",
  function: "Function",
  variable: "Variable",
  constant: "Constant",
  struct: "Struct",
  enumMember: "EnumMember",
  typeParameter: "TypeParameter",
};

/** Map an editor symbol kind onto Monaco's numeric `SymbolKind`. */
export function editorSymbolKindToMonaco(kind: EditorSymbolKind, kinds: MonacoSymbolKinds): number {
  return kinds[EDITOR_SYMBOL_KIND_TO_MONACO[kind]];
}

/**
 * Map one editor document symbol to a Monaco document symbol. The server returns a flattened list; a
 * symbol's `range` doubles as its `selectionRange` (Monaco renders both, and the deterministic
 * provider reports a single span per symbol).
 */
export function editorSymbolToMonaco(
  symbol: EditorDocumentSymbol,
  kinds: MonacoSymbolKinds,
): MonacoDocumentSymbol {
  const range = editorRangeToMonaco(symbol.range);
  return {
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: editorSymbolKindToMonaco(symbol.kind, kinds),
    tags: [],
    range,
    selectionRange: range,
    ...(symbol.containerName === undefined ? {} : { containerName: symbol.containerName }),
  };
}

/** Map a full symbols list to Monaco document symbols. */
export function symbolsToMonaco(
  symbols: readonly EditorDocumentSymbol[],
  kinds: MonacoSymbolKinds,
): readonly MonacoDocumentSymbol[] {
  return symbols.map((symbol) => editorSymbolToMonaco(symbol, kinds));
}

// ─── Provider factory ─────────────────────────────────────────────────────────────────────────

export interface KeikoDocumentSymbolProviderDeps {
  /** The host-injected resolver that actually produces symbols (BFF call lives here). */
  readonly resolve: EditorSymbolsResolver;
  /** True when the Monaco model URI still belongs to this editor instance's current document. */
  readonly isCurrentDocument: (documentUri: string) => boolean;
  /** Monaco's `SymbolKind` enum, injected so the mappers stay value-import-free. */
  readonly symbolKinds: MonacoSymbolKinds;
  /** The editor language id (e.g. "typescript"); also the registration selector. */
  readonly documentLanguage: EditorLanguageId;
  /** Stream identity for this provider instance. */
  readonly streamId: string;
  /** Unique request-id factory. Injected so tests stay deterministic. */
  readonly newRequestId: () => string;
}

function buildRequest(
  deps: KeikoDocumentSymbolProviderDeps,
  documentUri: string,
  sequence: number,
): EditorSymbolsRequest {
  const identity: EditorRequestIdentity = {
    requestId: deps.newRequestId(),
    streamId: deps.streamId,
    sequence,
  };
  return {
    request: identity,
    document: { uri: documentUri, language: deps.documentLanguage, version: sequence },
  };
}

function controllerForToken(token: MonacoCancellationToken): AbortController {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  token.onCancellationRequested(() => {
    controller.abort();
  });
  return controller;
}

const EMPTY_SYMBOLS: readonly MonacoDocumentSymbol[] = [];

/**
 * Create a Monaco document-symbol provider backed by the host resolver. The provider builds a
 * content-free {@link EditorSymbolsRequest}, hands the resolver the request plus the live buffer text
 * and an {@link AbortSignal} wired to Monaco's cancellation token, and returns an empty list on any
 * failure so a symbol error never breaks the outline or editing.
 */
export function createKeikoDocumentSymbolProvider(
  deps: KeikoDocumentSymbolProviderDeps,
): MonacoDocumentSymbolProvider {
  let sequence = 0;
  return {
    async provideDocumentSymbols(model, token): Promise<readonly MonacoDocumentSymbol[]> {
      const documentUri = model.uri.toString();
      if (!deps.isCurrentDocument(documentUri)) {
        return EMPTY_SYMBOLS;
      }
      sequence += 1;
      const request = buildRequest(deps, documentUri, sequence);
      const controller = controllerForToken(token);
      try {
        const query: EditorSymbolsQuery = { request, documentText: model.getValue() };
        const response = await deps.resolve(query, controller.signal);
        return symbolsToMonaco(response.symbols, deps.symbolKinds);
      } catch {
        return EMPTY_SYMBOLS;
      }
    },
  };
}

export interface RegisterKeikoDocumentSymbolProviderArgs {
  readonly languages: MonacoDocumentSymbolRegistrar;
  readonly resolve: EditorSymbolsResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly documentLanguages: readonly EditorLanguageId[];
  readonly streamId: string;
  readonly newRequestId: () => string;
}

function composeDisposers(disposers: readonly MonacoDisposable[]): MonacoDisposable {
  return {
    dispose(): void {
      for (const disposer of disposers) {
        disposer.dispose();
      }
    },
  };
}

/**
 * Register the Keiko document-symbol provider for each governed language and return a single disposer
 * that tears every registration down. The caller owns disposal (the editor's unmount path).
 */
export function registerKeikoDocumentSymbolProvider(
  args: RegisterKeikoDocumentSymbolProviderArgs,
): MonacoDisposable {
  const disposers = args.documentLanguages.map((documentLanguage) => {
    const provider = createKeikoDocumentSymbolProvider({
      resolve: args.resolve,
      isCurrentDocument: args.isCurrentDocument,
      symbolKinds: args.languages.SymbolKind,
      documentLanguage,
      streamId: `${args.streamId}:${documentLanguage}`,
      newRequestId: args.newRequestId,
    });
    return args.languages.registerDocumentSymbolProvider(documentLanguage, provider);
  });
  return composeDisposers(disposers);
}

/** The governed languages eligible for document symbols (TS/JS; the #1198 deterministic set). */
export const SYMBOLS_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = ["typescript", "javascript"];
