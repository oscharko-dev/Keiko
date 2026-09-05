import { describe, expect, it } from "vitest";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogCompatibility,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  assertCompatibilityTime,
  assertIdentityCompatibility,
  createToolCatalog,
  createToolDescriptor,
  compileToolProjection,
} from "./index.js";
import { declaration, profile, fixture } from "./__fixtures__/catalog.js";

function requiredEntry(entries: readonly CatalogCompatibility[]): CatalogCompatibility {
  const value = entries[0];
  if (value === undefined) throw new TypeError("Expected producer compatibility entry");
  return value;
}

function transition(): {
  readonly from: ReturnType<typeof createToolDescriptor>;
  readonly to: ReturnType<typeof createToolDescriptor>;
  readonly previous: ReturnType<typeof createToolCatalog>;
  readonly input: {
    readonly descriptors: unknown[];
    readonly profiles: unknown[];
    readonly compatibility: ReturnType<typeof entry>[];
  };
} {
  const { descriptor: from, catalog: previous } = fixture();
  const to = createToolDescriptor({
    ...declaration(2),
    description: "Second version, unchanged value semantics.",
  });
  const compatibility = entry(from, to);
  return {
    from,
    to,
    previous,
    input: {
      descriptors: [to],
      profiles: [{ ...profile(to), compatibility: [compatibility] }],
      compatibility: [compatibility],
    },
  };
}
function entry(
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
describe("explicit finite compatibility", () => {
  it("validates direct assertion inputs instead of trusting TypeScript-only shapes", () => {
    const { from, to } = transition();
    const compatibility = entry(from, to);
    expect(() => {
      assertIdentityCompatibility(
        { ...compatibility, transformId: "unchecked" } as unknown as CatalogCompatibility,
        from,
        to,
        0,
      );
    }).toThrow();
    expect(() => {
      assertIdentityCompatibility(
        compatibility,
        { ...from, description: "tampered comparison source" },
        to,
        0,
      );
    }).toThrow("invalid-identity");
    expect(() => {
      assertCompatibilityTime({ ...compatibility, ownerIssue: 0 }, 0);
    }).toThrow();
    expect(() => {
      assertCompatibilityTime(
        { ...compatibility, extra: "private-data" } as unknown as CatalogCompatibility,
        0,
      );
    }).toThrow();
  });
  it("binds exact source, destination, profile and runtime with no automatic reverse or transitive conversion", () => {
    const { from, to, previous, input } = transition();
    const catalog = createToolCatalog(input, { referenceTimeMs: 0, previous });
    const projected = compileToolProjection(catalog, { id: "fixture", version: 1 });
    expect(projected.tools[0]?.toolRef).toEqual(to.toolRef);
    expect(catalog.compatibility).toEqual(input.compatibility);
    expect(() => {
      assertIdentityCompatibility(requiredEntry(catalog.compatibility), to, from, 0);
    }).toThrow("invalid-compatibility");
    const third = createToolDescriptor(declaration(3));
    expect(() => {
      assertIdentityCompatibility(requiredEntry(catalog.compatibility), from, third, 0);
    }).toThrow("invalid-compatibility");
    expect(() => createToolCatalog(input, { referenceTimeMs: 0 })).toThrow("invalid-compatibility");
  });
  it.each([
    { transformId: "automatic" },
    { expiresAt: "1970-01-01T00:00:00.000Z" },
    { expiresAt: "1970-01-09T00:00:00.000Z" },
    { expiresAt: "1970-01-02" },
    { ownerIssue: 0 },
    { removalIssue: undefined },
    { profile: { id: "other", version: 1 } },
    { adapter: { id: "opencode", version: "1.17.17" } },
  ])("rejects stale, missing, unscoped or unsupported compatibility %j", (change) => {
    const { previous, input, to } = transition();
    const compatibility = [{ ...input.compatibility[0], ...change }];
    expect(() =>
      createToolCatalog(
        { ...input, compatibility, profiles: [{ ...profile(to), compatibility }] },
        { referenceTimeMs: 0, previous },
      ),
    ).toThrow();
  });
  it("rejects schema/effect changes and widening bounds under identity transformation", () => {
    const { from, previous } = transition();
    for (const change of [
      { resultSchema: { type: "string" } },
      { bounds: { ...from.bounds, maxResultBytes: from.bounds.maxResultBytes + 1 } },
      {
        effects: ["workspace-write"],
        actionMapping: [{ action: "read", effects: ["workspace-write"] }],
        idempotency: "server-key-required",
      },
    ]) {
      const to = createToolDescriptor({ ...declaration(2), ...change });
      const compatibility = [entry(from, to)];
      expect(() =>
        createToolCatalog(
          { descriptors: [to], profiles: [{ ...profile(to), compatibility }], compatibility },
          { referenceTimeMs: 0, previous },
        ),
      ).toThrow("invalid-compatibility");
    }
  });
  it("rechecks explicit time at consumption while keeping snapshot identity timeless", () => {
    const { previous, input } = transition();
    const catalog = createToolCatalog(input, { referenceTimeMs: 0, previous });
    const compatibility = requiredEntry(catalog.compatibility);
    expect(() => {
      assertCompatibilityTime(compatibility, Date.parse(compatibility.expiresAt));
    }).toThrow("expired-compatibility");
    for (const time of [-1, 0.5, NaN])
      expect(() => {
        assertCompatibilityTime(compatibility, time);
      }).toThrow("invalid-compatibility");
    expect(() => {
      assertCompatibilityTime(
        {
          ...compatibility,
          expiresAt: new Date(TOOL_CATALOG_LIMITS.maxCompatibilityLifetimeMs).toISOString(),
        },
        0,
      );
    }).not.toThrow();
    expect(() => compileToolProjection(catalog, { id: "fixture", version: 1 })).not.toThrow();
  });
  it("rejects duplicate compatibility entries, old descriptor digests and version downgrade", () => {
    const { previous, input, from, to } = transition();
    expect(() =>
      createToolCatalog(
        { ...input, compatibility: [...input.compatibility, ...input.compatibility] },
        { referenceTimeMs: 0, previous },
      ),
    ).toThrow("duplicate-identity");
    const stale = {
      ...entry(from, to),
      to: { toolRef: to.toolRef, descriptorDigest: from.descriptorDigest },
    };
    expect(() =>
      createToolCatalog({ ...input, compatibility: [stale] }, { referenceTimeMs: 0, previous }),
    ).toThrow("invalid-compatibility");
    const reverse = entry(to, from);
    expect(() =>
      createToolCatalog(
        { descriptors: [from], profiles: [profile(from)], compatibility: [reverse] },
        { referenceTimeMs: 0 },
      ),
    ).toThrow("incompatible-version");
  });
});
