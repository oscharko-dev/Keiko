import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import {
  loadConfigFromFile,
  loadEgressConfigFromFile,
  parseCapabilityList,
  parseEnvEgressConfigFaultTolerant,
  parseGatewayConfig,
  parseModelCapability,
  resolveOutboundHttpEgressConfig,
  toSafeObject,
  type ParseGatewayConfigOptions,
} from "./config.js";

interface RawProvider {
  modelId: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
}

function validProvider(): RawProvider {
  return {
    modelId: "example-chat-model",
    baseUrl: "https://host.example/v1",
    apiKey: "example-test-token-1234567890",
    timeoutMs: 30000,
    maxRetries: 3,
    retryBaseDelayMs: 500,
  };
}

function validRaw(): unknown {
  return {
    providers: [validProvider()],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
  };
}

// Builds a config whose single provider is `mutate(validProvider())`.
function rawWithProvider(mutate: (provider: RawProvider) => Record<string, unknown>): unknown {
  return {
    providers: [mutate(validProvider())],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
  };
}

describe("parseGatewayConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a structurally valid config", () => {
    const config = parseGatewayConfig(validRaw());
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.modelId).toBe("example-chat-model");
    expect(config.providers[0]?.apiKeyHeaderName).toBe("authorization");
    expect(config.circuitBreaker.failureThreshold).toBe(5);
  });

  it("parses an optional Figma access token from local config", () => {
    const config = parseGatewayConfig({
      ...(validRaw() as Record<string, unknown>),
      figma: { accessToken: "  figd_config-token  " },
    });

    expect(config.figma?.accessToken).toBe("figd_config-token");
  });

  it("rejects malformed Figma config without echoing token-like values", () => {
    expect(() =>
      parseGatewayConfig({
        ...(validRaw() as Record<string, unknown>),
        figma: "figd_bad-token",
      }),
    ).toThrow(/figma must be an object/);
    try {
      parseGatewayConfig({
        ...(validRaw() as Record<string, unknown>),
        figma: { accessToken: 123 },
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).toContain("figma.accessToken");
      expect((error as Error).message).not.toContain("figd_bad-token");
    }
  });

  it("parses explicit enterprise egress settings and applies them to providers", () => {
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      egress: {
        httpProxy: "http://proxy.local:8080",
        httpsProxy: "https://secure-proxy.local:8443",
        noProxy: "localhost, 127.0.0.1",
        caBundlePath: "/etc/keiko/enterprise-ca.pem",
      },
    };
    const config = parseGatewayConfig(raw);
    expect(config.egress).toEqual({
      httpProxy: "http://proxy.local:8080/",
      httpsProxy: "https://secure-proxy.local:8443/",
      noProxy: ["localhost", "127.0.0.1"],
      caBundlePath: "/etc/keiko/enterprise-ca.pem",
    });
    expect(config.providers[0]?.egress).toEqual(config.egress);
  });

  it("parses enterprise egress settings from the environment", () => {
    const config = parseGatewayConfig(validRaw(), {
      KEIKO_HTTP_PROXY: "http://proxy.env.local:8080",
      KEIKO_HTTPS_PROXY: "http://secure-proxy.env.local:8443",
      KEIKO_NO_PROXY: "localhost,.corp.example",
      KEIKO_CA_BUNDLE_PATH: "/etc/keiko/env-ca.pem",
    });
    expect(config.egress).toEqual({
      httpProxy: "http://proxy.env.local:8080/",
      httpsProxy: "http://secure-proxy.env.local:8443/",
      noProxy: ["localhost", ".corp.example"],
      caBundlePath: "/etc/keiko/env-ca.pem",
    });
    expect(config.providers[0]?.egress).toEqual(config.egress);
  });

  it("lets env vars override explicit enterprise egress settings per field", () => {
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      egress: {
        httpProxy: "http://proxy.config.local:8080",
        httpsProxy: "http://secure-proxy.config.local:8443",
        noProxy: "localhost,.config.example",
      },
    };
    const config = parseGatewayConfig(raw, {
      KEIKO_HTTP_PROXY: "http://proxy.env.local:8080",
      KEIKO_CA_BUNDLE_PATH: "/etc/keiko/env-ca.pem",
    });
    expect(config.egress).toEqual({
      httpProxy: "http://proxy.env.local:8080/",
      httpsProxy: "http://secure-proxy.config.local:8443/",
      noProxy: ["localhost", ".config.example"],
      caBundlePath: "/etc/keiko/env-ca.pem",
    });
    expect(config.providers[0]?.egress).toEqual(config.egress);
  });

  it("keeps valid config-file egress when a credentialed env override is ignored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      egress: { httpsProxy: "http://secure-proxy.config.local:8443" },
    };
    const config = parseGatewayConfig(raw, {
      HTTPS_PROXY: "http://user:supersecret@proxy.env.local:8080",
      KEIKO_CA_BUNDLE_PATH: "/etc/keiko/env-ca.pem",
    });
    expect(config.egress).toEqual({
      httpsProxy: "http://secure-proxy.config.local:8443/",
      caBundlePath: "/etc/keiko/env-ca.pem",
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("HTTPS_PROXY");
    expect(warn.mock.calls[0]?.[0]).not.toContain("supersecret");
    expect(warn.mock.calls[0]?.[0]).not.toContain("user");
  });

  it("rejects credential-bearing proxy URLs without echoing the credentials", () => {
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      egress: { httpsProxy: "http://user:secret-pass@proxy.local:8080" },
    };
    try {
      parseGatewayConfig(raw);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).toContain("must not embed credentials");
      expect((error as Error).message).not.toContain("secret-pass");
    }
  });

  it("accepts a safe custom API key header name", () => {
    const raw = rawWithProvider((p) => ({ ...p, apiKeyHeaderName: "X-Litellm-Key" }));
    const config = parseGatewayConfig(raw);
    expect(config.providers[0]?.apiKeyHeaderName).toBe("x-litellm-key");
  });

  it("rejects unsupported API key header names", () => {
    const raw = rawWithProvider((p) => ({ ...p, apiKeyHeaderName: "Content-Type" }));
    expect(() => parseGatewayConfig(raw)).toThrow(/must be one of/);
  });

  it("rejects proxy routing headers as API key header names", () => {
    const raw = rawWithProvider((p) => ({ ...p, apiKeyHeaderName: "X-Forwarded-Host" }));
    expect(() => parseGatewayConfig(raw)).toThrow(/must be one of/);
  });

  it("rejects malformed API key header names", () => {
    const raw = rawWithProvider((p) => ({ ...p, apiKeyHeaderName: "X Bad" }));
    expect(() => parseGatewayConfig(raw)).toThrow(/valid HTTP header/);
  });

  it("throws ConfigInvalidError when providers is missing", () => {
    expect(() => parseGatewayConfig({ circuitBreaker: {} })).toThrow(ConfigInvalidError);
  });

  it("throws ConfigInvalidError with a descriptive message when apiKey is missing", () => {
    const raw = rawWithProvider(({ apiKey: _drop, ...rest }) => rest);
    expect(() => parseGatewayConfig(raw)).toThrow(/providers\[0\]\.apiKey/);
  });

  it("never echoes the apiKey value in the error message", () => {
    const raw = rawWithProvider((p) => ({ ...p, timeoutMs: -1 }));
    try {
      parseGatewayConfig(raw);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).not.toContain("example-test-token-1234567890");
    }
  });

  it("rejects a non-positive timeoutMs", () => {
    const raw = rawWithProvider((p) => ({ ...p, timeoutMs: -1 }));
    expect(() => parseGatewayConfig(raw)).toThrow(/timeoutMs/);
  });

  it("accepts a provider modelId that is not in the capability registry", () => {
    const raw = rawWithProvider((p) => ({ ...p, modelId: "not-in-registry" }));
    const config = parseGatewayConfig(raw);
    expect(config.providers[0]?.modelId).toBe("not-in-registry");
  });

  it("accepts an unregistered provider when capability metadata is declared", () => {
    const raw = rawWithProvider((p) => ({
      ...p,
      modelId: "example-private-chat",
      capability: {
        kind: "chat",
        contextWindow: 64_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        costClass: "medium",
        latencyClass: "fast",
        throughputHint: "local endpoint",
        preferredUseCases: ["Local coding workflow"],
        knownLimitations: ["Validate against the target endpoint"],
      },
    }));
    const config = parseGatewayConfig(raw);
    expect(config.providers[0]?.modelId).toBe("example-private-chat");
    expect(config.capabilities?.[0]).toMatchObject({
      id: "example-private-chat",
      kind: "chat",
      toolCalling: true,
      structuredOutput: true,
    });
  });

  // Issue #810 (Epic #761 silent-drop gotcha): supportsImageInput must round-trip through
  // parseGatewayConfig via the inline provider-capability path. Validated against the real
  // deployment id llama-4-maverick-vision so a vision provider becomes capability-routable.
  it("round-trips supportsImageInput: true through the inline provider capability path", () => {
    const raw = rawWithProvider((p) => ({
      ...p,
      modelId: "llama-4-maverick-vision",
      capability: {
        kind: "chat",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        supportsImageInput: true,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "vision endpoint",
        preferredUseCases: ["Vision"],
        knownLimitations: ["Validate against the target endpoint"],
      },
    }));
    const config = parseGatewayConfig(raw);
    const cap = config.capabilities?.find((c) => c.id === "llama-4-maverick-vision");
    expect(cap?.supportsImageInput).toBe(true);
  });

  // Mutation guard: the inline path defaults supportsImageInput to false when omitted, so a
  // text provider is never mistaken for a vision provider.
  it("defaults supportsImageInput to false when the inline capability omits it", () => {
    const raw = rawWithProvider((p) => ({
      ...p,
      modelId: "example-text-chat",
      capability: { kind: "chat", contextWindow: 8_192 },
    }));
    const config = parseGatewayConfig(raw);
    const cap = config.capabilities?.find((c) => c.id === "example-text-chat");
    expect(cap?.supportsImageInput).toBe(false);
  });

  // Issue #810: the strict top-level `capabilities` array (parseModelCapability) must also
  // round-trip supportsImageInput: true — this is the wire-facing surface, not just inline.
  it("round-trips supportsImageInput: true through the strict top-level capabilities array", () => {
    const raw = {
      providers: [{ ...validProvider(), modelId: "llama-4-maverick-vision" }],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
      capabilities: [
        {
          id: "llama-4-maverick-vision",
          kind: "chat",
          contextWindow: 128_000,
          maxOutputTokens: 4_096,
          toolCalling: true,
          structuredOutput: true,
          streaming: true,
          supportsImageInput: true,
          supportsDocumentInput: false,
          workflowEligible: true,
          costClass: "medium",
          latencyClass: "standard",
          throughputHint: "vision endpoint",
          preferredUseCases: ["Vision"],
          knownLimitations: ["Validate against the target endpoint"],
        },
      ],
    };
    const config = parseGatewayConfig(raw);
    const cap = config.capabilities?.find((c) => c.id === "llama-4-maverick-vision");
    expect(cap?.supportsImageInput).toBe(true);
  });

  // Issue #763 (Epic #761 determinism-first contract): the determinism capability flags
  // supportsSeeding / supportsResponseFormat are the AC2 reproducibility gate — generationPort
  // only sends a seed / json_schema responseFormat when the chosen model advertises them
  // (capability.supportsSeeding === true / capability.supportsResponseFormat === true). They must
  // round-trip through the inline provider-capability path so a deployment can declare a
  // seed-capable model and have it actually apply the seed.
  it("round-trips supportsSeeding/supportsResponseFormat: true through the inline provider capability path", () => {
    const raw = rawWithProvider((p) => ({
      ...p,
      modelId: "deterministic-chat",
      capability: {
        kind: "chat",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        supportsSeeding: true,
        supportsResponseFormat: true,
        costClass: "medium",
        latencyClass: "standard",
        throughputHint: "deterministic endpoint",
        preferredUseCases: ["Reproducible generation"],
        knownLimitations: ["Validate against the target endpoint"],
      },
    }));
    const config = parseGatewayConfig(raw);
    const cap = config.capabilities?.find((c) => c.id === "deterministic-chat");
    expect(cap?.supportsSeeding).toBe(true);
    expect(cap?.supportsResponseFormat).toBe(true);
  });

  // Mutation guard: the inline path defaults both determinism flags to false when omitted, so a
  // model is never mistakenly treated as seed-capable (which would persist a misleading seedUsed).
  it("defaults supportsSeeding/supportsResponseFormat to false when the inline capability omits them", () => {
    const raw = rawWithProvider((p) => ({
      ...p,
      modelId: "nondeterministic-chat",
      capability: { kind: "chat", contextWindow: 8_192 },
    }));
    const config = parseGatewayConfig(raw);
    const cap = config.capabilities?.find((c) => c.id === "nondeterministic-chat");
    expect(cap?.supportsSeeding).toBe(false);
    expect(cap?.supportsResponseFormat).toBe(false);
  });

  // Issue #763: the strict top-level `capabilities` array (parseModelCapability →
  // optionalDeterminismFlags) is the wire-facing, authoritative override surface. A parser
  // regression there could silently disable the AC2 seeding gate for every declared model without
  // any other test catching it, so pin the true round-trip explicitly.
  it("round-trips supportsSeeding/supportsResponseFormat: true through the strict top-level capabilities array", () => {
    const raw = {
      providers: [{ ...validProvider(), modelId: "deterministic-chat" }],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
      capabilities: [
        {
          id: "deterministic-chat",
          kind: "chat",
          contextWindow: 128_000,
          maxOutputTokens: 4_096,
          toolCalling: true,
          structuredOutput: true,
          streaming: true,
          supportsImageInput: false,
          supportsDocumentInput: false,
          supportsSeeding: true,
          supportsResponseFormat: true,
          workflowEligible: true,
          costClass: "medium",
          latencyClass: "standard",
          throughputHint: "deterministic endpoint",
          preferredUseCases: ["Reproducible generation"],
          knownLimitations: ["Validate against the target endpoint"],
        },
      ],
    };
    const config = parseGatewayConfig(raw);
    const cap = config.capabilities?.find((c) => c.id === "deterministic-chat");
    expect(cap?.supportsSeeding).toBe(true);
    expect(cap?.supportsResponseFormat).toBe(true);
  });

  // Mutation guard: the strict top-level path preserves absence (optionalDeterminismFlags only
  // materialises a flag when declared), so an omitted determinism flag must read back as undefined,
  // not a coerced false — the gate treats both as "not seed-capable" but the wire shape must not drift.
  it("leaves supportsSeeding/supportsResponseFormat undefined when the strict top-level capability omits them", () => {
    const raw = {
      providers: [{ ...validProvider(), modelId: "plain-chat" }],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
      capabilities: [
        {
          id: "plain-chat",
          kind: "chat",
          contextWindow: 8_192,
          maxOutputTokens: 2_048,
          toolCalling: false,
          structuredOutput: false,
          streaming: false,
          supportsImageInput: false,
          supportsDocumentInput: false,
          workflowEligible: true,
          costClass: "low",
          latencyClass: "fast",
          throughputHint: "plain endpoint",
          preferredUseCases: ["Chat"],
          knownLimitations: ["Validate against the target endpoint"],
        },
      ],
    };
    const config = parseGatewayConfig(raw);
    const cap = config.capabilities?.find((c) => c.id === "plain-chat");
    expect(cap?.supportsSeeding).toBeUndefined();
    expect(cap?.supportsResponseFormat).toBeUndefined();
  });

  // Issue #1210: supportsInfilling / infillingAlignment gate Keiko editor inline completion. They
  // must round-trip through the inline provider-capability path so a deployment can declare an
  // aligned FIM model and have the completion-model selection actually elect it.
  it("round-trips supportsInfilling/infillingAlignment through the inline provider capability path", () => {
    const raw = rawWithProvider((p) => ({
      ...p,
      modelId: "fim-chat",
      capability: {
        kind: "chat",
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        supportsInfilling: true,
        infillingAlignment: "instruct",
        costClass: "low",
        latencyClass: "fast",
        throughputHint: "fim endpoint",
        preferredUseCases: ["Inline completion"],
        knownLimitations: ["Validate against the target endpoint"],
      },
    }));
    const config = parseGatewayConfig(raw);
    const cap = config.capabilities?.find((c) => c.id === "fim-chat");
    expect(cap?.supportsInfilling).toBe(true);
    expect(cap?.infillingAlignment).toBe("instruct");
  });

  // Mutation guard: the inline path defaults supportsInfilling to false when omitted, so a model is
  // never mistakenly treated as suffix-aware (which would mis-route inline completion to a model).
  it("defaults supportsInfilling to false and omits infillingAlignment when the inline capability omits them", () => {
    const raw = rawWithProvider((p) => ({
      ...p,
      modelId: "plain-inline-chat",
      capability: { kind: "chat", contextWindow: 8_192 },
    }));
    const config = parseGatewayConfig(raw);
    const cap = config.capabilities?.find((c) => c.id === "plain-inline-chat");
    expect(cap?.supportsInfilling).toBe(false);
    expect(cap?.infillingAlignment).toBeUndefined();
  });

  it("round-trips supportsInfilling/infillingAlignment through the strict top-level capabilities array", () => {
    const raw = {
      providers: [{ ...validProvider(), modelId: "fim-chat" }],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
      capabilities: [
        {
          id: "fim-chat",
          kind: "chat",
          contextWindow: 128_000,
          maxOutputTokens: 4_096,
          toolCalling: true,
          structuredOutput: true,
          streaming: true,
          supportsImageInput: false,
          supportsDocumentInput: false,
          supportsInfilling: true,
          infillingAlignment: "edit-tuned",
          workflowEligible: true,
          costClass: "low",
          latencyClass: "fast",
          throughputHint: "fim endpoint",
          preferredUseCases: ["Inline completion"],
          knownLimitations: ["Validate against the target endpoint"],
        },
      ],
    };
    const config = parseGatewayConfig(raw);
    const cap = config.capabilities?.find((c) => c.id === "fim-chat");
    expect(cap?.supportsInfilling).toBe(true);
    expect(cap?.infillingAlignment).toBe("edit-tuned");
  });

  it("leaves supportsInfilling/infillingAlignment undefined when the strict top-level capability omits them", () => {
    const raw = {
      providers: [{ ...validProvider(), modelId: "plain-chat" }],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
      capabilities: [
        {
          id: "plain-chat",
          kind: "chat",
          contextWindow: 8_192,
          maxOutputTokens: 2_048,
          toolCalling: false,
          structuredOutput: false,
          streaming: false,
          supportsImageInput: false,
          supportsDocumentInput: false,
          workflowEligible: true,
          costClass: "low",
          latencyClass: "fast",
          throughputHint: "plain endpoint",
          preferredUseCases: ["Chat"],
          knownLimitations: ["Validate against the target endpoint"],
        },
      ],
    };
    const config = parseGatewayConfig(raw);
    const cap = config.capabilities?.find((c) => c.id === "plain-chat");
    expect(cap?.supportsInfilling).toBeUndefined();
    expect(cap?.infillingAlignment).toBeUndefined();
  });

  it("rejects custom capability metadata whose id differs from the provider modelId", () => {
    const raw = rawWithProvider((p) => ({
      ...p,
      modelId: "example-private-chat",
      capability: { id: "other-model", kind: "chat" },
    }));
    expect(() => parseGatewayConfig(raw)).toThrow(/capability\.id/);
  });

  // Test B — parseProviderCapability non-chat workflow rejection via inline path (Issue #143 verifier LOW)
  // Exercises config.ts:323 — the kind !== "chat" && workflowEligible guard inside the
  // per-provider inline capability parser. This path is distinct from the top-level
  // parseModelCapability surface tested in the parseModelCapability describe block.
  it("rejects an inline provider capability with kind: 'embedding' and workflowEligible: true", () => {
    const raw = rawWithProvider((p) => ({
      ...p,
      capability: {
        kind: "embedding",
        workflowEligible: true,
      },
    }));
    try {
      parseGatewayConfig(raw);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      const message = (error as ConfigInvalidError).message;
      expect(message).toContain("providers[0].capability.workflowEligible");
      expect(message).toMatch(
        /providers\[0\]\.capability\.workflowEligible must be false when providers\[0\]\.capability\.kind is not "chat"/u,
      );
    }
  });

  it("rejects an empty providers array", () => {
    expect(() => parseGatewayConfig({ providers: [], circuitBreaker: {} })).toThrow(
      ConfigInvalidError,
    );
  });

  it("file apiKey takes precedence over KEIKO_DEFAULT_API_KEY", () => {
    const config = parseGatewayConfig(validRaw(), {
      KEIKO_DEFAULT_API_KEY: "example-env-token-1234567890abcd",
    });
    expect(config.providers[0]?.apiKey).toBe("example-test-token-1234567890");
  });

  it("env per-model base url overrides file base url", () => {
    const config = parseGatewayConfig(validRaw(), {
      KEIKO_MODEL_EXAMPLE_CHAT_MODEL_BASE_URL: "https://override.example/v1",
    });
    expect(config.providers[0]?.baseUrl).toBe("https://override.example/v1");
  });

  it("env per-model api key overrides file api key", () => {
    const config = parseGatewayConfig(validRaw(), {
      KEIKO_MODEL_EXAMPLE_CHAT_MODEL_API_KEY: "example-per-model-token-1234567890",
    });
    expect(config.providers[0]?.apiKey).toBe("example-per-model-token-1234567890");
  });

  it("env default API key header applies when config omits it", () => {
    const config = parseGatewayConfig(validRaw(), {
      KEIKO_DEFAULT_API_KEY_HEADER_NAME: "X-Api-Key",
    });
    expect(config.providers[0]?.apiKeyHeaderName).toBe("x-api-key");
  });

  it("env per-model API key header overrides file and default headers", () => {
    const raw = rawWithProvider((p) => ({ ...p, apiKeyHeaderName: "api-key" }));
    const config = parseGatewayConfig(raw, {
      KEIKO_DEFAULT_API_KEY_HEADER_NAME: "X-Api-Key",
      KEIKO_MODEL_EXAMPLE_CHAT_MODEL_API_KEY_HEADER_NAME: "X-Litellm-Key",
    });
    expect(config.providers[0]?.apiKeyHeaderName).toBe("x-litellm-key");
  });

  it("global default fills in a provider with no key from file or per-model env", () => {
    const raw = rawWithProvider(({ apiKey: _drop, ...rest }) => rest);
    const config = parseGatewayConfig(raw, {
      KEIKO_DEFAULT_API_KEY: "example-env-token-1234567890abcd",
      KEIKO_DEFAULT_BASE_URL: "https://default.example/v1",
    });
    expect(config.providers[0]?.apiKey).toBe("example-env-token-1234567890abcd");
  });

  describe("baseUrl validation", () => {
    it("rejects a file: scheme baseUrl", () => {
      const raw = rawWithProvider((p) => ({ ...p, baseUrl: "file:///etc/passwd" }));
      expect(() => parseGatewayConfig(raw)).toThrow(ConfigInvalidError);
    });

    it("rejects a non-URL string as baseUrl", () => {
      const raw = rawWithProvider((p) => ({ ...p, baseUrl: "not a url" }));
      expect(() => parseGatewayConfig(raw)).toThrow(ConfigInvalidError);
    });

    it("rejects a baseUrl with embedded credentials and does not echo the password", () => {
      const raw = rawWithProvider((p) => ({
        ...p,
        baseUrl: "https://user:pass@host.example/v1",
      }));
      try {
        parseGatewayConfig(raw);
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigInvalidError);
        expect((error as Error).message).not.toContain("pass");
      }
    });

    it("rejects a baseUrl with a query string or fragment", () => {
      const withQuery = rawWithProvider((p) => ({
        ...p,
        baseUrl: "https://host.example/v1?api-version=latest",
      }));
      const withFragment = rawWithProvider((p) => ({
        ...p,
        baseUrl: "https://host.example/v1#fragment",
      }));
      expect(() => parseGatewayConfig(withQuery)).toThrow(/query string or fragment/);
      expect(() => parseGatewayConfig(withFragment)).toThrow(/query string or fragment/);
    });

    it("rejects a plaintext non-loopback baseUrl", () => {
      const raw = rawWithProvider((p) => ({ ...p, baseUrl: "http://10.0.0.5:8000/v1" }));
      expect(() => parseGatewayConfig(raw)).toThrow(/https/);
    });

    it("accepts a plaintext loopback baseUrl for local development", () => {
      const raw = rawWithProvider((p) => ({ ...p, baseUrl: "http://127.0.0.1:8000/v1" }));
      expect(() => parseGatewayConfig(raw)).not.toThrow();
    });

    it("accepts a plaintext IPv6 loopback baseUrl for local development", () => {
      const raw = rawWithProvider((p) => ({ ...p, baseUrl: "http://[::1]:8000/v1" }));
      expect(() => parseGatewayConfig(raw)).not.toThrow();
    });

    it("accepts a standard https baseUrl", () => {
      const raw = rawWithProvider((p) => ({ ...p, baseUrl: "https://api.example.com/v1" }));
      expect(() => parseGatewayConfig(raw)).not.toThrow();
    });

    it("rejects a plaintext baseUrl whose host only starts with 127. (not real loopback)", () => {
      for (const host of ["127.evil.com", "127.0.0.1.evil.com"]) {
        const raw = rawWithProvider((p) => ({ ...p, baseUrl: `http://${host}/v1` }));
        expect(() => parseGatewayConfig(raw)).toThrow(/https/);
      }
    });

    it("accepts https regardless of host (host filtering is intentionally not done)", () => {
      const raw = rawWithProvider((p) => ({ ...p, baseUrl: "https://127.evil.com/v1" }));
      expect(() => parseGatewayConfig(raw)).not.toThrow();
    });
  });
});

