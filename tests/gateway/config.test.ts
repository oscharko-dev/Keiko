import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigInvalidError } from "../../src/gateway/errors.js";
import { loadConfigFromFile, parseGatewayConfig, toSafeObject } from "../../src/gateway/config.js";

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
  it("parses a structurally valid config", () => {
    const config = parseGatewayConfig(validRaw());
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.modelId).toBe("example-chat-model");
    expect(config.providers[0]?.apiKeyHeaderName).toBe("authorization");
    expect(config.circuitBreaker.failureThreshold).toBe(5);
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

  it("rejects custom capability metadata whose id differs from the provider modelId", () => {
    const raw = rawWithProvider((p) => ({
      ...p,
      modelId: "example-private-chat",
      capability: { id: "other-model", kind: "chat" },
    }));
    expect(() => parseGatewayConfig(raw)).toThrow(/capability\.id/);
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
});
