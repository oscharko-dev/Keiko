/**
 * Monaco completion-provider bridge (Issue #1199, ADR-0042 D4/D5).
 *
 * Bridges Monaco's `languages.registerCompletionItemProvider` to the host-injected
 * {@link EditorCompletionResolver}. The bridge is pure wiring: it maps a Monaco completion call to a
 * content-free {@link EditorCompletionRequest}, hands the host the request plus the live buffer text,
 * applies cross-boundary stale-response discard ({@link shouldDiscardResponse}, #1192), and maps the
 * returned {@link EditorCompletionResponse} items back to Monaco suggestions. It computes no
 * completions, calls no model, and performs no I/O — every result comes from the host resolver
 * (ADR-0042 D5).
 *
 * Monaco is reached only through the small structural interfaces below (never a value import of
 * `monaco-editor`), so the mappers are unit-testable without a browser and the module stays
 * import-side-effect-free.
 */
import { shouldDiscardResponse } from "../completion-identity.js";
import type { EditorLanguageId } from "../languages.js";
import type {
  EditorCompletionItem,
  EditorCompletionItemKind,
  EditorCompletionRequest,
  EditorCompletionResolver,
  EditorCompletionResponse,
  EditorCompletionTriggerKind,
  EditorPosition,
  EditorRange,
  EditorRequestIdentity,
} from "../types.js";

// ─── Minimal structural Monaco surface (no value import of `monaco-editor`) ─────────────────────

/** Monaco's `CompletionItemKind` enum (name → numeric id). The bridge maps editor kinds onto it. */
export interface MonacoCompletionItemKinds {
  readonly Text: number;
  readonly Method: number;
  readonly Function: number;
  readonly Constructor: number;
  readonly Field: number;
  readonly Variable: number;
  readonly Class: number;
  readonly Interface: number;
  readonly Module: number;
  readonly Property: number;
  readonly Keyword: number;
  readonly Snippet: number;
}

/** Monaco's `CompletionTriggerKind` enum (Invoke=0, TriggerCharacter=1, TriggerForIncomplete=2). */
export interface MonacoCompletionTriggerKinds {
  readonly Invoke: number;
  readonly TriggerCharacter: number;
  readonly TriggerForIncompleteCompletions: number;
}

export interface MonacoPositionLike {
  readonly lineNumber: number;
  readonly column: number;
}

export interface MonacoWordAtPosition {
  readonly startColumn: number;
  readonly endColumn: number;
}

export interface MonacoCompletionModel {
  getValue(): string;
  getWordUntilPosition(position: MonacoPositionLike): MonacoWordAtPosition;
  readonly uri: { toString(): string };
}

export interface MonacoCompletionContext {
  readonly triggerKind: number;
  readonly triggerCharacter?: string | undefined;
}

export interface MonacoDisposable {
  dispose(): void;
}

export interface MonacoCancellationToken {
  readonly isCancellationRequested: boolean;
  // Monaco's real token returns an `IDisposable`; the bridge ignores the return value.
  onCancellationRequested(listener: () => void): MonacoDisposable;
}

export interface MonacoRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export interface MonacoCompletionSuggestion {
  readonly label: string;
  readonly kind: number;
  readonly insertText: string;
  readonly range: MonacoRange;
  readonly detail?: string;
  readonly sortText?: string;
}

export interface MonacoCompletionList {
  readonly suggestions: readonly MonacoCompletionSuggestion[];
  readonly incomplete: boolean;
}

export interface MonacoCompletionItemProvider {
  readonly triggerCharacters?: readonly string[] | undefined;
  provideCompletionItems(
    model: MonacoCompletionModel,
    position: MonacoPositionLike,
    context: MonacoCompletionContext,
    token: MonacoCancellationToken,
  ): Promise<MonacoCompletionList>;
}

/** The slice of the live `monaco.languages` namespace the bridge consumes. */
export interface MonacoLanguagesRegistrar {
  readonly CompletionItemKind: MonacoCompletionItemKinds;
  readonly CompletionTriggerKind: MonacoCompletionTriggerKinds;
  registerCompletionItemProvider(
    languageSelector: string | readonly string[],
    provider: MonacoCompletionItemProvider,
  ): MonacoDisposable;
}

// ─── Pure mappers ───────────────────────────────────────────────────────────────────────────────

/** Map a Monaco completion-trigger context to the content-free editor trigger kind (#1192). */
export function monacoTriggerToEditor(
  context: MonacoCompletionContext,
  kinds: MonacoCompletionTriggerKinds,
): { triggerKind: EditorCompletionTriggerKind; triggerCharacter?: string } {
  if (context.triggerKind === kinds.TriggerCharacter) {
    return {
      triggerKind: "trigger-character",
      ...(typeof context.triggerCharacter === "string"
        ? { triggerCharacter: context.triggerCharacter }
        : {}),
    };
  }
  if (context.triggerKind === kinds.TriggerForIncompleteCompletions) {
    return { triggerKind: "incomplete" };
  }
  return { triggerKind: "invoked" };
}

