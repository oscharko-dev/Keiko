import { describe, expect, it } from "vitest";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";

import { configuredCatalogModels } from "./codingWorkbenchModelReadiness";

function model(id: string, conversationReady?: boolean): ModelCapability {
  return {
    id,
    kind: "chat",
    ...(conversationReady === undefined ? {} : { conversationReady }),
  } as ModelCapability;
}

describe("configuredCatalogModels", () => {
  const activated = model("activated", true);
  const notActivated = model("not-activated");

  it("reads the unfiltered model read, which still lists a model nobody activated", () => {
    const catalog = {
      models: [activated],
      modelCatalogRead: {
        capabilities: [activated, notActivated],
        source: "bootstrap" as const,
        correlationId: "corr-1",
      },
    };
    expect(configuredCatalogModels(catalog)).toEqual([activated, notActivated]);
  });

  it("falls back to the published models while no read exists", () => {
    expect(configuredCatalogModels({ models: [activated], modelCatalogRead: undefined })).toEqual([
      activated,
    ]);
  });

  it("keeps an empty read empty instead of falling back to the published models", () => {
    const catalog = {
      models: [activated],
      modelCatalogRead: { capabilities: [], source: "bootstrap" as const, correlationId: "c" },
    };
    expect(configuredCatalogModels(catalog)).toEqual([]);
  });

  it("is empty without a catalog", () => {
    expect(configuredCatalogModels(null)).toEqual([]);
  });
});
