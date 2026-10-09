import { describe, expect, it } from "vitest";
import { createDefaultChatCapability } from "./capabilities.js";
import { parseGatewayConfig, parseModelCapability, toSafeObject } from "./config.js";

const MODEL = "citation-fixture-model";
const CAPABILITY = createDefaultChatCapability(MODEL);

function inline(value?: unknown, kind = "chat"): unknown {
  return {
    providers: [
      {
        modelId: MODEL,
        baseUrl: "https://fixture.example.invalid/v1",
        apiKey: "fixture-key",
        capability: {
          kind,
          contextWindow: 8192,
          ...(value === undefined ? {} : { citationBehaviour: value }),
        },
      },
    ],
  };
}

describe("closed citation behavior capability metadata", () => {
  it.each(["cites", "cites-after-repair", "never"])(
    "round-trips %s through both capability parsers",
    (citationBehaviour) => {
      const strict = parseModelCapability({ ...CAPABILITY, citationBehaviour }, "capability");
      expect(strict.citationBehaviour).toBe(citationBehaviour);
      const configured = parseGatewayConfig(inline(citationBehaviour));
      expect(configured.capabilities?.[0]?.citationBehaviour).toBe(citationBehaviour);
      expect(toSafeObject(configured).capabilities?.[0]?.citationBehaviour).toBe(citationBehaviour);
    },
  );

  it("preserves unknown absence instead of claiming never", () => {
    expect(parseModelCapability(CAPABILITY, "capability")).not.toHaveProperty("citationBehaviour");
    expect(parseGatewayConfig(inline()).capabilities?.[0]).not.toHaveProperty("citationBehaviour");
  });

  it.each(["unknown", "CITES", "arbitrary", null, true, 1, ["cites"]])(
    "rejects invalid observed metadata %j on both surfaces",
    (citationBehaviour) => {
      expect(() =>
        parseModelCapability({ ...CAPABILITY, citationBehaviour }, "capability"),
      ).toThrow();
      expect(() => parseGatewayConfig(inline(citationBehaviour))).toThrow();
    },
  );

  it("rejects citation observations on a non-chat capability", () => {
    expect(() => parseGatewayConfig(inline("cites", "embedding"))).toThrow();
    expect(() =>
      parseModelCapability(
        { ...CAPABILITY, kind: "embedding", workflowEligible: false, citationBehaviour: "never" },
        "capability",
      ),
    ).toThrow();
  });
});