/** Map a 1-based Monaco caret to the editor's 0-based {@link EditorPosition} (UTF-16 columns). */
export function monacoPositionToEditor(position: MonacoPositionLike): EditorPosition {
  return { line: position.lineNumber - 1, column: position.column - 1 };
}

// Editor kind → the `MonacoCompletionItemKinds` member name. A total map (every editor kind has a
// 1:1 Monaco kind), so the lookup is exhaustive without a high-complexity switch.
const EDITOR_KIND_TO_MONACO: Readonly<
  Record<EditorCompletionItemKind, keyof MonacoCompletionItemKinds>
> = {
  text: "Text",
  method: "Method",
  function: "Function",
  constructor: "Constructor",
  field: "Field",
  variable: "Variable",
  class: "Class",
  interface: "Interface",
  module: "Module",
  property: "Property",
  keyword: "Keyword",
  snippet: "Snippet",
};

/** Map an editor completion-item kind onto Monaco's numeric `CompletionItemKind`. */
export function editorKindToMonaco(
  kind: EditorCompletionItemKind,
  kinds: MonacoCompletionItemKinds,
): number {
  return kinds[EDITOR_KIND_TO_MONACO[kind]];
}

/** Convert a 0-based {@link EditorRange} to a 1-based Monaco range. */
export function editorRangeToMonaco(range: EditorRange): MonacoRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.column + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.column + 1,
  };
}

/**
 * The replacement range for an item with no explicit `range`: the word being typed up to the caret,
 * so accepting an item replaces the current identifier rather than inserting beside it.
 */
export function wordRangeAt(
  model: MonacoCompletionModel,
  position: MonacoPositionLike,
): MonacoRange {
  const word = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn,
  };
}

/** Map one editor completion item to a Monaco suggestion. */
export function editorItemToMonacoSuggestion(
  item: EditorCompletionItem,
  fallbackRange: MonacoRange,
  kinds: MonacoCompletionItemKinds,
): MonacoCompletionSuggestion {
  return {
    label: item.label,
    kind: editorKindToMonaco(item.kind, kinds),
    insertText: item.insertText,
    range: item.range === undefined ? fallbackRange : editorRangeToMonaco(item.range),
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.sortText === undefined ? {} : { sortText: item.sortText }),
  };
}

/** Map a full completion response to a Monaco completion list. */
export function responseToCompletionList(
  response: EditorCompletionResponse,
  fallbackRange: MonacoRange,
  kinds: MonacoCompletionItemKinds,
): MonacoCompletionList {
  return {
    suggestions: response.items.map((item) =>
      editorItemToMonacoSuggestion(item, fallbackRange, kinds),
    ),
    incomplete: response.isIncomplete,
  };
}

const EMPTY_LIST: MonacoCompletionList = { suggestions: [], incomplete: false };

// ─── Provider factory ─────────────────────────────────────────────────────────────────────────

export interface KeikoCompletionProviderDeps {
  /** The host-injected resolver that actually produces completions (BFF call lives here). */
  readonly resolve: EditorCompletionResolver;
  /** True only for the document owned by this editor instance. */
  readonly isCurrentDocument: (documentUri: string) => boolean;
  readonly languages: MonacoLanguagesRegistrar;
  readonly triggerCharacters: readonly string[];
  // The editor language id (e.g. "typescript"); for the governed TS/JS set this equals the Monaco
  // language id used for provider registration, so it serves as both the request language and the
  // registration selector.
  readonly documentLanguage: EditorLanguageId;
  readonly contextBudgetBytes: number;
  /** Stream identity for this provider instance; supersession is scoped to it. */
  readonly streamId: string;
  /** Unique request-id factory. Injected so tests stay deterministic. */
  readonly newRequestId: () => string;
}

function buildRequest(
  deps: KeikoCompletionProviderDeps,
  model: MonacoCompletionModel,
  position: MonacoPositionLike,
  context: MonacoCompletionContext,
  sequence: number,
): EditorCompletionRequest {
  const trigger = monacoTriggerToEditor(context, deps.languages.CompletionTriggerKind);
  const identity: EditorRequestIdentity = {
    requestId: deps.newRequestId(),
    streamId: deps.streamId,
    sequence,
  };
  return {
    request: identity,
    document: {
      uri: model.uri.toString(),
      language: deps.documentLanguage,
      version: sequence,
    },
    position: monacoPositionToEditor(position),
    triggerKind: trigger.triggerKind,
    ...(trigger.triggerCharacter === undefined
      ? {}
      : { triggerCharacter: trigger.triggerCharacter }),
    contextBudgetBytes: deps.contextBudgetBytes,
  };
}

