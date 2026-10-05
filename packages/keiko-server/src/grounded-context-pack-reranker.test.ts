import { describe, expect, it } from "vitest";
import { UNVERIFIED_GATEWAY } from "@oscharko-dev/keiko-contracts/runtime/gateway-verification";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type CandidateFile,
  type EvidenceAtom,
  type RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import {
  requestLiteLLMRerank,
  type GatewayConfig,
  type LiteLLMRerankRequest,
  type RerankOutcome,
} from "@oscharko-dev/keiko-model-gateway";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore } from "./store/index.js";
import { configuredContextPackRerankerFor } from "./grounded-context-pack-reranker.js";

const QUERY: RetrievalQuery = {
  kind: "natural-language",
  text: "where is the target behavior?",
  caseSensitive: false,
  maxResults: 10,
  emittedAtMs: 1,
};

function config(withReranker: boolean): GatewayConfig {
  return {
    providers: [],
    capabilities: [],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    ...(withReranker
      ? {
          reranker: {
            modelId: "qwen3-reranker",
            baseUrl: "https://reranker.example/v1",
            apiKey: "reranker-test-key",
            timeoutMs: 30_000,
          },
        }
      : {}),
  };
}

function depsWith(
  gatewayConfig: GatewayConfig,
  rerankRequest: (request: LiteLLMRerankRequest) => Promise<RerankOutcome>,
): UiHandlerDeps {
  const env: Record<string, string> = {};
  return {
    config: gatewayConfig,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env,
    redactor: buildRedactor(env, gatewayConfig),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    rerankRequest,
  };
}

function candidate(scopePath: string, score: number): CandidateFile {
  return {
    scopePath,
    score,
    signals: [{ name: "lexical", value: score }],
    omitted: undefined,
  };
}

function atom(scopePath: string, score: number): EvidenceAtom {
  return {
    schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
    stableId: `${scopePath}:atom`,
    scopePath,
    lineRange: { startLine: 3, endLine: 7 },
    score,
    provenance: { kind: "lexical-search", tool: "repo-search", queryFingerprint: "q" },
    redactionState: "redacted",
    emittedAtMs: 1,
    ledgerRef: undefined,
  };
}

