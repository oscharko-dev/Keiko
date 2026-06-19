/**
 * Monaco inline-completion (ghost-text) bridge (Issue #1200, ADR-0042 D5/D6).
 *
 * Bridges Monaco's `languages.registerInlineCompletionsProvider` to the host-injected
 * {@link EditorInlineCompletionResolver}. The bridge is pure wiring: it maps a Monaco inline-completion
 * call to a content-free {@link EditorInlineCompletionRequest}, hands the host the request plus the
 * live buffer text (the host assembles the suffix-aware prompt and routes the governed FIM model
 * server-side), applies cross-boundary stale-response discard ({@link shouldDiscardResponse}, #1192),
 * maps the returned ghost-text item back to a Monaco inline completion, and records content-free
 * acceptance/rejection telemetry from Monaco's lifecycle callbacks. It computes no completions, calls
 * no model, performs no I/O, and persists no code content (ADR-0042 D5; Acceptance Criteria 5/6).
 *
 * Acceptance is explicit by construction: the bridge only renders ghost text; the user accepts it
 * solely through Monaco's own inline-suggest commit gesture (Tab / accept action). A superseded or
 * rejected suggestion never mutates the buffer (Acceptance Criteria 2/3). Per-keystroke pacing is
 * Monaco's built-in `debounceDelayMs`; cross-boundary cancellation rides the request identity and an
 * `AbortSignal` wired to Monaco's cancellation token.
 *
 * Monaco is reached only through the small structural interfaces below (never a value import of
 * `monaco-editor`), so the mappers are unit-testable without a browser and the module stays
 * import-side-effect-free. Geometry mappers and shared structural types are reused from the
 * completion bridge (#1199).
 */
