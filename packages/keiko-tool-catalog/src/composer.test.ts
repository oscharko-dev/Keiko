import { describe, expect, it } from "vitest";
import type { CatalogCompatibility } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { createToolRef } from "./identity.js";
import { createToolDescriptor } from "./descriptor.js";
import { lookupCatalogTool } from "./catalog.js";
import { createKeikoToolCatalog, type CatalogRegistrationSet } from "./composer.js";
import { declaration } from "./__fixtures__/catalog.js";

function registrationSet(
  descriptor: ReturnType<typeof createToolDescriptor>,
  alias = "fixture_read",
): CatalogRegistrationSet {
  return {
    profile: { id: "fixture", version: 1 },
    adapterDialect: { id: "gateway-json-schema", version: 1 },
    adapterRuntime: { id: "keiko", version: "0.3.17" },
    entries: [{ alias, descriptor }],
  };
}

// Mirrors compatibility.test.ts's own `entry()` fixture: an unchanged-semantics version bump,
// eligible under referenceTimeMs 0 because it expires one day after the epoch.
function versionBumpCompatibility(
  from: ReturnType<typeof createToolDescriptor>,
  to: ReturnType<typeof createToolDescriptor>,
): CatalogCompatibility {
  return {
    from: { toolRef: from.toolRef, descriptorDigest: from.descriptorDigest },
    to: { toolRef: to.toolRef, descriptorDigest: to.descriptorDigest },
    profile: { id: "fixture", version: 1 },
    adapter: { id: "keiko", version: "0.3.17" },
    transformId: "identity-v1" as const,
    ownerIssue: 3406,
    expiresAt: "1970-01-02T00:00:00.000Z",
    removalIssue: 3415,
  };
}

describe("createKeikoToolCatalog compatibility threading (b1-4)", () => {
  it("compiles a well-formed version-bump compatibility entry against the prior composed snapshot", () => {
    const from = createToolDescriptor(declaration(1));
    const to = createToolDescriptor(declaration(2));
    const previous = createKeikoToolCatalog([registrationSet(from)]);
    const compatibility = [versionBumpCompatibility(from, to)];
    const next = createKeikoToolCatalog([registrationSet(to)], compatibility, {
      referenceTimeMs: 0,
      previous,
    });
    expect(next.compatibility).toEqual(compatibility);
    expect(lookupCatalogTool(next, createToolRef("keiko.fixture.read", 2))).toBeDefined();
  });

  it("still fails closed when a compatibility entry is published without threading a prior snapshot", () => {
    const from = createToolDescriptor(declaration(1));
    const to = createToolDescriptor(declaration(2));
    expect(() =>
      createKeikoToolCatalog([registrationSet(to)], [versionBumpCompatibility(from, to)], {
        referenceTimeMs: 0,
      }),
    ).toThrow("invalid-compatibility");
  });

  it("defaults to the wall clock and no comparison snapshot for every compatibility-free caller", () => {
    const descriptor = createToolDescriptor(declaration(1));
    const catalog = createKeikoToolCatalog([registrationSet(descriptor)]);
    expect(catalog.compatibility).toEqual([]);
    expect(lookupCatalogTool(catalog, descriptor.toolRef)).toBeDefined();
  });
});