describe("configuredContextPackRerankerFor", () => {
  it("returns undefined when no gateway reranker is configured", () => {
    const deps = depsWith(config(false), () =>
      Promise.resolve({ ok: true, value: { modelId: "unused", results: [] } }),
    );

    expect(configuredContextPackRerankerFor(deps, QUERY, undefined)).toBeUndefined();
    deps.store.close();
  });

  it("sends bounded candidate metadata and applies model-returned ordering", async () => {
    let captured: LiteLLMRerankRequest | undefined;
    const deps = depsWith(config(true), (request) => {
      captured = request;
      return Promise.resolve({
        ok: true,
        value: {
          modelId: request.modelId,
          results: [
            { index: 1, relevanceScore: 0.98 },
            { index: 0, relevanceScore: 0.73 },
          ],
        },
      });
    });
    const reranker = configuredContextPackRerankerFor(deps, QUERY, undefined);
    const candidates = [candidate("src/a.ts", 0.4), candidate("src/b.ts", 0.6)];
    const controller = new AbortController();

    const out = await reranker?.rerank(
      candidates,
      new Map(candidates.map((entry) => [entry.scopePath, [atom(entry.scopePath, entry.score)]])),
      2,
      { signal: controller.signal, timeoutMs: 125 },
    );

    expect(captured?.modelId).toBe("qwen3-reranker");
    expect(captured?.query).toBe(QUERY.text);
    expect(captured?.documents[0]).toContain("Path: src/a.ts");
    expect(captured?.documents[0]).toContain("Evidence atoms:");
    expect(captured).toMatchObject({ signal: controller.signal, timeoutMs: 125 });
    expect(out?.map((entry) => entry.scopePath)).toEqual(["src/b.ts", "src/a.ts"]);
    expect(out?.[0]?.signals[0]).toEqual({ name: "model-rerank", value: 0.98 });
    deps.store.close();
  });

  it("pins one gateway-config generation when the workflow seam is created", async () => {
    const pinned = config(true);
    const saved = {
      ...config(true),
      reranker: {
        ...config(true).reranker,
        modelId: "saved-reranker",
        baseUrl: "https://saved-reranker.example/v1",
      },
    } as GatewayConfig;
    let configReads = 0;
    let captured: LiteLLMRerankRequest | undefined;
    const base = depsWith(pinned, (request) => {
      captured = request;
      return Promise.resolve({
        ok: true,
        value: { modelId: request.modelId, results: [{ index: 0 }] },
      });
    });
    const deps: UiHandlerDeps = {
      ...base,
      gatewayConfig: {
        storagePath: "/runtime/config.json",
        current: () => {
          configReads += 1;
          return configReads === 1 ? pinned : saved;
        },
        present: () => true,
        set: () => undefined,
        generation: () => 0,
        verification: () => UNVERIFIED_GATEWAY,
        recordVerification: () => undefined,
        verifiedCapability: () => undefined,
        recordVerifiedCapability: () => undefined,
        clearVerifiedCapability: () => false,
      },
    };
    const reranker = configuredContextPackRerankerFor(deps, QUERY, undefined);
    const candidates = [candidate("src/a.ts", 0.4)];

    await reranker?.rerank(candidates, new Map(), 1);

    expect(configReads).toBe(1);
    expect(captured?.endpoint).toBe("https://reranker.example/v1");
    expect(captured?.modelId).toBe("qwen3-reranker");
    deps.store.close();
  });

  it("preserves every candidate when the provider returns an empty result list", async () => {
    const deps = depsWith(config(true), (request) =>
      Promise.resolve({ ok: true, value: { modelId: request.modelId, results: [] } }),
    );
    const reranker = configuredContextPackRerankerFor(deps, QUERY, undefined);
    const candidates = [candidate("src/a.ts", 0.4), candidate("src/b.ts", 0.6)];

    const out = await reranker?.rerank(candidates, new Map(), candidates.length);

    expect(out).toBe(candidates);
    expect(out).toHaveLength(2);
    deps.store.close();
  });

  it("bounds the aggregate request bytes and preserves every unsubmitted candidate", async () => {
    let captured: LiteLLMRerankRequest | undefined;
    let bodyBytes = 0;
    const deps = depsWith(config(true), (request) => {
      captured = request;
      return requestLiteLLMRerank({
        ...request,
        fetchImpl: (_url, init) => {
          bodyBytes = httpBodyBytes(init);
          return Promise.resolve(completeRerankResponse(request));
        },
      });
    });
    const candidates = Array.from({ length: 8_000 }, (_, index) =>
      candidate(`handbook/測定-${String(index)}.html`, 0.5),
    );
    const byteBudget = 4_096;
    const seam = configuredContextPackRerankerFor(deps, QUERY, undefined, byteBudget);
    const out = await seam?.rerank(candidates, new Map(), candidates.length);
    const request = requiredRequest(captured);
    expect(bodyBytes).toBeGreaterThan(0);
    expect(bodyBytes).toBeLessThanOrEqual(byteBudget);
    expect(request.documents.length).toBeGreaterThan(0);
    expect(request.documents.length).toBeLessThan(candidates.length);
    expect(request.topN).toBe(request.documents.length);
    expect(out?.at(-1)).toBe(candidates.at(-1));
    expect(out).toHaveLength(candidates.length);
    expect(out?.[0]?.scopePath).toBe(candidates[request.documents.length - 1]?.scopePath);
    expect(out?.[0]?.signals[0]).toEqual({ name: "model-rerank", value: 0.99 });
    deps.store.close();
  });

  it("retains the original pool when the request envelope cannot fit", async () => {
    let calls = 0;
    const deps = depsWith(config(true), () => {
      calls += 1;
      return Promise.resolve({ ok: true, value: { modelId: "unused", results: [] } });
    });
    const candidates = [candidate("src/測定.ts", 0.5)];
    const seam = configuredContextPackRerankerFor(deps, QUERY, undefined, 1);
    const out = await seam?.rerank(candidates, new Map(), candidates.length);
    expect(out).toBe(candidates);
    expect(calls).toBe(0);
    deps.store.close();
  });

  it("preserves original identity on a failed bounded request", async () => {
    let captured: LiteLLMRerankRequest | undefined;
    let bodyBytes = 0;
    const deps = depsWith(config(true), (request) => {
      captured = request;
      return requestLiteLLMRerank({
        ...request,
        fetchImpl: (_url, init) => {
          bodyBytes = httpBodyBytes(init);
          return Promise.reject(new Error("Unavailable"));
        },
      });
    });
    const candidates = Array.from({ length: 100 }, (_, index) =>
      candidate(`notes/${String(index)}.txt`, 0.5),
    );
    const seam = configuredContextPackRerankerFor(deps, QUERY, undefined, 1_024);
    const out = await seam?.rerank(candidates, new Map(), candidates.length);
    expect(bodyBytes).toBeGreaterThan(0);
    expect(bodyBytes).toBeLessThanOrEqual(1_024);
    expect(captured?.documents.length).toBeLessThan(candidates.length);
    expect(out).toBe(candidates);
    deps.store.close();
  });

  it("preserves the full pool when topK is smaller than the submitted batch", async () => {
    const deps = depsWith(config(true), (request) =>
      Promise.resolve({
        ok: true,
        value: { modelId: request.modelId, results: [{ index: 1, relevanceScore: 0.99 }] },
      }),
    );
    const candidates = [candidate("src/a.ts", 0.4), candidate("src/b.ts", 0.6)];
    const seam = configuredContextPackRerankerFor(deps, QUERY, undefined, 4_096);
    const out = await seam?.rerank(candidates, new Map(), 1);
    expect(out).toBe(candidates);
    deps.store.close();
  });
});

function httpBodyBytes(init: RequestInit | undefined): number {
  if (typeof init?.body !== "string") throw new TypeError("Expected serialized HTTP body");
  return Buffer.byteLength(init.body, "utf8");
}

function requiredRequest(request: LiteLLMRerankRequest | undefined): LiteLLMRerankRequest {
  if (request === undefined) throw new TypeError("Expected rerank transport request");
  return request;
}

function completeRerankResponse(request: LiteLLMRerankRequest): Response {
  const results = request.documents
    .map((_document, index) => ({ index, relevance_score: 0.99 }))
    .reverse();
  return new Response(JSON.stringify({ results }), {
    headers: { "content-type": "application/json" },
  });
}
