import { describe, expect, it } from "vitest";

import {
  createKeikoFormattingProvider,
  editorTextEditToMonaco,
  editsToMonaco,
  FORMATTING_ELIGIBLE_LANGUAGES,
  monacoFormattingOptionsToEditor,
  registerKeikoFormattingProvider,
  type MonacoDocumentFormattingEditProvider,
  type MonacoDocumentFormattingRegistrar,
  type MonacoFormattingModel,
  type MonacoFormattingOptions,
} from "./formatting-bridge.js";
import type { MonacoCancellationToken } from "./completion-bridge.js";
import type { EditorFormattingResolver, EditorTextEdit } from "../types.js";
import { EDITOR_BUILTIN_CAPABILITIES } from "@oscharko-dev/keiko-contracts";

function model(text = "const x   =   1;\n", version = 1): MonacoFormattingModel {
  return {
    getValue: () => text,
    getVersionId: () => version,
    uri: { toString: () => "inmemory://model/1" },
  };
}

const OPTIONS: MonacoFormattingOptions = { tabSize: 2, insertSpaces: true };

function token(cancelled = false): MonacoCancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  };
}

function edit(newText: string): EditorTextEdit {
  return { range: { start: { line: 0, column: 7 }, end: { line: 0, column: 13 } }, newText };
}

describe("pure mappers", () => {
  it("maps an editor text edit to a Monaco text edit (1-based range, newText -> text)", () => {
    expect(editorTextEditToMonaco(edit(" = "))).toEqual({
      range: { startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 14 },
      text: " = ",
    });
  });

  it("maps a list of edits", () => {
    expect(editsToMonaco([edit("a"), edit("b")]).map((e) => e.text)).toEqual(["a", "b"]);
  });

  it("maps Monaco formatting options to the editor preferences", () => {
    expect(monacoFormattingOptionsToEditor({ tabSize: 4, insertSpaces: false })).toEqual({
      tabSize: 4,
      insertSpaces: false,
    });
  });
});

function provider(resolve: EditorFormattingResolver): MonacoDocumentFormattingEditProvider {
  return createKeikoFormattingProvider({
    resolve,
    isCurrentDocument: (documentUri) => documentUri === "inmemory://model/1",
    documentLanguage: "typescript",
    streamId: "stream",
    newRequestId: () => "req",
  });
}

describe("createKeikoFormattingProvider", () => {
  it("resolves reformatting edits and maps them to Monaco text edits", async () => {
    const resolve: EditorFormattingResolver = (query) =>
      Promise.resolve({ request: query.request.request, edits: [edit(" = ")] });
    const edits = await provider(resolve).provideDocumentFormattingEdits(model(), OPTIONS, token());
    expect(edits).toEqual([
      {
        range: { startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 14 },
        text: " = ",
      },
    ]);
  });

  it("forwards the live buffer, content-free request, and indentation options to the resolver", async () => {
    let seenText = "";
    let seenInsertSpaces: boolean | null = null;
    let seenVersion = 0;
    const resolve: EditorFormattingResolver = (query) => {
      seenText = query.documentText;
      seenInsertSpaces = query.request.options.insertSpaces;
      seenVersion = query.request.document.version;
      return Promise.resolve({ request: query.request.request, edits: [] });
    };
    await provider(resolve).provideDocumentFormattingEdits(
      model("buffer", 7),
      { tabSize: 4, insertSpaces: false },
      token(),
    );
    expect(seenText).toBe("buffer");
    expect(seenInsertSpaces).toBe(false);
    expect(seenVersion).toBe(7);
  });

  it("ignores another editor model before calling the resolver", async () => {
    let calls = 0;
    const resolve: EditorFormattingResolver = (query) => {
      calls += 1;
      return Promise.resolve({ request: query.request.request, edits: [edit(" = ")] });
    };
    const edits = await provider(resolve).provideDocumentFormattingEdits(
      {
        getValue: () => "other",
        getVersionId: () => 1,
        uri: { toString: () => "inmemory://model/2" },
      },
      OPTIONS,
      token(),
    );
    expect(edits).toEqual([]);
    expect(calls).toBe(0);
  });

  it("returns no edits on resolver failure (never corrupts the buffer)", async () => {
    const resolve: EditorFormattingResolver = () => Promise.reject(new Error("boom"));
    expect(
      await provider(resolve).provideDocumentFormattingEdits(model(), OPTIONS, token()),
    ).toEqual([]);
  });

  it("returns no edits when cancelled before completion (cancellable)", async () => {
    const resolve: EditorFormattingResolver = (query) =>
      Promise.resolve({ request: query.request.request, edits: [edit(" = ")] });
    // A pre-cancelled token aborts the controller, so the resolved edits are dropped rather than
    // applied to the buffer.
    const edits = await provider(resolve).provideDocumentFormattingEdits(
      model(),
      OPTIONS,
      token(true),
    );
    expect(edits).toEqual([]);
  });

  it("drops edits when cancelled mid-flight, after the request starts (cancellable)", async () => {
    // Exercise the post-await abort guard: cancellation fires while the request is in flight, before
    // it settles, so the resolved edits must NOT be applied to the buffer.
    let fireCancel: (() => void) | undefined;
    const liveToken: MonacoCancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: (listener) => {
        fireCancel = listener;
        return { dispose: (): void => undefined };
      },
    };
    let settle: (() => void) | undefined;
    const resolve: EditorFormattingResolver = (query) =>
      new Promise((res) => {
        settle = (): void => {
          res({ request: query.request.request, edits: [edit(" = ")] });
        };
      });
    const pending = provider(resolve).provideDocumentFormattingEdits(model(), OPTIONS, liveToken);
    expect(fireCancel).toBeDefined();
    fireCancel?.();
    settle?.();
    expect(await pending).toEqual([]);
  });

  it("drops edits when the model version changes while formatting is in flight", async () => {
    let version = 1;
    let settle: (() => void) | undefined;
    const liveModel: MonacoFormattingModel = {
      getValue: () => "const x=1;\n",
      getVersionId: () => version,
      uri: { toString: () => "inmemory://model/1" },
    };
    const resolve: EditorFormattingResolver = (query) =>
      new Promise((res) => {
        settle = (): void => {
          res({ request: query.request.request, edits: [edit(" = ")] });
        };
      });
    const pending = provider(resolve).provideDocumentFormattingEdits(liveModel, OPTIONS, token());
    version = 2;
    settle?.();
    expect(await pending).toEqual([]);
  });

  it("aborts the resolver signal when the token is already cancelled", async () => {
    let aborted = false;
    const resolve: EditorFormattingResolver = (query, signal) => {
      aborted = signal.aborted;
      return Promise.resolve({ request: query.request.request, edits: [] });
    };
    await provider(resolve).provideDocumentFormattingEdits(model(), OPTIONS, token(true));
    expect(aborted).toBe(true);
  });
});

