import { describe, expect, it } from "vitest";
import { createInitialToolCatalog } from "./legacy.js";
import { compileToolProjection } from "./projection.js";
import { computeHandlerSetDigest, type ToolHandlerSetIdentity } from "./handler-set.js";

function identities(): readonly ToolHandlerSetIdentity[] {
  const catalog = createInitialToolCatalog();
  const projection = compileToolProjection(catalog, { id: "legacy-native", version: 1 });
  return projection.tools.map((tool) => ({
    toolRef: tool.toolRef,
    descriptorDigest: tool.descriptorDigest,
    handlerId: "fixture-handler",
    handlerVersion: 1,
    catalogAction: tool.alias,
  }));
}

describe("canonical tool handler-set identity", () => {
  it("distinguishes the actual bound handlers for the same projection", () => {
    const catalog = createInitialToolCatalog();
    const projection = compileToolProjection(catalog, { id: "legacy-native", version: 1 });
    const bound = identities();
    const changed = bound.map((binding, index) =>
      index === 0 ? { ...binding, handlerId: "replacement-handler" } : binding,
    );
    const missing = bound.map((binding, index) =>
      index === 0
        ? { ...binding, handlerId: null, handlerVersion: null, catalogAction: null }
        : binding,
    );
    const digest = computeHandlerSetDigest(projection.projectionDigest, bound);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(computeHandlerSetDigest(projection.projectionDigest, changed)).not.toBe(digest);
    expect(computeHandlerSetDigest(projection.projectionDigest, missing)).not.toBe(digest);
    expect(computeHandlerSetDigest(projection.projectionDigest, bound)).toBe(digest);
  });
});
