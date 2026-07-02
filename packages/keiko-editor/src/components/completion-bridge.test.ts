import { describe, expect, it, vi } from "vitest";

import {
  COMPLETION_ELIGIBLE_LANGUAGES,
  createEditorRequestId,
  createKeikoCompletionProvider,
  editorItemToMonacoSuggestion,
  editorKindToMonaco,
  editorRangeToMonaco,
  monacoPositionToEditor,
  monacoTriggerToEditor,
  registerKeikoCompletionProvider,
  responseToCompletionList,
  wordRangeAt,
  type KeikoCompletionProviderDeps,
  type MonacoCancellationToken,
  type MonacoCompletionContext,
  type MonacoCompletionItemKinds,
  type MonacoCompletionModel,
  type MonacoCompletionTriggerKinds,
  type MonacoLanguagesRegistrar,
  type MonacoPositionLike,
} from "./completion-bridge.js";
import type {
  EditorCompletionItem,
  EditorCompletionResolver,
  EditorCompletionResponse,
  EditorRequestIdentity,
} from "../index.js";

// Distinct numeric ids so a wrong kind mapping is observable.
const KINDS: MonacoCompletionItemKinds = {
  Text: 1,
  Method: 2,
  Function: 3,
  Constructor: 4,
  Field: 5,
  Variable: 6,
  Class: 7,
  Interface: 8,
  Module: 9,
  Property: 10,
  Keyword: 11,
  Snippet: 12,
};

const TRIGGER_KINDS: MonacoCompletionTriggerKinds = {
  Invoke: 0,
  TriggerCharacter: 1,
  TriggerForIncompleteCompletions: 2,
};

function fakeLanguages(): MonacoLanguagesRegistrar & {
  readonly registrations: { language: string | readonly string[] }[];
} {
  const registrations: { language: string | readonly string[] }[] = [];
  return {
    CompletionItemKind: KINDS,
    CompletionTriggerKind: TRIGGER_KINDS,
    registrations,
    registerCompletionItemProvider(languageSelector, _provider): { dispose: () => void } {
      registrations.push({ language: languageSelector });
      return { dispose: vi.fn() };
    },
  };
}

