import type {
  ManagedLspSemanticTokenData,
  ManagedLspSemanticTokenLegend,
} from "@oscharko-dev/keiko-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createEditorSemanticTokensHost,
  type EditorSemanticTokensResolver,
} from "./editorSemanticTokens";

function legend(
  overrides: Partial<ManagedLspSemanticTokenLegend> = {},
): ManagedLspSemanticTokenLegend {
  return {
    schemaVersion: "1",
    legendVersion: 3,
    tokenTypes: ["class", "variable"],
    tokenModifiers: ["declaration"],
    returnedTypeCount: 2,
    totalTypeCount: 2,
    returnedModifierCount: 1,
    totalModifierCount: 1,
    truncated: false,
    ...overrides,
  };
}

function data(
  values: readonly number[] = [0, 0, 5, 0, 1, 1, 2, 3, 1, 0],
  overrides: Partial<ManagedLspSemanticTokenData> = {},
): ManagedLspSemanticTokenData {
  return {
    schemaVersion: "1",
    legendVersion: 3,
    documentVersion: 7,
    dataVersion: 1,
    data: values,
    returnedTokenCount: values.length / 5,
    totalTokenCount: values.length / 5,
    truncated: false,
    ...overrides,
  };
}

function model(
  text = "Class name\n  var item",
  version = 7,
): {
  version: number;
  getValue(): string;
  getVersionId(): number;
  getLineCount(): number;
  getLineMaxColumn(lineNumber: number): number;
  readonly uri: { toString(): string };
} {
  const lines = text.split("\n");
  return {
    version,
    getValue: (): string => text,
    getVersionId(): number {
      return this.version;
    },
    getLineCount: (): number => lines.length,
    getLineMaxColumn: (lineNumber): number => (lines[lineNumber - 1]?.length ?? 0) + 1,
    uri: { toString: (): string => "keiko-editor://current" },
  };
}

function cancellationToken(cancelled = false): {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
  cancel(): void;
} {
  const listeners = new Set<() => void>();
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose: (): void => void listeners.delete(listener) };
    },
    cancel(): void {
      for (const listener of listeners) listener();
    },
  };
}

function host(resolve: EditorSemanticTokensResolver, legendOverride = legend()) {
  return createEditorSemanticTokensHost({
    legend: legendOverride,
    resolve,
    isCurrentDocument: (uri) => uri === "keiko-editor://current",
    language: "rust",
    streamId: "semantic-stream",
    newRequestId: () => "request-1",
    isLargeDocument: (text) => text.length > 500_000,
  });
}

describe("createEditorSemanticTokensHost", () => {
  it("maps a bounded response into Monaco token data", async () => {
    const resolve = vi.fn<EditorSemanticTokensResolver>(() => Promise.resolve(data()));
    const semantic = host(resolve);

    expect(semantic?.provider.getLegend()).toEqual({
      tokenTypes: ["class", "variable"],
      tokenModifiers: ["declaration"],
    });
    await expect(
      semantic?.provider.provideDocumentSemanticTokens(model(), null, cancellationToken()),
    ).resolves.toEqual({ data: Uint32Array.from(data().data) });
    expect(resolve.mock.calls[0]?.[0].request.document).toMatchObject({
      language: "rust",
      version: 7,
    });
  });

  it("aborts and drops an in-flight request on cancellation", async () => {
    let observedSignal: AbortSignal | undefined;
    const semantic = host((_query, signal) => {
      observedSignal = signal;
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(data())));
    });
    const token = cancellationToken();
    const pending = semantic?.provider.provideDocumentSemanticTokens(model(), null, token);
    token.cancel();

    await expect(pending).resolves.toBeNull();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("drops stale versions, superseded responses, and disposed work", async () => {
    const pending: ((value: ManagedLspSemanticTokenData) => void)[] = [];
    const semantic = host(() => new Promise((resolve) => pending.push(resolve)));
    const current = model();
    const first = semantic?.provider.provideDocumentSemanticTokens(
      current,
      null,
      cancellationToken(),
    );
    const second = semantic?.provider.provideDocumentSemanticTokens(
      current,
      null,
      cancellationToken(),
    );
    pending[0]?.(data());
    current.version = 8;
    pending[1]?.(data([], { documentVersion: 8 }));

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    semantic?.dispose();
  });

  it.each([
    ["out-of-range line", [2, 0, 1, 0, 0]],
    ["out-of-range column", [0, 20, 1, 0, 0]],
    ["overlap", [0, 0, 5, 0, 0, 0, 4, 2, 1, 0]],
    ["invalid token type", [0, 0, 1, 4, 0]],
    ["invalid modifier mask", [0, 0, 1, 0, 2]],
    ["non-tuple payload", [0, 0, 1]],
  ])("returns null for malformed %s data", async (_label, values) => {
    const semantic = host(() => Promise.resolve(data(values)));
    await expect(
      semantic?.provider.provideDocumentSemanticTokens(model(), null, cancellationToken()),
    ).resolves.toBeNull();
  });

  it("preserves syntax fallback for large documents and invalid legends", async () => {
    const resolve = vi.fn<EditorSemanticTokensResolver>(() => Promise.resolve(data()));
    const semantic = host(resolve);
    await expect(
      semantic?.provider.provideDocumentSemanticTokens(
        model("x".repeat(500_001)),
        null,
        cancellationToken(),
      ),
    ).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    expect(host(resolve, legend({ tokenTypes: ["class", "class"] }))).toBeUndefined();
  });
});

