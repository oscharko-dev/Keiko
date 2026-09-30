// Customer report on 1.1.13: a LiteLLM `hosted_vllm` model declares no context window, so Keiko
// planned it as a 4,096-token model and every grounded question failed. These tests pin the three
// gateway-owned pieces of the repair: reading the window a provider states in its overflow answer,
// reporting it to the host, and asking an assumed deployment for it once at startup.
import { describe, expect, it, vi } from "vitest";
import { ContextOverflowError, ProviderError } from "@oscharko-dev/keiko-security/errors/gateway";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { OpenAiAdapter, reportedContextWindowTokens } from "./openai-adapter.js";
import { Gateway, type ContextWindowReport } from "./gateway.js";
import { discoverGatewayContextWindow } from "./readiness-probe.js";
import { assumedChatCapability, createDefaultChatCapability } from "./capabilities.js";
import {
  loadConfigFromFile,
  markAssumedPlaceholderContextWindows,
  parseModelCapability,
  toolCallingConfigurationFingerprint,
} from "./config.js";
import type { GatewayConfig, ModelProviderConfig } from "./types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROVIDER: ModelProviderConfig = {
  modelId: "gemma-4-31b-it",
  baseUrl: "https://litellm.example/v1",
  apiKey: ["example-test-token-", "1234567890abcd"].join(""),
  timeoutMs: 30_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};

function rejection(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: { message, type: null, code: String(status) } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("reportedContextWindowTokens", () => {
  it.each([
    [
      "vLLM input overflow",
      "This model's maximum context length is 32768 tokens. However, you requested 1024 output tokens and your prompt contains 40000 input tokens, for a total of 41024 tokens.",
      32_768,
    ],
    [
      "vLLM >= 0.11 output allocation",
      "max_tokens=1000000000 cannot be greater than max_model_len=131072. Please request fewer output tokens.",
      131_072,
    ],
    [
      "LiteLLM wrapping vLLM",
      'litellm.BadRequestError: Hosted_vllmException - {"object":"error","message":"This model\'s maximum context length is 8192 tokens. However, your request has 9000 input tokens."}',
      8_192,
    ],
    [
      "OpenAI / Azure",
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
      128_000,
    ],
    ["Anthropic via LiteLLM", "prompt is too long: 250000 tokens > 200000 maximum", 200_000],
    [
      "TGI",
      "Input validation error: `inputs` tokens + `max_new_tokens` must be <= 8192. Given: 9000",
      8_192,
    ],
    [
      "llama.cpp server",
      "the request exceeds the available context size (n_ctx = 16384), try increasing it",
      16_384,
    ],
  ])("reads the window from a %s answer", (_name, message, expected) => {
    expect(reportedContextWindowTokens({ error: { message } })).toBe(expected);
  });

  it("reports nothing for an overflow that names no window or an implausible one", () => {
    expect(reportedContextWindowTokens({ error: { code: "context_length_exceeded" } })).toBe(
      undefined,
    );
    expect(
      reportedContextWindowTokens({ error: { message: "maximum context length is 100 tokens" } }),
    ).toBe(undefined);
    expect(reportedContextWindowTokens("not a payload")).toBe(undefined);
  });
});

describe("OpenAiAdapter overflow mapping", () => {
  it("attaches the provider-stated window to the ContextOverflowError", async () => {
    const adapter = new OpenAiAdapter({
      requestId: "overflow-mapping",
      costClass: "medium",
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(
          rejection("This model's maximum context length is 32768 tokens. However, ..."),
        ),
    });
    const error: unknown = await adapter
      .call({ modelId: PROVIDER.modelId, messages: [{ role: "user", content: "hi" }] }, PROVIDER)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContextOverflowError);
    expect((error as ContextOverflowError).reportedContextWindowTokens).toBe(32_768);
  });

  it("classifies vLLM's too-large output allocation as an overflow, not a generic 400", async () => {
    const adapter = new OpenAiAdapter({
      requestId: "overflow-mapping",
      costClass: "medium",
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(
          rejection("max_tokens=9000 cannot be greater than max_model_len=8192. Please request."),
        ),
    });
    const error: unknown = await adapter
      .call({ modelId: PROVIDER.modelId, messages: [{ role: "user", content: "hi" }] }, PROVIDER)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ContextOverflowError);
    expect(error).not.toBeInstanceOf(ProviderError);
    expect((error as ContextOverflowError).reportedContextWindowTokens).toBe(8_192);
  });

  // Every window form the parser reads must also be CLASSIFIED as an overflow — otherwise the
  // rejection maps to a generic ProviderError and the stated window is never adopted.
  it.each([
    [
      "TGI",
      "`inputs` tokens + `max_new_tokens` must be <= 8192. Given: 9000 `inputs` tokens and 1024 `max_new_tokens`",
      422,
      8_192,
    ],
    ["Anthropic via LiteLLM", "prompt is too long: 250000 tokens > 200000 maximum", 400, 200_000],
    [
      "llama.cpp",
      "the request exceeds the available context size (n_ctx = 8192), try increasing it",
      400,
      8_192,
    ],
  ])(
    "classifies the %s window rejection as an overflow",
    async (_name, message, status, tokens) => {
      const adapter = new OpenAiAdapter({
        requestId: "overflow-mapping",
        costClass: "medium",
        fetchImpl: (): Promise<Response> => Promise.resolve(rejection(message, status)),
      });
      const error: unknown = await adapter
        .call({ modelId: PROVIDER.modelId, messages: [{ role: "user", content: "hi" }] }, PROVIDER)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ContextOverflowError);
      expect((error as ContextOverflowError).reportedContextWindowTokens).toBe(tokens);
    },
  );
});

