/**
 * Monaco document-formatting bridge (Issue #1201, ADR-0042 D4).
 *
 * Bridges Monaco's `languages.registerDocumentFormattingEditProvider` to the host-injected
 * {@link EditorFormattingResolver}. Registering only the *document* formatting provider (not an
 * on-type formatter) keeps formatting **explicit**: it runs only when the user invokes Monaco's
 * "Format Document" command/action (Acceptance Criterion 4). It is **cancellable**: Monaco's
 * cancellation token is wired to an {@link AbortSignal} the resolver forwards to the bounded,
 * deadline-guarded server language service. The bridge maps the call to a content-free
 * {@link EditorFormattingRequest}, hands the host the request plus the live buffer text and the
 * editor's indentation options, and maps the returned reviewable edits back to Monaco text edits. It
 * computes no edits, calls no model, and performs no I/O (ADR-0042 D4).
 *
 * Monaco is reached only through the small structural interfaces below (never a value import of
 * `monaco-editor`), so the mappers are unit-testable without a browser and the module stays
 * import-side-effect-free.
 */
import type { EditorLanguageId } from "../languages.js";
import type {
  EditorFormattingOptions,
  EditorFormattingQuery,
  EditorFormattingRequest,
  EditorFormattingResolver,
  EditorRequestIdentity,
  EditorTextEdit,
} from "../types.js";
import {
  editorRangeToMonaco,
  type MonacoCancellationToken,
  type MonacoDisposable,
  type MonacoRange,
} from "./completion-bridge.js";

// ─── Minimal structural Monaco surface (no value import of `monaco-editor`) ─────────────────────

export interface MonacoFormattingModel {
  getValue(): string;
  getVersionId(): number;
  readonly uri: { toString(): string };
}

/** Monaco's `FormattingOptions`: the active editor indentation settings. */
export interface MonacoFormattingOptions {
  readonly tabSize: number;
  readonly insertSpaces: boolean;
}

/** A Monaco `TextEdit`: replace `range` with `text`. */
export interface MonacoTextEdit {
  readonly range: MonacoRange;
  readonly text: string;
}

export interface MonacoDocumentFormattingEditProvider {
  provideDocumentFormattingEdits(
    model: MonacoFormattingModel,
    options: MonacoFormattingOptions,
    token: MonacoCancellationToken,
  ): Promise<readonly MonacoTextEdit[]>;
}

/** The slice of the live `monaco.languages` namespace the formatting bridge consumes. */
export interface MonacoDocumentFormattingRegistrar {
  registerDocumentFormattingEditProvider(
    languageSelector: string | readonly string[],
    provider: MonacoDocumentFormattingEditProvider,
  ): MonacoDisposable;
}

// ─── Pure mappers ───────────────────────────────────────────────────────────────────────────────

/** Map one editor text edit to a Monaco text edit (0-based range → 1-based; `newText` → `text`). */
export function editorTextEditToMonaco(edit: EditorTextEdit): MonacoTextEdit {
  return { range: editorRangeToMonaco(edit.range), text: edit.newText };
}

/** Map a list of reformatting edits to Monaco text edits. */
export function editsToMonaco(edits: readonly EditorTextEdit[]): readonly MonacoTextEdit[] {
  return edits.map(editorTextEditToMonaco);
}

/** Map Monaco's formatting options to the editor's indentation preferences. */
export function monacoFormattingOptionsToEditor(
  options: MonacoFormattingOptions,
): EditorFormattingOptions {
  return { tabSize: options.tabSize, insertSpaces: options.insertSpaces };
}

// ─── Provider factory ─────────────────────────────────────────────────────────────────────────

export interface KeikoFormattingProviderDeps {
  /** The host-injected resolver that actually produces the reformat edits (BFF call lives here). */
  readonly resolve: EditorFormattingResolver;
  /** True when the Monaco model URI still belongs to this editor instance's current document. */
  readonly isCurrentDocument: (documentUri: string) => boolean;
  /** The editor language id (e.g. "typescript"); also the registration selector. */
  readonly documentLanguage: EditorLanguageId;
  /** Stream identity for this provider instance. */
  readonly streamId: string;
  /** Unique request-id factory. Injected so tests stay deterministic. */
  readonly newRequestId: () => string;
}

function buildRequest(
  deps: KeikoFormattingProviderDeps,
  documentUri: string,
  options: MonacoFormattingOptions,
  sequence: number,
  version: number,
): EditorFormattingRequest {
  const identity: EditorRequestIdentity = {
    requestId: deps.newRequestId(),
    streamId: deps.streamId,
    sequence,
  };
  return {
    request: identity,
    document: { uri: documentUri, language: deps.documentLanguage, version },
    options: monacoFormattingOptionsToEditor(options),
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

const EMPTY_EDITS: readonly MonacoTextEdit[] = [];

/**
 * Create a Monaco document-formatting provider backed by the host resolver. The provider builds a
 * content-free {@link EditorFormattingRequest} carrying the editor's indentation options, hands the
 * resolver the request plus the live buffer text and an {@link AbortSignal} wired to Monaco's
 * cancellation token, and returns no edits on any failure or cancellation so a formatting error never
 * mutates the buffer or breaks editing.
 */
export function createKeikoFormattingProvider(
  deps: KeikoFormattingProviderDeps,
): MonacoDocumentFormattingEditProvider {
  let sequence = 0;
  return {
    async provideDocumentFormattingEdits(
      model,
      options,
      token,
    ): Promise<readonly MonacoTextEdit[]> {
      const documentUri = model.uri.toString();
      if (!deps.isCurrentDocument(documentUri)) {
        return EMPTY_EDITS;
      }
      sequence += 1;
      const versionBefore = model.getVersionId();
      const request = buildRequest(deps, documentUri, options, sequence, versionBefore);
      const controller = controllerForToken(token);
      try {
        const query: EditorFormattingQuery = { request, documentText: model.getValue() };
        const response = await deps.resolve(query, controller.signal);
        // A request cancelled or superseded by a model change while in flight must not mutate the
        // buffer: drop the now-stale edits instead of applying them to a different document state.
        if (
          controller.signal.aborted ||
          !deps.isCurrentDocument(documentUri) ||
          model.getVersionId() !== versionBefore
        ) {
          return EMPTY_EDITS;
        }
        return editsToMonaco(response.edits);
      } catch {
        return EMPTY_EDITS;
      }
    },
  };
}

export interface RegisterKeikoFormattingProviderArgs {
  readonly languages: MonacoDocumentFormattingRegistrar;
  readonly resolve: EditorFormattingResolver;
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
 * Register the Keiko document-formatting provider for each governed language and return a single
 * disposer that tears every registration down. The caller owns disposal (the editor's unmount path).
 */
export function registerKeikoFormattingProvider(
  args: RegisterKeikoFormattingProviderArgs,
): MonacoDisposable {
  const disposers = args.documentLanguages.map((documentLanguage) => {
    const provider = createKeikoFormattingProvider({
      resolve: args.resolve,
      isCurrentDocument: args.isCurrentDocument,
      documentLanguage,
      streamId: `${args.streamId}:${documentLanguage}`,
      newRequestId: args.newRequestId,
    });
    return args.languages.registerDocumentFormattingEditProvider(documentLanguage, provider);
  });
  return composeDisposers(disposers);
}

/** The governed languages eligible for formatting (TS/JS; the #1198 deterministic set). */
export const FORMATTING_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
];
