import { describe, expect, it, vi } from "vitest";

import {
  createKeikoInlineCompletionProvider,
  DEFAULT_INLINE_COMPLETION_CONTEXT_BUDGET_BYTES,
  DEFAULT_INLINE_COMPLETION_DEBOUNCE_MS,
  editorInlineItemToMonaco,
  endOfLifeReasonToEvent,
  INLINE_COMPLETION_ELIGIBLE_LANGUAGES,
  monacoInlineTriggerToEditor,
  registerKeikoInlineCompletionProvider,
  responseToInlineCompletions,
  type KeikoInlineCompletionProviderDeps,
  type MonacoInlineCompletionContext,
  type MonacoInlineCompletionEndOfLifeReasonKinds,
  type MonacoInlineCompletionModel,
  type MonacoInlineCompletionsProvider,
  type MonacoInlineCompletionsRegistrar,
  type MonacoInlineCompletionTriggerKinds,
} from "./inline-completion-bridge.js";
// Shared structural Monaco types are owned by the completion bridge (#1199) and reused here.
import type { MonacoCancellationToken, MonacoPositionLike } from "./completion-bridge.js";
import { createInlineCompletionTelemetry } from "./inline-completion-telemetry.js";
import type {
  EditorInlineCompletionItem,
  EditorInlineCompletionResolver,
  EditorInlineCompletionResponse,
  EditorRequestIdentity,
} from "../index.js";

const TRIGGER_KINDS: MonacoInlineCompletionTriggerKinds = { Automatic: 0, Explicit: 1 };
const END_OF_LIFE_KINDS: MonacoInlineCompletionEndOfLifeReasonKinds = {
  Accepted: 0,
  Rejected: 1,
  Ignored: 2,
};

function fakeRegistrar(): MonacoInlineCompletionsRegistrar & {
  readonly registrations: (string | readonly string[])[];
} {
  const registrations: (string | readonly string[])[] = [];
  return {
    InlineCompletionTriggerKind: TRIGGER_KINDS,
    InlineCompletionEndOfLifeReasonKind: END_OF_LIFE_KINDS,
    registrations,
    registerInlineCompletionsProvider(languageSelector, _provider): { dispose: () => void } {
      registrations.push(languageSelector);
      return { dispose: vi.fn() };
    },
  };
}

function fakeModel(value = "const a = 1;\n"): MonacoInlineCompletionModel {
  return { getValue: () => value, uri: { toString: () => "inmemory://model/a.ts" } };
}

function fakeToken(): MonacoCancellationToken & {
  cancel: () => void;
  disposeListener: ReturnType<typeof vi.fn>;
} {
  let listener: (() => void) | null = null;
  const disposeListener = vi.fn(() => {
    listener = null;
  });
  return {
    isCancellationRequested: false,
    onCancellationRequested(fn): { dispose: () => void } {
      listener = fn;
      return { dispose: disposeListener };
    },
    cancel(): void {
      listener?.();
    },
    disposeListener,
  };
}

function position(lineNumber = 1, column = 5): MonacoPositionLike {
  return { lineNumber, column };
}

function context(triggerKind = TRIGGER_KINDS.Automatic): MonacoInlineCompletionContext {
  return { triggerKind };
}

function inlineItem(
  overrides: Partial<EditorInlineCompletionItem> = {},
): EditorInlineCompletionItem {
  return {
    insertText: "fooBar()",
    range: { start: { line: 0, column: 6 }, end: { line: 0, column: 6 } },
    provenance: {
      origin: "ai-inline-completion",
      model: {
        modelId: "fim-fast",
        gatewayPolicyVersion: "editor-inline-completion/1",
        promptHash: "a".repeat(64),
        producedAt: 1,
      },
    },
    ...overrides,
  };
}

function response(
  request: EditorRequestIdentity,
  items: readonly EditorInlineCompletionItem[],
): EditorInlineCompletionResponse {
  return { request, items };
}

