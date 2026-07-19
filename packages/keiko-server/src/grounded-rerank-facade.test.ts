import { describe, expect, it } from "vitest";

import type {
  GatewayConfig,
  LiteLLMRerankRequest,
  RerankOutcome,
  RerankerConfig,
} from "@oscharko-dev/keiko-model-gateway";

import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
import {
  applyRerankMapping,
  fallbackRerankSelection,
  rerankSelection,
} from "./grounded-rerank-facade.js";
import { createInMemoryUiStore } from "./store/index.js";

type EgressConfig = NonNullable<GatewayConfig["egress"]>;

const GLOBAL_EGRESS: EgressConfig = {
  httpsProxy: "http://proxy.example:8080",
  noProxy: ["localhost"],
};

const RERANKER_EGRESS: EgressConfig = {
  caBundlePath: "/etc/keiko/reranker-ca.pem",
};

function rerankerConfig(egress?: EgressConfig): RerankerConfig {
  return {
    modelId: "qwen3-reranker",
    baseUrl: "https://reranker.example/v1",
    apiKey: "reranker-test-key",
    timeoutMs: 30_000,
    ...(egress === undefined ? {} : { egress }),
  };
}

function gatewayConfig(egress: EgressConfig = GLOBAL_EGRESS): GatewayConfig {
  return {
    providers: [],
    capabilities: [],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    egress,
    reranker: rerankerConfig(),
  };
}

function depsWith(
  config: GatewayConfig,
  rerankRequest: (request: LiteLLMRerankRequest) => Promise<RerankOutcome>,
): UiHandlerDeps {
  const env: Record<string, string> = {};
  return {
    config,
    configPresent: true,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env,
    redactor: buildRedactor(env, config),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    rerankRequest,
  };
}

function successfulOutcome(results: readonly { readonly index: number }[]): RerankOutcome {
  return { ok: true, value: { modelId: "qwen3-reranker", results } };
}

