/**
 * Monaco hover (quick-info) bridge (Issue #1201, ADR-0042 D4).
 *
 * Bridges Monaco's `languages.registerHoverProvider` to the host-injected {@link EditorHoverResolver}.
 * The bridge is pure wiring: it maps a Monaco hover call to a content-free {@link EditorHoverRequest},
 * hands the host the request plus the live buffer text, applies cross-boundary stale-response discard
 * ({@link shouldDiscardResponse}, #1192), and maps the returned {@link EditorHoverResponse} back to a
 * Monaco hover. It computes no quick info, calls no model, and performs no I/O — every result comes
 * from the host resolver, which is backed by the deterministic server language service (ADR-0042 D4).
 *
 * Markdown/DOMPurify supply-chain control (ADR-0042 D3.7): the server returns hover contents as plain
 * text, and this bridge renders them inside a fenced code block sized longer than any backtick run in
 * the content ({@link toInertCodeFence}). The Markdown renderer therefore HTML-escapes the content and
 * the editor's vendored DOMPurify only ever processes inert, escaped text — never active markup the
 * user's own buffer could smuggle through a type signature. No other Markdown sink is enabled.
 *
 * Monaco is reached only through the small structural interfaces below (never a value import of
 * `monaco-editor`), so the mappers are unit-testable without a browser and the module stays
 * import-side-effect-free. Geometry mappers and shared structural types are reused from the completion
 * bridge (#1199).
 */
import { shouldDiscardResponse } from "../completion-identity.js";
import type { EditorLanguageId } from "../languages.js";
import type {
  EditorHoverQuery,
  EditorHoverRequest,
  EditorHoverResolver,
  EditorHoverResponse,
  EditorRequestIdentity,
} from "../types.js";
import {
  editorRangeToMonaco,
  monacoPositionToEditor,
  type MonacoCancellationToken,
  type MonacoDisposable,
  type MonacoPositionLike,
  type MonacoRange,
} from "./completion-bridge.js";

// ─── Minimal structural Monaco surface (no value import of `monaco-editor`) ─────────────────────

export interface MonacoHoverModel {
  getValue(): string;
  readonly uri: { toString(): string };
}

/** Monaco's `IMarkdownString`; the bridge only ever sets `value` (an inert code fence). */
export interface MonacoMarkdownString {
  readonly value: string;
}

/** A Monaco hover: one or more Markdown blocks plus the span they describe. */
export interface MonacoHover {
  readonly contents: readonly MonacoMarkdownString[];
  readonly range?: MonacoRange;
}

export interface MonacoHoverProvider {
  provideHover(
    model: MonacoHoverModel,
    position: MonacoPositionLike,
    token: MonacoCancellationToken,
  ): Promise<MonacoHover | undefined>;
}

/** The slice of the live `monaco.languages` namespace the hover bridge consumes. */
export interface MonacoHoverRegistrar {
  registerHoverProvider(
    languageSelector: string | readonly string[],
    provider: MonacoHoverProvider,
  ): MonacoDisposable;
}

// ─── Pure mappers ───────────────────────────────────────────────────────────────────────────────

/** The longest run of consecutive backtick characters in `text` (0 when there are none). */
function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    if (char === "`") {
      current += 1;
      if (current > longest) {
        longest = current;
      }
    } else {
      current = 0;
    }
  }
  return longest;
}

/**
 * Wrap plain-text quick info in a Markdown code fence whose backtick run is longer than any run in the
 * content, so the content can never break out of the fence. The Markdown renderer then HTML-escapes
 * the content and the vendored DOMPurify only sees inert, escaped text (ADR-0042 D3.7).
 */
