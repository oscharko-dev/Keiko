import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";

import type { UiHandlerDeps } from "../deps.js";
import { modelIdEvidence, resolvedModelCapability } from "./model-id-evidence.js";

function provider(modelId: string): GatewayConfig["providers"][number] {
  return {
    modelId,
    baseUrl: "https://provider.example.invalid/v1",
    apiKey: "fake-test-key",
    timeoutMs: 5_000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
  };
}

function depsWithConfiguredProvider(modelId: string): UiHandlerDeps {
  return { config: { providers: [provider(modelId)] } } as unknown as UiHandlerDeps;
}

// #3557 review: a model id reaches the Activity Log only as a digest. A request-supplied id is
// caller content, and a configured one is operator-chosen text: an operator can name a provider
// entry "patient-Alice-Jones", and neither the configured-model check nor the opaque-id shape
// check proves such a value body-free.
describe("modelIdEvidence — the owning projection from a candidate model id to evidence", () => {
  it.each([
    ["an operator-configured id", "patient-Alice-Jones"],
    ["a request id no gateway configures", "typo-model-a"],
    ["an id that fails the opaque-id shape", "alice@example.com"],
  ])("digests %s and never carries the raw value", (_label, modelId) => {
    const evidence = modelIdEvidence(modelId);

    expect(evidence).toEqual({ modelIdDigest: expect.stringMatching(/^[a-f0-9]{16}$/) as unknown });
    expect(JSON.stringify(evidence)).not.toContain(modelId);
  });

  it("tells two candidates apart and a retried one as the same", () => {
    const first = modelIdEvidence("typo-model-a");

    expect(modelIdEvidence("typo-model-b").modelIdDigest).not.toBe(first.modelIdDigest);
    expect(modelIdEvidence("typo-model-a")).toEqual(first);
  });

  // A truncated id would make two long ids sharing a prefix indistinguishable.
  it("digests a long id whole, so two ids sharing a long prefix stay apart", () => {
    const first = modelIdEvidence(`model-${"x".repeat(300)}-a`);
    const second = modelIdEvidence(`model-${"x".repeat(300)}-b`);

    expect(second.modelIdDigest).not.toBe(first.modelIdDigest);
  });

  it("yields no evidence for an empty or absent model id", () => {
    expect(modelIdEvidence("")).toEqual({});
    expect(modelIdEvidence(undefined)).toEqual({});
  });
});

describe("resolvedModelCapability — the shared capability resolution", () => {
  it("resolves a configured model id to its capability", () => {
    const deps = depsWithConfiguredProvider("breaker-chat");
    expect(resolvedModelCapability(deps, "breaker-chat")?.id).toBe("breaker-chat");
  });

  it("resolves an unconfigured model id to undefined", () => {
    const deps = depsWithConfiguredProvider("breaker-chat");
    expect(resolvedModelCapability(deps, "not-configured")).toBeUndefined();
  });
});
