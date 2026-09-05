import { describe, expect, it } from "vitest";
import { KEIKO_PRODUCT_VERSION } from "@oscharko-dev/keiko-contracts/runtime/version";
import { assertCatalogDialect, NATIVE_TOOL_CATALOG_RUNTIME } from "./dialect.js";
import { legacyNativeRegistrationSet } from "./legacy.js";
import { childRegistrationSet } from "./child.js";

describe("native runtime identity, one producer (b3-25)", () => {
  it("derives the pinned native runtime version from the single product-version source", () => {
    expect(NATIVE_TOOL_CATALOG_RUNTIME).toEqual({ id: "keiko", version: KEIKO_PRODUCT_VERSION });
  });

  it("shares the exact runtime reference across every native registration set instead of a hand-copied literal", () => {
    // Legacy and child registration sets each bound a separately hand-copied "0.3.17" literal
    // before this fix; a version bump would drift dialect.ts, legacy.ts and child.ts out of step
    // with each other and with `assertCatalogDialect`'s own check. Pinning every set's
    // `adapterRuntime` back to the same producer value makes that drift impossible.
    expect(legacyNativeRegistrationSet().adapterRuntime).toEqual(NATIVE_TOOL_CATALOG_RUNTIME);
    expect(childRegistrationSet().adapterRuntime).toEqual(NATIVE_TOOL_CATALOG_RUNTIME);
  });

  it("accepts the pinned native runtime and rejects any other id or version", () => {
    const dialect = { id: "gateway-json-schema", version: 1 };
    expect(() => {
      assertCatalogDialect(dialect, NATIVE_TOOL_CATALOG_RUNTIME);
    }).not.toThrow();
    expect(() => {
      assertCatalogDialect(dialect, { id: "keiko", version: "0.0.1" });
    }).toThrow("unsupported-dialect");
    expect(() => {
      assertCatalogDialect(dialect, { id: "opencode", version: KEIKO_PRODUCT_VERSION });
    }).toThrow("unsupported-dialect");
  });
});