function providerDeps(
  resolve: EditorInlineCompletionResolver,
  overrides: Partial<KeikoInlineCompletionProviderDeps> = {},
): KeikoInlineCompletionProviderDeps {
  let n = 0;
  return {
    resolve,
    languages: fakeRegistrar(),
    documentLanguage: "typescript",
    contextBudgetBytes: DEFAULT_INLINE_COMPLETION_CONTEXT_BUDGET_BYTES,
    streamId: "stream-1",
    newRequestId: (): string => {
      n += 1;
      return `req-${String(n)}`;
    },
    debounceDelayMs: DEFAULT_INLINE_COMPLETION_DEBOUNCE_MS,
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: resolveFn };
}

describe("pure mappers", () => {
  it("maps the Monaco inline trigger to the content-free editor kind", () => {
    expect(monacoInlineTriggerToEditor(context(TRIGGER_KINDS.Automatic), TRIGGER_KINDS)).toBe(
      "automatic",
    );
    expect(monacoInlineTriggerToEditor(context(TRIGGER_KINDS.Explicit), TRIGGER_KINDS)).toBe(
      "explicit",
    );
  });

  it("maps an editor inline item to a Monaco inline completion (1-based range)", () => {
    const monaco = editorInlineItemToMonaco(inlineItem());
    expect(monaco.insertText).toBe("fooBar()");
    expect(monaco.range).toEqual({
      startLineNumber: 1,
      startColumn: 7,
      endLineNumber: 1,
      endColumn: 7,
    });
  });

  it("maps a response to a Monaco inline-completions list", () => {
    const list = responseToInlineCompletions(
      response({ requestId: "r", streamId: "s", sequence: 1 }, [inlineItem(), inlineItem()]),
    );
    expect(list.items).toHaveLength(2);
  });

  it("maps end-of-life reason kinds to telemetry events", () => {
    expect(endOfLifeReasonToEvent(END_OF_LIFE_KINDS.Accepted, END_OF_LIFE_KINDS)).toBe("accepted");
    expect(endOfLifeReasonToEvent(END_OF_LIFE_KINDS.Rejected, END_OF_LIFE_KINDS)).toBe("rejected");
    expect(endOfLifeReasonToEvent(END_OF_LIFE_KINDS.Ignored, END_OF_LIFE_KINDS)).toBe("ignored");
    expect(endOfLifeReasonToEvent(99, END_OF_LIFE_KINDS)).toBeUndefined();
  });
});

