import { describe, expect, it } from "vitest";

import {
  createKeikoHoverProvider,
  HOVER_ELIGIBLE_LANGUAGES,
  hoverResponseToMonaco,
  registerKeikoHoverProvider,
  toInertCodeFence,
  type MonacoHover,
  type MonacoHoverModel,
  type MonacoHoverProvider,
  type MonacoHoverRegistrar,
} from "./hover-bridge.js";
import type { MonacoCancellationToken } from "./completion-bridge.js";
import type { EditorHover, EditorHoverResolver, EditorHoverResponse } from "../types.js";

function model(text = "const x = 1;\n"): MonacoHoverModel {
  return { getValue: () => text, uri: { toString: () => "inmemory://model/1" } };
}

function token(cancelled = false): MonacoCancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: (): void => undefined }),
  };
}

function response(hover: EditorHover): EditorHoverResponse {
  return { request: { requestId: "r", streamId: "s", sequence: 1 }, hover };
}

describe("toInertCodeFence", () => {
  it("wraps plain text in a triple-backtick fence by default", () => {
    expect(toInertCodeFence("const x: number")).toBe("```\nconst x: number\n```");
  });

  it("grows the fence longer than any backtick run so content cannot escape it", () => {
    // Content holds a run of three backticks; the fence must be at least four.
    const fenced = toInertCodeFence("a ``` b");
    expect(fenced.startsWith("````\n")).toBe(true);
    expect(fenced.endsWith("\n````")).toBe(true);
    // The original content is preserved verbatim inside the fence.
    expect(fenced).toContain("a ``` b");
  });

  it("keeps HTML markup inert as literal text inside the fence", () => {
    const fenced = toInertCodeFence('type X = "<img src=x onerror=alert(1)>"');
    expect(fenced).toContain("<img src=x onerror=alert(1)>");
    expect(fenced.startsWith("```")).toBe(true);
  });
});

describe("hoverResponseToMonaco", () => {
  it("returns undefined when there is no quick info", () => {
    expect(hoverResponseToMonaco(response({ contents: null }))).toBeUndefined();
    expect(hoverResponseToMonaco(response({ contents: "" }))).toBeUndefined();
  });

  it("maps contents to a single inert code-fence markdown block", () => {
    const hover = hoverResponseToMonaco(response({ contents: "const x: number" }));
    expect(hover?.contents).toEqual([{ value: "```\nconst x: number\n```" }]);
  });

  it("maps an optional range to 1-based Monaco coordinates", () => {
    const hover = hoverResponseToMonaco(
      response({
        contents: "x",
        range: { start: { line: 1, column: 2 }, end: { line: 1, column: 3 } },
      }),
    );
    expect(hover?.range).toEqual({
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 2,
      endColumn: 4,
    });
  });

  it("omits the range when absent", () => {
    const hover = hoverResponseToMonaco(response({ contents: "x" }));
    expect(hover && "range" in hover).toBe(false);
  });
});

interface DeferredHover {
  readonly resolve: EditorHoverResolver;
  readonly calls: {
    readonly signal: AbortSignal;
    readonly sequence: number;
    settle(hover: EditorHover): void;
    fail(): void;
  }[];
}

function deferredResolver(): DeferredHover {
  const calls: DeferredHover["calls"] = [];
  const resolve: EditorHoverResolver = (query, signal) =>
    new Promise((res, rej) => {
      calls.push({
        signal,
        sequence: query.request.request.sequence,
        settle: (hover): void => {
          res({ request: query.request.request, hover });
        },
        fail: (): void => {
          rej(new Error("hover failed"));
        },
      });
    });
  return { resolve, calls };
}

function provider(resolve: EditorHoverResolver): MonacoHoverProvider {
  return createKeikoHoverProvider({
    resolve,
    isCurrentDocument: (documentUri) => documentUri === "inmemory://model/1",
    documentLanguage: "typescript",
    streamId: "stream",
    newRequestId: () => "req",
  });
}

