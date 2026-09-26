import { describe, expect, it } from "vitest";

import {
  createKeikoInlayHintsProvider,
  INLAY_HINTS_ELIGIBLE_LANGUAGES,
  registerKeikoInlayHintsProvider,
  type EditorInlayHintsResolver,
  type MonacoInlayHintsModel,
  type MonacoInlayHintsProvider,
  type MonacoInlayHintsRegistrar,
} from "./inlay-hints-bridge.js";
import type { MonacoCancellationToken, MonacoRange } from "./completion-bridge.js";

const URI = { toString: (): string => "keiko-editor://current" };

function model(text = "let value = 1;\n"): MonacoInlayHintsModel {
  return { getValue: () => text, uri: URI };
}

function range(): MonacoRange {
  return { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 18 };
}

function token(cancelled = false): MonacoCancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  };
}

function provider(resolve: EditorInlayHintsResolver): MonacoInlayHintsProvider {
  return createKeikoInlayHintsProvider({
    resolve,
    isCurrentDocument: (documentUri) => documentUri === URI.toString(),
    documentLanguage: "typescript",
    streamId: "inlay",
    newRequestId: () => "request",
  });
}

describe("createKeikoInlayHintsProvider", () => {
  it("maps inferred parameter and type hints into Monaco's native renderer", async () => {
    const provider = createKeikoInlayHintsProvider({
      resolve: (query) =>
        Promise.resolve({
          request: query.request.request,
          hints: [
            { position: { line: 0, column: 7 }, label: "value:", kind: "parameter" },
            { position: { line: 1, column: 12 }, label: ": string", kind: "type" },
            { position: { line: 1, column: 18 }, label: "enum", kind: "enum" },
            { position: { line: 1, column: 22 }, label: " = 42", kind: "value" },
          ],
        }),
      isCurrentDocument: () => true,
      documentLanguage: "typescript",
      streamId: "inlay",
      newRequestId: () => "request",
    });
    const result = await provider.provideInlayHints(
      { getValue: () => "format('x');\nlet result = 'x';", uri: URI },
      { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 18 },
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: (): void => undefined }),
      },
    );

    expect(result?.hints).toEqual([
      {
        label: "value:",
        position: { lineNumber: 1, column: 8 },
        kind: 2,
        style: "standard",
        paddingLeft: false,
        paddingRight: false,
      },
      {
        label: ": string",
        position: { lineNumber: 2, column: 13 },
        kind: 1,
        style: "standard",
        paddingLeft: false,
        paddingRight: false,
      },
      {
        label: "enum",
        position: { lineNumber: 2, column: 19 },
        kind: 1,
        style: "standard",
        paddingLeft: false,
        paddingRight: false,
      },
      {
        label: " = 42",
        position: { lineNumber: 2, column: 23 },
        kind: 1,
        style: "debug-value",
        paddingLeft: false,
        paddingRight: false,
      },
    ]);
  });

  it("ignores another editor model before calling the resolver", async () => {
    let calls = 0;
    const resolve: EditorInlayHintsResolver = (query) => {
      calls += 1;
      return Promise.resolve({ request: query.request.request, hints: [] });
    };
    const result = await provider(resolve).provideInlayHints(
      { getValue: () => "other", uri: { toString: () => "keiko-editor://other" } },
      range(),
      token(),
    );
    expect(result).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("returns the empty failedValue when the resolver rejects (never breaks editing)", async () => {
    const result = await provider(() => Promise.reject(new Error("boom"))).provideInlayHints(
      model(),
      range(),
      token(),
    );
    expect(result?.hints).toEqual([]);
    expect(typeof result?.dispose).toBe("function");
    expect(() => result?.dispose()).not.toThrow();
  });

  it("discards a superseded inlay-hints response", async () => {
    const calls: { readonly settle: (label: string) => void }[] = [];
    const resolve: EditorInlayHintsResolver = (query) =>
      new Promise((res) => {
        calls.push({
          settle: (label): void => {
            res({
              request: query.request.request,
              hints: [{ position: { line: 0, column: 0 }, label, kind: "type" }],
            });
          },
        });
      });
    const hintsProvider = provider(resolve);
    const first = hintsProvider.provideInlayHints(model(), range(), token());
    const second = hintsProvider.provideInlayHints(model(), range(), token());
    calls[1]?.settle("fresh");
    calls[0]?.settle("stale");
    expect(await first).toBeUndefined();
    expect((await second)?.hints[0]?.label).toBe("fresh");
  });
});

interface FakeInlayHintsRegistrar {
  readonly registrar: MonacoInlayHintsRegistrar;
  readonly registered: () => readonly (string | readonly string[])[];
  readonly disposeCount: () => number;
}

function buildRegistrar(): FakeInlayHintsRegistrar {
  const registered: (string | readonly string[])[] = [];
  let disposed = 0;
  const registrar: MonacoInlayHintsRegistrar = {
    registerInlayHintsProvider: (selector): { dispose: () => void } => {
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

describe("registerKeikoInlayHintsProvider", () => {
  it("registers a provider per governed language and disposes all on teardown", () => {
    const fake = buildRegistrar();
    const resolve: EditorInlayHintsResolver = (query) =>
      Promise.resolve({ request: query.request.request, hints: [] });
    const disposable = registerKeikoInlayHintsProvider({
      languages: fake.registrar,
      resolve,
      isCurrentDocument: () => true,
      documentLanguages: INLAY_HINTS_ELIGIBLE_LANGUAGES,
      streamId: "s",
      newRequestId: () => "r",
    });
    expect(fake.registered()).toEqual(["typescript", "javascript"]);
    disposable.dispose();
    expect(fake.disposeCount()).toBe(2);
  });

  it("exposes the governed eligible languages", () => {
    expect(INLAY_HINTS_ELIGIBLE_LANGUAGES).toEqual(["typescript", "javascript"]);
  });
});
