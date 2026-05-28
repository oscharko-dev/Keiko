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
    modelId: "gpt-oss-120b",
    baseUrl: "https://host.example/v1",
    apiKey: "sk-secret-key-value-1234567890",
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
    expect(config.providers[0]?.modelId).toBe("gpt-oss-120b");
    expect(config.circuitBreaker.failureThreshold).toBe(5);
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
      expect((error as Error).message).not.toContain("sk-secret-key-value-1234567890");
    }
  });

  it("rejects a non-positive timeoutMs", () => {
    const raw = rawWithProvider((p) => ({ ...p, timeoutMs: -1 }));
    expect(() => parseGatewayConfig(raw)).toThrow(/timeoutMs/);
  });

  it("rejects an empty providers array", () => {
    expect(() => parseGatewayConfig({ providers: [], circuitBreaker: {} })).toThrow(
      ConfigInvalidError,
    );
  });

  it("file apiKey takes precedence over KEIKO_DEFAULT_API_KEY", () => {
    const config = parseGatewayConfig(validRaw(), {
      KEIKO_DEFAULT_API_KEY: "sk-env-default-1234567890abcd",
    });
    expect(config.providers[0]?.apiKey).toBe("sk-secret-key-value-1234567890");
  });

  it("env per-model base url overrides file base url", () => {
    const config = parseGatewayConfig(validRaw(), {
      KEIKO_MODEL_GPT_OSS_120B_BASE_URL: "https://override.example/v1",
    });
    expect(config.providers[0]?.baseUrl).toBe("https://override.example/v1");
  });

  it("env per-model api key overrides file api key", () => {
    const config = parseGatewayConfig(validRaw(), {
      KEIKO_MODEL_GPT_OSS_120B_API_KEY: "sk-per-model-override-1234567890",
    });
    expect(config.providers[0]?.apiKey).toBe("sk-per-model-override-1234567890");
  });

  it("global default fills in a provider with no key from file or per-model env", () => {
    const raw = rawWithProvider(({ apiKey: _drop, ...rest }) => rest);
    const config = parseGatewayConfig(raw, {
      KEIKO_DEFAULT_API_KEY: "sk-env-default-1234567890abcd",
      KEIKO_DEFAULT_BASE_URL: "https://default.example/v1",
    });
    expect(config.providers[0]?.apiKey).toBe("sk-env-default-1234567890abcd");
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

    it("accepts a private/internal IP baseUrl (customer-internal endpoint use case)", () => {
      const raw = rawWithProvider((p) => ({ ...p, baseUrl: "http://10.0.0.5:8000/v1" }));
      expect(() => parseGatewayConfig(raw)).not.toThrow();
    });

    it("accepts a standard https baseUrl", () => {
      const raw = rawWithProvider((p) => ({ ...p, baseUrl: "https://api.example.com/v1" }));
      expect(() => parseGatewayConfig(raw)).not.toThrow();
    });
  });
});

describe("toSafeObject", () => {
  it("omits the apiKey field entirely", () => {
    const config = parseGatewayConfig(validRaw());
    const safe = toSafeObject(config);
    const serialised = JSON.stringify(safe);
    expect(serialised).not.toContain("sk-secret-key-value-1234567890");
    expect(serialised).not.toContain("apiKey");
  });

  it("preserves non-secret fields", () => {
    const config = parseGatewayConfig(validRaw());
    const safe = toSafeObject(config);
    expect(safe.providers[0]?.modelId).toBe("gpt-oss-120b");
    expect(safe.providers[0]?.baseUrl).toBe("https://host.example/v1");
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
    expect(config.providers[0]?.modelId).toBe("gpt-oss-120b");
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
      KEIKO_MODEL_GPT_OSS_120B_API_KEY: "sk-file-load-override-1234567890",
    });
    expect(config.providers[0]?.apiKey).toBe("sk-file-load-override-1234567890");
  });
});