export function toInertCodeFence(text: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** Map a hover response to a Monaco hover, or `undefined` when there is no quick info to show. */
export function hoverResponseToMonaco(response: EditorHoverResponse): MonacoHover | undefined {
  const { contents, range } = response.hover;
  if (contents === null || contents.length === 0) {
    return undefined;
  }
  return {
    contents: [{ value: toInertCodeFence(contents) }],
    ...(range === undefined ? {} : { range: editorRangeToMonaco(range) }),
  };
}

// ─── Provider factory ─────────────────────────────────────────────────────────────────────────

export interface KeikoHoverProviderDeps {
  /** The host-injected resolver that actually produces quick info (BFF call lives here). */
  readonly resolve: EditorHoverResolver;
  /** True when the Monaco model URI still belongs to this editor instance's current document. */
  readonly isCurrentDocument: (documentUri: string) => boolean;
  /** The editor language id (e.g. "typescript"); also the registration selector. */
  readonly documentLanguage: EditorLanguageId;
  /** Stream identity for this provider instance; supersession is scoped to it. */
  readonly streamId: string;
  /** Unique request-id factory. Injected so tests stay deterministic. */
  readonly newRequestId: () => string;
}

function buildRequest(
  deps: KeikoHoverProviderDeps,
  documentUri: string,
  position: MonacoPositionLike,
  sequence: number,
): EditorHoverRequest {
  const identity: EditorRequestIdentity = {
    requestId: deps.newRequestId(),
    streamId: deps.streamId,
    sequence,
  };
  return {
    request: identity,
    document: { uri: documentUri, language: deps.documentLanguage, version: sequence },
    position: monacoPositionToEditor(position),
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

/**
 * Create a Monaco hover provider backed by the host resolver. The provider:
 *  - builds a content-free {@link EditorHoverRequest} with a monotonic per-stream sequence,
 *  - hands the resolver the request plus the live buffer text and an {@link AbortSignal} wired to
 *    Monaco's cancellation token,
 *  - discards a response that a later hover request has superseded (#1192), and
 *  - returns `undefined` on any failure so a hover error never breaks editing.
 */
export function createKeikoHoverProvider(deps: KeikoHoverProviderDeps): MonacoHoverProvider {
  let sequence = 0;
  let latest: EditorRequestIdentity | null = null;
  return {
    async provideHover(model, position, token): Promise<MonacoHover | undefined> {
      const documentUri = model.uri.toString();
      if (!deps.isCurrentDocument(documentUri)) {
        return undefined;
      }
      sequence += 1;
      const request = buildRequest(deps, documentUri, position, sequence);
      latest = request.request;
      const controller = controllerForToken(token);
      try {
        const query: EditorHoverQuery = { request, documentText: model.getValue() };
        const response = await deps.resolve(query, controller.signal);
        if (shouldDiscardResponse(response.request, latest)) {
          return undefined;
        }
        return hoverResponseToMonaco(response);
      } catch {
        // A hover failure (network, abort, host error) must never break editing — show nothing.
        return undefined;
      }
    },
  };
}

export interface RegisterKeikoHoverProviderArgs {
  readonly languages: MonacoHoverRegistrar;
  readonly resolve: EditorHoverResolver;
  readonly isCurrentDocument: (documentUri: string) => boolean;
  /** The languages to register a provider for; one provider per language (mirrors completion). */
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
 * Register the Keiko hover provider for each governed language and return a single disposer that tears
 * every registration down. The caller owns disposal (the editor's unmount path).
 */
export function registerKeikoHoverProvider(args: RegisterKeikoHoverProviderArgs): MonacoDisposable {
  const disposers = args.documentLanguages.map((documentLanguage) => {
    const provider = createKeikoHoverProvider({
      resolve: args.resolve,
      isCurrentDocument: args.isCurrentDocument,
      documentLanguage,
      streamId: `${args.streamId}:${documentLanguage}`,
      newRequestId: args.newRequestId,
    });
    return args.languages.registerHoverProvider(documentLanguage, provider);
  });
  return composeDisposers(disposers);
}

/** The governed languages eligible for hover (TS/JS; the #1198 deterministic set). */
export const HOVER_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = ["typescript", "javascript"];
