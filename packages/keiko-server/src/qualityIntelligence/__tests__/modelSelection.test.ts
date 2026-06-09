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
import { resolveQiTestDesignSelection } from "../modelSelection.js";

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
