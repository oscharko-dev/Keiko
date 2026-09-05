import { describe, expect, expectTypeOf, it } from "vitest";
import { LEGACY_NATIVE_TOOL_CONSUMERS } from "./governed-tool-bridge.js";
import type {
  GatewayToolCatalogAdvertisement,
  ToolInvocationBridge,
} from "./governed-tool-bridge.js";
import type { BoundToolInvocation } from "./governed-tool-lifecycle.js";

describe("governed tool bridge contract", () => {
  it("keeps the bound invocation arm owned by the lifecycle contract", () => {
    expectTypeOf<
      Extract<ToolInvocationBridge, { kind: "bound" }>
    >().toEqualTypeOf<BoundToolInvocation>();
    expectTypeOf<
      Extract<GatewayToolCatalogAdvertisement, { kind: "bound" }>["legacySession"]
    >().toEqualTypeOf<undefined>();
  });
  it("keeps migration consumer membership immutable and explicitly finite", () => {
    expect(Object.isFrozen(LEGACY_NATIVE_TOOL_CONSUMERS)).toBe(true);
    expect(LEGACY_NATIVE_TOOL_CONSUMERS).not.toContain("managed-opencode");
    expect(LEGACY_NATIVE_TOOL_CONSUMERS).not.toContain("*");
  });
});
