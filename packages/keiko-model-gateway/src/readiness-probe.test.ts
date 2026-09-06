import { describe, expect, it } from "vitest";
import { requestGatewayReadinessChatCompletion } from "./readiness-probe.js";
import type { GatewayConfig, ModelProviderConfig } from "./types.js";

const PROVIDER: ModelProviderConfig = {
  modelId: "example-chat-model",
  baseUrl: "https://provider.example/v1/",
  // Deliberately low-entropy and self-describing: the split-string form this replaced still
  // matched gitleaks' generic-api-key rule, failing the required Secret scan (#3042).
  apiKey: "not-a-secret-readiness-probe-fixture",
  timeoutMs: 30_000,
  maxRetries: 3,
  retryBaseDelayMs: 500,
};

const CONFIG: GatewayConfig = {
  providers: [PROVIDER],
  circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("requestGatewayReadinessChatCompletion", () => {
  it("overrides raw body defaults with the admitted provider-specific output bound", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = (_url, init) => {
      if (typeof init?.body === "string") {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [], max_tokens: 128_000, max_completion_tokens: 128_000 },
      maxOutputTokens: 17,
      fetchImpl,
    });
    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, outputTokenParameter: "max_completion_tokens" },
      body: { messages: [], max_tokens: 128_000, max_completion_tokens: 128_000 },
      maxOutputTokens: 19,
      fetchImpl,
    });

    expect(bodies).toEqual([
      { model: PROVIDER.modelId, messages: [], max_tokens: 17 },
      { model: PROVIDER.modelId, messages: [], max_completion_tokens: 19 },
    ]);
  });

  it("trims a trailing slash from the base URL before joining /chat/completions", async () => {
    // LiteLLM production audit: a file/env-authored 'https://litellm.example.com/v1/' produced
    // '/v1//chat/completions', which LiteLLM answers with a 404 — the probe must trim exactly
    // like the sibling adapters (embedding, tts, stt, rerank, realtime) do.
    let seenUrl = "";
    const fetchImpl: typeof fetch = (url) => {
      if (typeof url === "string") seenUrl = url;
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [{ role: "user", content: "Reply with exactly: OK" }] },
      fetchImpl,
    });

    expect(seenUrl).toBe("https://provider.example/v1/chat/completions");
  });

  it("keeps a base URL without a trailing slash unchanged", async () => {
    // The other half of the conditional trim: exercising only the slash-bearing branch would
    // let an unconditional slice(0, -1) pass, which would eat the last path character and
    // produce '/v/chat/completions' (review finding on #3042).
    let seenUrl = "";
    const fetchImpl: typeof fetch = (url) => {
      if (typeof url === "string") seenUrl = url;
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, baseUrl: "https://provider.example/v1" },
      body: { messages: [{ role: "user", content: "Reply with exactly: OK" }] },
      fetchImpl,
    });

    expect(seenUrl).toBe("https://provider.example/v1/chat/completions");
  });

  it("uses the Azure deployment protocol for readiness probes", async () => {
    let seenUrl = "";
    const fetchImpl: typeof fetch = (url) => {
      seenUrl = url instanceof Request ? url.url : url.toString();
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: {
        ...PROVIDER,
        baseUrl: "https://provider.example",
        modelId: "deployment/name",
        endpointStyle: "azure-openai-deployment",
        apiVersion: "2025-03-01-preview",
      },
      body: { messages: [] },
      fetchImpl,
    });

    expect(seenUrl).toBe(
      "https://provider.example/openai/deployments/deployment%2Fname/chat/completions?api-version=2025-03-01-preview",
    );
  });

  it("sends the provider model id and credential header", async () => {
    let seenAuth: string | null = null;
    let seenBody = "";
    const fetchImpl: typeof fetch = (_url, init) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      seenBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [] },
      fetchImpl,
    });

    expect(seenAuth).toBe(`Bearer ${PROVIDER.apiKey}`);
    expect(JSON.parse(seenBody)).toMatchObject({ model: "example-chat-model" });
  });
});