describe("toSafeObject", () => {
  it("omits credential and endpoint fields entirely", () => {
    const config = parseGatewayConfig(validRaw());
    const safe = toSafeObject(config);
    const serialised = JSON.stringify(safe);
    expect(serialised).not.toContain("example-test-token-1234567890");
    expect(serialised).not.toContain("apiKey");
    expect(serialised).not.toContain("https://host.example/v1");
    expect(serialised).not.toContain("baseUrl");
  });

  it("omits enterprise egress proxy and CA topology", () => {
    const config = parseGatewayConfig(
      {
        ...(validRaw() as Record<string, unknown>),
        egress: {
          httpsProxy: "http://proxy.internal.example:8443",
          caBundlePath: "/etc/keiko/internal-ca.pem",
        },
      },
      {},
    );
    const serialised = JSON.stringify(toSafeObject(config));
    expect(serialised).not.toContain("proxy.internal.example");
    expect(serialised).not.toContain("internal-ca.pem");
    expect(serialised).not.toContain("egress");
  });

  it("omits Figma connector credentials", () => {
    const config = parseGatewayConfig({
      ...(validRaw() as Record<string, unknown>),
      figma: { accessToken: "figd_config-token" },
    });
    const serialised = JSON.stringify(toSafeObject(config));

    expect(serialised).not.toContain("figd_config-token");
    expect(serialised).not.toContain("figma");
    expect(serialised).not.toContain("accessToken");
  });

  it("preserves non-secret fields", () => {
    const config = parseGatewayConfig(validRaw());
    const safe = toSafeObject(config);
    expect(safe.providers[0]?.modelId).toBe("example-chat-model");
    expect(safe.providers[0]?.credentialHeaderName).toBe("authorization");
    expect(safe.providers[0]?.timeoutMs).toBe(30000);
  });

  it("preserves declared capability metadata without provider secrets", () => {
    const config = parseGatewayConfig(
      rawWithProvider((p) => ({
        ...p,
        modelId: "example-private-chat",
        capability: {
          kind: "chat",
          toolCalling: true,
          structuredOutput: true,
        },
      })),
    );
    const safe = toSafeObject(config);
    expect(safe.capabilities?.[0]).toMatchObject({
      id: "example-private-chat",
      kind: "chat",
      toolCalling: true,
      structuredOutput: true,
    });
    expect(JSON.stringify(safe)).not.toContain("example-test-token-1234567890");
    expect(JSON.stringify(safe)).not.toContain("https://host.example/v1");
  });

  // Issue #1557, ADR-0088 D2: provider voice ids are provider-sensitive and live on the credential
  // tier (`ModelProviderConfig.voiceProfiles`). They must never reach the browser-facing safe config,
  // while the content-free persona enums (`supportedVoicePersonas`) must survive. This pins the
  // structural leak-proofing (the allowlist drops voiceProfiles by omission).
  it("drops the credential-tier voiceProfiles but preserves content-free persona enums", () => {
    const config = parseGatewayConfig(
      ttsProviderRaw("keiko-tts", [
        { persona: "male", voiceId: "secret-provider-voice-male-001" },
        { persona: "female", voiceId: "secret-provider-voice-female-001" },
      ]),
    );
    const safe = toSafeObject(config);
    const serialised = JSON.stringify(safe);
    expect(serialised).not.toContain("secret-provider-voice-male-001");
    expect(serialised).not.toContain("secret-provider-voice-female-001");
    expect(serialised).not.toContain("voiceProfiles");
    expect(serialised).not.toContain("voiceId");
    expect(safe.capabilities?.find((c) => c.id === "keiko-tts")?.supportedVoicePersonas).toEqual([
      "male",
      "female",
    ]);
  });
});

