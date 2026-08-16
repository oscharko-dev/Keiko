import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  RETRIEVAL_CONTEXT_BUDGETS,
  tierForRetrievalContextSource,
  toCodingContextWirePack,
  type CodingContextPack,
  type RetrievalContextPack,
  type RetrievalContextSourceKind,
} from "@oscharko-dev/keiko-contracts";
import { codingContextEvidenceRunId } from "../editor/codingContextEvidence.js";
import { handleEditorContext } from "../editor/contextRoutes.js";
import { generateModelCompletions } from "../editor/editorCompletionModel.js";
import { generateInlineCompletion } from "../editor/editorInlineCompletionModel.js";
import type { UiHandlerDeps } from "../deps.js";
import type { RouteContext } from "../routes.js";
import {
  assembleRetrievalContext,
  effectiveRetrievalContextBudget,
  type RetrievalContextProvider,
} from "./contextAssembly.js";

type NeutralKind = Extract<RetrievalContextSourceKind, "graph-relations" | "entailment-evidence">;

function graphProvider(): RetrievalContextProvider<NeutralKind> {
  return {
    sourceKind: "graph-relations",
    order: 1,
    requiresEmbedding: false,
    run: () => ({
      excerpts: [
        {
          sourceKind: "graph-relations",
          id: "relation-b",
          score: 0.8,
          citationRef: "graph:b",
          text: "beta",
          truncated: false,
        },
        {
          sourceKind: "graph-relations",
          id: "relation-a",
          score: 0.8,
          citationRef: "graph:a",
          text: "alpha",
          truncated: false,
        },
      ],
      omission: undefined,
    }),
  };
}

function unavailableProvider(): RetrievalContextProvider<NeutralKind> {
  return {
    sourceKind: "entailment-evidence",
    order: 2,
    requiresEmbedding: false,
  };
}

async function assemble(
  providers: readonly RetrievalContextProvider<NeutralKind>[],
  requestedBudgetBytes?: number,
): Promise<RetrievalContextPack<NeutralKind, "chat-grounding">> {
  return assembleRetrievalContext({
    purpose: "chat-grounding",
    budget: RETRIEVAL_CONTEXT_BUDGETS["chat-grounding"],
    requestedBudgetBytes,
    allowEmbeddingProviders: true,
    signal: new AbortController().signal,
    providers,
    tierForSourceKind: tierForRetrievalContextSource,
  });
}

function codingPack(purpose: "completion" | "inline" = "completion"): CodingContextPack {
  return {
    schemaVersion: "1",
    purpose,
    excerpts: [
      {
        citation: {
          sourceKind: "repo-search",
          sourceTier: "first-party-workspace",
          id: "fixture-1",
          score: 0.75,
          rank: 0,
          citationRef: "fixture.ts",
          byteCount: 7,
          truncated: false,
        },
        text: "private",
      },
    ],
    usedBytes: 7,
    budgetBytes: purpose === "inline" ? 8_192 : 32_768,
    droppedForBudget: 0,
    omissions: [{ sourceKind: "memory", reason: "unavailable" }],
  };
}

function postEditorContext(body: unknown): RouteContext {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  (req as { method?: string }).method = "POST";
  return {
    req: req as unknown as IncomingMessage,
    res: {} as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/api/editor/context"),
  };
}

function deferredProvider(
  sourceKind: NeutralKind,
  order: number,
  id: string,
): {
  readonly provider: RetrievalContextProvider<NeutralKind>;
  readonly started: () => boolean;
  readonly resolve: () => void;
} {
  let hasStarted = false;
  let resolveOutcome: (() => void) | undefined;
  const outcomePromise = new Promise<void>((resolve) => {
    resolveOutcome = resolve;
  });
  const provider: RetrievalContextProvider<NeutralKind> = {
    sourceKind,
    order,
    requiresEmbedding: false,
    run: async () => {
      hasStarted = true;
      await outcomePromise;
      return {
        excerpts: [
          {
            sourceKind,
            id,
            score: 1,
            citationRef: id,
            text: id,
            truncated: false,
          },
        ],
        omission: undefined,
      };
    },
  };
  return {
    provider,
    started: (): boolean => hasStarted,
    resolve: (): void => {
      resolveOutcome?.();
    },
  };
}

function throwingProvider(): RetrievalContextProvider<NeutralKind> {
  return {
    sourceKind: "entailment-evidence",
    order: 5,
    requiresEmbedding: false,
    run: () => Promise.reject(new Error("provider blew up")),
  };
}

