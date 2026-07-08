import { describe, expect, it } from "vitest";

import {
  createKeikoReferencesProvider,
  REFERENCES_ELIGIBLE_LANGUAGES,
  referencesResponseToMonaco,
  registerKeikoReferencesProvider,
  type MonacoReferenceProvider,
  type MonacoReferenceRegistrar,
  type MonacoReferencesModel,
} from "./references-bridge.js";
import type { MonacoCancellationToken } from "./completion-bridge.js";
import type { MonacoUriLike } from "./definition-bridge.js";
import type { EditorReferencesResolver } from "../types.js";

const URI: MonacoUriLike = { toString: () => "keiko-editor://current" };

function model(text = "const x = 1; x;\n"): MonacoReferencesModel {
  return { getValue: () => text, uri: URI };
}

function token(): MonacoCancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  };
}

function provider(resolve: EditorReferencesResolver): MonacoReferenceProvider {
  return createKeikoReferencesProvider({
    resolve,
    isCurrentDocument: (documentUri) => documentUri === URI.toString(),
    documentLanguage: "typescript",
    streamId: "stream",
    newRequestId: () => "req",
    uriForPath: (path) => ({ toString: () => `keiko-editor://workspace/${path}` }),
  });
}

describe("referencesResponseToMonaco", () => {
  it("maps references to Monaco locations", () => {
    const locations = referencesResponseToMonaco(
      {
        request: { requestId: "r", streamId: "s", sequence: 1 },
        includesDeclaration: true,
        locations: [
          {
            path: "src/a.ts",
            range: { start: { line: 0, column: 6 }, end: { line: 0, column: 7 } },
          },
        ],
      },
      URI,
      (path): MonacoUriLike => ({ toString: () => `keiko-editor://workspace/${path}` }),
    );
    expect(locations[0]?.range).toEqual({
      startLineNumber: 1,
      startColumn: 7,
      endLineNumber: 1,
      endColumn: 8,
    });
    expect(locations[0]?.uri.toString()).toBe("keiko-editor://workspace/src/a.ts");
  });
});

describe("createKeikoReferencesProvider", () => {
  it("passes includeDeclaration from Monaco context to the resolver", async () => {
    let includeDeclaration: boolean | null = null;
    const resolve: EditorReferencesResolver = (query) => {
      includeDeclaration = query.request.includeDeclaration;
      return Promise.resolve({
        request: query.request.request,
        locations: [],
        includesDeclaration: query.request.includeDeclaration,
      });
    };
    await provider(resolve).provideReferences(
      model(),
      { lineNumber: 1, column: 7 },
      { includeDeclaration: false },
      token(),
    );
    expect(includeDeclaration).toBe(false);
  });

  it("passes live text and position coordinates", async () => {
    let seenText = "";
    const resolve: EditorReferencesResolver = (query) => {
      seenText = query.documentText;
      expect(query.request.position).toEqual({ line: 0, column: 6 });
      return Promise.resolve({
        request: query.request.request,
        locations: [],
        includesDeclaration: true,
      });
    };
    await provider(resolve).provideReferences(
      model("buffer"),
      { lineNumber: 1, column: 7 },
      { includeDeclaration: true },
      token(),
    );
    expect(seenText).toBe("buffer");
  });

  it("returns an empty list for another model or resolver failure", async () => {
    const resolve: EditorReferencesResolver = () => Promise.reject(new Error("boom"));
    await expect(
      provider(resolve).provideReferences(
        { getValue: () => "x", uri: { toString: () => "other" } },
        { lineNumber: 1, column: 1 },
        { includeDeclaration: true },
        token(),
      ),
    ).resolves.toEqual([]);
    await expect(
      provider(resolve).provideReferences(
        model(),
        { lineNumber: 1, column: 1 },
        { includeDeclaration: true },
        token(),
      ),
    ).resolves.toEqual([]);
  });
});

interface FakeRegistrar {
  readonly registrar: MonacoReferenceRegistrar;
  readonly registered: () => readonly (string | readonly string[])[];
  readonly disposeCount: () => number;
}

function buildRegistrar(): FakeRegistrar {
  const registered: (string | readonly string[])[] = [];
  let disposed = 0;
  return {
    registrar: {
      registerReferenceProvider: (selector): { dispose: () => void } => {
        registered.push(selector);
        return {
          dispose: (): void => {
            disposed += 1;
          },
        };
      },
    },
    registered: () => registered,
    disposeCount: () => disposed,
  };
}

describe("registerKeikoReferencesProvider", () => {
  it("registers a provider per governed language and disposes all", () => {
    const fake = buildRegistrar();
    const resolve: EditorReferencesResolver = (query) =>
      Promise.resolve({ request: query.request.request, locations: [], includesDeclaration: true });
    const disposable = registerKeikoReferencesProvider({
      languages: fake.registrar,
      resolve,
      isCurrentDocument: () => true,
      documentLanguages: REFERENCES_ELIGIBLE_LANGUAGES,
      streamId: "s",
      newRequestId: () => "r",
    });
    expect(fake.registered()).toEqual(["typescript", "javascript"]);
    disposable.dispose();
    expect(fake.disposeCount()).toBe(2);
  });
});