interface FakeFormattingRegistrar {
  readonly registrar: MonacoDocumentFormattingRegistrar;
  readonly registered: () => readonly (string | readonly string[])[];
  readonly disposeCount: () => number;
}

function buildRegistrar(): FakeFormattingRegistrar {
  const registered: (string | readonly string[])[] = [];
  let disposed = 0;
  const registrar: MonacoDocumentFormattingRegistrar = {
    registerDocumentFormattingEditProvider: (selector): { dispose: () => void } => {
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

describe("registerKeikoFormattingProvider", () => {
  it("registers a provider per governed language and disposes all on teardown", () => {
    const fake = buildRegistrar();
    const resolve: EditorFormattingResolver = (query) =>
      Promise.resolve({ request: query.request.request, edits: [] });
    const disposable = registerKeikoFormattingProvider({
      languages: fake.registrar,
      resolve,
      isCurrentDocument: () => true,
      documentLanguages: FORMATTING_ELIGIBLE_LANGUAGES,
      streamId: "s",
      newRequestId: () => "r",
    });
    expect(fake.registered()).toEqual(["typescript", "javascript"]);
    disposable.dispose();
    expect(fake.disposeCount()).toBe(2);
  });

  it("exposes the governed eligible languages", () => {
    expect(FORMATTING_ELIGIBLE_LANGUAGES).toEqual(["typescript", "javascript"]);
  });
});

describe("FORMATTING_ELIGIBLE_LANGUAGES ↔ registry coherence (ADR-0068 D7)", () => {
  // No double-registration: the Keiko bridge must register a DocumentFormattingEditProvider for
  // EXACTLY the languages the registry routes to "keiko-language-service" — never for a
  // "monaco-builtin" language (Monaco's bundled worker owns those; two providers would compete for
  // "Format Document"), and never dropping a language-service language. Pinning set equality means a
  // future shift of either side fails this test instead of silently shadowing or under-formatting.
  it("equals exactly the registry's keiko-language-service set", () => {
    const registryLanguageServiceIds = EDITOR_BUILTIN_CAPABILITIES.filter(
      (capability) => capability.documentFormatting === "keiko-language-service",
    )
      .map((capability) => capability.languageId)
      .sort((a, b) => a.localeCompare(b));
    const eligible = [...FORMATTING_ELIGIBLE_LANGUAGES].sort((a, b) => a.localeCompare(b));
    expect(eligible).toEqual(registryLanguageServiceIds);
  });

  it("never overlaps the monaco-builtin set (no competing provider)", () => {
    const monacoBuiltinIds = new Set(
      EDITOR_BUILTIN_CAPABILITIES.filter(
        (capability) => capability.documentFormatting === "monaco-builtin",
      ).map((capability) => capability.languageId),
    );
    for (const eligible of FORMATTING_ELIGIBLE_LANGUAGES) {
      expect(monacoBuiltinIds.has(eligible)).toBe(false);
    }
  });
});