describe("assembleRetrievalContext", () => {
  it("assembles a neutral purpose with deterministic ranks and auditable omissions", async () => {
    const providers = [graphProvider(), unavailableProvider()] as const;
    const forward = await assemble(providers, Number.MAX_SAFE_INTEGER);
    const reversed = await assemble([...providers].reverse(), Number.MAX_SAFE_INTEGER);

    expect(forward).toEqual(reversed);
    expect(forward.excerpts.map((entry) => entry.citation.id)).toEqual([
      "relation-a",
      "relation-b",
    ]);
    expect(forward.excerpts.map((entry) => entry.citation.rank)).toEqual([0, 1]);
    expect(forward.usedBytes).toBeLessThanOrEqual(forward.budgetBytes);
    expect(forward.budgetBytes).toBe(RETRIEVAL_CONTEXT_BUDGETS["chat-grounding"].budgetBytes);
    expect(forward.omissions).toEqual([
      { sourceKind: "entailment-evidence", reason: "unavailable" },
    ]);
  });

  it("degrades a throwing provider to an omission instead of aborting the pack (KEIKO-0491)", async () => {
    const throwing = throwingProvider();
    const succeeding = graphProvider();
    const pack = await assemble([throwing, succeeding], Number.MAX_SAFE_INTEGER);
    expect(pack.excerpts.map((entry) => entry.citation.id)).toEqual(["relation-a", "relation-b"]);
    expect(pack.omissions).toEqual([{ sourceKind: "entailment-evidence", reason: "unavailable" }]);
  });

  it("runs providers concurrently so wall-clock is bounded by the slowest, not the sum (KEIKO-0307)", async () => {
    // Deterministic barrier — no wall-clock threshold. Three providers each block until
    // the test resolves them. If they run sequentially, only the first will have started
    // when we probe; if they run concurrently, all three will have started before any of
    // them resolves. We yield microtasks so run() reaches its `await outcomePromise`
    // suspension point in each provider before probing.
    const p1 = deferredProvider("graph-relations", 1, "p-1");
    const p2 = deferredProvider("graph-relations", 2, "p-2");
    const p3 = deferredProvider("graph-relations", 3, "p-3");
    const packPromise = assemble([p1.provider, p2.provider, p3.provider], Number.MAX_SAFE_INTEGER);
    // A single macrotask boundary is enough for every provider's `run()` to hit its await.
    await new Promise((resolve) => setImmediate(resolve));
    expect(p1.started()).toBe(true);
    expect(p2.started()).toBe(true);
    expect(p3.started()).toBe(true);
    p1.resolve();
    p2.resolve();
    p3.resolve();
    const pack = await packPromise;
    // Concurrency changes wall-clock, not iteration order — packCandidates orders by score
    // and id, and the ordered append in assembleRetrievalContext preserves provider order.
    expect(pack.excerpts.map((entry) => entry.citation.id)).toEqual(["p-1", "p-2", "p-3"]);
  });

  it("records embedding exclusions instead of invoking a forbidden provider", async () => {
    const run = vi.fn(() => ({ excerpts: [], omission: undefined }));
    const provider: RetrievalContextProvider<NeutralKind> = {
      sourceKind: "graph-relations",
      order: 0,
      requiresEmbedding: true,
      run,
    };
    const pack = await assembleRetrievalContext({
      purpose: "inline",
      budget: RETRIEVAL_CONTEXT_BUDGETS.inline,
      allowEmbeddingProviders: false,
      signal: new AbortController().signal,
      providers: [provider],
      tierForSourceKind: tierForRetrievalContextSource,
    });

    expect(run).not.toHaveBeenCalled();
    expect(pack.omissions).toEqual([{ sourceKind: "graph-relations", reason: "too-expensive" }]);
  });

  it("clamps caller budgets pointwise and never widens either ceiling", () => {
    const base = RETRIEVAL_CONTEXT_BUDGETS["chat-grounding"];
    for (const requested of [-10, 0, 1, base.budgetBytes, base.budgetBytes * 2]) {
      const effective = effectiveRetrievalContextBudget(base, requested);
      expect(effective.budgetBytes).toBeLessThanOrEqual(base.budgetBytes);
      expect(effective.maxBytesPerSource).toBeLessThanOrEqual(base.maxBytesPerSource);
      expect(effective.maxBytesPerSource).toBeLessThanOrEqual(effective.budgetBytes);
    }
  });

  it("pins legacy prompt hashes and evidence run-id material across the alias extraction", async () => {
    const completion = await generateModelCompletions(
      {
        overlayText: "const a = 1;\nconst b = ",
        position: { line: 1, character: 10 },
        languageId: "typescript",
        contextPack: codingPack(),
        maxItems: 5,
        maxInsertTextChars: 100,
      },
      () => Promise.resolve("[]"),
      new AbortController().signal,
    );
    const inline = await generateInlineCompletion(
      {
        overlayText: "function add(a, b) {\n  return \n}\n",
        position: { line: 1, character: 9 },
        languageId: "typescript",
        contextPack: codingPack("inline"),
        maxInsertTextChars: 100,
      },
      () => Promise.resolve("a + b;"),
      new AbortController().signal,
    );

    expect(completion.promptHash).toBe(
      "cfffb972a9629d27e1a490d495e55a01cfa30e438b9acce83a84fc9fdac77b3f",
    );
    expect(inline.promptHash).toBe(
      "f8c891493abd9414bc1a494548b6a838a33506ccef2a2db84169ddf8f3df9846",
    );
    expect(
      codingContextEvidenceRunId(toCodingContextWirePack(codingPack()), 1_700_000_000_000),
    ).toBe("coding-context-5aa8f1c006077f96");
  });

  it("keeps neutral purposes fail-closed on the coding editor route", async () => {
    const result = await handleEditorContext(
      postEditorContext({
        schemaVersion: "1",
        purpose: "chat-grounding",
        root: ".",
        documentPath: "src/a.ts",
      }),
      {} as UiHandlerDeps,
    );

    expect(result).toEqual({
      status: 400,
      body: { error: { code: "INVALID_REQUEST", message: "request.purpose invalid" } },
    });
  });
});
