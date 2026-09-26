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

  // User finding #3643: a base URL that already ends in "/openai" — a shape Gateway Setup
  // accepts and persists (gateway-setup.test.ts's "https://example.openai.azure.com/openai"
  // case) — was sent to "/openai/openai/deployments/...", mirroring the same defect
  // openai-adapter.test.ts pins for the production adapter (both share
  // trimTrailingAzureOpenAiSegment in config.ts).
  it("does not duplicate the /openai segment when the base URL already ends in it (#3643)", async () => {
    let seenUrl = "";
    const fetchImpl: typeof fetch = (url) => {
      seenUrl = url instanceof Request ? url.url : url.toString();
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: {
        ...PROVIDER,
        baseUrl: "https://provider.example/openai",
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

  // User finding #3641: a strict OpenAI-compatible gateway that streams successfully but rejects
  // the optional stream_options field was recorded as "streaming unsupported" — this probe always
  // sent stream_options and returned the first (rejected) response as the verdict, although the
  // production adapter (OpenAiAdapter.dispatchCompatibleStream) already retries this exact
  // rejection without stream_options and succeeds on the same gateway.
  it("retries a streamed probe without stream_options after a rejection naming that field (#3641)", async () => {
    const seenBodies: Record<string, unknown>[] = [];
    let call = 0;
    const fetchImpl: typeof fetch = (_url, init) => {
      call += 1;
      if (typeof init?.body === "string") {
        seenBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      if (call === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { param: "stream_options", code: "unsupported_parameter" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    const response = await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [{ role: "user", content: "probe" }] },
      stream: true,
      fetchImpl,
    });

    expect(response.status).toBe(200);
    expect(call).toBe(2);
    expect(seenBodies).toEqual([
      {
        model: PROVIDER.modelId,
        messages: [{ role: "user", content: "probe" }],
        stream: true,
        stream_options: { include_usage: true },
      },
      { model: PROVIDER.modelId, messages: [{ role: "user", content: "probe" }], stream: true },
    ]);
  });

  // A rejection for another reason is rejected again without the field, so its verdict stands; the
  // probe never parses the untrusted error body to tell the two apart.
  it("keeps the verdict of a streamed probe rejected for an unrelated reason (#3641)", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = () => {
      call += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { param: "messages", message: "invalid" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const response = await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [{ role: "user", content: "probe" }] },
      stream: true,
      fetchImpl,
    });

    expect(response.status).toBe(400);
    expect(call).toBe(2);
  });

  it("does not retry a streamed probe that failed with a non-shape status (#3641)", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = () => {
      call += 1;
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    };

    const response = await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [{ role: "user", content: "probe" }] },
      stream: true,
      fetchImpl,
    });

    expect(response.status).toBe(503);
    expect(call).toBe(1);
  });

  it("does not retry a non-streamed probe (no stream_options is ever sent)", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = () => {
      call += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { param: "stream_options" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const response = await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: { messages: [] },
      fetchImpl,
    });

    expect(response.status).toBe(400);
    expect(call).toBe(1);
  });

  // User finding #3640: Azure GPT-5.6 tool calls cannot pass Coding Workbench readiness. The
  // forced tool-calling probe (packages/keiko-server's gateway-tool-calling-probe.ts) sends
  // `tools`/`tool_choice` with no reasoning_effort at all; Azure requires exactly "none" for a
  // reasoning-model-family deployment once tools are attached, and the model's own default effort
  // is not "none", so the probe was rejected and the deployment recorded as not supporting tool
  // calling.
  it("forces reasoning_effort 'none' for a reasoning-model-family deployment once the probe body attaches tools (#3640)", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = (_url, init) => {
      seenBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, modelId: "gpt-5.6" },
      body: {
        messages: [{ role: "user", content: "Call the report_readiness tool with status ok." }],
        tools: [{ type: "function", function: { name: "report_readiness" } }],
        tool_choice: { type: "function", function: { name: "report_readiness" } },
      },
      fetchImpl,
    });

    expect(seenBody.reasoning_effort).toBe("none");
  });

  it("does not force reasoning_effort for a reasoning-model-family deployment when the probe body has no tools (#3640)", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = (_url, init) => {
      seenBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, modelId: "gpt-5.6" },
      body: { messages: [{ role: "user", content: "Reply with exactly: OK" }] },
      fetchImpl,
    });

    expect(seenBody).not.toHaveProperty("reasoning_effort");
  });

  it("does not force reasoning_effort for a non-reasoning-family deployment even with tools attached (#3640)", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = (_url, init) => {
      seenBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: PROVIDER,
      body: {
        messages: [{ role: "user", content: "Call the report_readiness tool with status ok." }],
        tools: [{ type: "function", function: { name: "report_readiness" } }],
        tool_choice: { type: "function", function: { name: "report_readiness" } },
      },
      fetchImpl,
    });

    expect(seenBody).not.toHaveProperty("reasoning_effort");
  });

  // Only GPT-5.6 carries that contract: a gpt-5.4 deployment is probed as before.
  it("does not force reasoning_effort for a gpt-5.4 deployment with tools attached (#3640)", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = (_url, init) => {
      seenBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >;
      return Promise.resolve(jsonResponse({ choices: [] }));
    };

    await requestGatewayReadinessChatCompletion({
      config: CONFIG,
      provider: { ...PROVIDER, modelId: "gpt-5.4" },
      body: {
        messages: [{ role: "user", content: "Call the report_readiness tool with status ok." }],
        tools: [{ type: "function", function: { name: "report_readiness" } }],
        tool_choice: { type: "function", function: { name: "report_readiness" } },
      },
      fetchImpl,
    });

    expect(seenBody).not.toHaveProperty("reasoning_effort");
  });
});
