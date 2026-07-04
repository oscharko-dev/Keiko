/**
 * Regression proof that same-file multi-window editing no longer fans a single trigger out into
 * k BFF calls (GEN-PERF-EDITOR-006).
 *
 * Original defect: two windows editing the same (root, file) shared ONE Monaco model + one URI, and
 * every language provider guarded on `isCurrentDocument(uri)` — since both windows resolved to the
 * same URI, both providers' guards passed and EACH ran its host resolver (a BFF round-trip) on every
 * trigger, plus each window's diagnostics bridge fired on the shared `onDidChangeContent`.
 *
 * Step 03 mitigation: the host now folds a per-window `editorModelScope` (derived from `windowId`)
 * into the model URI, so two windows on the same file produce DISTINCT model URIs -> DISTINCT Monaco
 * models. Each provider's `isCurrentDocument` compares against its OWN window-scoped URI.
 *
 * This suite pins that contract at the provider level with the shipping `createKeikoCompletionProvider`:
 * two providers, each scoped to a distinct window URI of the SAME logical file; a completion trigger
 * carrying window A's URI runs ONLY window A's resolver, and window B's provider returns an empty
 * list WITHOUT calling its resolver. The mechanism (resolver call count per window) is asserted
 * directly, so the double-fire cannot silently return.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createKeikoCompletionProvider,
  type KeikoCompletionProviderDeps,
  type MonacoCancellationToken,
  type MonacoCompletionContext,
  type MonacoCompletionModel,
  type MonacoCompletionItemKinds,
  type MonacoCompletionTriggerKinds,
  type MonacoLanguagesRegistrar,
  type MonacoPositionLike,
} from "./completion-bridge.js";
import type { EditorCompletionResolver, EditorCompletionResponse } from "../index.js";

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

function fakeLanguages(): MonacoLanguagesRegistrar {
  return {
    CompletionItemKind: KINDS,
    CompletionTriggerKind: TRIGGER_KINDS,
    registerCompletionItemProvider(): { dispose: () => void } {
      return { dispose: vi.fn() };
    },
  };
}

// A model whose URI is the window-scoped document URI. Two windows on the same logical file carry
// the SAME file path but DIFFERENT model-scope segments, exactly as the host now builds them.
function fakeModel(uri: string): MonacoCompletionModel {
  return {
    getValue: () => "const a = 1;\n",
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: 5 }),
    uri: { toString: () => uri },
  };
}

function fakeToken(): MonacoCancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested(): { dispose: () => void } {
      return { dispose: vi.fn() };
    },
  };
}

function position(): MonacoPositionLike {
  return { lineNumber: 1, column: 5 };
}

function triggerContext(): MonacoCompletionContext {
  return { triggerKind: TRIGGER_KINDS.Invoke };
}

function okResponse(): EditorCompletionResponse {
  return {
    request: { requestId: "r", streamId: "s", sequence: 1 },
    items: [],
    isIncomplete: false,
    provenance: { sources: ["deterministic-language-service"], modelMode: "deterministic" },
  };
}

// A window-scoped provider whose `isCurrentDocument` matches ONLY its own window URI, mirroring the
// host's `isCurrentDocument` (uri equality against this window's model URI).
function windowProvider(windowUri: string): {
  readonly provider: ReturnType<typeof createKeikoCompletionProvider>;
  readonly resolve: ReturnType<typeof vi.fn>;
} {
  const resolve = vi.fn<EditorCompletionResolver>(() => Promise.resolve(okResponse()));
  const deps: KeikoCompletionProviderDeps = {
    resolve,
    isCurrentDocument: (documentUri: string): boolean => documentUri === windowUri,
    languages: fakeLanguages(),
    triggerCharacters: ["."],
    documentLanguage: "typescript",
    contextBudgetBytes: 4096,
    streamId: "s",
    newRequestId: () => "req",
  };
  return { provider: createKeikoCompletionProvider(deps), resolve };
}

describe("multi-window model scope — no k-fold BFF fan-out (GEN-PERF-EDITOR-006)", () => {
  // Same logical file, two windows -> two DISTINCT window-scoped model URIs.
  const FILE = "keiko-editor://workspace/root/src/app.ts";
  const windowAUri = `${FILE}#window=win-a`;
  const windowBUri = `${FILE}#window=win-b`;

  it("routes a trigger carrying window A's URI to window A's resolver only", async () => {
    const a = windowProvider(windowAUri);
    const b = windowProvider(windowBUri);

    // The completion trigger arrives on the model whose URI is window A's scoped URI.
    const model = fakeModel(windowAUri);
    await a.provider.provideCompletionItems(model, position(), triggerContext(), fakeToken());
    await b.provider.provideCompletionItems(model, position(), triggerContext(), fakeToken());

    // Window A owns this URI -> its resolver (BFF call) runs exactly once.
    expect(a.resolve).toHaveBeenCalledTimes(1);
    // Window B's guard rejects a foreign URI -> NO BFF call. Pre-Step-03 (shared URI) BOTH would run.
    expect(b.resolve).not.toHaveBeenCalled();
  });

  it("k windows on the same file each serve only their own trigger (no cross-window amplification)", async () => {
    const windows = Array.from({ length: 4 }, (_unused, index) =>
      windowProvider(`${FILE}#window=win-${String(index)}`),
    );

    // Fire one trigger per window, each on its own window-scoped model URI.
    for (let index = 0; index < windows.length; index += 1) {
      const model = fakeModel(`${FILE}#window=win-${String(index)}`);
      // Every window's provider sees the trigger, but only the owner runs its resolver.
      await Promise.all(
        windows.map((w) =>
          w.provider.provideCompletionItems(model, position(), triggerContext(), fakeToken()),
        ),
      );
    }

    // Total resolver calls == number of windows (one owned trigger each), NOT windows^2. A shared
    // URI would make every provider's guard pass on every trigger => 16 calls for 4 windows.
    const totalCalls = windows.reduce((sum, w) => sum + w.resolve.mock.calls.length, 0);
    expect(totalCalls).toBe(windows.length);
    windows.forEach((w) => {
      expect(w.resolve).toHaveBeenCalledTimes(1);
    });
  });
});