describe("loadConfigFromFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads and parses a JSON config file", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(validRaw()), "utf8");
    const config = loadConfigFromFile(path);
    expect(config.providers[0]?.modelId).toBe("example-chat-model");
  });

  it("throws ConfigInvalidError for a missing file", () => {
    expect(() => loadConfigFromFile(join(dir, "nope.json"))).toThrow(ConfigInvalidError);
  });

  it("throws ConfigInvalidError for malformed JSON", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not json", "utf8");
    expect(() => loadConfigFromFile(path)).toThrow(ConfigInvalidError);
  });

  it("applies env precedence over the file-loaded values", () => {
    const path = join(dir, "merge.json");
    writeFileSync(path, JSON.stringify(validRaw()), "utf8");
    const config = loadConfigFromFile(path, {
      KEIKO_MODEL_EXAMPLE_CHAT_MODEL_API_KEY: "example-file-load-token-1234567890",
    });
    expect(config.providers[0]?.apiKey).toBe("example-file-load-token-1234567890");
  });

  it("loads egress-only config JSON from disk without requiring providers", () => {
    const path = join(dir, "egress-only.json");
    writeFileSync(
      path,
      JSON.stringify({
        egress: {
          httpsProxy: "http://secure-proxy.config.local:8443",
          noProxy: "localhost,127.0.0.1",
        },
      }),
      "utf8",
    );
    const config = loadEgressConfigFromFile(path, {
      KEIKO_CA_BUNDLE_PATH: "/etc/keiko/env-ca.pem",
    });
    expect(config).toEqual({
      httpsProxy: "http://secure-proxy.config.local:8443/",
      noProxy: ["localhost", "127.0.0.1"],
      caBundlePath: "/etc/keiko/env-ca.pem",
    });
  });
});

describe("resolveOutboundHttpEgressConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when neither config nor env defines egress", () => {
    expect(resolveOutboundHttpEgressConfig(undefined, {})).toBeUndefined();
  });

  it("applies env overrides independently over explicit config", () => {
    const config = resolveOutboundHttpEgressConfig(
      {
        httpProxy: "http://proxy.config.local:8080",
        httpsProxy: "http://secure-proxy.config.local:8443",
        noProxy: ["localhost"],
      },
      {
        KEIKO_HTTP_PROXY: "http://proxy.env.local:8080",
        KEIKO_NO_PROXY: ".corp.example",
      },
    );
    expect(config).toEqual({
      httpProxy: "http://proxy.env.local:8080/",
      httpsProxy: "http://secure-proxy.config.local:8443/",
      noProxy: [".corp.example"],
    });
  });
});

// ─── Strict capability parser (Issue #143) ───────────────────────────────────────
// `parseModelCapability` is the fail-closed parser for explicit, wire-facing
// capability records (top-level `capabilities` array). Every boolean is required
// (no implicit defaults) — callers that want a default chat capability must call
// `createDefaultChatCapability`. Sibling-field values (especially anything from a
// ModelProviderConfig such as apiKey) must NEVER appear in error messages.

function validCapability(): Record<string, unknown> {
  return {
    id: "example-chat-model",
    kind: "chat",
    contextWindow: 64_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "runtime-configured",
    preferredUseCases: ["Chat"],
    knownLimitations: ["Validate against the target endpoint"],
  };
}

function withoutKey(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone = { ...source };
  Reflect.deleteProperty(clone, key);
  return clone;
}

describe("parseModelCapability", () => {
  it("accepts a valid chat capability and round-trips every declared field", () => {
    const raw = validCapability();
    const parsed = parseModelCapability(raw, "capabilities[0]");
    expect(parsed).toEqual(raw);
  });

  it("rejects a missing supportsImageInput with a path-scoped ConfigInvalidError", () => {
    const rest = withoutKey(validCapability(), "supportsImageInput");
    try {
      parseModelCapability(rest, "capabilities[0]");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      const message = (error as Error).message;
      expect(message).toContain("capabilities[0].supportsImageInput");
      // No sibling-field VALUES (provider modelId/url/key) leak into the message.
      // The path itself may contain field NAMES; values are what must not appear.
      expect(message).not.toContain("64000");
      expect(message).not.toContain("runtime-configured");
      expect(message).not.toContain("Validate against the target endpoint");
    }
  });

  it("rejects a missing supportsDocumentInput", () => {
    const rest = withoutKey(validCapability(), "supportsDocumentInput");
    expect(() => parseModelCapability(rest, "capabilities[0]")).toThrow(/supportsDocumentInput/);
  });

  it("rejects a missing workflowEligible", () => {
    const rest = withoutKey(validCapability(), "workflowEligible");
    expect(() => parseModelCapability(rest, "capabilities[0]")).toThrow(/workflowEligible/);
  });

  it("rejects a non-chat kind with workflowEligible: true (invariant: workflow ⇒ chat)", () => {
    const raw = {
      ...validCapability(),
      kind: "embedding",
      workflowEligible: true,
    };
    try {
      parseModelCapability(raw, "capabilities[0]");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).toContain("workflowEligible");
    }
  });

  it("rejects an unknown kind discriminant", () => {
    const raw = { ...validCapability(), kind: "unknown-kind" };
    expect(() => parseModelCapability(raw, "capabilities[0]")).toThrow(/kind/);
  });

  it("rejects an unknown top-level field (strict — no silent absorption)", () => {
    const raw = { ...validCapability(), surpriseField: "value" };
    try {
      parseModelCapability(raw, "capabilities[0]");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).toContain("surpriseField");
    }
  });

  it("rejects a non-object input", () => {
    expect(() => parseModelCapability("not-an-object", "capabilities[0]")).toThrow(
      ConfigInvalidError,
    );
  });

  it("rejects a non-integer contextWindow", () => {
    const raw = { ...validCapability(), contextWindow: -1 };
    expect(() => parseModelCapability(raw, "capabilities[0]")).toThrow(/contextWindow/);
  });

  it("accepts an embedding capability whose workflowEligible is false", () => {
    const raw = { ...validCapability(), kind: "embedding", workflowEligible: false };
    const parsed = parseModelCapability(raw, "capabilities[0]");
    expect(parsed.kind).toBe("embedding");
    expect(parsed.workflowEligible).toBe(false);
  });

  // Issue #1210: supportsInfilling / infillingAlignment are recognised strict-list keys and
  // round-trip exactly (the strict parser rejects unknown keys, so this also proves they are
  // allow-listed).
  it("accepts and round-trips supportsInfilling/infillingAlignment", () => {
    const raw = { ...validCapability(), supportsInfilling: true, infillingAlignment: "instruct" };
    const parsed = parseModelCapability(raw, "capabilities[0]");
    expect(parsed.supportsInfilling).toBe(true);
    expect(parsed.infillingAlignment).toBe("instruct");
  });

  it("rejects infillingAlignment without supportsInfilling: true (invariant: alignment ⇒ infilling)", () => {
    const raw = { ...validCapability(), infillingAlignment: "instruct" };
    try {
      parseModelCapability(raw, "capabilities[0]");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).toContain("infillingAlignment");
    }
  });

  it("rejects infillingAlignment with an explicit supportsInfilling: false", () => {
    const raw = { ...validCapability(), supportsInfilling: false, infillingAlignment: "instruct" };
    expect(() => parseModelCapability(raw, "capabilities[0]")).toThrow(/infillingAlignment/);
  });

  it("rejects supportsInfilling: true on a non-chat kind (invariant: infilling ⇒ chat)", () => {
    const raw = {
      ...validCapability(),
      kind: "embedding",
      workflowEligible: false,
      supportsInfilling: true,
    };
    try {
      parseModelCapability(raw, "capabilities[0]");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).toContain("supportsInfilling");
    }
  });

  it("rejects an unknown infillingAlignment value", () => {
    const raw = {
      ...validCapability(),
      supportsInfilling: true,
      infillingAlignment: "raw-base-fim",
    };
    expect(() => parseModelCapability(raw, "capabilities[0]")).toThrow(/infillingAlignment/);
  });

  it("accepts an ocr-vision capability whose workflowEligible is false", () => {
    const raw = { ...validCapability(), kind: "ocr-vision", workflowEligible: false };
    const parsed = parseModelCapability(raw, "capabilities[0]");
    expect(parsed.kind).toBe("ocr-vision");
  });

  // Test A — ocr-vision + workflowEligible rejection (top-level parser, Issue #143 verifier LOW)
  it("rejects kind: 'ocr-vision' with workflowEligible: true", () => {
    const malformed = {
      id: "test-vision",
      kind: "ocr-vision" as const,
      contextWindow: 8000,
      maxOutputTokens: 4000,
      toolCalling: false,
      structuredOutput: false,
      streaming: false,
      supportsImageInput: true,
      supportsDocumentInput: false,
      workflowEligible: true,
      costClass: "medium" as const,
      latencyClass: "standard" as const,
      throughputHint: "test",
      preferredUseCases: [],
      knownLimitations: [],
    };
    expect(() => parseModelCapability(malformed, "capability")).toThrow(ConfigInvalidError);
    expect(() => parseModelCapability(malformed, "capability")).toThrow(
      /capability\.workflowEligible must be false when capability\.kind is not "chat"/u,
    );
  });

  // Test C — credential-shaped sibling field no-leakage (Issue #143 security-triage MEDIUM, OWASP A09)
  it("does not echo a credential-shaped sibling field in the rejection message", () => {
    const credentialShaped = ["sk-", "test-abcdef1234567890"].join("");
    const malformed = {
      id: "test-chat",
      kind: "chat" as const,
      contextWindow: 8000,
      maxOutputTokens: 4000,
      toolCalling: false,
      structuredOutput: false,
      streaming: false,
      supportsImageInput: false,
      supportsDocumentInput: false,
      workflowEligible: false,
      costClass: "medium" as const,
      latencyClass: "standard" as const,
      throughputHint: "test",
      preferredUseCases: [],
      knownLimitations: [],
      apiKey: credentialShaped,
    };
    try {
      parseModelCapability(malformed, "capability");
      throw new Error("expected parseModelCapability to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      const message = (error as ConfigInvalidError).message;
      expect(message).toContain("capability.apiKey");
      expect(message).not.toContain(credentialShaped);
    }
  });
});