import { shouldDiscardResponse } from "../completion-identity.js";
import type { EditorLanguageId } from "../languages.js";
import type {
  EditorInlineCompletionItem,
  EditorInlineCompletionRequest,
  EditorInlineCompletionResolver,
  EditorInlineCompletionResponse,
  EditorInlineCompletionTriggerKind,
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
import type {
  InlineCompletionTelemetry,
  InlineCompletionTelemetryEvent,
} from "./inline-completion-telemetry.js";

// ─── Minimal structural Monaco surface (no value import of `monaco-editor`) ─────────────────────

/** Monaco's `InlineCompletionTriggerKind` enum (Automatic=0, Explicit=1). */
export interface MonacoInlineCompletionTriggerKinds {
  readonly Automatic: number;
  readonly Explicit: number;
}

/** Monaco's `InlineCompletionEndOfLifeReasonKind` enum (Accepted=0, Rejected=1, Ignored=2). */
export interface MonacoInlineCompletionEndOfLifeReasonKinds {
  readonly Accepted: number;
  readonly Rejected: number;
  readonly Ignored: number;
}

export interface MonacoInlineCompletionContext {
  readonly triggerKind: number;
}

export interface MonacoInlineCompletionModel {
  getValue(): string;
  readonly uri: { toString(): string };
}

/** One Monaco inline-completion item: ghost text plus the document span it replaces. */
export interface MonacoInlineCompletion {
  readonly insertText: string;
  readonly range: MonacoRange;
}

export interface MonacoInlineCompletions {
  readonly items: readonly MonacoInlineCompletion[];
}

/** The reason an inline completion reached end-of-life; `kind` is one of the enum members above. */
export interface MonacoInlineCompletionEndOfLifeReason {
  readonly kind: number;
}

/**
 * The slice of Monaco's `InlineCompletionsProvider` the bridge implements. `disposeInlineCompletions`
 * is required by Monaco; the others are optional lifecycle hooks the bridge uses for content-free
 * telemetry. `debounceDelayMs` lets Monaco pace per-keystroke requests (Acceptance Criterion 1).
 */
export interface MonacoInlineCompletionsProvider {
  readonly debounceDelayMs?: number | undefined;
  provideInlineCompletions(
    model: MonacoInlineCompletionModel,
    position: MonacoPositionLike,
    context: MonacoInlineCompletionContext,
    token: MonacoCancellationToken,
  ): Promise<MonacoInlineCompletions | undefined>;
  handleItemDidShow?(completions: MonacoInlineCompletions, item: MonacoInlineCompletion): void;
  handlePartialAccept?(completions: MonacoInlineCompletions, item: MonacoInlineCompletion): void;
  handleEndOfLifetime?(
    completions: MonacoInlineCompletions,
    item: MonacoInlineCompletion,
    reason: MonacoInlineCompletionEndOfLifeReason,
  ): void;
  disposeInlineCompletions(completions: MonacoInlineCompletions): void;
}

/** The slice of the live `monaco.languages` namespace the inline bridge consumes. */
export interface MonacoInlineCompletionsRegistrar {
  readonly InlineCompletionTriggerKind: MonacoInlineCompletionTriggerKinds;
  readonly InlineCompletionEndOfLifeReasonKind: MonacoInlineCompletionEndOfLifeReasonKinds;
  registerInlineCompletionsProvider(
    languageSelector: string | readonly string[],
    provider: MonacoInlineCompletionsProvider,
  ): MonacoDisposable;
}

// ─── Pure mappers ───────────────────────────────────────────────────────────────────────────────

/** Map a Monaco inline-completion trigger to the content-free editor trigger kind (#1192). */
export function monacoInlineTriggerToEditor(
  context: MonacoInlineCompletionContext,
  kinds: MonacoInlineCompletionTriggerKinds,
): EditorInlineCompletionTriggerKind {
  return context.triggerKind === kinds.Explicit ? "explicit" : "automatic";
}

/** Map one editor inline item to a Monaco inline completion (ghost text + replacement range). */
export function editorInlineItemToMonaco(item: EditorInlineCompletionItem): MonacoInlineCompletion {
  return { insertText: item.insertText, range: editorRangeToMonaco(item.range) };
}

/** Map a full inline-completion response to a Monaco inline-completions list. */
export function responseToInlineCompletions(
  response: EditorInlineCompletionResponse,
): MonacoInlineCompletions {
  return { items: response.items.map(editorInlineItemToMonaco) };
}

/** Map a Monaco end-of-life reason kind onto the content-free telemetry event, or undefined. */
export function endOfLifeReasonToEvent(
  reasonKind: number,
  kinds: MonacoInlineCompletionEndOfLifeReasonKinds,
): InlineCompletionTelemetryEvent | undefined {
  if (reasonKind === kinds.Accepted) {
    return "accepted";
  }
  if (reasonKind === kinds.Rejected) {
    return "rejected";
  }
  if (reasonKind === kinds.Ignored) {
    return "ignored";
  }
  return undefined;
}

const EMPTY_INLINE_COMPLETIONS: MonacoInlineCompletions = { items: [] };

// ─── Provider factory ─────────────────────────────────────────────────────────────────────────

export interface KeikoInlineCompletionProviderDeps {
  /** The host-injected resolver that actually produces ghost text (BFF call lives here). */
  readonly resolve: EditorInlineCompletionResolver;
  readonly languages: MonacoInlineCompletionsRegistrar;
  /** The editor language id (e.g. "typescript"); also the registration selector. */
  readonly documentLanguage: EditorLanguageId;
  readonly contextBudgetBytes: number;
  /** Stream identity for this provider instance; supersession is scoped to it. */
  readonly streamId: string;
  /** Unique request-id factory. Injected so tests stay deterministic. */
  readonly newRequestId: () => string;
  /** Per-keystroke debounce Monaco applies before calling the provider (Acceptance Criterion 1). */
  readonly debounceDelayMs: number;
  /** Optional content-free telemetry accumulator fed from Monaco's lifecycle callbacks. */
  readonly telemetry?: InlineCompletionTelemetry | undefined;
  /** Injectable clock for content-free latency telemetry; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}

function buildRequest(
  deps: KeikoInlineCompletionProviderDeps,
  model: MonacoInlineCompletionModel,
  position: MonacoPositionLike,
  context: MonacoInlineCompletionContext,
  sequence: number,
): EditorInlineCompletionRequest {
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
    triggerKind: monacoInlineTriggerToEditor(context, deps.languages.InlineCompletionTriggerKind),
    contextBudgetBytes: deps.contextBudgetBytes,
  };
}

// Mutable per-instance supersession state: a monotonic sequence and the latest request identity.
interface InlineProviderState {
  sequence: number;
  latest: EditorRequestIdentity | null;
}

// Wires an AbortController to Monaco's cancellation token (immediate + on-request abort).
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

// The provider's `provideInlineCompletions` body, extracted so the factory stays a thin assembler.
async function provideInline(
  deps: KeikoInlineCompletionProviderDeps,
  state: InlineProviderState,
  model: MonacoInlineCompletionModel,
  position: MonacoPositionLike,
  context: MonacoInlineCompletionContext,
  token: MonacoCancellationToken,
): Promise<MonacoInlineCompletions | undefined> {
  state.sequence += 1;
  const request = buildRequest(deps, model, position, context, state.sequence);
  state.latest = request.request;
  const controller = controllerForToken(token);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  try {
    const response = await deps.resolve(
      { request, documentText: model.getValue() },
      controller.signal,
    );
    // Cross-boundary stale-response discard: a later keystroke may have superseded this request while
    // it was in flight; `latest` holds the newest identity, so a superseded response renders nothing
    // (Acceptance Criterion 3).
    if (shouldDiscardResponse(response.request, state.latest)) {
      return undefined;
    }
    const mapped = responseToInlineCompletions(response);
    if (mapped.items.length === 0) {
      return undefined;
    }
    deps.telemetry?.record("offered");
    return mapped;
  } catch {
    // Acceptance Criterion 1: an inline-completion failure (network, abort, host error) must never
    // break typing — render no ghost text.
    return undefined;
  } finally {
    deps.telemetry?.recordLatency(now() - startedAt);
  }
}

function recordEndOfLife(
  deps: KeikoInlineCompletionProviderDeps,
  reason: MonacoInlineCompletionEndOfLifeReason,
): void {
  const event = endOfLifeReasonToEvent(
    reason.kind,
    deps.languages.InlineCompletionEndOfLifeReasonKind,
  );
  if (event !== undefined) {
    deps.telemetry?.record(event);
  }
}

/**
 * Create a Monaco inline-completion provider backed by the host resolver. The provider:
 *  - builds a content-free {@link EditorInlineCompletionRequest} with a monotonic per-stream sequence,
 *  - hands the resolver the request plus the live buffer text and an {@link AbortSignal} wired to
 *    Monaco's cancellation token,
 *  - discards a response that a later request has superseded (Acceptance Criterion 3),
 *  - returns no suggestion on any failure so an inline-completion error never breaks editing (AC1), and
 *  - records content-free acceptance/rejection telemetry from Monaco's lifecycle callbacks (AC6).
 */
export function createKeikoInlineCompletionProvider(
  deps: KeikoInlineCompletionProviderDeps,
): MonacoInlineCompletionsProvider {
  const state: InlineProviderState = { sequence: 0, latest: null };
  return {
    debounceDelayMs: deps.debounceDelayMs,
    provideInlineCompletions: (
      model,
      position,
      context,
      token,
    ): Promise<MonacoInlineCompletions | undefined> =>
      provideInline(deps, state, model, position, context, token),
    handleItemDidShow: (): void => {
      deps.telemetry?.record("shown");
    },
    handlePartialAccept: (): void => {
      deps.telemetry?.record("partially-accepted");
    },
    handleEndOfLifetime: (_completions, _item, reason): void => {
      recordEndOfLife(deps, reason);
    },
    disposeInlineCompletions: (): void => {
      // The returned inline-completions object holds no disposable resources; nothing to release.
    },
  };
}

export interface RegisterKeikoInlineCompletionProviderArgs {
  readonly languages: MonacoInlineCompletionsRegistrar;
  readonly resolve: EditorInlineCompletionResolver;
  /**
   * The languages to register a provider for. One provider is registered per language with that
   * language fixed, mirroring the completion bridge so a buffer that switches language within a
   * single editor mount is still served by the correct registration.
   */
  readonly documentLanguages: readonly EditorLanguageId[];
  readonly contextBudgetBytes: number;
  readonly streamId: string;
  readonly newRequestId: () => string;
  readonly debounceDelayMs: number;
  readonly telemetry?: InlineCompletionTelemetry | undefined;
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
 * Register the Keiko inline-completion provider for each governed language and return a single
 * disposer that tears every registration down. The caller owns disposal (the editor's unmount path),
 * so the registrations never outlive the editor instance.
 */
export function registerKeikoInlineCompletionProvider(
  args: RegisterKeikoInlineCompletionProviderArgs,
): MonacoDisposable {
  const disposers = args.documentLanguages.map((documentLanguage) => {
    const provider = createKeikoInlineCompletionProvider({
      resolve: args.resolve,
      languages: args.languages,
      documentLanguage,
      contextBudgetBytes: args.contextBudgetBytes,
      // Supersession is scoped per language registration; each serves a distinct model.
      streamId: `${args.streamId}:${documentLanguage}`,
      newRequestId: args.newRequestId,
      debounceDelayMs: args.debounceDelayMs,
      ...(args.telemetry === undefined ? {} : { telemetry: args.telemetry }),
    });
    return args.languages.registerInlineCompletionsProvider(documentLanguage, provider);
  });
  return composeDisposers(disposers);
}

/** The governed languages eligible for inline completion (TS/JS; the #1198 deterministic set). */
export const INLINE_COMPLETION_ELIGIBLE_LANGUAGES: readonly EditorLanguageId[] = [
  "typescript",
  "javascript",
];

/**
 * Default per-keystroke debounce (ms) the inline-completion provider applies. ~75 ms matches the
 * GitHub Copilot debounce envelope (Issue #1200 grounding) and bounds request pacing without
 * blocking typing; the render/INP budget is owned separately by #1207 (ADR-0042 D5).
 */
export const DEFAULT_INLINE_COMPLETION_DEBOUNCE_MS = 75;

/** Default advisory coding-context budget (bytes) the bridge requests — the server `inline` budget. */
export const DEFAULT_INLINE_COMPLETION_CONTEXT_BUDGET_BYTES = 8_192;

export { EMPTY_INLINE_COMPLETIONS };
