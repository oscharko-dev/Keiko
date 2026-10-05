import { describe, expect, it, vi } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  collectSemanticSearchDocument,
  createSemanticSearchSession,
  fuseLexicalAndSemanticRanks,
  runSemanticSearchSession,
  semanticSearchTool,
  SEMANTIC_RRF_K,
  type SemanticSearchMatch,
  type SemanticSearchProvider,
} from "./repoSearchSemantic.js";

function query(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "charge card",
    caseSensitive: false,
    maxResults: 10,
    emittedAtMs: 0,
  };
}

function providerReturning(matches: readonly SemanticSearchMatch[]): SemanticSearchProvider {
  return { name: "fixture", search: () => Promise.resolve(matches) };
}

describe("repoSearchSemantic", () => {
  it.each([
    { text: "ok\uFFFD", maxDocumentBytes: 5, expected: "ok\uFFFD" },
    { text: "ok中", maxDocumentBytes: 4, expected: "ok" },
    { text: "ok😀", maxDocumentBytes: 5, expected: "ok" },
  ])(
    "preserves valid replacement characters and clips only incomplete bytes ($text)",
    ({ text, maxDocumentBytes, expected }) => {
      const session = createSemanticSearchSession(providerReturning([]), query(), {
        maxDocumentBytes,
        maxDocuments: 1,
      });
      collectSemanticSearchDocument(session, { scopePath: "src/note.txt", text });
      expect(session?.documents).toEqual([{ scopePath: "src/note.txt", text: expected }]);
    },
  );
  it("bounds the ranked provider payload across documents before egress", async () => {
    const bounds = { maxDocuments: 3, maxDocumentBytes: 15 };
    let supplied: readonly { readonly scopePath: string; readonly text: string }[] = [];
    const session = createSemanticSearchSession(
      {
        name: "payload-fixture",
        search: (input) => {
          supplied = input.documents;
          return Promise.resolve([]);
        },
      },
      query(),
      bounds,
    );
    for (let index = 0; index < 6; index += 1) {
      collectSemanticSearchDocument(
        session,
        { scopePath: `note-${String(index)}.txt`, text: "ok\uFFFDtail" },
        index,
      );
    }
    await runSemanticSearchSession(session, query(), undefined);
    expect(supplied.map((document) => document.scopePath)).toEqual([
      "note-5.txt",
      "note-4.txt",
      "note-3.txt",
    ]);
    expect(supplied.map((document) => document.text)).toEqual(["ok\uFFFD", "ok\uFFFD", "ok\uFFFD"]);
    expect(supplied).toHaveLength(bounds.maxDocuments);
    expect(supplied.reduce((sum, document) => sum + Buffer.byteLength(document.text), 0)).toBe(
      bounds.maxDocumentBytes,
    );
  });

  it("keeps an explicitly unbounded provider wait pending without scheduling a timer", async () => {
    vi.useFakeTimers();
    try {
      let finish: ((matches: readonly SemanticSearchMatch[]) => void) | undefined;
      const response = new Promise<readonly SemanticSearchMatch[]>((resolve) => {
        finish = resolve;
      });
      const onTimeout = vi.fn();
      const session = createSemanticSearchSession(
        { name: "unbounded-fixture", search: () => response },
        query(),
      );
      collectSemanticSearchDocument(session, { scopePath: "note.txt", text: "charge card" });
      let settled = false;
      const pending = runSemanticSearchSession(session, query(), undefined, {
        timeoutMs: Infinity,
        onTimeout,
      });
      void pending.then(() => {
        settled = true;
      });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(settled).toBe(false);
      expect(onTimeout).not.toHaveBeenCalled();
      if (finish === undefined) throw new Error("Expected a pending provider response");
      finish([{ scopePath: "note.txt", score: 1, line: 1 }]);
      await expect(pending).resolves.toEqual([{ scopePath: "note.txt", score: 1, line: 1 }]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the RRF constant stable and sanitizes provider names", () => {
    expect(SEMANTIC_RRF_K).toBe(60);
    expect(semanticSearchTool("Local Fixture Provider")).toBe(
      "repo.semanticSearch:local-fixture-provider",
    );
    expect(semanticSearchTool("---Enterprise@@Provider---")).toBe(
      "repo.semanticSearch:enterprise-provider",
    );
    expect(semanticSearchTool("!!!")).toBe("repo.semanticSearch:unnamed");
    // Regression for the charCodeAt -> codePointAt rename (typescript:S7758) in
    // stripEdgeHyphens. A supplementary-plane character (2 UTF-16 code units) is never a "safe"
    // provider-name character, so safeProviderName drops it before stripEdgeHyphens ever runs;
    // this proves the surrounding sanitization pipeline still produces a clean, uncorrupted name
    // end-to-end instead of leaking a stray surrogate into the tool id.
    expect(semanticSearchTool("😀Provider😀")).toBe("repo.semanticSearch:provider");
  });

  it("fuses lexical and semantic ranks deterministically without comparing raw scores", () => {
    const fused = fuseLexicalAndSemanticRanks(
      [
        { scopePath: "README.md", score: 10 },
        { scopePath: "src/charge.ts", score: 1 },
      ],
      [{ scopePath: "src/charge.ts", score: 0.97 }],
    );

    expect(fused[0]?.scopePath).toBe("src/charge.ts");
    expect(fused[0]?.lexicalRank).toBe(2);
    expect(fused[0]?.semanticRank).toBe(1);
    expect(fused[0]?.signals.map((signal) => signal.name)).toEqual([
      "rrf:lexical",
      "rrf:semantic",
      "rrf:fused",
    ]);
  });

  it("drops a NaN-scored match so it never fuses into a positive score (GEN-DUP-SEMANTIC-003)", async () => {
    // The score clamp is now the canonical contracts clampUnit, which maps NaN -> 0. A provider match
    // whose score is NaN is rejected up-front and thus contributes no semantic rank, so the path fuses
    // with only its lexical contribution — the semantic side is 0, never a NaN that would poison sorting.
    const session = createSemanticSearchSession(
      providerReturning([{ scopePath: "src/charge.ts", score: Number.NaN }]),
      query(),
    );
    collectSemanticSearchDocument(session, { scopePath: "src/charge.ts", text: "charge card" });
    const matches = await runSemanticSearchSession(session, query(), undefined);
    expect(matches).toEqual([]);

    const fused = fuseLexicalAndSemanticRanks(
      [{ scopePath: "src/charge.ts", score: 1 }],
      [...matches.map((match) => ({ scopePath: match.scopePath, score: match.score }))],
    );
    expect(fused[0]?.semanticRank).toBeUndefined();
    expect(fused[0]?.semanticContribution).toBe(0);
    expect(Number.isFinite(fused[0]?.fusedScore)).toBe(true);
  });

  it("clamps an out-of-range provider score into the unit interval", async () => {
    const session = createSemanticSearchSession(
      providerReturning([{ scopePath: "src/charge.ts", score: 4.2 }]),
      query(),
    );
    collectSemanticSearchDocument(session, { scopePath: "src/charge.ts", text: "charge card" });
    const matches = await runSemanticSearchSession(session, query(), undefined);
    expect(matches[0]?.score).toBe(1);
  });

  it("times out a provider that ignores abort without waiting for it to settle", async () => {
    vi.useFakeTimers();
    try {
      let providerSignal: AbortSignal | undefined;
      let timeoutCalls = 0;
      const provider: SemanticSearchProvider = {
        name: "pending-fixture",
        search: ({ signal }) => {
          providerSignal = signal;
          return new Promise<readonly SemanticSearchMatch[]>(() => undefined);
        },
      };
      const session = createSemanticSearchSession(provider, query());
      collectSemanticSearchDocument(session, {
        scopePath: "src/charge.ts",
        text: "charge card",
      });

      const result = runSemanticSearchSession(session, query(), undefined, {
        timeoutMs: 25,
        onTimeout: (): void => {
          timeoutCalls += 1;
        },
      });
      await vi.advanceTimersByTimeAsync(25);

      await expect(result).resolves.toEqual([]);
      expect(timeoutCalls).toBe(1);
      expect(providerSignal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(timeoutCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets an external abort win without reporting a semantic timeout", async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      let providerSignal: AbortSignal | undefined;
      let timeoutCalls = 0;
      const provider: SemanticSearchProvider = {
        name: "pending-fixture",
        search: ({ signal }) => {
          providerSignal = signal;
          return new Promise<readonly SemanticSearchMatch[]>(() => undefined);
        },
      };
      const session = createSemanticSearchSession(provider, query());
      collectSemanticSearchDocument(session, {
        scopePath: "src/charge.ts",
        text: "charge card",
      });

      const result = runSemanticSearchSession(session, query(), caller.signal, {
        timeoutMs: 25,
        onTimeout: (): void => {
          timeoutCalls += 1;
        },
      });
      caller.abort();

      await expect(result).resolves.toEqual([]);
      expect(providerSignal?.aborted).toBe(true);
      expect(timeoutCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(25);
      expect(timeoutCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