/**
 * Create a Monaco completion provider backed by the host resolver. The provider:
 *  - builds a content-free {@link EditorCompletionRequest} with a monotonic per-stream sequence,
 *  - hands the resolver the request plus the live buffer text and an {@link AbortSignal} wired to
 *    Monaco's cancellation token,
 *  - discards a response that a later request has superseded (Acceptance Criterion 3), and
 *  - returns an empty list on any failure so a completion error never breaks editing (AC4).
 */
// eslint-disable-next-line max-lines-per-function
export function createKeikoCompletionProvider(
  deps: KeikoCompletionProviderDeps,
): MonacoCompletionItemProvider {
  let sequence = 0;
  let latest: EditorRequestIdentity | null = null;
  let activeController: AbortController | null = null;

  return {
    triggerCharacters: deps.triggerCharacters,
    async provideCompletionItems(model, position, context, token): Promise<MonacoCompletionList> {
      const documentUri = model.uri.toString();
      if (!deps.isCurrentDocument(documentUri)) {
        return EMPTY_LIST;
      }
      sequence += 1;
      const request = buildRequest(deps, model, position, context, sequence);
      latest = request.request;

      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      if (token.isCancellationRequested) {
        controller.abort();
      }
      const cancellationSub = token.onCancellationRequested(() => {
        controller.abort();
      });

      try {
        const response = await deps.resolve(
          { request, documentText: model.getValue() },
          controller.signal,
        );
        // Cross-boundary stale-response discard: a later keystroke may have superseded this request
        // while it was in flight. `latest` always holds the newest identity for this stream (it is
        // assigned before the await above), so a superseded response renders nothing.
        if (shouldDiscardResponse(response.request, latest)) {
          return EMPTY_LIST;
        }
        if (!deps.isCurrentDocument(documentUri)) {
          return EMPTY_LIST;
        }
        return responseToCompletionList(
          response,
          wordRangeAt(model, position),
          deps.languages.CompletionItemKind,
        );
      } catch {
        // AC4: a completion failure (network, abort, host error) must never break editing.
        return EMPTY_LIST;
      } finally {
        cancellationSub.dispose();
        if (activeController === controller) {
          activeController = null;
        }
      }
    },
  };
}

export interface RegisterKeikoCompletionProviderArgs {
  readonly languages: MonacoLanguagesRegistrar;
  readonly resolve: EditorCompletionResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  /**
   * The languages to register a provider for. One provider is registered per language with that
   * language fixed, so a buffer that switches language within a single editor mount (e.g. opening a
   * `.js` file after a `.ts` file in the same card) is still served by the correct registration.
   */
  readonly documentLanguages: readonly EditorLanguageId[];
  readonly triggerCharacters: readonly string[];
  readonly contextBudgetBytes: number;
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
 * Register the Keiko completion provider for each governed language and return a single disposer that
 * tears every registration down. The caller owns disposal (the editor's unmount path), so the
 * registrations never outlive the editor instance.
 */
export function registerKeikoCompletionProvider(
  args: RegisterKeikoCompletionProviderArgs,
): MonacoDisposable {
  const disposers = args.documentLanguages.map((documentLanguage) => {
    const provider = createKeikoCompletionProvider({
      resolve: args.resolve,
      isCurrentDocument: args.isCurrentDocument,
      languages: args.languages,
      triggerCharacters: args.triggerCharacters,
      documentLanguage,
      contextBudgetBytes: args.contextBudgetBytes,
      // Supersession is scoped per language registration; each serves a distinct model.
      streamId: `${args.streamId}:${documentLanguage}`,
      newRequestId: args.newRequestId,
    });
    return args.languages.registerCompletionItemProvider(documentLanguage, provider);
  });
  return composeDisposers(disposers);
}

/** Default trigger characters for the TypeScript/JavaScript suggestion widget (LSP-aligned). */
export const DEFAULT_COMPLETION_TRIGGER_CHARACTERS: readonly string[] = [
  ".",
  '"',
  "'",
  "`",
  "/",
  "@",
  "<",
  "#",
];

/** The governed languages that have a deterministic completion provider (TS/JS; #1198). */
export const COMPLETION_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
];

/** Default advisory coding-context budget (bytes) the bridge requests for completion. */
export const DEFAULT_COMPLETION_CONTEXT_BUDGET_BYTES = 32_768;

let requestIdFallbackCounter = 0;

/**
 * Default request-id factory for the bridge: a UUID where the platform offers one, otherwise a
 * monotonic per-instance counter. Deterministic-friendly (no `Math.random`/`Date.now`) so the bridge
 * stays unit-testable; tests inject their own factory through {@link KeikoCompletionProviderDeps}.
 */
export function createEditorRequestId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoObj?.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  requestIdFallbackCounter += 1;
  return `kreq-${requestIdFallbackCounter.toString(36)}`;
}
