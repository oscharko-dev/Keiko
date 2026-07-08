import { describe, expect, it } from "vitest";

import {
  createKeikoDefinitionProvider,
  DEFINITION_ELIGIBLE_LANGUAGES,
  definitionResponseToMonaco,
  registerKeikoDefinitionProvider,
  type MonacoDefinitionModel,
  type MonacoDefinitionProvider,
  type MonacoDefinitionRegistrar,
  type MonacoUriLike,
} from "./definition-bridge.js";
import type { MonacoCancellationToken } from "./completion-bridge.js";
import type { EditorDefinitionResolver } from "../types.js";

const URI: MonacoUriLike = { toString: () => "keiko-editor://current" };

function model(text = "import { x } from './x';\n"): MonacoDefinitionModel {
  return { getValue: () => text, uri: URI };
}

function token(cancelled = false): MonacoCancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  };
}

function provider(resolve: EditorDefinitionResolver): MonacoDefinitionProvider {
  return createKeikoDefinitionProvider({
    resolve,
    isCurrentDocument: (documentUri) => documentUri === URI.toString(),
    documentLanguage: "typescript",
    streamId: "stream",
    newRequestId: () => "req",
    uriForPath: (path) => ({ toString: () => `keiko-editor://workspace/${path}` }),
  });
}

describe("definitionResponseToMonaco", () => {
  it("maps workspace locations to Monaco locations", () => {
    const locations = definitionResponseToMonaco(
      {
        request: { requestId: "r", streamId: "s", sequence: 1 },
        locations: [
          {
            path: "src/x.ts",
            range: { start: { line: 2, column: 4 }, end: { line: 2, column: 5 } },
          },
        ],
      },
      URI,
      (path): MonacoUriLike => ({ toString: () => `keiko-editor://workspace/${path}` }),
    );
    expect(locations[0]?.range).toEqual({
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 3,
      endColumn: 6,
    });
    expect(locations[0]?.uri.toString()).toBe("keiko-editor://workspace/src/x.ts");
  });
});

describe("createKeikoDefinitionProvider", () => {
  it("passes live text and a content-free position request to the resolver", async () => {
    let seenText = "";
    const resolve: EditorDefinitionResolver = (query) => {
      seenText = query.documentText;
      expect(query.request.position).toEqual({ line: 0, column: 7 });
      return Promise.resolve({ request: query.request.request, locations: [] });
    };
    await provider(resolve).provideDefinition(
      model("buffer"),
      { lineNumber: 1, column: 8 },
      token(),
    );
    expect(seenText).toBe("buffer");
  });

  it("ignores another editor model before calling the resolver", async () => {
    let calls = 0;
    const resolve: EditorDefinitionResolver = (query) => {
      calls += 1;
      return Promise.resolve({ request: query.request.request, locations: [] });
    };
    const result = await provider(resolve).provideDefinition(
      { getValue: () => "other", uri: { toString: () => "keiko-editor://other" } },
      { lineNumber: 1, column: 1 },
      token(),
    );
    expect(result).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("returns no locations on resolver failure", async () => {
    const resolve: EditorDefinitionResolver = () => Promise.reject(new Error("boom"));
    await expect(
      provider(resolve).provideDefinition(model(), { lineNumber: 1, column: 1 }, token()),
    ).resolves.toEqual([]);
  });

  it("discards a superseded definition response", async () => {
    const calls: {
      settle: (path: string) => void;
    }[] = [];
    const resolve: EditorDefinitionResolver = (query) =>
      new Promise((res) => {
        calls.push({
          settle: (path): void => {
            res({
              request: query.request.request,
              locations: [
                { path, range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } } },
              ],
            });
          },
        });
      });
    const p = provider(resolve);
    const first = p.provideDefinition(model(), { lineNumber: 1, column: 1 }, token());
    const second = p.provideDefinition(model(), { lineNumber: 2, column: 1 }, token());
    calls[1]?.settle("fresh.ts");
    calls[0]?.settle("stale.ts");
    expect(await first).toBeUndefined();
    expect((await second)?.[0]?.uri.toString()).toBe("keiko-editor://workspace/fresh.ts");
  });
});

interface FakeRegistrar {
  readonly registrar: MonacoDefinitionRegistrar;
  readonly registered: () => readonly (string | readonly string[])[];
  readonly disposeCount: () => number;
}

function buildRegistrar(): FakeRegistrar {
  const registered: (string | readonly string[])[] = [];
  let disposed = 0;
  return {
    registrar: {
      registerDefinitionProvider: (selector): { dispose: () => void } => {
        registered.push(selector);
        return { dispose: (): void => void (disposed += 1) };
      },
    },
    registered: () => registered,
    disposeCount: () => disposed,
  };
}

describe("registerKeikoDefinitionProvider", () => {
  it("registers a provider per governed language and disposes all", () => {
    const fake = buildRegistrar();
    const resolve: EditorDefinitionResolver = (query) =>
      Promise.resolve({ request: query.request.request, locations: [] });
    const disposable = registerKeikoDefinitionProvider({
      languages: fake.registrar,
      resolve,
      isCurrentDocument: () => true,
      documentLanguages: DEFINITION_ELIGIBLE_LANGUAGES,
      streamId: "s",
      newRequestId: () => "r",
    });
    expect(fake.registered()).toEqual(["typescript", "javascript"]);
    disposable.dispose();
    expect(fake.disposeCount()).toBe(2);
  });
});
