import { describe, expect, it } from "vitest";
import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type CandidateFile,
  type EvidenceAtom,
  type RetrievalQuery,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type {
  GatewayConfig,
  LiteLLMRerankRequest,
  RerankOutcome,
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

    const out = await reranker?.rerank(
      candidates,
      new Map(candidates.map((entry) => [entry.scopePath, [atom(entry.scopePath, entry.score)]])),
      2,
    );

    expect(captured?.modelId).toBe("qwen3-reranker");
    expect(captured?.query).toBe(QUERY.text);
    expect(captured?.documents[0]).toContain("Path: src/a.ts");
    expect(captured?.documents[0]).toContain("Evidence atoms:");
    expect(out?.map((entry) => entry.scopePath)).toEqual(["src/b.ts", "src/a.ts"]);
    expect(out?.[0]?.signals[0]).toEqual({ name: "model-rerank", value: 0.98 });
    deps.store.close();
  });
});
