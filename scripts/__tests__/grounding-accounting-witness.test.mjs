import { describe, expect, it } from "vitest";
import { countGatewayPromptTokens } from "../../packages/keiko-model-gateway/dist/prompt-token-accounting.js";
import { groundingAccountingWitness } from "../../tests/e2e/support/grounding-accounting-witness.mjs";

function request() {
  return {
    model: "e2e-chat-model",
    max_tokens: 1024,
    messages: [
      { role: "system", content: "Use supplied source evidence." },
      { role: "user", content: "A synthetic source fact. ".repeat(30) },
    ],
  };
}

const usage = { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 };

describe("body-free text-only grounded provider accounting witness", () => {
  it("counts the actual wire with the gateway producer without retaining message bodies", () => {
    const wire = request();
    const raw = JSON.stringify(wire);
    const witness = groundingAccountingWitness(raw, usage);
    const canonical = countGatewayPromptTokens(wire);
    expect(canonical).toBeGreaterThan(usage.prompt_tokens);
    expect(witness).toMatchObject({
      supportedTextOnly: true,
      canonicalPromptTokens: canonical,
      promptTokens: 8,
      completionTokens: 6,
      accountedPromptTokens: canonical,
      outputTokensMax: 1024,
      outputCapFields: 1,
    });
    expect(witness.requestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(witness)).not.toContain("synthetic source");
  });

  it("observes either provider output cap and detects ambiguous dual caps", () => {
    const wire = request();
    const { max_tokens, ...withoutLegacy } = wire;
    const replacement = { ...withoutLegacy, max_completion_tokens: max_tokens };
    expect(groundingAccountingWitness(JSON.stringify(replacement), usage)).toMatchObject({
      outputCapFields: 1,
      outputTokensMax: 1024,
    });
    expect(
      groundingAccountingWitness(JSON.stringify({ ...wire, ...replacement }), usage)
        .outputCapFields,
    ).toBe(2);
  });

  it("retains provider measurements above the canonical floor", () => {
    const observed = countGatewayPromptTokens(request()) + 100;
    expect(
      groundingAccountingWitness(JSON.stringify(request()), { ...usage, prompt_tokens: observed })
        .accountedPromptTokens,
    ).toBe(observed);
  });

  it.each([
    { tools: [{ type: "function", function: { name: "lookup" } }] },
    { response_format: { type: "json_object" } },
    {
      messages: [
        { role: "system", content: "s" },
        { role: "tool", content: "t" },
      ],
    },
    {
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: [{ type: "text", text: "p" }] },
      ],
    },
    {
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "p", tool_calls: [] },
      ],
    },
  ])("refuses unqualified richer wire shapes: %j", (unsupported) => {
    expect(
      groundingAccountingWitness(JSON.stringify({ ...request(), ...unsupported }), usage),
    ).toMatchObject({
      supportedTextOnly: false,
      canonicalPromptTokens: null,
      accountedPromptTokens: null,
    });
  });
});