function assumedConfig(): GatewayConfig {
  return {
    providers: [PROVIDER],
    capabilities: [assumedChatCapability(PROVIDER.modelId)],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
  };
}

describe("Gateway context-window report hook", () => {
  it("reports the provider-stated window of a buffered overflow before rethrowing it", async () => {
    const reports: ContextWindowReport[] = [];
    const gateway = new Gateway(assumedConfig(), {
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(rejection("This model's maximum context length is 32768 tokens.")),
      onContextWindowReported: (report): void => {
        reports.push(report);
      },
    });
    await expect(
      gateway.chat({
        modelId: PROVIDER.modelId,
        messages: [{ role: "user", content: "hi" }],
        logContext: { correlationId: "corr-overflow" },
      }),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(reports).toEqual([
      {
        modelId: PROVIDER.modelId,
        contextWindowTokens: 32_768,
        correlationId: "corr-overflow",
        deploymentFingerprint: toolCallingConfigurationFingerprint(PROVIDER),
      },
    ]);
  });

  it("reports the window of a streamed overflow", async () => {
    const onContextWindowReported = vi.fn();
    const gateway = new Gateway(assumedConfig(), {
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(rejection("max_tokens=1 cannot be greater than max_model_len=4096.")),
      onContextWindowReported,
    });
    const drain = async (): Promise<void> => {
      for await (const _chunk of gateway.chatStream({
        modelId: PROVIDER.modelId,
        messages: [{ role: "user", content: "hi" }],
      })) {
        // drain
      }
    };
    await expect(drain()).rejects.toBeInstanceOf(ContextOverflowError);
    expect(onContextWindowReported).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: PROVIDER.modelId, contextWindowTokens: 4_096 }),
    );
  });

  it("stays silent for an overflow that names no window", async () => {
    const onContextWindowReported = vi.fn();
    const gateway = new Gateway(assumedConfig(), {
      fetchImpl: (): Promise<Response> => Promise.resolve(rejection("context_length_exceeded")),
      onContextWindowReported,
    });
    await expect(
      gateway.chat({ modelId: PROVIDER.modelId, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(onContextWindowReported).not.toHaveBeenCalled();
  });
});

describe("assumed context windows", () => {
  it("plans an assumed window with the default geometry and a declared one exactly", () => {
    const assumed = deriveContextProfileFromCapability(assumedChatCapability("m"));
    expect(assumed.maxInputTokens).toBe(128_000);
    expect(assumed.effectiveInputBudget).toBe(116_000);
    const declared = deriveContextProfileFromCapability({
      ...createDefaultChatCapability("m"),
      contextWindow: 4_096,
    });
    expect(declared.maxInputTokens).toBe(4_096);
    expect(declared.effectiveInputBudget).toBe(2_944);
  });

  it("parses the flag only for chat capabilities and round-trips it only when true", () => {
    const record = { ...assumedChatCapability("m") };
    expect(parseModelCapability(record, "capabilities[0]").contextWindowAssumed).toBe(true);
    expect(
      parseModelCapability({ ...record, contextWindowAssumed: false }, "capabilities[0]"),
    ).not.toHaveProperty("contextWindowAssumed");
    expect(() =>
      parseModelCapability(
        { ...record, kind: "embedding", contextWindowAssumed: true },
        "capabilities[0]",
      ),
    ).toThrow(/only valid for chat models/u);
  });

  it("round-trips a provider-reported window flag for chat capabilities only", () => {
    const record = { ...createDefaultChatCapability("m"), contextWindowReported: true };
    expect(parseModelCapability(record, "capabilities[0]").contextWindowReported).toBe(true);
    expect(() =>
      parseModelCapability(
        { ...record, kind: "embedding", contextWindowReported: true },
        "capabilities[0]",
      ),
    ).toThrow(/only valid for chat models/u);
  });

  it("marks the exact legacy placeholder signature at load and nothing else", () => {
    const placeholder = { ...createDefaultChatCapability("legacy") };
    const declared = { ...createDefaultChatCapability("declared"), maxOutputTokens: 4_096 };
    const marked = markAssumedPlaceholderContextWindows({
      capabilities: [placeholder, declared],
      providers: [{ modelId: "p", capability: { ...createDefaultChatCapability("p") } }],
    }) as {
      capabilities: Record<string, unknown>[];
      providers: { capability: Record<string, unknown> }[];
    };
    expect(marked.capabilities[0]?.contextWindowAssumed).toBe(true);
    expect(marked.capabilities[1]).not.toHaveProperty("contextWindowAssumed");
    expect(marked.providers[0]?.capability.contextWindowAssumed).toBe(true);
  });

  it("keeps a provider-reported 4,096-token window proven across a reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-reported-window-"));
    try {
      const path = join(dir, "keiko.config.json");
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 2,
          providers: [{ ...PROVIDER }],
          capabilities: [
            { ...createDefaultChatCapability(PROVIDER.modelId), contextWindowReported: true },
          ],
        }),
      );
      const loaded = loadConfigFromFile(path).capabilities?.[0];
      expect(loaded?.contextWindowReported).toBe(true);
      expect(loaded).not.toHaveProperty("contextWindowAssumed");
      if (loaded === undefined) throw new Error("expected the loaded capability");
      expect(deriveContextProfileFromCapability(loaded).maxInputTokens).toBe(4_096);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a persisted 1.1.13 placeholder capability as assumed", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-assumed-window-"));
    try {
      const path = join(dir, "keiko.config.json");
      writeFileSync(
        path,
        JSON.stringify({
          schemaVersion: 2,
          providers: [{ ...PROVIDER }],
          capabilities: [createDefaultChatCapability(PROVIDER.modelId)],
        }),
      );
      const loaded = loadConfigFromFile(path);
      expect(loaded.capabilities?.[0]?.contextWindowAssumed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("discoverGatewayContextWindow", () => {
  it("asks with an output allocation larger than any window and reads vLLM's answer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        rejection("max_tokens=1000000000 cannot be greater than max_model_len=65536."),
      ),
    );
    const outcome = await discoverGatewayContextWindow({
      config: assumedConfig(),
      provider: PROVIDER,
      fetchImpl,
    });
    expect(outcome).toEqual({ status: "reported", contextWindowTokens: 65_536 });
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body.max_tokens).toBe(1_000_000_000);
    expect(body.model).toBe(PROVIDER.modelId);
  });

  it("reports nothing when the provider accepts the allocation", async () => {
    const outcome = await discoverGatewayContextWindow({
      config: assumedConfig(),
      provider: PROVIDER,
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
            status: 200,
          }),
        ),
    });
    expect(outcome).toEqual({ status: "not-reported", httpStatus: 200 });
  });

  it("reports nothing for a rejection that names no window", async () => {
    const outcome = await discoverGatewayContextWindow({
      config: assumedConfig(),
      provider: PROVIDER,
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(
          rejection(
            "max_tokens is too large: 1000000000. This model supports at most 16384 completion tokens",
          ),
        ),
    });
    expect(outcome).toEqual({ status: "not-reported", httpStatus: 400 });
  });
});
