import { describe, expect, it } from "vitest";

import {
  actionKindToMonaco,
  actionToMonaco,
  CODE_ACTION_ELIGIBLE_LANGUAGES,
  codeActionsResponseToMonaco,
  createKeikoCodeActionProvider,
  markerToEditorDiagnostic,
  monacoRangeToEditor,
  registerKeikoCodeActionProvider,
  type MonacoCodeActionKinds,
  type MonacoCodeActionModel,
  type MonacoCodeActionProvider,
  type MonacoCodeActionRegistrar,
  type MonacoMarkerLike,
} from "./code-action-bridge.js";
import type { MonacoCancellationToken, MonacoRange } from "./completion-bridge.js";
import type { MonacoUriLike } from "./definition-bridge.js";
import type { EditorCodeActionsResolver } from "../types.js";

const URI: MonacoUriLike = { toString: () => "keiko-editor://current" };
const KINDS: MonacoCodeActionKinds = {
  QuickFix: "quickfix",
  Refactor: "refactor",
  Source: "source",
};
const RANGE: MonacoRange = {
  startLineNumber: 1,
  startColumn: 7,
  endLineNumber: 1,
  endColumn: 8,
};

function model(text = "const x: number = 's';\n"): MonacoCodeActionModel {
  return { getValue: () => text, uri: URI };
}

function marker(): MonacoMarkerLike {
  return {
    severity: 8,
    message: "Type mismatch",
    startLineNumber: 1,
    startColumn: 7,
    endLineNumber: 1,
    endColumn: 8,
    source: "typescript",
    code: 2322,
  };
}

function token(): MonacoCancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  };
}

function provider(resolve: EditorCodeActionsResolver): MonacoCodeActionProvider {
  return createKeikoCodeActionProvider({
    resolve,
    isCurrentDocument: (documentUri) => documentUri === URI.toString(),
    codeActionKinds: KINDS,
    documentLanguage: "typescript",
    streamId: "stream",
    newRequestId: () => "req",
  });
}

describe("code-action pure mappers", () => {
  it("maps Monaco ranges and markers to editor diagnostics", () => {
    expect(monacoRangeToEditor(RANGE)).toEqual({
      start: { line: 0, column: 6 },
      end: { line: 0, column: 7 },
    });
    expect(markerToEditorDiagnostic(marker())).toEqual({
      range: { start: { line: 0, column: 6 }, end: { line: 0, column: 7 } },
      severity: "error",
      message: "Type mismatch",
      source: "typescript",
      code: "2322",
    });
  });

  it("maps single-model edits and omits review-required null-edits actions", () => {
    const runtimeKinds = {
      QuickFix: { value: "quickfix" },
      Refactor: { value: "refactor" },
      Source: { value: "source" },
    };
    const action = actionToMonaco(
      {
        title: "Change to number",
        kind: "quickfix",
        edits: [
          { range: { start: { line: 0, column: 18 }, end: { line: 0, column: 21 } }, newText: "1" },
        ],
      },
      URI,
      [marker()],
      runtimeKinds,
    );
    expect(action?.kind).toBe("quickfix");
    expect(actionKindToMonaco("quickfix", runtimeKinds)).toBe("quickfix");
    expect(action?.edit.edits[0]?.textEdit.text).toBe("1");
    expect(action?.edit.edits[0]?.versionId).toBeUndefined();
    expect(
      actionToMonaco({ title: "Multi-file", kind: "quickfix", edits: null }, URI, [], KINDS),
    ).toBeNull();
  });

  it("builds a disposable Monaco code-action list", () => {
    const list = codeActionsResponseToMonaco(
      {
        request: { requestId: "r", streamId: "s", sequence: 1 },
        actions: [{ title: "Noop", kind: "source", edits: [] }],
      },
      URI,
      [],
      KINDS,
    );
    expect(list.actions).toHaveLength(1);
    expect((): void => {
      list.dispose();
    }).not.toThrow();
  });
});

describe("createKeikoCodeActionProvider", () => {
  it("passes live text, range, and diagnostics to the resolver", async () => {
    let seenText = "";
    const resolve: EditorCodeActionsResolver = (query) => {
      seenText = query.documentText;
      expect(query.request.range).toEqual({
        start: { line: 0, column: 6 },
        end: { line: 0, column: 7 },
      });
      expect(query.request.diagnostics[0]?.code).toBe("2322");
      return Promise.resolve({ request: query.request.request, actions: [] });
    };
    await provider(resolve).provideCodeActions(
      model("buffer"),
      RANGE,
      { markers: [marker()] },
      token(),
    );
    expect(seenText).toBe("buffer");
  });

  it("returns an empty list for another model or resolver failure", async () => {
    const resolve: EditorCodeActionsResolver = () => Promise.reject(new Error("boom"));
    await expect(
      provider(resolve).provideCodeActions(
        { getValue: () => "x", uri: { toString: () => "other" } },
        RANGE,
        { markers: [] },
        token(),
      ),
    ).resolves.toEqual(expect.objectContaining({ actions: [] }));
    await expect(
      provider(resolve).provideCodeActions(model(), RANGE, { markers: [] }, token()),
    ).resolves.toEqual(expect.objectContaining({ actions: [] }));
  });
});

interface FakeRegistrar {
  readonly registrar: MonacoCodeActionRegistrar;
  readonly registered: () => readonly (string | readonly string[])[];
  readonly metadata: () => readonly string[];
  readonly disposeCount: () => number;
}

function buildRegistrar(withKind = true): FakeRegistrar {
  const registered: (string | readonly string[])[] = [];
  let metadata: readonly string[] = [];
  let disposed = 0;
  return {
    registrar: {
      ...(withKind ? { CodeActionKind: KINDS } : {}),
      registerCodeActionProvider: (
        selector,
        _provider,
        providerMetadata,
      ): { dispose: () => void } => {
        registered.push(selector);
        metadata = providerMetadata?.providedCodeActionKinds ?? [];
        return {
          dispose: (): void => {
            disposed += 1;
          },
        };
      },
    },
    registered: () => registered,
    metadata: () => metadata,
    disposeCount: () => disposed,
  };
}

describe("registerKeikoCodeActionProvider", () => {
  it("registers a provider per governed language with metadata and disposes all", () => {
    const fake = buildRegistrar();
    const resolve: EditorCodeActionsResolver = (query) =>
      Promise.resolve({ request: query.request.request, actions: [] });
    const disposable = registerKeikoCodeActionProvider({
      languages: fake.registrar,
      resolve,
      isCurrentDocument: () => true,
      documentLanguages: CODE_ACTION_ELIGIBLE_LANGUAGES,
      streamId: "s",
      newRequestId: () => "r",
    });
    expect(fake.registered()).toEqual(["typescript", "javascript"]);
    expect(fake.metadata()).toEqual(["quickfix", "refactor", "source"]);
    disposable.dispose();
    expect(fake.disposeCount()).toBe(2);
  });

  it("falls back to Monaco's standard kind strings when the runtime omits CodeActionKind", () => {
    const fake = buildRegistrar(false);
    const resolve: EditorCodeActionsResolver = (query) =>
      Promise.resolve({ request: query.request.request, actions: [] });
    registerKeikoCodeActionProvider({
      languages: fake.registrar,
      resolve,
      isCurrentDocument: () => true,
      documentLanguages: ["typescript"],
      streamId: "s",
      newRequestId: () => "r",
    });
    expect(fake.metadata()).toEqual(["quickfix", "refactor", "source"]);
  });
});
