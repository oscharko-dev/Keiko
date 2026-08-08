import { describe, expect, it } from "vitest";
import { appliedGatewayConfigFieldCount, parseGatewayConfigUpload } from "./gatewayConfigParsing";

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

describe("parseGatewayConfigUpload", () => {
  it("maps the documented keiko.config.json shape onto the form fields", () => {
    const fields = parseGatewayConfigUpload(
      JSON.stringify({
        providers: [
          providerFixture(),
          providerFixture({
            modelId: "text-embed",
            capability: { id: "text-embed", kind: "embed" },
          }),
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 1_000, halfOpenProbes: 1 },
        capabilities: [{ id: "vision-x", supportsImageInput: true }],
      }),
    );

    expect(fields).toEqual({
      baseUrl: "https://llm-gateway.example.com/v1",
      apiKey: undefined,
      apiKeyHeaderName: "api-key",
      timeoutMs: "30000",
      deploymentNames: ["gpt-5o", "text-embed"],
      imageInputModelIds: ["gpt-5o", "vision-x"],
      workflowEligibleModelIds: ["gpt-5o"],
    });
  });

  it("passes an optional per-provider apiKey through for prefill", () => {
    const fields = parseGatewayConfigUpload(
      JSON.stringify({ providers: [providerFixture({ apiKey: "placeholder-secret" })] }),
    );

    expect(fields?.apiKey).toBe("placeholder-secret");
  });

  it("deduplicates model ids across providers and capability entries", () => {
    const fields = parseGatewayConfigUpload(
      JSON.stringify({
        providers: [providerFixture(), providerFixture()],
        capabilities: [{ id: "gpt-5o", supportsImageInput: true, workflowEligible: true }],
      }),
    );

    expect(fields?.deploymentNames).toEqual(["gpt-5o"]);
    expect(fields?.imageInputModelIds).toEqual(["gpt-5o"]);
    expect(fields?.workflowEligibleModelIds).toEqual(["gpt-5o"]);
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
  ])("refuses %s", (_label, serialized) => {
    expect(parseGatewayConfigUpload(serialized)).toBeUndefined();
  });

  it("ignores hostile non-string and out-of-range scalar values instead of applying them", () => {
    const fields = parseGatewayConfigUpload(
      JSON.stringify({
        providers: [
          providerFixture({
            baseUrl: 42,
            apiKeyHeaderName: ["Authorization"],
            timeoutMs: -5,
            apiKey: { steal: true },
            capability: "not-an-object",
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
      imageInputModelIds: [],
      workflowEligibleModelIds: [],
    });
  });
});

describe("appliedGatewayConfigFieldCount", () => {
  it("counts filled scalars and non-empty lists, nothing else", () => {
    const fields = parseGatewayConfigUpload(JSON.stringify({ providers: [providerFixture()] }));
    if (fields === undefined) throw new Error("fixture must parse");

    // baseUrl + header + timeout + deployments + image list + workflow list; no apiKey in the file.
    expect(appliedGatewayConfigFieldCount(fields)).toBe(6);
  });
});