// ─── Voice capability parsing (Issue #493, ADR-0058 D5/D7) ───────────────────────
// The voice ModelKind plus its additive sub-capability flags and provider locality, with the two
// voice invariants enforced identically by the strict and inline parsers: voice fields require
// kind "voice"; a voice capability must advertise ≥1 sub-capability and declare a locality.

function validVoiceCapability(): Record<string, unknown> {
  return {
    id: "keiko-stt",
    kind: "voice",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    supportsSpeechInput: true,
    voiceProviderLocality: "azure-foundry",
    workflowEligible: false,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "runtime-configured voice endpoint",
    preferredUseCases: ["Dictation"],
    knownLimitations: ["Validate against the target endpoint"],
  };
}

describe("parseModelCapability — voice capability", () => {
  it("accepts and round-trips an STT-only voice capability (AC2/AC6)", () => {
    const raw = validVoiceCapability();
    const parsed = parseModelCapability(raw, "capabilities[0]");
    expect(parsed).toEqual(raw);
    expect(parsed.kind).toBe("voice");
    expect(parsed.supportsSpeechInput).toBe(true);
    expect(parsed.voiceProviderLocality).toBe("azure-foundry");
  });

  it("preserves only declared voice flags (round-trips exactly, no false-defaulting)", () => {
    const raw = validVoiceCapability();
    const parsed = parseModelCapability(raw, "capabilities[0]");
    expect(parsed.supportsSpeechOutput).toBeUndefined();
    expect(parsed.supportsRealtimeVoice).toBeUndefined();
  });

  it("rejects a voice capability that advertises no sub-capability (fail-closed)", () => {
    const raw = withoutKey(validVoiceCapability(), "supportsSpeechInput");
    expect(() => parseModelCapability(raw, "capabilities[0]")).toThrow(
      /must advertise at least one of/,
    );
  });

  it("rejects a voice capability missing voiceProviderLocality", () => {
    const raw = withoutKey(validVoiceCapability(), "voiceProviderLocality");
    expect(() => parseModelCapability(raw, "capabilities[0]")).toThrow(
      /must declare voiceProviderLocality/,
    );
  });

  it("rejects an unknown voiceProviderLocality value", () => {
    const raw = { ...validVoiceCapability(), voiceProviderLocality: "on-prem" };
    expect(() => parseModelCapability(raw, "capabilities[0]")).toThrow(/voiceProviderLocality/);
  });

  it("rejects voice fields on a non-voice kind (no Azure hardcode bleed into chat)", () => {
    const raw = { ...validCapability(), supportsSpeechInput: true };
    expect(() => parseModelCapability(raw, "capabilities[0]")).toThrow(
      /voice capability fields require/,
    );
  });

  it("rejects voiceProviderLocality on a non-voice kind", () => {
    const raw = { ...validCapability(), voiceProviderLocality: "azure-foundry" };
    expect(() => parseModelCapability(raw, "capabilities[0]")).toThrow(
      /voice capability fields require/,
    );
  });

  it("accepts a realtime voice capability with both speech directions", () => {
    const raw = {
      ...validVoiceCapability(),
      id: "realtime-voice",
      supportsSpeechInput: true,
      supportsSpeechOutput: true,
      supportsRealtimeVoice: true,
      voiceProviderLocality: "customer-hosted",
    };
    const parsed = parseModelCapability(raw, "capabilities[0]");
    expect(parsed.supportsRealtimeVoice).toBe(true);
    expect(parsed.voiceProviderLocality).toBe("customer-hosted");
  });
});

describe("parseGatewayConfig — inline voice provider (AC6, no Azure hardcode)", () => {
  it("registers a keiko-stt provider with an inline STT-only voice capability", () => {
    const raw = rawWithProvider((p) => ({
      ...p,
      modelId: "keiko-stt",
      capability: {
        kind: "voice",
        supportsSpeechInput: true,
        voiceProviderLocality: "azure-foundry",
        costClass: "low",
        latencyClass: "fast",
        throughputHint: "azure foundry stt deployment",
        preferredUseCases: ["Dictation"],
        knownLimitations: ["Validate against the target endpoint"],
      },
    }));
    const config = parseGatewayConfig(raw);
    const cap = config.capabilities?.find((c) => c.id === "keiko-stt");
    expect(cap?.kind).toBe("voice");
    expect(cap?.supportsSpeechInput).toBe(true);
    expect(cap?.voiceProviderLocality).toBe("azure-foundry");
  });

  it("rejects an inline voice capability with no advertised sub-capability", () => {
    const raw = rawWithProvider((p) => ({
      ...p,
      modelId: "empty-voice",
      capability: { kind: "voice", voiceProviderLocality: "local-only" },
    }));
    expect(() => parseGatewayConfig(raw)).toThrow(/must advertise at least one of/);
  });
});

// ─── Voice persona profiles (Issue #1557, Epic #1556, ADR-0088 D2) ───────────────
// The credential-tier persona → voice-id mapping (`voiceProfiles`) and the derived content-free
// `supportedVoicePersonas` on the matching capability. AC2 is proven by representing all five
// deployment classes by modelId with no hard-coded deployment names.

// An inline speech-output (TTS) voice capability body (no id — taken from the provider modelId).
function ttsCapabilityBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "voice",
    supportsSpeechOutput: true,
    voiceProviderLocality: "customer-hosted",
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "runtime-configured tts deployment",
    preferredUseCases: ["Speech output"],
    knownLimitations: ["Validate against the target endpoint"],
    ...overrides,
  };
}

function ttsProviderRaw(
  modelId: string,
  voiceProfiles: readonly unknown[],
  capabilityOverrides: Record<string, unknown> = {},
): unknown {
  return rawWithProvider((p) => ({
    ...p,
    modelId,
    capability: ttsCapabilityBody(capabilityOverrides),
    voiceProfiles,
  }));
}

