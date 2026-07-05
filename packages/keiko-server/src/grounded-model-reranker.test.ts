import { describe, expect, it } from "vitest";

import type {
  GatewayConfig,
  LiteLLMRerankRequest,
  RerankOutcome,
  RerankerConfig,
} from "@oscharko-dev/keiko-model-gateway";

import { requestConfiguredRerank } from "./grounded-model-reranker.js";
import type { UiHandlerDeps } from "./deps.js";
import { buildRedactor, createRunRegistry } from "./index.js";
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

describe("requestConfiguredRerank", () => {
  it("passes the shared gateway egress config when the reranker has no override", async () => {
    let captured: LiteLLMRerankRequest | undefined;
    const deps = depsWith(gatewayConfig(), (request) => {
      captured = request;
      return Promise.resolve({ ok: true, value: { modelId: request.modelId, results: [] } });
    });

    await requestConfiguredRerank({
      deps,
      query: "alpha",
      documents: ["alpha document"],
      topN: 1,
    });

    expect(captured?.egress).toEqual(GLOBAL_EGRESS);
    deps.store.close();
  });

  it("prefers a reranker-specific egress override over the shared gateway egress config", async () => {
    let captured: LiteLLMRerankRequest | undefined;
    const config: GatewayConfig = {
      ...gatewayConfig(GLOBAL_EGRESS),
      reranker: rerankerConfig(RERANKER_EGRESS),
    };
    const deps = depsWith(config, (request) => {
      captured = request;
      return Promise.resolve({ ok: true, value: { modelId: request.modelId, results: [] } });
    });

    await requestConfiguredRerank({
      deps,
      query: "alpha",
      documents: ["alpha document"],
      topN: 1,
    });

    expect(captured?.egress).toEqual(RERANKER_EGRESS);
    deps.store.close();
  });

  it("maps thrown reranker transport failures to redacted fallback diagnostics", async () => {
    const deps = depsWith(gatewayConfig(), () => {
      throw new Error(
        "provider payload for https://reranker.example/v1 leaked query alpha and sk-secret",
      );
    });

    const attempt = await requestConfiguredRerank({
      deps,
      query: "alpha",
      documents: ["alpha document"],
      topN: 1,
    });

    expect(attempt.outcome).toBeUndefined();
    expect(attempt.diagnostics).toMatchObject({
      status: "unavailable",
      mode: "provider-backed",
      candidateCount: 1,
      documentCount: 1,
      keptCount: 1,
      failureKind: "transport",
    });
    expect(JSON.stringify(attempt.diagnostics)).not.toContain("reranker.example");
    expect(JSON.stringify(attempt.diagnostics)).not.toContain("sk-secret");
    deps.store.close();
  });
});
