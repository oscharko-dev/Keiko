import { describe, expect, it } from "vitest";

import { gatewayAgentModel, openCodeAgentModelBinding } from "./opencodeNativeAgentModels.js";

const SMALL = { contextWindowTokens: 16_000, maxInputTokens: 12_000, maxOutputTokens: 2_000 };
const CATALOG = { runModelId: "gemma-4-31b-it", models: { "gemma-small": SMALL } } as const;

// #3903 AC1: an agent's own model is honoured only as a model the gateway serves.
describe("per-agent gateway models", () => {
  it("routes the run's model to its alias and a further gateway model to itself", () => {
    expect(gatewayAgentModel("keiko-runtime/coding", CATALOG)).toBe("keiko-runtime/coding");
    expect(gatewayAgentModel("gemma-4-31b-it", CATALOG)).toBe("keiko-runtime/coding");
    expect(gatewayAgentModel("keiko-runtime/gemma-small", CATALOG)).toBe(
      "keiko-runtime/gemma-small",
    );
    // A standalone spelling names the gateway's model of that id.
    expect(gatewayAgentModel("ollama/gemma-small", CATALOG)).toBe("keiko-runtime/gemma-small");
    expect(gatewayAgentModel("gemma-small", CATALOG)).toBe("keiko-runtime/gemma-small");
  });

  it("refuses every model the gateway does not serve, so no traffic leaves the gateway", () => {
    for (const value of ["anthropic/claude-haiku", "keiko-runtime/unknown", "", "openai/"])
      expect(gatewayAgentModel(value, CATALOG), value).toBeUndefined();
  });

  it("binds the configured overrides in merge order and counts the refused ones", () => {
    const binding = openCodeAgentModelBinding(
      [
        { agent: { explore: { model: "gemma-small" }, general: { model: "openai/gpt-x" } } },
        {
          agents: {
            explore: { model: "keiko-runtime/coding" },
            reviewer: { model: "gemma-small", system: "ignored" },
            "bad name": { model: "gemma-small" },
            noModel: { description: "x" },
          },
        },
      ],
      CATALOG,
    );
    expect(binding).toEqual({
      models: CATALOG.models,
      agents: {
        explore: { model: "keiko-runtime/coding" },
        reviewer: { model: "keiko-runtime/gemma-small" },
      },
      admittedCount: 3,
      refusedCount: 2,
    });
  });
});