describe("parseGatewayConfig — voiceProfiles parsing (Issue #1557)", () => {
  it("parses voiceProfiles and derives supportedVoicePersonas in canonical order", () => {
    const config = parseGatewayConfig(
      ttsProviderRaw("keiko-tts", [
        { persona: "neutral", voiceId: "voice-neutral-01" },
        { persona: "male", voiceId: "voice-male-01" },
      ]),
    );
    const provider = config.providers.find((p) => p.modelId === "keiko-tts");
    expect(provider?.voiceProfiles).toEqual([
      { persona: "neutral", voiceId: "voice-neutral-01" },
      { persona: "male", voiceId: "voice-male-01" },
    ]);
    const cap = config.capabilities?.find((c) => c.id === "keiko-tts");
    expect(cap?.supportedVoicePersonas).toEqual(["male", "neutral"]);
  });

  it("trims voiceId whitespace and preserves the trimmed value", () => {
    const config = parseGatewayConfig(
      ttsProviderRaw("keiko-tts", [{ persona: "female", voiceId: "  voice-female-01  " }]),
    );
    const provider = config.providers.find((p) => p.modelId === "keiko-tts");
    expect(provider?.voiceProfiles).toEqual([{ persona: "female", voiceId: "voice-female-01" }]);
  });

  it("omits voiceProfiles entirely when the key is absent (present-only round-trip)", () => {
    const config = parseGatewayConfig(
      rawWithProvider((p) => ({ ...p, modelId: "keiko-tts", capability: ttsCapabilityBody() })),
    );
    const provider = config.providers.find((p) => p.modelId === "keiko-tts");
    expect(Object.hasOwn(provider ?? {}, "voiceProfiles")).toBe(false);
    const cap = config.capabilities?.find((c) => c.id === "keiko-tts");
    expect(cap?.supportedVoicePersonas).toBeUndefined();
  });

  it("rejects an unknown persona value", () => {
    expect(() =>
      parseGatewayConfig(ttsProviderRaw("keiko-tts", [{ persona: "robot", voiceId: "v1" }])),
    ).toThrow(/persona must be one of/);
  });

  it("rejects an empty (or whitespace-only) voiceId", () => {
    expect(() =>
      parseGatewayConfig(ttsProviderRaw("keiko-tts", [{ persona: "male", voiceId: "" }])),
    ).toThrow(/voiceId must be a non-empty string/);
    expect(() =>
      parseGatewayConfig(ttsProviderRaw("keiko-tts", [{ persona: "male", voiceId: "   " }])),
    ).toThrow(/voiceId must be a non-empty string/);
  });

  it("rejects a non-object voiceProfiles entry", () => {
    expect(() => parseGatewayConfig(ttsProviderRaw("keiko-tts", ["not-an-object"]))).toThrow(
      /must be an object/,
    );
  });

  it("rejects a non-array voiceProfiles", () => {
    expect(() =>
      parseGatewayConfig(
        rawWithProvider((p) => ({
          ...p,
          modelId: "keiko-tts",
          capability: ttsCapabilityBody(),
          voiceProfiles: { persona: "male", voiceId: "v1" },
        })),
      ),
    ).toThrow(/voiceProfiles must be an array/);
  });

  it("rejects a duplicate persona", () => {
    expect(() =>
      parseGatewayConfig(
        ttsProviderRaw("keiko-tts", [
          { persona: "male", voiceId: "v1" },
          { persona: "male", voiceId: "v2" },
        ]),
      ),
    ).toThrow(/declares persona "male" more than once/);
  });

  it("rejects voiceProfiles on an STT-only provider (personas are output voices)", () => {
    expect(() =>
      parseGatewayConfig(
        rawWithProvider((p) => ({
          ...p,
          modelId: "keiko-stt",
          capability: {
            kind: "voice",
            supportsSpeechInput: true,
            voiceProviderLocality: "azure-foundry",
          },
          voiceProfiles: [{ persona: "male", voiceId: "v1" }],
        })),
      ),
    ).toThrow(/voiceProfiles requires a kind:"voice" capability that advertises/);
  });

  it("rejects voiceProfiles on a non-voice (chat) provider", () => {
    expect(() =>
      parseGatewayConfig(
        rawWithProvider((p) => ({
          ...p,
          modelId: "chat-model",
          capability: { kind: "chat", contextWindow: 8_192 },
          voiceProfiles: [{ persona: "male", voiceId: "v1" }],
        })),
      ),
    ).toThrow(/voiceProfiles requires a kind:"voice" capability that advertises/);
  });

  it("rejects voiceProfiles on a provider with NO declared capability", () => {
    expect(() =>
      parseGatewayConfig(
        rawWithProvider((p) => ({
          ...p,
          modelId: "no-capability",
          voiceProfiles: [{ persona: "male", voiceId: "v1" }],
        })),
      ),
    ).toThrow(/voiceProfiles requires a kind:"voice" capability that advertises/);
  });

  it("accepts voiceProfiles on a realtime provider (realtime counts as output)", () => {
    const config = parseGatewayConfig(
      ttsProviderRaw("keiko-realtime", [{ persona: "neutral", voiceId: "voice-neutral-01" }], {
        supportsSpeechOutput: false,
        supportsSpeechInput: true,
        supportsRealtimeVoice: true,
      }),
    );
    const cap = config.capabilities?.find((c) => c.id === "keiko-realtime");
    expect(cap?.supportedVoicePersonas).toEqual(["neutral"]);
  });

  // HAZARD-1: derivation must target the MERGED (effective) capability. A top-level `capabilities`
  // entry overrides the inline one for the same modelId; personas attach to that override.
  it("derives personas onto the inline capability when there is no override", () => {
    const config = parseGatewayConfig(
      ttsProviderRaw("keiko-tts", [{ persona: "male", voiceId: "v-male" }]),
    );
    const cap = config.capabilities?.find((c) => c.id === "keiko-tts");
    expect(cap?.supportedVoicePersonas).toEqual(["male"]);
    // The override path is exercised by the next test.
  });

  it("derives personas onto the TOP-LEVEL override capability (merged, not inline) [HAZARD-1]", () => {
    const base = ttsProviderRaw("keiko-tts", [{ persona: "female", voiceId: "v-female" }]);
    const raw = {
      ...(base as Record<string, unknown>),
      // A top-level capabilities entry for the SAME id overrides the inline one. It is the effective
      // capability the personas must attach to. It still advertises speech output (else rejected).
      capabilities: [
        {
          id: "keiko-tts",
          kind: "voice",
          contextWindow: 0,
          maxOutputTokens: 0,
          toolCalling: false,
          structuredOutput: false,
          streaming: false,
          supportsImageInput: false,
          supportsDocumentInput: false,
          supportsSpeechOutput: true,
          voiceProviderLocality: "local-only",
          workflowEligible: false,
          costClass: "high",
          latencyClass: "slow",
          throughputHint: "override tts",
          preferredUseCases: ["Speech output"],
          knownLimitations: ["overridden"],
        },
      ],
    };
    const config = parseGatewayConfig(raw);
    const cap = config.capabilities?.find((c) => c.id === "keiko-tts");
    // The override's distinctive fields prove it is the merged capability, and personas attached.
    expect(cap?.voiceProviderLocality).toBe("local-only");
    expect(cap?.costClass).toBe("high");
    expect(cap?.supportedVoicePersonas).toEqual(["female"]);
  });

  it("rejects voiceProfiles when the TOP-LEVEL override drops speech output [HAZARD-1]", () => {
    const base = ttsProviderRaw("keiko-tts", [{ persona: "female", voiceId: "v-female" }]);
    const raw = {
      ...(base as Record<string, unknown>),
      // Override turns the voice capability into STT-only — the personas now have no output surface,
      // so derivation against the MERGED capability must reject (proving it is not the inline one).
      capabilities: [
        {
          id: "keiko-tts",
          kind: "voice",
          contextWindow: 0,
          maxOutputTokens: 0,
          toolCalling: false,
          structuredOutput: false,
          streaming: false,
          supportsImageInput: false,
          supportsDocumentInput: false,
          supportsSpeechInput: true,
          voiceProviderLocality: "local-only",
          workflowEligible: false,
          costClass: "low",
          latencyClass: "fast",
          throughputHint: "override stt",
          preferredUseCases: ["Dictation"],
          knownLimitations: ["overridden"],
        },
      ],
    };
    expect(() => parseGatewayConfig(raw)).toThrow(
      /voiceProfiles requires a kind:"voice" capability that advertises/,
    );
  });

  // AC2: all five deployment classes representable by modelId + flags + voiceProfiles, no hard-coded
  // deployment names anywhere in the parser.
  it("represents all five deployment classes by modelId (AC2, no hard-coding)", () => {
    const raw = {
      providers: [
        {
          ...validProvider(),
          modelId: "keiko-stt",
          capability: {
            kind: "voice",
            supportsSpeechInput: true,
            voiceProviderLocality: "azure-foundry",
          },
        },
        {
          ...validProvider(),
          modelId: "keiko-tts",
          capability: ttsCapabilityBody(),
          voiceProfiles: [{ persona: "neutral", voiceId: "tts-neutral" }],
        },
        {
          ...validProvider(),
          modelId: "keiko-audio-output",
          capability: ttsCapabilityBody({ voiceProviderLocality: "local-only" }),
          voiceProfiles: [{ persona: "female", voiceId: "audio-female" }],
        },
        {
          ...validProvider(),
          modelId: "keiko-realtime",
          capability: {
            kind: "voice",
            supportsRealtimeVoice: true,
            voiceProviderLocality: "customer-hosted",
          },
          voiceProfiles: [{ persona: "male", voiceId: "rt-male" }],
        },
        {
          ...validProvider(),
          modelId: "keiko-realtime-stt",
          capability: {
            kind: "voice",
            supportsSpeechInput: true,
            supportsRealtimeVoice: true,
            voiceProviderLocality: "customer-hosted",
          },
          voiceProfiles: [{ persona: "neutral", voiceId: "rtstt-neutral" }],
        },
      ],
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30000, halfOpenProbes: 2 },
    };
    const config = parseGatewayConfig(raw);
    expect(config.providers.map((p) => p.modelId)).toEqual([
      "keiko-stt",
      "keiko-tts",
      "keiko-audio-output",
      "keiko-realtime",
      "keiko-realtime-stt",
    ]);
    // STT-only carries no personas; the four output-capable ones do.
    expect(
      config.capabilities?.find((c) => c.id === "keiko-stt")?.supportedVoicePersonas,
    ).toBeUndefined();
    expect(config.capabilities?.find((c) => c.id === "keiko-tts")?.supportedVoicePersonas).toEqual([
      "neutral",
    ]);
    expect(
      config.capabilities?.find((c) => c.id === "keiko-realtime")?.supportedVoicePersonas,
    ).toEqual(["male"]);
  });

  it("rejects supportedVoicePersonas as a raw INPUT key on the strict capability parser", () => {
    const raw = { ...validVoiceCapability(), supportedVoicePersonas: ["male"] };
    expect(() => parseModelCapability(raw, "capabilities[0]")).toThrow(
      /supportedVoicePersonas is not a recognised capability field/,
    );
  });
});