describe("rerankSelection", () => {
  it("passes the shared gateway egress config when the reranker has no override", async () => {
    let captured: LiteLLMRerankRequest | undefined;
    const deps = depsWith(gatewayConfig(), (request) => {
      captured = request;
      return Promise.resolve(successfulOutcome([{ index: 0 }]));
    });

    await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["alpha document"],
      documentFor: (candidate) => candidate,
      topN: 1,
      fallbackMode: "slice-topN",
    });

    expect(captured?.egress).toEqual(GLOBAL_EGRESS);
    deps.store.close();
  });

  it("prefers a reranker-specific egress override", async () => {
    let captured: LiteLLMRerankRequest | undefined;
    const config: GatewayConfig = {
      ...gatewayConfig(GLOBAL_EGRESS),
      reranker: rerankerConfig(RERANKER_EGRESS),
    };
    const deps = depsWith(config, (request) => {
      captured = request;
      return Promise.resolve(successfulOutcome([{ index: 0 }]));
    });

    await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["alpha document"],
      documentFor: (candidate) => candidate,
      topN: 1,
      fallbackMode: "slice-topN",
    });

    expect(captured?.egress).toEqual(RERANKER_EGRESS);
    deps.store.close();
  });

  it("denies external reranking before document materialization or transport", async () => {
    let documentCalls = 0;
    let transportCalls = 0;
    const deps = depsWith(gatewayConfig(), () => {
      transportCalls += 1;
      return Promise.resolve(successfulOutcome([{ index: 1 }]));
    });

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["a", "b", "c"],
      documentFor: (candidate) => {
        documentCalls += 1;
        return candidate;
      },
      topN: 2,
      policy: { externalReranking: "deny", localReranking: "allow" },
      fallbackMode: "slice-topN",
    });

    expect(result.selected).toEqual(["a", "b"]);
    expect(result.diagnostics).toEqual({
      status: "denied",
      mode: "local-only",
      candidateCount: 3,
      documentCount: 0,
      keptCount: 2,
      failureKind: "policy-denied",
      latencyMs: 0,
    });
    expect({ documentCalls, transportCalls }).toEqual({ documentCalls: 0, transportCalls: 0 });
    deps.store.close();
  });

  it("reports an unconfigured reranker without materializing documents", async () => {
    let documentCalls = 0;
    const deps = depsWith({ ...gatewayConfig(), reranker: undefined }, () =>
      Promise.resolve(successfulOutcome([{ index: 0 }])),
    );

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["a"],
      documentFor: (candidate) => {
        documentCalls += 1;
        return candidate;
      },
      topN: 1,
      fallbackMode: "slice-topN",
    });

    expect(result.selected).toEqual(["a"]);
    expect(result.diagnostics).toMatchObject({
      status: "disabled",
      failureKind: "not-configured",
      documentCount: 0,
    });
    expect(documentCalls).toBe(0);
    deps.store.close();
  });

  it("maps valid results and applies scores once", async () => {
    const deps = depsWith(gatewayConfig(), () =>
      Promise.resolve({
        ok: true,
        value: {
          modelId: "qwen3-reranker",
          results: [
            { index: 1, relevanceScore: 0.9 },
            { index: 0, relevanceScore: 0.6 },
          ],
        },
      }),
    );

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: [
        { id: "a", score: 0 },
        { id: "b", score: 0 },
      ],
      documentFor: (candidate) => candidate.id,
      topN: 2,
      applyScore: (candidate, rerank) => ({
        ...candidate,
        score: rerank.relevanceScore ?? candidate.score,
      }),
      fallbackMode: "slice-topN",
    });

    expect(result.selected).toEqual([
      { id: "b", score: 0.9 },
      { id: "a", score: 0.6 },
    ]);
    expect(result.diagnostics).toMatchObject({ status: "applied", keptCount: 2 });
    deps.store.close();
  });

  it.each([
    { label: "empty", results: [] },
    { label: "duplicate", results: [{ index: 0 }, { index: 0 }] },
    { label: "out-of-range", results: [{ index: 9 }] },
    { label: "non-integer", results: [{ index: 0.5 }] },
  ])("falls back with invalid diagnostics for $label mappings", async ({ results }) => {
    const deps = depsWith(gatewayConfig(), () => Promise.resolve(successfulOutcome(results)));

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["a", "b"],
      documentFor: (candidate) => candidate,
      topN: 1,
      fallbackMode: "slice-topN",
    });

    expect(result.selected).toEqual(["a"]);
    expect(result.diagnostics).toMatchObject({
      status: "invalid-response",
      failureKind: "invalid-response",
      keptCount: 1,
    });
    deps.store.close();
  });

  it("uses identity fallback so empty provider results never drop candidates", async () => {
    const candidates = ["a", "b"] as const;
    const deps = depsWith(gatewayConfig(), () => Promise.resolve(successfulOutcome([])));

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates,
      documentFor: (candidate) => candidate,
      topN: 1,
      fallbackMode: "identity",
    });

    expect(result.selected).toBe(candidates);
    expect(result.diagnostics.status).toBe("invalid-response");
    deps.store.close();
  });

  it("maps thrown transport failures to redacted fallback diagnostics", async () => {
    const deps = depsWith(gatewayConfig(), () => {
      throw new Error("https://reranker.example/v1 leaked alpha and sk-secret");
    });

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["alpha document"],
      documentFor: (candidate) => candidate,
      topN: 1,
      fallbackMode: "slice-topN",
    });

    expect(result.diagnostics).toMatchObject({
      status: "unavailable",
      failureKind: "transport",
      candidateCount: 1,
      documentCount: 1,
      keptCount: 1,
    });
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/reranker\.example|sk-secret/u);
    deps.store.close();
  });

  it("maps a thrown transport failure to cancelled for an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = depsWith(gatewayConfig(), () => Promise.reject(new Error("aborted")));

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["alpha document"],
      documentFor: (candidate) => candidate,
      topN: 1,
      signal: controller.signal,
      fallbackMode: "slice-topN",
    });

    expect(result.diagnostics).toMatchObject({
      status: "unavailable",
      failureKind: "cancelled",
    });
    deps.store.close();
  });

  it.each(["rate-limited", "proxy-blocked-by-policy"] as const)(
    "maps %s outcomes to unavailable diagnostics",
    async (kind) => {
      const deps = depsWith(gatewayConfig(), () => Promise.resolve({ ok: false, kind }));

      const result = await rerankSelection({
        deps,
        query: "alpha",
        candidates: ["a", "b"],
        documentFor: (candidate) => candidate,
        topN: 1,
        fallbackMode: "slice-topN",
      });

      expect(result.diagnostics).toMatchObject({
        status: "unavailable",
        candidateCount: 2,
        documentCount: 2,
        keptCount: 1,
        failureKind: kind,
      });
      deps.store.close();
    },
  );

  it("keeps localReranking reserved and behaviorally inert", async () => {
    let transportCalls = 0;
    const deps = depsWith(gatewayConfig(), () => {
      transportCalls += 1;
      return Promise.resolve(successfulOutcome([{ index: 1 }]));
    });

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["a", "b"],
      documentFor: (candidate) => candidate,
      topN: 1,
      policy: { externalReranking: "allow", localReranking: "deny" },
      fallbackMode: "slice-topN",
    });

    expect(result.selected).toEqual(["b"]);
    expect(transportCalls).toBe(1);
    deps.store.close();
  });

  it("separates fallback diagnostics from the pre-capped provider pool", async () => {
    let captured: LiteLLMRerankRequest | undefined;
    const deps = depsWith(gatewayConfig(), (request) => {
      captured = request;
      return Promise.resolve(successfulOutcome([{ index: 1 }]));
    });

    const result = await rerankSelection({
      deps,
      query: "alpha",
      candidates: ["a", "b", "c"],
      providerCandidates: ["a", "b"],
      documentFor: (candidate) => candidate,
      topN: 2,
      fallbackMode: "slice-topN",
    });

    expect(captured?.documents).toEqual(["a", "b"]);
    expect(result.selected).toEqual(["b"]);
    expect(result.diagnostics.candidateCount).toBe(2);
    deps.store.close();
  });
});

describe("rerank facade selection properties", () => {
  it("keeps mapped selections as bounded subset-permutations", () => {
    for (let size = 1; size <= 12; size += 1) {
      const candidates = Array.from({ length: size }, (_, index) => `candidate-${String(index)}`);
      const results = candidates.map((_candidate, index) => ({ index })).reverse();
      const topN = Math.max(1, Math.floor(size / 2));
      const selected = applyRerankMapping(candidates, results, topN);

      if (selected === undefined) throw new Error("valid generated mapping was rejected");
      expect(selected).toHaveLength(topN);
      expect(new Set(selected).size).toBe(selected.length);
      expect(selected.every((candidate) => candidates.includes(candidate))).toBe(true);
      expect(selected).not.toHaveLength(0);
    }
  });

  it("makes both fallback modes monotonic", () => {
    const candidates = ["a", "b", "c"] as const;

    expect(fallbackRerankSelection(candidates, 2, "slice-topN")).toEqual(["a", "b"]);
    expect(fallbackRerankSelection(candidates, 1, "identity")).toBe(candidates);
  });
});
