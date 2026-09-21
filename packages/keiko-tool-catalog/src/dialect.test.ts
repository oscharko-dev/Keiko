import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_TOOL_CATALOG_RUNTIME as CONTRACT_NATIVE_TOOL_CATALOG_RUNTIME } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { assertCatalogDialect, NATIVE_TOOL_CATALOG_RUNTIME } from "./dialect.js";
import { legacyNativeRegistrationSet } from "./legacy.js";
import { childRegistrationSet } from "./child.js";

describe("native runtime identity, one producer (b3-25)", () => {
  it("takes the native runtime from the contracts leaf's single constant, not from the release number", () => {
    // Until #3565 this pinned `version: KEIKO_PRODUCT_VERSION`. That choice was the convenient
    // single source against the b3-25 drift below, but it made every version bump change
    // `catalogRevision` and `projectionDigest` of an unchanged catalog, and with them the manifest
    // and the container-only performance evidence, so no release could be cut without a hand-made
    // preparation pull request (owner decision 2026-09-21, #3565). The single-source invariant
    // stays and is now owned by keiko-contracts; the identity-stability invariant is pinned below.
    expect(NATIVE_TOOL_CATALOG_RUNTIME).toBe(CONTRACT_NATIVE_TOOL_CATALOG_RUNTIME);
    expect(Object.isFrozen(NATIVE_TOOL_CATALOG_RUNTIME)).toBe(true);
    expect(NATIVE_TOOL_CATALOG_RUNTIME.id).toBe("keiko");
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
      assertCatalogDialect(dialect, {
        id: "opencode",
        version: NATIVE_TOOL_CATALOG_RUNTIME.version,
      });
    }).toThrow("unsupported-dialect");
  });
});

// #3565. The release button cannot regenerate the container-measured catalog evidence, so a catalog
// identity that follows the release number forces a hand-made preparation pull request for every
// release. This compiles the production catalog twice, under two different product versions, through
// the real producer entry points: any module that hashes the product version into the identity again
// makes the two disagree.
describe("catalog identity is independent of the product version (#3565)", () => {
  const VERSION_MODULE = "@oscharko-dev/keiko-contracts/runtime/version";

  afterEach(() => {
    vi.doUnmock(VERSION_MODULE);
    vi.resetModules();
  });

  async function identityUnder(productVersion: string): Promise<readonly string[]> {
    vi.resetModules();
    vi.doMock(VERSION_MODULE, () => ({
      KEIKO_CONTRACTS_VERSION: productVersion,
      KEIKO_PRODUCT_VERSION: productVersion,
    }));
    const producer = await import("./index.js");
    const catalog = producer.createKeikoToolCatalog([
      producer.legacyNativeRegistrationSet(),
      producer.childRegistrationSet(),
    ]);
    const projections = [
      producer.legacyNativeRegistrationSet().profile,
      producer.childRegistrationSet().profile,
    ].map((profile) => producer.compileToolProjection(catalog, profile).projectionDigest);
    return [catalog.catalogRevision, ...projections];
  }

  it("keeps catalogRevision and every native projectionDigest across a version bump", async () => {
    const before = await identityUnder("1.1.1");
    const after = await identityUnder("99.0.0");
    expect(before).toHaveLength(3);
    expect(after).toStrictEqual(before);
  });
});
