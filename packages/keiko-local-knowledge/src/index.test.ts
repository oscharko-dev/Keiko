// index.test.ts — barrel-surface assertions. Two contracts:
//   1. Every public export is reachable.
//   2. No exported function returns chunks or vectors without a capsule scope. The
//      Foundry-IQ "no global pool" invariant is enforced at the type level by carrying
//      capsuleId/sourceId/documentId on every record; this test guards the API shape
//      itself so a future commit cannot quietly add `listAllChunks(store)` etc.

import { describe, expect, it } from "vitest";

import * as api from "./index.js";
import type {
  KnowledgeStoreKeyProvider,
  KnowledgeStoreKeyProviderContext,
  KnowledgeStoreProtectionOptions,
} from "./index.js";

const PUBLIC_EXPORTS = [
  "KEIKO_LOCAL_KNOWLEDGE_VERSION",
  "KnowledgeStoreError",
  "KnowledgePathError",
  "KnowledgeNotFoundError",
  "resolveKnowledgeStorePath",
  "openKnowledgeStore",
  "createCapsule",
  "deleteCapsule",
  "getCapsule",
  "listCapsules",
  "updateCapsuleState",
  "addSourceToCapsule",
  "listCapsuleSources",
  "removeSourceFromCapsule",
  "createCapsuleSet",
  "deleteCapsuleSet",
  "getCapsuleSet",
  "listCapsuleSets",
  // Discovery + extraction (#194)
  "discoverAndExtract",
  "documentIdFor",
  "extensionOf",
  "extractDocument",
  "mediaTypeFor",
  "walkSource",
  "DEFAULT_DISCOVERY_OPTIONS",
] as const;

describe("barrel surface", () => {
  it("exposes every documented function and constant", () => {
    for (const name of PUBLIC_EXPORTS) {
      expect(Object.hasOwn(api, name), `${name} missing from barrel`).toBe(true);
    }
  });

  // Foundry-IQ invariant: there is no unscoped read API. Any export whose name starts
  // with `list` MUST take an explicit capsule scope (function arity ≥ 2, second arg
  // by convention). Aliasing this away by renaming is also caught — no export name
  // contains "Vectors" or "Chunks" at all in this package's public surface, except for
  // the explicit test seeding helper exported for package consumers that need fixture
  // setup without reaching into internals.
  it("does not expose unscoped chunk/vector readers", () => {
    const names = Object.keys(api);
    const offenders = names.filter((name) => {
      return (
        /^list(All|Every)/.test(name) ||
        /Vectors?$/.test(name) ||
        /Chunks?$/.test(name) ||
        name === "listVectors" ||
        name === "listChunks"
      );
    });
    expect(offenders, `unscoped reader exports leaked: ${offenders.join(", ")}`).toStrictEqual([]);
    expect(api).not.toHaveProperty("scriptedAdapter");
    expect(api).not.toHaveProperty("seedCapsuleWithVectors");
  });

  it("each `list*` export takes the capsule (or set) as its scope arg", () => {
    // Each list* takes (store, capsuleId/setId) or just (store) for capsule/set
    // *enumerations*. The store-only enumerations (`listCapsules`, `listCapsuleSets`)
    // are PERMITTED — they enumerate the top-level Foundry-IQ entities themselves, not
    // their internals. Anything else MUST be capsule-scoped.
    const allowedStoreOnly = new Set(["listCapsules", "listCapsuleSets"]);
    const listNames = Object.keys(api).filter((name) => name.startsWith("list"));
    for (const name of listNames) {
      const fn = (api as Record<string, unknown>)[name];
      if (typeof fn !== "function") continue;
      if (allowedStoreOnly.has(name)) {
        expect(fn.length, `${name} should take exactly the store`).toBe(1);
      } else {
        expect(fn.length, `${name} should take store + scope arg`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("exposes local-store protection seam types", () => {
    const pin = <T>(_value?: T): T | undefined => undefined;
    pin<KnowledgeStoreKeyProvider>();
    pin<KnowledgeStoreKeyProviderContext>();
    pin<KnowledgeStoreProtectionOptions>();
  });
});
