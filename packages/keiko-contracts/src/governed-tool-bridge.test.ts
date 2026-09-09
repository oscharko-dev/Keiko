import { describe, expectTypeOf, it } from "vitest";
import type {
  GatewayToolCatalogAdvertisement,
  GovernedToolCallRequest,
} from "./governed-tool-bridge.js";
import type { BoundToolInvocation } from "./governed-tool-lifecycle.js";

describe("governed tool bridge contract", () => {
  it("keeps the bound invocation arm owned by the lifecycle contract", () => {
    expectTypeOf<GovernedToolCallRequest["invocation"]>().toEqualTypeOf<BoundToolInvocation>();
    expectTypeOf<GatewayToolCatalogAdvertisement["kind"]>().toEqualTypeOf<"bound">();
  });
});
