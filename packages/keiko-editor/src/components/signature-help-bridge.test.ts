import { describe, expect, it } from "vitest";

import {
  createKeikoSignatureHelpProvider,
  DEFAULT_SIGNATURE_HELP_RETRIGGER_CHARACTERS,
  DEFAULT_SIGNATURE_HELP_TRIGGER_CHARACTERS,
  registerKeikoSignatureHelpProvider,
  SIGNATURE_HELP_ELIGIBLE_LANGUAGES,
  signatureHelpResponseToMonaco,
  signatureToMonaco,
  type MonacoSignatureHelpModel,
  type MonacoSignatureHelpProvider,
  type MonacoSignatureHelpRegistrar,
} from "./signature-help-bridge.js";
import type { MonacoCancellationToken } from "./completion-bridge.js";
import type { MonacoUriLike } from "./definition-bridge.js";
import type { EditorSignatureHelpResolver } from "../types.js";

const URI: MonacoUriLike = { toString: () => "keiko-editor://current" };

function model(text = "fn("): MonacoSignatureHelpModel {
  return { getValue: () => text, uri: URI };
}

function token(cancelled = false): MonacoCancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  };
}

function provider(resolve: EditorSignatureHelpResolver): MonacoSignatureHelpProvider {
  return createKeikoSignatureHelpProvider({
    resolve,
    isCurrentDocument: (documentUri) => documentUri === URI.toString(),
    documentLanguage: "typescript",
    streamId: "stream",
    newRequestId: () => "req",
    triggerCharacters: ["("],
    retriggerCharacters: [","],
  });
}

describe("signature-help pure mappers", () => {
  it("maps signatures and parameters", () => {
    expect(
      signatureToMonaco({
        label: "fn(value: string): void",
        documentation: "call fn",
        parameters: [{ label: "value" }],
      }),
    ).toEqual({
      label: "fn(value: string): void",
      documentation: "call fn",
      parameters: [{ label: "value" }],
    });
  });

  it("returns undefined for empty signature help", () => {
    expect(
      signatureHelpResponseToMonaco({
        request: { requestId: "r", streamId: "s", sequence: 1 },
        signatures: [],
        activeSignature: null,
        activeParameter: null,
      }),
    ).toBeUndefined();
  });

  it("maps active signature and parameter defaults", () => {
    const result = signatureHelpResponseToMonaco({
      request: { requestId: "r", streamId: "s", sequence: 1 },
      signatures: [{ label: "fn(a: string)", parameters: [{ label: "a" }] }],
      activeSignature: null,
      activeParameter: null,
    });
    expect(result?.value.activeSignature).toBe(0);
    expect(result?.value.activeParameter).toBe(0);
  });
});

describe("createKeikoSignatureHelpProvider", () => {
  it("advertises trigger and retrigger characters", () => {
    const helpProvider = provider((query) =>
      Promise.resolve({
        request: query.request.request,
        signatures: [],
        activeSignature: null,
        activeParameter: null,
      }),
    );
    expect(helpProvider.signatureHelpTriggerCharacters).toEqual(["("]);
    expect(helpProvider.signatureHelpRetriggerCharacters).toEqual([","]);
  });

  it("passes live text, position, and trigger character to the resolver", async () => {
    let seenText = "";
    const resolve: EditorSignatureHelpResolver = (query) => {
      seenText = query.documentText;
      expect(query.request.position).toEqual({ line: 0, column: 3 });
      expect(query.request.triggerCharacter).toBe("(");
      return Promise.resolve({
        request: query.request.request,
        signatures: [{ label: "fn()", parameters: [] }],
        activeSignature: 0,
        activeParameter: null,
      });
    };
    const result = await provider(resolve).provideSignatureHelp(
      model("buffer"),
      { lineNumber: 1, column: 4 },
      token(),
      { triggerCharacter: "(" },
    );
    expect(seenText).toBe("buffer");
    expect(result?.value.signatures[0]?.label).toBe("fn()");
  });

  it("returns undefined for another model or resolver failure", async () => {
    const resolve: EditorSignatureHelpResolver = () => Promise.reject(new Error("boom"));
    await expect(
      provider(resolve).provideSignatureHelp(
        { getValue: () => "x", uri: { toString: () => "other" } },
        { lineNumber: 1, column: 1 },
        token(),
        {},
      ),
    ).resolves.toBeUndefined();
    await expect(
      provider(resolve).provideSignatureHelp(model(), { lineNumber: 1, column: 1 }, token(), {}),
    ).resolves.toBeUndefined();
  });

  it("discards a superseded signature-help response", async () => {
    const calls: { readonly settle: (label: string) => void }[] = [];
    const resolve: EditorSignatureHelpResolver = (query) =>
      new Promise((res) => {
        calls.push({
          settle: (label): void => {
            res({
              request: query.request.request,
              signatures: [{ label, parameters: [] }],
              activeSignature: 0,
              activeParameter: 0,
            });
          },
        });
      });
    const helpProvider = provider(resolve);
    const first = helpProvider.provideSignatureHelp(
      model(),
      { lineNumber: 1, column: 3 },
      token(),
      {},
    );
    const second = helpProvider.provideSignatureHelp(
      model(),
      { lineNumber: 1, column: 4 },
      token(),
      {},
    );
    calls[1]?.settle("fresh");
    calls[0]?.settle("stale");
    expect(await first).toBeUndefined();
    expect((await second)?.value.signatures[0]?.label).toBe("fresh");
  });
});

interface FakeRegistrar {
  readonly registrar: MonacoSignatureHelpRegistrar;
  readonly registered: () => readonly (string | readonly string[])[];
  readonly triggerCharacters: () => readonly string[];
  readonly disposeCount: () => number;
}

function buildRegistrar(): FakeRegistrar {
  const registered: (string | readonly string[])[] = [];
  let triggerCharacters: readonly string[] = [];
  let disposed = 0;
  return {
    registrar: {
      registerSignatureHelpProvider: (selector, helpProvider): { dispose: () => void } => {
        registered.push(selector);
        triggerCharacters = helpProvider.signatureHelpTriggerCharacters;
        return {
          dispose: (): void => {
            disposed += 1;
          },
        };
      },
    },
    registered: () => registered,
    triggerCharacters: () => triggerCharacters,
    disposeCount: () => disposed,
  };
}

describe("registerKeikoSignatureHelpProvider", () => {
  it("registers a provider per governed language and disposes all", () => {
    const fake = buildRegistrar();
    const resolve: EditorSignatureHelpResolver = (query) =>
      Promise.resolve({
        request: query.request.request,
        signatures: [],
        activeSignature: null,
        activeParameter: null,
      });
    const disposable = registerKeikoSignatureHelpProvider({
      languages: fake.registrar,
      resolve,
      isCurrentDocument: () => true,
      documentLanguages: SIGNATURE_HELP_ELIGIBLE_LANGUAGES,
      streamId: "s",
      newRequestId: () => "r",
    });
    expect(fake.registered()).toEqual(["typescript", "javascript"]);
    expect(fake.triggerCharacters()).toEqual(DEFAULT_SIGNATURE_HELP_TRIGGER_CHARACTERS);
    disposable.dispose();
    expect(fake.disposeCount()).toBe(2);
  });

  it("exposes default trigger/retrigger characters", () => {
    expect(DEFAULT_SIGNATURE_HELP_TRIGGER_CHARACTERS).toEqual(["(", ","]);
    expect(DEFAULT_SIGNATURE_HELP_RETRIGGER_CHARACTERS).toEqual([")", ","]);
  });
});
