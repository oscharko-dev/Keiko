// Tests for selectModelForQiCapability (Epic #761, Issue #762).
//
// QI selects models purely by capability — no hard-coded model id. qi:test-design requires a chat
// model with structured-output; a config that cannot satisfy it yields a typed
// QI_CAPABILITY_UNAVAILABLE error rather than a silent fallback.

import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ModelCapability } from "@oscharko-dev/keiko-model-gateway";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import { selectModelForQiCapability } from "../modelSelection.js";
import { QiGenerationError } from "../generationPort.js";

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function capability(id: string, overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: ["Chat"],
    knownLimitations: [],
    ...overrides,
  };
}

function configWith(
  capabilities: readonly ModelCapability[],
): ReturnType<typeof parseGatewayConfig> {
  return parseGatewayConfig(
    {
      providers: capabilities.map((c) => ({
        modelId: c.id,
        baseUrl: "https://fake.example.com/v1",
        apiKey: "fake-key",
        capability: c,
      })),
    },
    {},
  );
}

function depsWith(config: ReturnType<typeof parseGatewayConfig> | undefined): UiHandlerDeps {
  const deps: UiHandlerDeps = {
    config,
    configPresent: config !== undefined,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (_id: string): undefined => undefined,
    store: createInMemoryUiStore(),
  };
  return deps;
}

describe("selectModelForQiCapability", () => {
  it("throws QI_CAPABILITY_UNAVAILABLE when no config is present", () => {
    try {
      selectModelForQiCapability(depsWith(undefined), "qi:test-design");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(QiGenerationError);
      expect((err as QiGenerationError).code).toBe("QI_CAPABILITY_UNAVAILABLE");
    }
  });

  it("selects a chat model with structured-output for qi:test-design", () => {
    const deps = depsWith(configWith([capability("structured-1", { structuredOutput: true })]));
    expect(selectModelForQiCapability(deps, "qi:test-design")).toBe("structured-1");
  });

  it("throws QI_CAPABILITY_UNAVAILABLE when only a non-structured-output model is configured", () => {
    const deps = depsWith(configWith([capability("text-only", { structuredOutput: false })]));
    try {
      selectModelForQiCapability(deps, "qi:test-design");
      expect.fail("should throw");
    } catch (err) {
      expect((err as QiGenerationError).code).toBe("QI_CAPABILITY_UNAVAILABLE");
    }
  });

  it("honours a compatible requested model id", () => {
    const deps = depsWith(
      configWith([
        capability("cheap", { structuredOutput: true, costClass: "low" }),
        capability("requested", { structuredOutput: true }),
      ]),
    );
    expect(selectModelForQiCapability(deps, "qi:test-design", "requested")).toBe("requested");
  });

  it("ignores an incompatible requested model and selects a compatible one", () => {
    const deps = depsWith(
      configWith([
        capability("bad-request", { structuredOutput: false }),
        capability("good-fallback", { structuredOutput: true }),
      ]),
    );
    expect(selectModelForQiCapability(deps, "qi:test-design", "bad-request")).toBe("good-fallback");
  });

  it("prefers the lowest-cost matching model", () => {
    const deps = depsWith(
      configWith([
        capability("high", { structuredOutput: true, costClass: "high" }),
        capability("low", { structuredOutput: true, costClass: "low" }),
        capability("medium", { structuredOutput: true, costClass: "medium" }),
      ]),
    );
    expect(selectModelForQiCapability(deps, "qi:test-design")).toBe("low");
  });

  it("references no hard-coded model id (selection is config-driven)", () => {
    const deps = depsWith(configWith([capability("any-named-model", { structuredOutput: true })]));
    expect(selectModelForQiCapability(deps, "qi:test-design")).toBe("any-named-model");
  });
});