describe("createKeikoInlineCompletionProvider", () => {
  it("builds a content-free request and returns mapped ghost text", async () => {
    const resolve = vi.fn<EditorInlineCompletionResolver>((query) =>
      Promise.resolve(response(query.request.request, [inlineItem()])),
    );
    const provider = createKeikoInlineCompletionProvider(providerDeps(resolve));

    const result = await provider.provideInlineCompletions(
      fakeModel(),
      position(),
      context(TRIGGER_KINDS.Automatic),
      fakeToken(),
    );

    expect(result?.items).toHaveLength(1);
    const query = resolve.mock.calls[0]?.[0];
    expect(query?.documentText).toBe("const a = 1;\n");
    expect(query?.request.triggerKind).toBe("automatic");
    expect(query?.request.position).toEqual({ line: 0, column: 4 });
    expect(query?.request.document.language).toBe("typescript");
    expect(query?.request.contextBudgetBytes).toBe(DEFAULT_INLINE_COMPLETION_CONTEXT_BUDGET_BYTES);
    // content-free: no buffer text on the request identity
    expect(JSON.stringify(query?.request)).not.toContain("const a");
  });

  it("records an 'offered' event only when items are produced", async () => {
    const telemetry = createInlineCompletionTelemetry();
    const provider = createKeikoInlineCompletionProvider(
      providerDeps((query) => Promise.resolve(response(query.request.request, [inlineItem()])), {
        telemetry,
      }),
    );
    await provider.provideInlineCompletions(fakeModel(), position(), context(), fakeToken());
    expect(telemetry.snapshot().offered).toBe(1);
  });

  it("records content-free resolver latency p50/p95", async () => {
    const telemetry = createInlineCompletionTelemetry();
    const ticks = [100, 148];
    const provider = createKeikoInlineCompletionProvider(
      providerDeps((query) => Promise.resolve(response(query.request.request, [inlineItem()])), {
        telemetry,
        now: () => ticks.shift() ?? 148,
      }),
    );
    await provider.provideInlineCompletions(fakeModel(), position(), context(), fakeToken());
    expect(telemetry.snapshot()).toMatchObject({
      requestCount: 1,
      requestLatencyMsP50: 48,
      requestLatencyMsP95: 48,
    });
  });

  it("returns undefined and records nothing when the host yields no items", async () => {
    const telemetry = createInlineCompletionTelemetry();
    const provider = createKeikoInlineCompletionProvider(
      providerDeps((query) => Promise.resolve(response(query.request.request, [])), { telemetry }),
    );
    const result = await provider.provideInlineCompletions(
      fakeModel(),
      position(),
      context(),
      fakeToken(),
    );
    expect(result).toBeUndefined();
    expect(telemetry.snapshot().offered).toBe(0);
  });

  it("discards a response whose identity no longer matches the latest request (AC3)", async () => {
    // The resolver answers with a STALE identity (as if a later keystroke had superseded this
    // request while it was in flight); the bridge must render nothing rather than the stale ghost text.
    const staleIdentity: EditorRequestIdentity = { requestId: "old", streamId: "s", sequence: 0 };
    const provider = createKeikoInlineCompletionProvider(
      providerDeps(() => Promise.resolve(response(staleIdentity, [inlineItem()]))),
    );
    const result = await provider.provideInlineCompletions(
      fakeModel(),
      position(),
      context(),
      fakeToken(),
    );
    expect(result).toBeUndefined();
  });

  it("aborts the resolver signal when Monaco cancels", async () => {
    const signals: AbortSignal[] = [];
    const result = deferred<EditorInlineCompletionResponse>();
    const provider = createKeikoInlineCompletionProvider(
      providerDeps((_query, signal) => {
        signals.push(signal);
        return result.promise;
      }),
    );
    const token = fakeToken();
    const call = provider.provideInlineCompletions(fakeModel(), position(), context(), token);
    expect(signals[0]?.aborted).toBe(false);
    token.cancel();
    expect(signals[0]?.aborted).toBe(true);
    result.resolve(response({ requestId: "req-1", streamId: "stream-1", sequence: 1 }, []));
    await call;
    expect(token.disposeListener).toHaveBeenCalledTimes(1);
  });

  it("aborts the previous active request when a newer request starts", async () => {
    const first = deferred<EditorInlineCompletionResponse>();
    const second = deferred<EditorInlineCompletionResponse>();
    const queue = [first, second];
    const captured: EditorRequestIdentity[] = [];
    const signals: AbortSignal[] = [];
    let index = 0;
    const provider = createKeikoInlineCompletionProvider(
      providerDeps((query, signal) => {
        captured.push(query.request.request);
        signals.push(signal);
        const slot = queue[index];
        index += 1;
        return slot === undefined
          ? Promise.resolve(response(query.request.request, []))
          : slot.promise;
      }),
    );

    const firstCall = provider.provideInlineCompletions(
      fakeModel(),
      position(),
      context(),
      fakeToken(),
    );
    const secondCall = provider.provideInlineCompletions(
      fakeModel(),
      position(),
      context(),
      fakeToken(),
    );

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    const [firstReq, secondReq] = captured;
    if (firstReq === undefined || secondReq === undefined) {
      throw new Error("expected two captured requests");
    }
    first.resolve(response(firstReq, [inlineItem({ insertText: "stale" })]));
    second.resolve(response(secondReq, [inlineItem({ insertText: "fresh" })]));
    expect(await firstCall).toBeUndefined();
    expect((await secondCall)?.items.map((item) => item.insertText)).toEqual(["fresh"]);
  });

  it("renders nothing when the resolver rejects, never breaking typing (AC1)", async () => {
    const provider = createKeikoInlineCompletionProvider(
      providerDeps(() => Promise.reject(new Error("boom"))),
    );
    const result = await provider.provideInlineCompletions(
      fakeModel(),
      position(),
      context(),
      fakeToken(),
    );
    expect(result).toBeUndefined();
  });

  it("records content-free shown/accept/reject/ignore/partial telemetry from lifecycle callbacks", () => {
    const telemetry = createInlineCompletionTelemetry();
    const provider = createKeikoInlineCompletionProvider(
      providerDeps(() => Promise.reject(new Error("inline test")), { telemetry }),
    );
    const completions = { items: [] };
    const item = {
      insertText: "x",
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    };

    provider.handleItemDidShow?.(completions, item);
    provider.handlePartialAccept?.(completions, item);
    provider.handleEndOfLifetime?.(completions, item, { kind: END_OF_LIFE_KINDS.Accepted });
    provider.handleEndOfLifetime?.(completions, item, { kind: END_OF_LIFE_KINDS.Rejected });
    provider.handleEndOfLifetime?.(completions, item, { kind: END_OF_LIFE_KINDS.Ignored });
    // disposeInlineCompletions is a required no-op
    expect(() => {
      provider.disposeInlineCompletions(completions);
    }).not.toThrow();

    expect(telemetry.snapshot()).toEqual({
      offered: 0,
      shown: 1,
      accepted: 1,
      rejected: 1,
      ignored: 1,
      partiallyAccepted: 1,
      requestCount: 0,
      requestLatencyMsP50: 0,
      requestLatencyMsP95: 0,
    });
  });

  it("exposes Monaco's debounce delay for per-keystroke pacing (AC1)", () => {
    const provider = createKeikoInlineCompletionProvider(
      providerDeps(() => Promise.reject(new Error("inline test")), { debounceDelayMs: 75 }),
    );
    expect(provider.debounceDelayMs).toBe(75);
  });
});