describe("createKeikoHoverProvider", () => {
  it("resolves quick info and maps it to a Monaco hover", async () => {
    const resolve: EditorHoverResolver = (query) =>
      Promise.resolve({ request: query.request.request, hover: { contents: "x: number" } });
    const hover = await provider(resolve).provideHover(
      model(),
      { lineNumber: 1, column: 1 },
      token(),
    );
    expect(hover?.contents[0]?.value).toContain("x: number");
  });

  it("passes the live buffer text and a content-free request to the resolver", async () => {
    let seenText = "";
    const resolve: EditorHoverResolver = (query) => {
      seenText = query.documentText;
      expect(query.request.position).toEqual({ line: 0, column: 0 });
      return Promise.resolve({ request: query.request.request, hover: { contents: "x" } });
    };
    await provider(resolve).provideHover(model("buffer"), { lineNumber: 1, column: 1 }, token());
    expect(seenText).toBe("buffer");
  });

  it("ignores another editor model before calling the resolver", async () => {
    let calls = 0;
    const resolve: EditorHoverResolver = (query) => {
      calls += 1;
      return Promise.resolve({ request: query.request.request, hover: { contents: "x" } });
    };
    const hover = await provider(resolve).provideHover(
      { getValue: () => "other", uri: { toString: () => "inmemory://model/2" } },
      { lineNumber: 1, column: 1 },
      token(),
    );
    expect(hover).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("returns undefined on resolver failure (never breaks editing)", async () => {
    const resolve: EditorHoverResolver = () => Promise.reject(new Error("boom"));
    const hover = await provider(resolve).provideHover(
      model(),
      { lineNumber: 1, column: 1 },
      token(),
    );
    expect(hover).toBeUndefined();
  });

  it("discards a superseded hover response", async () => {
    const deferred = deferredResolver();
    const hoverProvider = provider(deferred.resolve);
    const first = hoverProvider.provideHover(model(), { lineNumber: 1, column: 1 }, token());
    const second = hoverProvider.provideHover(model(), { lineNumber: 2, column: 1 }, token());
    deferred.calls[1]?.settle({ contents: "fresh" });
    deferred.calls[0]?.settle({ contents: "stale" });
    expect(await first).toBeUndefined();
    expect((await second)?.contents[0]?.value).toContain("fresh");
  });

  it("aborts the resolver when the cancellation token is already cancelled", () => {
    const deferred = deferredResolver();
    void provider(deferred.resolve).provideHover(
      model(),
      { lineNumber: 1, column: 1 },
      token(true),
    );
    expect(deferred.calls[0]?.signal.aborted).toBe(true);
  });
});

interface FakeHoverRegistrar {
  readonly registrar: MonacoHoverRegistrar;
  readonly registered: () => readonly (string | readonly string[])[];
  readonly disposeCount: () => number;
}

function buildRegistrar(): FakeHoverRegistrar {
  const registered: (string | readonly string[])[] = [];
  let disposed = 0;
  const registrar: MonacoHoverRegistrar = {
    registerHoverProvider: (selector): { dispose: () => void } => {
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

describe("registerKeikoHoverProvider", () => {
  it("registers a provider per governed language and disposes all on teardown", () => {
    const fake = buildRegistrar();
    const resolve: EditorHoverResolver = (query) =>
      Promise.resolve({ request: query.request.request, hover: { contents: null } });
    const disposable = registerKeikoHoverProvider({
      languages: fake.registrar,
      resolve,
      isCurrentDocument: () => true,
      documentLanguages: HOVER_ELIGIBLE_LANGUAGES,
      streamId: "s",
      newRequestId: () => "r",
    });
    expect(fake.registered()).toEqual(["typescript", "javascript"]);
    disposable.dispose();
    expect(fake.disposeCount()).toBe(2);
  });

  it("exposes the governed eligible languages", () => {
    expect(HOVER_ELIGIBLE_LANGUAGES).toEqual(["typescript", "javascript"]);
  });
});

// Type-only guard: the structural Monaco hover shape stays assignable.
const _hover: MonacoHover = { contents: [{ value: "x" }] };
void _hover;
