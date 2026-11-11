import { describe, expect, it } from "vitest";
import type { CatalogCompatibility } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { createToolRef } from "./identity.js";
import { createToolDescriptor } from "./descriptor.js";
import { lookupCatalogTool } from "./catalog.js";
import { createKeikoToolCatalog, type CatalogRegistrationSet } from "./composer.js";
import { declaration } from "./__fixtures__/catalog.js";
import { NATIVE_TOOL_CATALOG_RUNTIME } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

function registrationSet(
  descriptor: ReturnType<typeof createToolDescriptor>,
  alias = "fixture_read",
): CatalogRegistrationSet {
  return {
    profile: { id: "fixture", version: 1 },
    adapterDialect: { id: "gateway-json-schema", version: 1 },
    adapterRuntime: NATIVE_TOOL_CATALOG_RUNTIME,
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
    adapter: NATIVE_TOOL_CATALOG_RUNTIME,
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

// Each Jira chat selection composes a new catalog from the same issued descriptors. Copying them
// lost their issued identity, so every selection re-verified, re-copied and re-hashed every tool.
describe("createKeikoToolCatalog issued descriptor retention", () => {
  function bulkSet(
    descriptors: readonly ReturnType<typeof createToolDescriptor>[],
  ): CatalogRegistrationSet {
    return {
      ...registrationSet(descriptors[0] ?? createToolDescriptor(declaration(1))),
      entries: descriptors.map((descriptor, index) => ({
        alias: `fixture_read_${String(index)}`,
        descriptor,
      })),
    };
  }
  function bulkDescriptors(
    count: number,
    descriptionBytes: number,
  ): ReturnType<typeof createToolDescriptor>[] {
    return Array.from({ length: count }, (_, index) =>
      createToolDescriptor({
        ...declaration(1),
        toolRef: createToolRef(`keiko.fixture.read${"abcdefgh"[index] ?? "z"}`, 1),
        description: "x".repeat(descriptionBytes),
      }),
    );
  }

  it("keeps each issued descriptor by identity instead of a re-verified copy", () => {
    const descriptor = createToolDescriptor(declaration(1));
    const catalog = createKeikoToolCatalog([registrationSet(descriptor)]);
    expect(catalog.descriptors[0]).toBe(descriptor);
    expect(lookupCatalogTool(catalog, descriptor.toolRef)).toBe(descriptor);
  });

  it("still verifies an equal descriptor it did not issue and refuses a tampered one", () => {
    const descriptor = createToolDescriptor(declaration(1));
    const copy = structuredClone(descriptor);
    const catalog = createKeikoToolCatalog([registrationSet(copy)]);
    expect(catalog.descriptors[0]).not.toBe(copy);
    expect(catalog.descriptors[0]).toEqual(descriptor);
    expect(() =>
      createKeikoToolCatalog([registrationSet({ ...copy, description: "Tampered." })]),
    ).toThrow("invalid-identity");
  });

  it("charges a kept descriptor against the catalog byte bound exactly like a copied one", () => {
    // Five 60,000-byte descriptions exceed the 262,144-byte catalog envelope.
    const issued = bulkDescriptors(5, 60_000);
    expect(() => createKeikoToolCatalog([bulkSet(issued)])).toThrow("input-bound");
    expect(() =>
      createKeikoToolCatalog([bulkSet(issued.map((descriptor) => structuredClone(descriptor)))]),
    ).toThrow("input-bound");
    // Four fit, on both paths, and the issued path keeps every descriptor.
    const fitting = bulkDescriptors(4, 60_000);
    const catalog = createKeikoToolCatalog([bulkSet(fitting)]);
    expect(fitting.every((descriptor) => catalog.descriptors.includes(descriptor))).toBe(true);
    expect(
      createKeikoToolCatalog([bulkSet(fitting.map((descriptor) => structuredClone(descriptor)))])
        .catalogRevision,
    ).toBe(catalog.catalogRevision);
  });
});