describe("registerKeikoInlineCompletionProvider", () => {
  it("registers one provider per governed language and disposes all on teardown", () => {
    const languages = fakeRegistrar();
    const disposers: { dispose: () => void }[] = [];
    languages.registerInlineCompletionsProvider = vi.fn((selector: string | readonly string[]) => {
      languages.registrations.push(selector);
      const d = { dispose: vi.fn() };
      disposers.push(d);
      return d;
    });
    const disposer = registerKeikoInlineCompletionProvider({
      languages,
      resolve: () => Promise.reject(new Error("inline test")),
      documentLanguages: INLINE_COMPLETION_ELIGIBLE_LANGUAGES,
      contextBudgetBytes: DEFAULT_INLINE_COMPLETION_CONTEXT_BUDGET_BYTES,
      streamId: "s",
      newRequestId: () => "r",
      debounceDelayMs: DEFAULT_INLINE_COMPLETION_DEBOUNCE_MS,
    });
    expect(languages.registrations).toEqual(["typescript", "javascript"]);
    disposer.dispose();
    for (const d of disposers) {
      expect(d.dispose).toHaveBeenCalledTimes(1);
    }
  });

  it("scopes the supersession stream id per language (streamId:language)", async () => {
    const captured: string[] = [];
    const providers: MonacoInlineCompletionsProvider[] = [];
    const languages: MonacoInlineCompletionsRegistrar = {
      InlineCompletionTriggerKind: TRIGGER_KINDS,
      InlineCompletionEndOfLifeReasonKind: END_OF_LIFE_KINDS,
      registerInlineCompletionsProvider: (_selector, provider) => {
        providers.push(provider);
        return { dispose: vi.fn() };
      },
    };
    registerKeikoInlineCompletionProvider({
      languages,
      resolve: (query) => {
        captured.push(query.request.request.streamId);
        return Promise.resolve(response(query.request.request, []));
      },
      documentLanguages: ["typescript", "javascript"],
      contextBudgetBytes: 8192,
      streamId: "base",
      newRequestId: () => "r",
      debounceDelayMs: 75,
    });
    for (const provider of providers) {
      await provider.provideInlineCompletions(fakeModel(), position(), context(), fakeToken());
    }
    expect(captured).toEqual(["base:typescript", "base:javascript"]);
  });
});
