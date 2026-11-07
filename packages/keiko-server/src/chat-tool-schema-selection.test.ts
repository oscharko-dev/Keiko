import { describe, expect, it } from "vitest";
import { createDefaultChatCapability } from "@oscharko-dev/keiko-model-gateway";
import { deriveContextProfileFromCapability } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { gatewayToolDefinitions } from "@oscharko-dev/keiko-tool-catalog";
import { createCatalogToolBinder } from "./tool-catalog/catalogToolDispatch.js";
import { catalogToolFixture } from "./tool-catalog/__fixtures__/catalogToolFixture.js";
import { chatToolSelectionFits, offeredDefinitions } from "./chat-tool-schema-selection.js";

const request = {
  modelId: "selection-budget",
  messages: [{ role: "user", content: "Read a project." }],
  maxOutputTokens: 1024,
} as const;
const profile = deriveContextProfileFromCapability({
  ...createDefaultChatCapability(request.modelId),
  contextWindow: 32768,
});

describe("selected model schema accounting", () => {
  it("uses ordinary offer admission and excludes refused schemas from both model and budget", () => {
    const f = catalogToolFixture();
    const binder = createCatalogToolBinder(f.input, f.options);
    const definitions = gatewayToolDefinitions(f.pure.catalog, f.input.projection.profile);
    expect(offeredDefinitions(f.input, definitions, binder.offer())).toHaveLength(1);
    f.preview.mockReturnValue({ ok: false, reason: "authority-invalid" });
    expect(offeredDefinitions(f.input, definitions, binder.offer())).toEqual([]);
    f.preview.mockReturnValue({ ok: true });
    f.budgetAvailable.mockReturnValue(false);
    expect(offeredDefinitions(f.input, definitions, binder.offer())).toEqual([]);
  });

  it("does not admit an earlier contract version by matching only its canonical name", () => {
    const f = catalogToolFixture();
    const binder = createCatalogToolBinder(f.input, f.options);
    const definitions = gatewayToolDefinitions(f.pure.catalog, f.input.projection.profile);
    const offered = binder.offer();
    expect(
      offeredDefinitions(f.input, definitions, {
        ...offered,
        toolRefs: offered.toolRefs.map((ref) => ({
          ...ref,
          contractVersion: ref.contractVersion + 1,
        })),
      }),
    ).toEqual([]);
  });

  it("admits the requested subset but refuses the complete schema set and exhausted prompt grant", () => {
    const definitions = Array.from({ length: 100 }, (_, index) => ({
      name: `bounded_${String(index)}`,
      description: "Typed operation description. ".repeat(100),
      parameters: {
        type: "object",
        properties: { name: { type: "string", maxLength: 128 } },
        required: ["name"],
        additionalProperties: false,
      },
    }));
    expect(chatToolSelectionFits(request, definitions.slice(0, 1), profile, 100000)).toBe(true);
    expect(chatToolSelectionFits(request, definitions, profile, 100000)).toBe(false);
    expect(chatToolSelectionFits(request, definitions.slice(0, 1), profile, 1)).toBe(false);
    expect(
      chatToolSelectionFits(
        { ...request, messages: [{ role: "user", content: "context ".repeat(30000) }] },
        [],
        profile,
        100000,
      ),
    ).toBe(false);
  });
});