describe("parseCapabilityList", () => {
  it("returns parsed entries in declaration order", () => {
    const raw = [
      { ...validCapability(), id: "first" },
      { ...validCapability(), id: "second" },
      { ...validCapability(), id: "third" },
    ];
    const parsed = parseCapabilityList(raw, "capabilities");
    expect(parsed.map((c) => c.id)).toEqual(["first", "second", "third"]);
  });

  it("rejects the whole list when any single entry is malformed (no partial acceptance)", () => {
    const raw = [
      { ...validCapability(), id: "ok" },
      { ...validCapability(), id: "bad", kind: "unknown-kind" },
      { ...validCapability(), id: "alsoOk" },
    ];
    try {
      parseCapabilityList(raw, "capabilities");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).toContain("capabilities[1].kind");
    }
  });

  it("rejects a non-array input", () => {
    expect(() => parseCapabilityList({ not: "an array" }, "capabilities")).toThrow(
      ConfigInvalidError,
    );
  });

  it("returns an empty list for an empty array", () => {
    expect(parseCapabilityList([], "capabilities")).toEqual([]);
  });
});

describe("parseGatewayConfig top-level capabilities array", () => {
  it("validates a top-level capabilities array through parseCapabilityList", () => {
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      capabilities: [{ ...validCapability(), id: "example-chat-model" }],
    };
    const config = parseGatewayConfig(raw);
    expect(config.capabilities?.[0]?.id).toBe("example-chat-model");
    expect(config.capabilities?.[0]?.supportsImageInput).toBe(false);
  });

  it("rejects a malformed top-level capabilities array without echoing the apiKey", () => {
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      capabilities: [{ ...validCapability(), kind: "unknown-kind" }],
    };
    try {
      parseGatewayConfig(raw);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).not.toContain("example-test-token-1234567890");
    }
  });

  it("prefers a top-level capability over an inline provider capability with the same id", () => {
    const raw = rawWithProvider((p) => ({
      ...p,
      modelId: "example-private-chat",
      capability: {
        kind: "chat",
        toolCalling: false,
        structuredOutput: false,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: false,
        preferredUseCases: ["Inline default"],
        knownLimitations: ["inline"],
      },
    })) as Record<string, unknown>;
    raw.capabilities = [
      {
        ...validCapability(),
        id: "example-private-chat",
        toolCalling: true,
        structuredOutput: true,
        supportsImageInput: true,
        supportsDocumentInput: true,
        workflowEligible: true,
        preferredUseCases: ["Top-level explicit"],
        knownLimitations: ["top-level"],
      },
    ];

    const config = parseGatewayConfig(raw);
    expect(config.capabilities).toHaveLength(1);
    expect(config.capabilities?.[0]).toMatchObject({
      id: "example-private-chat",
      toolCalling: true,
      structuredOutput: true,
      supportsImageInput: true,
      supportsDocumentInput: true,
      workflowEligible: true,
      preferredUseCases: ["Top-level explicit"],
      knownLimitations: ["top-level"],
    });
  });
});

describe("parseGatewayConfig grounding block", () => {
  it("grounding is undefined when the block is absent (no-config behaviour unchanged)", () => {
    const config = parseGatewayConfig(validRaw());
    expect(config.grounding).toBeUndefined();
  });

  it("parses a valid grounding block with a single positive-integer field", () => {
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      grounding: { maxConnectedSources: 4 },
    };
    const config = parseGatewayConfig(raw);
    expect(config.grounding?.maxConnectedSources).toBe(4);
  });

  it("parses all grounding fields when all are provided as positive integers", () => {
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      grounding: {
        maxConnectedSources: 8,
        maxLocalKnowledgeSources: 8,
        maxPromptReferences: 4,
        maxExcerptChars: 500,
        referenceBudget: 5,
        hybridMaxCandidates: 12,
        hybridMaxExcerptBytes: 65536,
      },
    };
    const config = parseGatewayConfig(raw);
    expect(config.grounding?.maxConnectedSources).toBe(8);
    expect(config.grounding?.maxLocalKnowledgeSources).toBe(8);
    expect(config.grounding?.maxPromptReferences).toBe(4);
    expect(config.grounding?.maxExcerptChars).toBe(500);
    expect(config.grounding?.referenceBudget).toBe(5);
    expect(config.grounding?.hybridMaxCandidates).toBe(12);
    expect(config.grounding?.hybridMaxExcerptBytes).toBe(65536);
  });

  it("clamps an over-ceiling value (9999) to the ceiling (64) rather than rejecting it", () => {
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      grounding: { maxConnectedSources: 9999 },
    };
    const config = parseGatewayConfig(raw);
    expect(config.grounding?.maxConnectedSources).toBe(64);
  });

  it("throws ConfigInvalidError for a non-integer grounding field (1.5)", () => {
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      grounding: { maxConnectedSources: 1.5 },
    };
    expect(() => parseGatewayConfig(raw)).toThrow(ConfigInvalidError);
    expect(() => parseGatewayConfig(raw)).toThrow(/grounding\.maxConnectedSources/);
  });

  it("throws ConfigInvalidError for a zero grounding field (not positive)", () => {
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      grounding: { referenceBudget: 0 },
    };
    expect(() => parseGatewayConfig(raw)).toThrow(ConfigInvalidError);
    expect(() => parseGatewayConfig(raw)).toThrow(/grounding\.referenceBudget/);
  });

  it("throws ConfigInvalidError for a negative grounding field", () => {
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      grounding: { maxPromptReferences: -5 },
    };
    expect(() => parseGatewayConfig(raw)).toThrow(ConfigInvalidError);
  });

  it("ignores unknown keys in the grounding block (forward-compat)", () => {
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      grounding: { maxConnectedSources: 4, unknownFutureKey: 99 },
    };
    expect(() => parseGatewayConfig(raw)).not.toThrow();
    const config = parseGatewayConfig(raw);
    expect(config.grounding?.maxConnectedSources).toBe(4);
  });
});

describe("toSafeObject grounding field", () => {
  it("includes resolved grounding limits when the config has a grounding block", () => {
    const raw = {
      ...(validRaw() as Record<string, unknown>),
      grounding: { maxConnectedSources: 4 },
    };
    const config = parseGatewayConfig(raw);
    const safe = toSafeObject(config);
    expect(safe.grounding?.maxConnectedSources).toBe(4);
  });

  it("omits grounding from the safe object when no grounding block was configured", () => {
    const config = parseGatewayConfig(validRaw());
    const safe = toSafeObject(config);
    expect(safe.grounding).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(safe, "grounding")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseEnvEgressConfigFaultTolerant — per-field independent parsing
// ---------------------------------------------------------------------------

describe("parseEnvEgressConfigFaultTolerant", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty object when no egress env vars are set", () => {
    const result = parseEnvEgressConfigFaultTolerant({});
    expect(result).toEqual({});
  });

  it("parses valid env vars into an egress config", () => {
    const result = parseEnvEgressConfigFaultTolerant({
      KEIKO_HTTP_PROXY: "http://proxy.example.invalid:8080",
      KEIKO_CA_BUNDLE_PATH: "/etc/keiko/corp.pem",
    });
    expect(result.httpProxy).toBe("http://proxy.example.invalid:8080/");
    expect(result.caBundlePath).toBe("/etc/keiko/corp.pem");
  });

  it("a malformed HTTPS_PROXY does NOT discard a valid caBundlePath", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = parseEnvEgressConfigFaultTolerant({
      HTTPS_PROXY: "http://user:pass@proxy.example.invalid:8080",
      KEIKO_CA_BUNDLE_PATH: "/etc/keiko/corp.pem",
    });
    expect(result.caBundlePath).toBe("/etc/keiko/corp.pem");
    expect(result.httpsProxy).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    // Warning must name the var, never the value (may contain password)
    expect(warn.mock.calls[0]?.[0]).toContain("HTTPS_PROXY");
    expect(warn.mock.calls[0]?.[0]).not.toContain("pass");
  });

  it("a malformed HTTP_PROXY does NOT discard a valid noProxy setting", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = parseEnvEgressConfigFaultTolerant({
      HTTP_PROXY: "ftp://proxy.example.invalid",
      NO_PROXY: "localhost,127.0.0.1",
    });
    expect(result.httpProxy).toBeUndefined();
    expect(result.noProxy).toEqual(["localhost", "127.0.0.1"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("HTTP_PROXY");
  });

  it("a credentialed HTTPS_PROXY is logged by var name only (no credentials in warning)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    parseEnvEgressConfigFaultTolerant({
      HTTPS_PROXY: "http://user:supersecret@corp-proxy:8080",
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).not.toContain("supersecret");
    expect(warn.mock.calls[0]?.[0]).not.toContain("user");
    expect(warn.mock.calls[0]?.[0]).toContain("HTTPS_PROXY");
  });

  it("KEIKO_* vars take precedence over standard env vars", () => {
    const result = parseEnvEgressConfigFaultTolerant({
      KEIKO_HTTP_PROXY: "http://keiko-proxy.invalid:8080",
      HTTP_PROXY: "http://standard-proxy.invalid:8080",
    });
    expect(result.httpProxy).toBe("http://keiko-proxy.invalid:8080/");
  });

  it("parses KEIKO_NO_PROXY as a comma-separated string", () => {
    const result = parseEnvEgressConfigFaultTolerant({
      KEIKO_NO_PROXY: "localhost, 127.0.0.1, .corp.example",
    });
    expect(result.noProxy).toEqual(["localhost", "127.0.0.1", ".corp.example"]);
  });
});