function fakeModel(
  value = "const a = 1;\n",
  word = { startColumn: 1, endColumn: 5 },
  uri = "inmemory://model/a.ts",
): MonacoCompletionModel {
  return {
    getValue: () => value,
    getWordUntilPosition: () => word,
    uri: { toString: () => uri },
  };
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

function requireCapturedRequest(value: EditorRequestIdentity | null): EditorRequestIdentity {
  if (value === null) {
    throw new Error("expected a captured request");
  }
  return value;
}

function position(lineNumber = 1, column = 5): MonacoPositionLike {
  return { lineNumber, column };
}

function triggerContext(
  triggerKind = TRIGGER_KINDS.Invoke,
  triggerCharacter?: string,
): MonacoCompletionContext {
  return { triggerKind, ...(triggerCharacter === undefined ? {} : { triggerCharacter }) };
}

function item(overrides: Partial<EditorCompletionItem> = {}): EditorCompletionItem {
  return {
    label: "alpha",
    kind: "function",
    insertText: "alpha()",
    provenance: { origin: "deterministic-completion" },
    ...overrides,
  };
}

function response(
  request: EditorRequestIdentity,
  items: readonly EditorCompletionItem[],
  isIncomplete = false,
): EditorCompletionResponse {
  return {
    request,
    items,
    isIncomplete,
    provenance: { sources: ["deterministic-language-service"], modelMode: "deterministic" },
  };
}

function providerDeps(
  resolve: EditorCompletionResolver,
  overrides: Partial<KeikoCompletionProviderDeps> = {},
): KeikoCompletionProviderDeps {
  let n = 0;
  return {
    resolve,
    isCurrentDocument: () => true,
    languages: fakeLanguages(),
    triggerCharacters: ["."],
    documentLanguage: "typescript",
    contextBudgetBytes: 4096,
    streamId: "stream-1",
    newRequestId: (): string => {
      n += 1;
      return `req-${n.toString()}`;
    },
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
  it("maps Monaco trigger context to the content-free editor trigger kind", () => {
    expect(monacoTriggerToEditor(triggerContext(TRIGGER_KINDS.Invoke), TRIGGER_KINDS)).toEqual({
      triggerKind: "invoked",
    });
    expect(
      monacoTriggerToEditor(triggerContext(TRIGGER_KINDS.TriggerCharacter, "."), TRIGGER_KINDS),
    ).toEqual({ triggerKind: "trigger-character", triggerCharacter: "." });
    expect(
      monacoTriggerToEditor(
        triggerContext(TRIGGER_KINDS.TriggerForIncompleteCompletions),
        TRIGGER_KINDS,
      ),
    ).toEqual({ triggerKind: "incomplete" });
  });

  it("omits the trigger character when Monaco supplies none for a trigger-character event", () => {
    expect(
      monacoTriggerToEditor(triggerContext(TRIGGER_KINDS.TriggerCharacter), TRIGGER_KINDS),
    ).toEqual({ triggerKind: "trigger-character" });
  });

  it("converts a 1-based Monaco caret to a 0-based editor position", () => {
    expect(monacoPositionToEditor(position(3, 5))).toEqual({ line: 2, column: 4 });
  });

  it("maps every editor completion-item kind onto the matching Monaco kind", () => {
    const pairs: [EditorCompletionItem["kind"], number][] = [
      ["text", KINDS.Text],
      ["method", KINDS.Method],
      ["function", KINDS.Function],
      ["constructor", KINDS.Constructor],
      ["field", KINDS.Field],
      ["variable", KINDS.Variable],
      ["class", KINDS.Class],
      ["interface", KINDS.Interface],
      ["module", KINDS.Module],
      ["property", KINDS.Property],
      ["keyword", KINDS.Keyword],
      ["snippet", KINDS.Snippet],
    ];
    for (const [kind, expected] of pairs) {
      expect(editorKindToMonaco(kind, KINDS)).toBe(expected);
    }
  });

  it("converts a 0-based editor range to a 1-based Monaco range", () => {
    expect(
      editorRangeToMonaco({ start: { line: 0, column: 0 }, end: { line: 1, column: 3 } }),
    ).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 4 });
  });

  it("derives the word-until-position replacement range from the model", () => {
    expect(wordRangeAt(fakeModel("abc", { startColumn: 1, endColumn: 4 }), position(1, 4))).toEqual(
      {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 4,
      },
    );
  });

  it("maps an item to a Monaco suggestion, using the fallback range and optional fields", () => {
    const fallback = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 };
    const suggestion = editorItemToMonacoSuggestion(
      item({ detail: "d", sortText: "0" }),
      fallback,
      KINDS,
    );
    expect(suggestion).toEqual({
      label: "alpha",
      kind: KINDS.Function,
      insertText: "alpha()",
      range: fallback,
      detail: "d",
      sortText: "0",
    });
  });

  it("prefers an item's explicit range over the fallback and omits absent optional fields", () => {
    const fallback = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 };
    const suggestion = editorItemToMonacoSuggestion(
      item({ range: { start: { line: 0, column: 2 }, end: { line: 0, column: 6 } } }),
      fallback,
      KINDS,
    );
    expect(suggestion.range).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 1,
      endColumn: 7,
    });
    expect(suggestion.detail).toBeUndefined();
    expect(suggestion.sortText).toBeUndefined();
  });

  it("maps a response to a Monaco completion list carrying the incomplete flag", () => {
    const fallback = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 };
    const list = responseToCompletionList(
      response(
        { requestId: "r", streamId: "s", sequence: 1 },
        [item(), item({ label: "b" })],
        true,
      ),
      fallback,
      KINDS,
    );
    expect(list.suggestions).toHaveLength(2);
    expect(list.incomplete).toBe(true);
  });
});

