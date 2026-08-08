import { describe, expect, it } from "vitest";
import {
  appliedGatewayConfigFieldCount,
  parseGatewayConfigUpload,
  type GatewayConfigUploadFields,
} from "./gatewayConfigParsing";

function providerFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelId: "gpt-5o",
    baseUrl: "https://llm-gateway.example.com/v1",
    apiKeyHeaderName: "api-key",
    timeoutMs: 30_000,
    maxRetries: 2,
    retryBaseDelayMs: 250,
    capability: {
      id: "gpt-5o",
      kind: "chat",
      supportsImageInput: true,
      workflowEligible: true,
    },
    ...overrides,
  };
}

function fieldsOf(serialized: string): GatewayConfigUploadFields {
  const result = parseGatewayConfigUpload(serialized);
  if (result.outcome !== "fields") throw new Error(`expected fields, got ${result.outcome}`);
  return result.fields;
}

describe("parseGatewayConfigUpload", () => {
  it("maps the documented keiko.config.json shape onto the form fields", () => {
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture(),
          providerFixture({
            modelId: "text-embed",
            capability: { id: "text-embed", kind: "embedding" },
          }),
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
        capabilities: [{ id: "text-embed", kind: "embedding", supportsImageInput: true }],
      }),
    );

    expect(fields).toEqual({
      baseUrl: "https://llm-gateway.example.com/v1",
      apiKey: undefined,
      apiKeyHeaderName: "api-key",
      timeoutMs: "30000",
      deploymentNames: ["gpt-5o", "text-embed"],
      imageInputModelIds: ["gpt-5o", "text-embed"],
      workflowEligibleModelIds: ["gpt-5o"],
      figmaAccessToken: undefined,
    });
  });

  it("passes an optional per-provider apiKey through for prefill", () => {
    const fields = fieldsOf(
      JSON.stringify({ providers: [providerFixture({ apiKey: "placeholder-secret" })] }),
    );

    expect(fields.apiKey).toBe("placeholder-secret");
  });

  it("rejects providers that disagree on any connection scalar instead of flattening them", () => {
    // Review finding on #3031: the form holds one connection; testing every model against the
    // first provider's endpoint would silently rewrite the others.
    const conflicting = JSON.stringify({
      providers: [
        providerFixture(),
        providerFixture({ modelId: "other", baseUrl: "https://different.example.com/v1" }),
      ],
    });

    expect(parseGatewayConfigUpload(conflicting)).toEqual({ outcome: "invalid" });
  });

  it("treats identical repeated scalars as one connection", () => {
    const fields = fieldsOf(
      JSON.stringify({ providers: [providerFixture(), providerFixture({ modelId: "second" })] }),
    );

    expect(fields.baseUrl).toBe("https://llm-gateway.example.com/v1");
    expect(fields.deploymentNames).toEqual(["gpt-5o", "second"]);
  });

  it("applies an explicitly empty eligibility declaration as an empty list, not silence", () => {
    // Review finding on #3031: a file whose capabilities declare NO eligible model must clear
    // the form field, exactly like manually emptying it.
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture({
            capability: { id: "gpt-5o", kind: "chat", workflowEligible: false },
          }),
        ],
      }),
    );

    expect(fields.workflowEligibleModelIds).toEqual([]);
    expect(fields.imageInputModelIds).toEqual([]);
  });

  it("leaves the flag lists undefined when the file carries no capability record at all", () => {
    const fields = fieldsOf(
      JSON.stringify({ providers: [{ modelId: "gpt-5o", baseUrl: "https://x.example.com" }] }),
    );

    expect(fields.workflowEligibleModelIds).toBeUndefined();
    expect(fields.imageInputModelIds).toBeUndefined();
  });

  it("lets an authoritative top-level capability override an inline declaration", () => {
    // Review finding on #3031: production configuration parsing resolves capabilities by model
    // id with top-level records overriding inline ones — the importer must agree.
    const fields = fieldsOf(
      JSON.stringify({
        providers: [providerFixture()],
        capabilities: [
          { id: "gpt-5o", kind: "chat", supportsImageInput: false, workflowEligible: false },
        ],
      }),
    );

    expect(fields.workflowEligibleModelIds).toEqual([]);
    expect(fields.imageInputModelIds).toEqual([]);
  });

  it("refuses voice and OCR providers the generic deployment list cannot represent", () => {
    // Review finding on #3031: dedicated setup fields exist for these kinds; importing them as
    // generic deployments would persist the wrong capability kind.
    const voice = JSON.stringify({
      providers: [
        providerFixture(),
        providerFixture({ modelId: "tts", capability: { id: "tts", kind: "voice" } }),
      ],
    });

    expect(parseGatewayConfigUpload(voice)).toEqual({ outcome: "unsupportedKind" });
  });

  it("carries a supported Figma credential through for prefill", () => {
    // Review finding on #3031: the setup form owns a Figma token field, so a file that carries
    // one must fill it instead of silently dropping the connector credential.
    const fields = fieldsOf(
      JSON.stringify({
        providers: [providerFixture()],
        figma: { accessToken: "figma-placeholder-token" },
      }),
    );

    expect(fields.figmaAccessToken).toBe("figma-placeholder-token");
    expect(appliedGatewayConfigFieldCount(fields)).toBe(7);
  });

  it("rejects a malformed top-level capability record instead of skipping it", () => {
    // Review finding on #3031: the same fail-closed policy as the provider list — hostile or
    // corrupted capability entries must not be silently dropped from a "successful" load.
    const malformed = JSON.stringify({
      providers: [providerFixture()],
      capabilities: ["not-an-object"],
    });

    expect(parseGatewayConfigUpload(malformed)).toEqual({ outcome: "invalid" });
  });

  it("rejects a top-level capability whose id no imported provider carries", () => {
    // Review finding on #3031: an untestable id in the flag lists would fail Test & Save AFTER
    // the upload reported success.
    const orphan = JSON.stringify({
      providers: [providerFixture()],
      capabilities: [{ id: "vision-x", kind: "chat", supportsImageInput: true }],
    });

    expect(parseGatewayConfigUpload(orphan)).toEqual({ outcome: "invalid" });
  });

  it("rejects a present-but-malformed inline capability instead of treating it as absent", () => {
    // Review finding on #3031: the production parser rejects the same corrupted shape; only a
    // truly ABSENT capability field means "no declaration".
    const malformed = JSON.stringify({
      providers: [providerFixture({ capability: "not-an-object" })],
    });

    expect(parseGatewayConfigUpload(malformed)).toEqual({ outcome: "invalid" });
  });

  it("mirrors the setup route's 100-provider ceiling at upload time", () => {
    // Review finding on #3031: an oversized file must fail here, not at Test & Save after a
    // reported success.
    const oversized = JSON.stringify({
      providers: Array.from({ length: 101 }, (_, index) =>
        providerFixture({ modelId: `model-${String(index)}`, capability: undefined }),
      ),
    });

    expect(parseGatewayConfigUpload(oversized)).toEqual({ outcome: "invalid" });
  });

  it("refuses provider settings the form cannot represent with an honest outcome", () => {
    // Review finding on #3031: endpoint style / API version / output token parameter would be
    // silently rebuilt with defaults — a changed runtime configuration behind a success message.
    const azure = JSON.stringify({
      providers: [providerFixture({ endpointStyle: "azure-openai-deployment" })],
    });

    expect(parseGatewayConfigUpload(azure)).toEqual({ outcome: "unsupportedSetting" });
    // Retry tuning stays tolerated: it changes no endpoint or protocol.
    const retries = JSON.stringify({ providers: [providerFixture({ maxRetries: 7 })] });
    expect(parseGatewayConfigUpload(retries).outcome).toBe("fields");
  });

  it.each([
    ["not JSON at all", "{ nope"],
    ["a JSON scalar", JSON.stringify("hello")],
    ["a JSON array root", JSON.stringify([])],
    ["an object without providers", JSON.stringify({ circuitBreaker: {} })],
    ["an empty providers array", JSON.stringify({ providers: [] })],
    ["a provider without a modelId", JSON.stringify({ providers: [{ baseUrl: "https://x" }] })],
    [
      "a provider list with one malformed entry (fail closed, no partial apply)",
      JSON.stringify({ providers: [providerFixture(), { modelId: 42 }] }),
    ],
    [
      "an unknown capability kind",
      JSON.stringify({
        providers: [providerFixture({ capability: { id: "gpt-5o", kind: "quantum" } })],
      }),
    ],
  ])("refuses %s", (_label, serialized) => {
    expect(parseGatewayConfigUpload(serialized)).toEqual({ outcome: "invalid" });
  });

  it("ignores hostile non-string and out-of-range scalar values instead of applying them", () => {
    const fields = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture({
            baseUrl: 42,
            apiKeyHeaderName: ["Authorization"],
            timeoutMs: -5,
            apiKey: { steal: true },
            capability: undefined,
          }),
        ],
      }),
    );

    expect(fields).toEqual({
      baseUrl: undefined,
      apiKey: undefined,
      apiKeyHeaderName: undefined,
      timeoutMs: undefined,
      deploymentNames: ["gpt-5o"],
      imageInputModelIds: undefined,
      workflowEligibleModelIds: undefined,
      figmaAccessToken: undefined,
    });
  });
});

describe("appliedGatewayConfigFieldCount", () => {
  it("counts filled scalars, deployments, and every defined flag list — empty included", () => {
    const fields = fieldsOf(JSON.stringify({ providers: [providerFixture()] }));

    // baseUrl + header + timeout + deployments + image list + workflow list; no apiKey on file.
    expect(appliedGatewayConfigFieldCount(fields)).toBe(6);

    const clearing = fieldsOf(
      JSON.stringify({
        providers: [
          providerFixture({ capability: { id: "gpt-5o", kind: "chat", workflowEligible: false } }),
        ],
      }),
    );
    // The two defined-but-empty lists clear their fields — an applied change, so still 6.
    expect(appliedGatewayConfigFieldCount(clearing)).toBe(6);
  });
});