describe("secret-reference resolution (#1320)", () => {
  // Minimal raw provider that needs no apiKey in the file (uses secretRef or env).
  function secretRefProvider(
    modelId: string,
    apiKeySecretRef: string,
    apiKey?: string,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      modelId,
      baseUrl: "https://gw.example.com",
      apiKeySecretRef,
    };
    if (apiKey !== undefined) {
      base.apiKey = apiKey;
    }
    return base;
  }

  // Minimal raw provider with a file apiKey and no secretRef.
  function fileKeyProvider(modelId: string, apiKey: string): Record<string, unknown> {
    return { modelId, baseUrl: "https://gw.example.com", apiKey };
  }

  function wrapProviders(...providers: readonly Record<string, unknown>[]): unknown {
    return { providers };
  }

  // 1. Vault resolves: secretRef present, no file apiKey; resolver returns the vault value.
  it("resolves apiKey from the secretResolver when apiKeySecretRef is present and no file apiKey is set", () => {
    const options: ParseGatewayConfigOptions = {
      secretResolver: (ref) => (ref === "cred:m1" ? "vault-key" : undefined),
    };
    const raw = wrapProviders(secretRefProvider("m1", "cred:m1"));
    const config = parseGatewayConfig(raw, {}, options);
    expect(config.providers[0]?.apiKey).toBe("vault-key");
  });

  // 2. Per-model env beats vault: KEIKO_MODEL_M1_API_KEY overrides apiKeySecretRef.
  it("per-model env KEIKO_MODEL_<TOKEN>_API_KEY beats secretResolver (highest precedence)", () => {
    const options: ParseGatewayConfigOptions = {
      secretResolver: (ref) => (ref === "cred:m1" ? "vault-key" : undefined),
    };
    const raw = wrapProviders(secretRefProvider("m1", "cred:m1"));
    const config = parseGatewayConfig(raw, { KEIKO_MODEL_M1_API_KEY: "env-key" }, options);
    expect(config.providers[0]?.apiKey).toBe("env-key");
  });

  // 3. Vault beats file plaintext: when both apiKeySecretRef and apiKey are present, vault wins.
  it("secretResolver result beats a file plaintext apiKey", () => {
    const options: ParseGatewayConfigOptions = {
      secretResolver: (ref) => (ref === "cred:m1" ? "vault-key" : undefined),
    };
    const raw = wrapProviders(secretRefProvider("m1", "cred:m1", "file-key"));
    const config = parseGatewayConfig(raw, {}, options);
    expect(config.providers[0]?.apiKey).toBe("vault-key");
  });

  // 4. File plaintext used when resolver returns undefined (no vault available or ref unknown).
  it("falls back to file plaintext apiKey when secretResolver returns undefined", () => {
    const options: ParseGatewayConfigOptions = {
      secretResolver: (_ref) => undefined,
    };
    const raw = wrapProviders(secretRefProvider("m1", "cred:m1", "file-key"));
    const config = parseGatewayConfig(raw, {}, options);
    expect(config.providers[0]?.apiKey).toBe("file-key");
  });

  // 4b. File plaintext used when no options are passed at all (no secretResolver).
  it("falls back to file plaintext apiKey when no options are provided", () => {
    const raw = wrapProviders(secretRefProvider("m1", "cred:m1", "file-key"));
    const config = parseGatewayConfig(raw, {});
    expect(config.providers[0]?.apiKey).toBe("file-key");
  });

  // 5. Default env fallback: secretRef present, resolver returns undefined, no file apiKey.
  it("falls back to KEIKO_DEFAULT_API_KEY when secretResolver returns undefined and no file apiKey exists", () => {
    const options: ParseGatewayConfigOptions = {
      secretResolver: (_ref) => undefined,
    };
    const raw = wrapProviders(secretRefProvider("m1", "cred:m1"));
    const config = parseGatewayConfig(raw, { KEIKO_DEFAULT_API_KEY: "default-key" }, options);
    expect(config.providers[0]?.apiKey).toBe("default-key");
  });

  // 6. Missing everywhere throws ConfigInvalidError mentioning apiKey.
  it("throws ConfigInvalidError when no credential source resolves the apiKey", () => {
    const options: ParseGatewayConfigOptions = {
      secretResolver: (_ref) => undefined,
    };
    const raw = wrapProviders(secretRefProvider("m1", "cred:m1"));
    try {
      parseGatewayConfig(raw, {}, options);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as ConfigInvalidError).message).toContain("apiKey");
    }
  });

  // 7a. Resolver that throws degrades gracefully when a file apiKey is available.
  it("treats a throwing secretResolver as undefined and falls back to file apiKey", () => {
    const options: ParseGatewayConfigOptions = {
      secretResolver: (_ref) => {
        throw new Error("vault locked");
      },
    };
    const raw = wrapProviders(secretRefProvider("m1", "cred:m1", "file-key"));
    const config = parseGatewayConfig(raw, {}, options);
    expect(config.providers[0]?.apiKey).toBe("file-key");
  });

  // 7b. Resolver that throws with no other source → ConfigInvalidError, not the raw vault error.
  it("throws ConfigInvalidError (not the resolver error) when resolver throws and no other source resolves", () => {
    const options: ParseGatewayConfigOptions = {
      secretResolver: (_ref) => {
        throw new Error("vault locked");
      },
    };
    const raw = wrapProviders(secretRefProvider("m1", "cred:m1"));
    try {
      parseGatewayConfig(raw, {}, options);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigInvalidError);
      expect((error as Error).message).not.toContain("vault locked");
      expect((error as ConfigInvalidError).message).toContain("apiKey");
    }
  });

  // 8. loadConfigFromFile forwards ParseGatewayConfigOptions to parseGatewayConfig.
  describe("loadConfigFromFile forwards options", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "keiko-secret-ref-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("resolves apiKeySecretRef via secretResolver injected through loadConfigFromFile options", () => {
      const configPath = join(dir, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({ providers: [secretRefProvider("vault-model", "cred:vm")] }),
        "utf8",
      );
      const options: ParseGatewayConfigOptions = {
        secretResolver: (ref) => (ref === "cred:vm" ? "injected-vault-key" : undefined),
      };
      const config = loadConfigFromFile(configPath, {}, options);
      expect(config.providers[0]?.apiKey).toBe("injected-vault-key");
    });
  });

  // 9. toSafeObject excludes apiKeySecretRef and the resolved key entirely.
  it("toSafeObject omits apiKeySecretRef, the credential reference value, and the resolved key", () => {
    const options: ParseGatewayConfigOptions = {
      secretResolver: (ref) => (ref === "cred:m1" ? "resolved-vault-key" : undefined),
    };
    const raw = wrapProviders(secretRefProvider("m1", "cred:m1"));
    const config = parseGatewayConfig(raw, {}, options);
    const serialised = JSON.stringify(toSafeObject(config));
    expect(serialised).not.toContain("apiKeySecretRef");
    expect(serialised).not.toContain("cred:");
    expect(serialised).not.toContain("resolved-vault-key");
  });

  // Mutation guard: verify the resolver is actually called with the exact reference string.
  it("calls secretResolver with the exact apiKeySecretRef string from the raw config", () => {
    const calls: string[] = [];
    const options: ParseGatewayConfigOptions = {
      secretResolver: (ref) => {
        calls.push(ref);
        return "spy-key";
      },
    };
    const raw = wrapProviders(secretRefProvider("m1", "cred:exact-ref"));
    parseGatewayConfig(raw, {}, options);
    expect(calls).toEqual(["cred:exact-ref"]);
  });

  // Mutation guard: empty string secretRef must not invoke the resolver (treated as absent).
  it("does not invoke secretResolver when apiKeySecretRef is an empty string", () => {
    let called = false;
    const options: ParseGatewayConfigOptions = {
      secretResolver: (_ref) => {
        called = true;
        return "should-not-be-used";
      },
    };
    const raw = wrapProviders({ ...fileKeyProvider("m1", "file-key"), apiKeySecretRef: "" });
    const config = parseGatewayConfig(raw, {}, options);
    expect(called).toBe(false);
    expect(config.providers[0]?.apiKey).toBe("file-key");
  });
});