import {
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS,
  MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES,
} from "@oscharko-dev/keiko-contracts/runtime/managed-lsp-capabilities";
import type { ManagedLspSemanticTokenType } from "@oscharko-dev/keiko-contracts";

function excessiveSemanticCells(): number[] {
  return Array.from({ length: (MANAGED_LSP_SEMANTIC_TOKEN_MAX_TOKENS + 1) * 5 }, (_, index) =>
    index % 5 === 2 ? 1 : 0,
  );
}

describe("editor semantic-token bounded publication", () => {
  it("does not use a caller data iterator after validation and fitting", async () => {
    const values = data().data.slice();
    const expectedLength = values.length;
    let iterations = 0;
    Object.defineProperty(values, Symbol.iterator, {
      value: function* (): IterableIterator<number> {
        iterations += 1;
        yield* excessiveSemanticCells();
      },
    });
    const semantic = host(() => Promise.resolve(data(values)));
    try {
      const result = await semantic?.provider.provideDocumentSemanticTokens(
        model(),
        null,
        cancellationToken(),
      );
      expect(result !== null && result !== undefined).toBe(true);
      expect(result?.data.length).toBe(expectedLength);
      expect(iterations).toBe(0);
    } finally {
      semantic?.dispose();
    }
  });

  it("does not convert a different late data getter result", async () => {
    const healthy = data();
    const excessive = excessiveSemanticCells();
    let reads = 0;
    const response = {
      ...healthy,
      get data(): readonly number[] {
        return ++reads <= 4 ? healthy.data : excessive;
      },
    };
    const semantic = host(() => Promise.resolve(response));
    try {
      const result = await semantic?.provider.provideDocumentSemanticTokens(
        model(),
        null,
        cancellationToken(),
      );
      expect(result?.data.length).toBe(healthy.data.length);
    } finally {
      semantic?.dispose();
    }
  });

  it("publishes a bounded owned legend instead of a retained iterator", () => {
    const types: ManagedLspSemanticTokenType[] = ["class", "variable"];
    let iterations = 0;
    Object.defineProperty(types, Symbol.iterator, {
      value: function* (): IterableIterator<ManagedLspSemanticTokenType> {
        iterations += 1;
        for (let index = 0; index <= MANAGED_LSP_SEMANTIC_TOKEN_MAX_TYPES; index += 1)
          yield "class";
      },
    });
    const semantic = host(() => Promise.resolve(data()), legend({ tokenTypes: types }));
    try {
      expect(semantic).toBeDefined();
      expect(semantic?.provider.getLegend().tokenTypes.length).toBe(2);
      expect(iterations).toBe(0);
    } finally {
      semantic?.dispose();
    }
  });

  it("retains extra-field refusal before creating the owned conversion view", async () => {
    const semantic = host(() => Promise.resolve({ ...data(), unknownField: true }));
    try {
      await expect(
        semantic?.provider.provideDocumentSemanticTokens(model(), null, cancellationToken()),
      ).resolves.toBeNull();
    } finally {
      semantic?.dispose();
    }
  });
});

describe("semantic-token capture currentness", () => {
  it("drops a response disposed during its data getter inspection", async () => {
    const healthy = data();
    const response = {
      ...healthy,
      get data(): readonly number[] {
        semantic?.dispose();
        return healthy.data;
      },
    };
    const semantic = host(() => Promise.resolve(response));
    try {
      await expect(
        semantic?.provider.provideDocumentSemanticTokens(model(), null, cancellationToken()),
      ).resolves.toBeNull();
    } finally {
      semantic?.dispose();
    }
  });
});