describe("createKeikoCompletionProvider", () => {
  it("builds a content-free request, passes the live buffer text, and renders items", async () => {
    const seen: { documentText: string; request: EditorCompletionResponse["request"] }[] = [];
    const resolve: EditorCompletionResolver = (query) => {
      seen.push({ documentText: query.documentText, request: query.request.request });
      return Promise.resolve(response(query.request.request, [item()]));
    };
    const provider = createKeikoCompletionProvider(providerDeps(resolve));
    const list = await provider.provideCompletionItems(
      fakeModel("const a = 1;\n"),
      position(1, 5),
      triggerContext(TRIGGER_KINDS.TriggerCharacter, "."),
      fakeToken(),
    );
    expect(list.suggestions).toHaveLength(1);
    expect(seen[0]?.documentText).toBe("const a = 1;\n");
    expect(seen[0]?.request).toEqual({ requestId: "req-1", streamId: "stream-1", sequence: 1 });
    expect(provider.triggerCharacters).toEqual(["."]);
  });

  it("returns an empty list without resolving when the model is not this editor's document", async () => {
    const resolve = vi.fn<EditorCompletionResolver>();
    const provider = createKeikoCompletionProvider(
      providerDeps(resolve, {
        isCurrentDocument: (documentUri) => documentUri === "inmemory://model/a.ts",
      }),
    );
    const list = await provider.provideCompletionItems(
      fakeModel("const b = 1;\n", { startColumn: 1, endColumn: 5 }, "inmemory://model/b.ts"),
      position(),
      triggerContext(),
      fakeToken(),
    );
    expect(list).toEqual({ suggestions: [], incomplete: false });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not abort an active owned request when Monaco invokes the provider for another model", async () => {
    const first = deferred<EditorCompletionResponse>();
    const signals: AbortSignal[] = [];
    const resolve: EditorCompletionResolver = (query, signal) => {
      signals.push(signal);
      return first.promise.then(() => response(query.request.request, []));
    };
    const provider = createKeikoCompletionProvider(
      providerDeps(resolve, {
        isCurrentDocument: (documentUri) => documentUri === "inmemory://model/a.ts",
      }),
    );

    const firstCall = provider.provideCompletionItems(
      fakeModel("const a = 1;\n", { startColumn: 1, endColumn: 5 }, "inmemory://model/a.ts"),
      position(),
      triggerContext(),
      fakeToken(),
    );
    const backgroundList = await provider.provideCompletionItems(
      fakeModel("const b = 1;\n", { startColumn: 1, endColumn: 5 }, "inmemory://model/b.ts"),
      position(),
      triggerContext(),
      fakeToken(),
    );

    expect(backgroundList).toEqual({ suggestions: [], incomplete: false });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    first.resolve(response({ requestId: "ignored", streamId: "ignored", sequence: 0 }, []));
    await firstCall;
  });

  it("drops a response when the editor switches documents before completion resolves", async () => {
    let currentUri = "inmemory://model/a.ts";
    const pending = deferred<EditorCompletionResponse>();
    let captured: EditorRequestIdentity | null = null;
    const resolve: EditorCompletionResolver = (query) => {
      captured = query.request.request;
      return pending.promise;
    };
    const provider = createKeikoCompletionProvider(
      providerDeps(resolve, { isCurrentDocument: (documentUri) => documentUri === currentUri }),
    );

    const call = provider.provideCompletionItems(
      fakeModel("const a = 1;\n", { startColumn: 1, endColumn: 5 }, "inmemory://model/a.ts"),
      position(),
      triggerContext(),
      fakeToken(),
    );
    currentUri = "inmemory://model/b.ts";
    pending.resolve(response(requireCapturedRequest(captured), [item()]));

    expect(await call).toEqual({ suggestions: [], incomplete: false });
  });

  it("advances the per-stream sequence on each call", async () => {
    const requests: EditorRequestIdentity[] = [];
    const resolve: EditorCompletionResolver = (query) => {
      requests.push(query.request.request);
      return Promise.resolve(response(query.request.request, []));
    };
    const provider = createKeikoCompletionProvider(providerDeps(resolve));
    await provider.provideCompletionItems(fakeModel(), position(), triggerContext(), fakeToken());
    await provider.provideCompletionItems(fakeModel(), position(), triggerContext(), fakeToken());
    expect(requests.map((r) => r.sequence)).toEqual([1, 2]);
  });

  it("discards a superseded (stale) response and renders nothing for it (AC3)", async () => {
    const first = deferred<EditorCompletionResponse>();
    const second = deferred<EditorCompletionResponse>();
    const queue = [first, second];
    let index = 0;
    const captured: EditorRequestIdentity[] = [];
    const resolve: EditorCompletionResolver = (query) => {
      captured.push(query.request.request);
      const slot = queue[index];
      index += 1;
      return slot === undefined
        ? Promise.resolve(response(query.request.request, []))
        : slot.promise;
    };
    const provider = createKeikoCompletionProvider(providerDeps(resolve));

    const firstCall = provider.provideCompletionItems(
      fakeModel(),
      position(),
      triggerContext(),
      fakeToken(),
    );
    const secondCall = provider.provideCompletionItems(
      fakeModel(),
      position(),
      triggerContext(),
      fakeToken(),
    );
    // Resolve the SECOND request first so it becomes current, then the stale first.
    const [firstReq, secondReq] = captured;
    if (firstReq === undefined || secondReq === undefined) {
      throw new Error("expected two captured requests");
    }
    second.resolve(response(secondReq, [item({ label: "fresh" })]));
    first.resolve(response(firstReq, [item({ label: "stale" })]));

    const secondList = await secondCall;
    const firstList = await firstCall;
    expect(secondList.suggestions.map((s) => s.label)).toEqual(["fresh"]);
    expect(firstList.suggestions).toEqual([]);
  });

  it("aborts the previous active request when a newer request starts", async () => {
    const first = deferred<EditorCompletionResponse>();
    const second = deferred<EditorCompletionResponse>();
    const queue = [first, second];
    const captured: EditorRequestIdentity[] = [];
    const signals: AbortSignal[] = [];
    let index = 0;
    const resolve: EditorCompletionResolver = (query, signal) => {
      captured.push(query.request.request);
      signals.push(signal);
      const slot = queue[index];
      index += 1;
      return slot === undefined
        ? Promise.resolve(response(query.request.request, []))
        : slot.promise;
    };
    const provider = createKeikoCompletionProvider(providerDeps(resolve));

    const firstCall = provider.provideCompletionItems(
      fakeModel(),
      position(),
      triggerContext(),
      fakeToken(),
    );
    const secondCall = provider.provideCompletionItems(
      fakeModel(),
      position(),
      triggerContext(),
      fakeToken(),
    );

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    const [firstReq, secondReq] = captured;
    if (firstReq === undefined || secondReq === undefined) {
      throw new Error("expected two captured requests");
    }
    first.resolve(response(firstReq, [item({ label: "stale" })]));
    second.resolve(response(secondReq, [item({ label: "fresh" })]));
    expect((await firstCall).suggestions).toEqual([]);
    expect((await secondCall).suggestions.map((suggestion) => suggestion.label)).toEqual(["fresh"]);
  });

  it("aborts the resolver signal when Monaco cancels the request", async () => {
    const token = fakeToken();
    let observedAborted: boolean | null = null;
    const resolve: EditorCompletionResolver = (query, signal) =>
      new Promise<EditorCompletionResponse>((res) => {
        signal.addEventListener("abort", () => {
          observedAborted = signal.aborted;
          res(response(query.request.request, []));
        });
      });
    const provider = createKeikoCompletionProvider(providerDeps(resolve));
    const call = provider.provideCompletionItems(fakeModel(), position(), triggerContext(), token);
    token.cancel();
    await call;
    expect(observedAborted).toBe(true);
    expect(token.disposeListener).toHaveBeenCalledTimes(1);
  });

  it("aborts immediately when the token is already cancelled before the call", async () => {
    const token = fakeToken();
    const cancelledToken: MonacoCancellationToken = { ...token, isCancellationRequested: true };
    let abortedAtStart: boolean | null = null;
    const resolve: EditorCompletionResolver = (query, signal) => {
      abortedAtStart = signal.aborted;
      return Promise.resolve(response(query.request.request, []));
    };
    const provider = createKeikoCompletionProvider(providerDeps(resolve));
    await provider.provideCompletionItems(
      fakeModel(),
      position(),
      triggerContext(),
      cancelledToken,
    );
    expect(abortedAtStart).toBe(true);
    expect(token.disposeListener).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list when the resolver rejects, so editing is never broken (AC4)", async () => {
    const resolve: EditorCompletionResolver = () => Promise.reject(new Error("boom"));
    const provider = createKeikoCompletionProvider(providerDeps(resolve));
    const list = await provider.provideCompletionItems(
      fakeModel(),
      position(),
      triggerContext(),
      fakeToken(),
    );
    expect(list.suggestions).toEqual([]);
    expect(list.incomplete).toBe(false);
  });
});

describe("registerKeikoCompletionProvider", () => {
  it("registers one provider per governed language and disposes them all", () => {
    const languages = fakeLanguages();
    const disposer = registerKeikoCompletionProvider({
      languages,
      resolve: () => Promise.resolve(response({ requestId: "r", streamId: "s", sequence: 1 }, [])),
      isCurrentDocument: () => true,
      documentLanguages: COMPLETION_ELIGIBLE_LANGUAGES,
      triggerCharacters: ["."],
      contextBudgetBytes: 4096,
      streamId: "stream",
      newRequestId: createEditorRequestId,
    });
    expect(languages.registrations.map((r) => r.language)).toEqual(["typescript", "javascript"]);
    expect(() => {
      disposer.dispose();
    }).not.toThrow();
  });
});

describe("createEditorRequestId", () => {
  it("returns distinct non-empty strings", () => {
    const a = createEditorRequestId();
    const b = createEditorRequestId();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});
