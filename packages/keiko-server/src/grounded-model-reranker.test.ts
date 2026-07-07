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

  it("reports a not-configured reranker via status: disabled + failureKind: not-configured, never status: not-configured", async () => {
    const deps = depsWith({ ...gatewayConfig(), reranker: undefined }, () =>
      Promise.resolve({ ok: true, value: { modelId: "unused", results: [] } }),
    );

    const attempt = await requestConfiguredRerank({
      deps,
      query: "alpha",
      documents: ["alpha document"],
      topN: 1,
    });

    expect(attempt.outcome).toBeUndefined();
    expect(attempt.diagnostics.status).toBe("disabled");
    expect(attempt.diagnostics.status).not.toBe("not-configured");
    expect(attempt.diagnostics.failureKind).toBe("not-configured");
    deps.store.close();
  });

  it("maps a thrown transport failure to cancelled when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = depsWith(gatewayConfig(), () => Promise.reject(new Error("aborted mid-flight")));

    const attempt = await requestConfiguredRerank({
      deps,
      query: "alpha",
      documents: ["alpha document"],
      topN: 1,
      signal: controller.signal,
    });

    expect(attempt.outcome).toBeUndefined();
    expect(attempt.diagnostics).toMatchObject({
      status: "unavailable",
      mode: "provider-backed",
      failureKind: "cancelled",
    });
    deps.store.close();
  });

  it.each(["rate-limited", "proxy-blocked-by-policy"] as const)(
    "maps %s outcomes to redacted unavailable diagnostics",
    async (kind) => {
      const deps = depsWith(gatewayConfig(), () => Promise.resolve({ ok: false, kind }));

      const attempt = await requestConfiguredRerank({
        deps,
        query: "alpha",
        documents: ["alpha document", "beta document"],
        topN: 1,
      });

      expect(attempt.outcome).toBeUndefined();
      expect(attempt.diagnostics).toMatchObject({
        status: "unavailable",
        mode: "provider-backed",
        candidateCount: 2,
        documentCount: 2,
        keptCount: 1,
        failureKind: kind,
      });
      expect(JSON.stringify(attempt.diagnostics)).not.toContain("reranker.example");
      expect(JSON.stringify(attempt.diagnostics)).not.toContain("reranker-test-key");
      deps.store.close();
    },
  );
});
