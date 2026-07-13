import { describe, expect, it } from "vitest";

import type { EditorDefinitionResolver } from "../types.js";
import type { MonacoCancellationToken } from "./completion-bridge.js";
import {
  createLocationNavigationProvider,
  type LocationNavigationProvider,
} from "./location-navigation-bridge.js";
import type { MonacoDefinitionModel, MonacoUriLike } from "./definition-bridge.js";

const URI: MonacoUriLike = { toString: () => "keiko-editor://current" };

function model(text = "const value = call();\n"): MonacoDefinitionModel {
  return { getValue: () => text, uri: URI };
}

function token(cancelled = false): MonacoCancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: (listener): { dispose: () => void } => {
      if (cancelled) listener();
      return { dispose: (): void => undefined };
    },
  };
}

function provider(resolve: EditorDefinitionResolver): LocationNavigationProvider {
  return createLocationNavigationProvider({
    resolve,
    isCurrentDocument: (documentUri) => documentUri === URI.toString(),
    documentLanguage: "typescript",
    streamId: "stream",
    newRequestId: () => "request",
    uriForPath: (path) => ({ toString: () => `keiko-editor://workspace/${path}` }),
  });
}

describe("createLocationNavigationProvider", () => {
  it("ignores non-current models before calling the resolver", async () => {
    let calls = 0;
    const result = await provider((query) => {
      calls += 1;
      return Promise.resolve({ request: query.request.request, locations: [] });
    }).provideLocation(
      { getValue: () => "other", uri: { toString: () => "keiko-editor://other" } },
      { lineNumber: 1, column: 1 },
      token(),
    );

    expect(result).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("passes live text, position, and cancellation to the resolver", async () => {
    let seenText = "";
    let seenAbort = false;
    const result = await provider((query, signal) => {
      seenText = query.documentText;
      seenAbort = signal.aborted;
      expect(query.request.position).toEqual({ line: 0, column: 6 });
      return Promise.resolve({
        request: query.request.request,
        locations: [
          {
            path: "src/target.ts",
            range: { start: { line: 1, column: 2 }, end: { line: 1, column: 8 } },
          },
        ],
      });
    }).provideLocation(model("buffer"), { lineNumber: 1, column: 7 }, token(true));

    expect(seenText).toBe("buffer");
    expect(seenAbort).toBe(true);
    expect(result?.[0]?.uri.toString()).toBe("keiko-editor://workspace/src/target.ts");
  });

  it("uses the current model URI when no workspace URI mapper is supplied", async () => {
    const providerWithoutMapper = createLocationNavigationProvider({
      resolve: (query) =>
        Promise.resolve({
          request: query.request.request,
          locations: [
            {
              path: "src/current.ts",
              range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
            },
          ],
        }),
      isCurrentDocument: () => true,
      documentLanguage: "typescript",
      streamId: "stream",
      newRequestId: () => "request",
    });

    const result = await providerWithoutMapper.provideLocation(
      model(),
      { lineNumber: 1, column: 1 },
      token(),
    );

    expect(result?.[0]?.uri).toBe(URI);
  });

  it("returns empty locations on resolver failure", async () => {
    await expect(
      provider(() => Promise.reject(new Error("boom"))).provideLocation(
        model(),
        { lineNumber: 1, column: 1 },
        token(),
      ),
    ).resolves.toEqual([]);
  });

  it("discards superseded location responses", async () => {
    const calls: { readonly settle: (path: string) => void }[] = [];
    const nav = provider(
      (query) =>
        new Promise((resolve) => {
          calls.push({
            settle: (path): void => {
              resolve({
                request: query.request.request,
                locations: [
                  {
                    path,
                    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } },
                  },
                ],
              });
            },
          });
        }),
    );

    const first = nav.provideLocation(model(), { lineNumber: 1, column: 1 }, token());
    const second = nav.provideLocation(model(), { lineNumber: 2, column: 1 }, token());
    calls[1]?.settle("fresh.ts");
    calls[0]?.settle("stale.ts");

    expect(await first).toBeUndefined();
    expect((await second)?.[0]?.uri.toString()).toBe("keiko-editor://workspace/fresh.ts");
  });
});
