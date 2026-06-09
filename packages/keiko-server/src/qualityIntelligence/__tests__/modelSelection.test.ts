// Tests for the QI test-design resolver (Epic #761, Issue #762/#763).
//
// Test-design prefers configured structured-output chat models, degrades to chat-only models when
// needed, and finally falls back to a deterministic no-model baseline.

import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ModelCapability } from "@oscharko-dev/keiko-model-gateway";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import { resolveQiMultimodalSelection, resolveQiTestDesignSelection } from "../modelSelection.js";

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
  return {
    config,
    configPresent: config !== undefined,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (_id: string): undefined => undefined,
    store: createInMemoryUiStore(),
  };
}

describe("resolveQiTestDesignSelection", () => {
  it("returns a deterministic baseline when no config is present", () => {
    expect(resolveQiTestDesignSelection(depsWith(undefined))).toEqual({ kind: "baseline" });
  });

  it("honours an explicitly requested configured chat model", () => {
    const deps = depsWith(
      configWith([
        capability("cheap-structured", { structuredOutput: true, costClass: "low" }),
        capability("requested-chat-only", { structuredOutput: false, costClass: "high" }),
      ]),
    );
    const selection = resolveQiTestDesignSelection(deps, "requested-chat-only");
    expect(selection.kind).toBe("model");
    if (selection.kind === "model") {
      expect(selection.modelId).toBe("requested-chat-only");
      expect(selection.capability.structuredOutput).toBe(false);
    }
  });

  it("prefers the lowest-cost structured-output chat model when none is requested", () => {
    const deps = depsWith(
      configWith([
        capability("high-structured", { structuredOutput: true, costClass: "high" }),
        capability("low-structured", { structuredOutput: true, costClass: "low" }),
        capability("cheap-chat-only", { structuredOutput: false, costClass: "low" }),
      ]),
    );
    const selection = resolveQiTestDesignSelection(deps);
    expect(selection.kind).toBe("model");
    if (selection.kind === "model") {
      expect(selection.modelId).toBe("low-structured");
      expect(selection.capability.structuredOutput).toBe(true);
    }
  });

  it("degrades to a chat-only model when no structured-output chat model exists", () => {
    const deps = depsWith(
      configWith([
        capability("high-chat-only", { structuredOutput: false, costClass: "high" }),
        capability("low-chat-only", { structuredOutput: false, costClass: "low" }),
      ]),
    );
    const selection = resolveQiTestDesignSelection(deps);
    expect(selection.kind).toBe("model");
    if (selection.kind === "model") {
      expect(selection.modelId).toBe("low-chat-only");
      expect(selection.capability.structuredOutput).toBe(false);
    }
  });

  it("ignores a requested non-chat model and falls back to the best chat strategy", () => {
    const deps = depsWith(
      configWith([
        capability("chat-fallback", { structuredOutput: true }),
        capability("embed-request", {
          kind: "embedding",
          structuredOutput: false,
          toolCalling: false,
          streaming: false,
          workflowEligible: false,
          maxOutputTokens: 0,
        }),
      ]),
    );
    const selection = resolveQiTestDesignSelection(deps, "embed-request");
    expect(selection.kind).toBe("model");
    if (selection.kind === "model") {
      expect(selection.modelId).toBe("chat-fallback");
    }
  });
});

// Issue #810: multimodal selection routes a vision stage to a configured image-input model BY
// CAPABILITY, and reports a typed "unavailable" (never a silent text fallback) when absent.
describe("resolveQiMultimodalSelection", () => {
  it("reports unavailable when no config is present (caller degrades to IR-only)", () => {
    expect(resolveQiMultimodalSelection(depsWith(undefined))).toEqual({ kind: "unavailable" });
  });

  it("selects the configured image-input model by capability when present", () => {
    const deps = depsWith(
      configWith([
        capability("text-chat", { supportsImageInput: false }),
        capability("vision-chat", { supportsImageInput: true }),
      ]),
    );
    const selection = resolveQiMultimodalSelection(deps);
    expect(selection.kind).toBe("model");
    if (selection.kind === "model") {
      expect(selection.modelId).toBe("vision-chat");
      expect(selection.capability.supportsImageInput).toBe(true);
    }
  });

  it("reports unavailable when only text-only chat models are configured (no silent fallback)", () => {
    const deps = depsWith(
      configWith([
        capability("text-chat-a", { supportsImageInput: false }),
        capability("text-chat-b", { supportsImageInput: false, costClass: "low" }),
      ]),
    );
    expect(resolveQiMultimodalSelection(deps)).toEqual({ kind: "unavailable" });
  });

  it("prefers the lowest-cost image-input model when several are configured", () => {
    const deps = depsWith(
      configWith([
        capability("vision-high", { supportsImageInput: true, costClass: "high" }),
        capability("vision-low", { supportsImageInput: true, costClass: "low" }),
      ]),
    );
    const selection = resolveQiMultimodalSelection(deps);
    expect(selection.kind).toBe("model");
    if (selection.kind === "model") {
      expect(selection.modelId).toBe("vision-low");
    }
  });

  // Capability-driven, not id-driven: a model named "…vision…" with no image-input capability
  // must NOT be selected — proves selection is by capability flag, never by id substring.
  it("does NOT select a vision-NAMED model that lacks the image-input capability", () => {
    const deps = depsWith(
      configWith([capability("llama-4-maverick-vision", { supportsImageInput: false })]),
    );
    expect(resolveQiMultimodalSelection(deps)).toEqual({ kind: "unavailable" });
  });
});
