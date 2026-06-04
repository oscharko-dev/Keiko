// capsule-set-lifecycle.test.ts — set is a logical composition; deleting it leaves member
// capsules intact, while deleting a member capsule removes the set's reference row.

import type { CapsuleSetId, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCapsule, deleteCapsule, getCapsule } from "./capsule-lifecycle.js";
import {
  createCapsuleSet,
  deleteCapsuleSet,
  getCapsuleSet,
  listCapsuleSets,
} from "./capsule-set-lifecycle.js";
import { KnowledgeNotFoundError } from "./errors.js";
import { freshStore, sampleCapsuleInput } from "./_support.js";
import type { KnowledgeStore } from "./store.js";

let store: KnowledgeStore;
let cleanup: () => void;
let aId: KnowledgeCapsuleId;
let bId: KnowledgeCapsuleId;

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
  aId = createCapsule(store, sampleCapsuleInput({ id: "cap-a" as KnowledgeCapsuleId })).id;
  bId = createCapsule(
    store,
    sampleCapsuleInput({ id: "cap-b" as KnowledgeCapsuleId, storageReference: "b" }),
  ).id;
});

afterEach(() => {
  cleanup();
});

describe("createCapsuleSet + getCapsuleSet", () => {
  it("round-trips a set referencing two capsules", () => {
    const set = createCapsuleSet(store, {
      id: "set-1" as CapsuleSetId,
      displayName: "All",
      description: "everything",
      tags: ["t"],
      capsuleIds: [aId, bId],
    });
    expect(set.id).toBe("set-1");
    expect(set.displayName).toBe("All");
    expect(set.description).toBe("everything");
    expect(set.tags).toStrictEqual(["t"]);
    expect(set.capsuleIds).toStrictEqual([aId, bId]);
    expect(typeof set.composedAt).toBe("number");

    const fetched = getCapsuleSet(store, "set-1" as CapsuleSetId);
    expect(fetched).toStrictEqual(set);
  });

  it("returns undefined for an unknown set id", () => {
    expect(getCapsuleSet(store, "ghost" as CapsuleSetId)).toBeUndefined();
  });

  it("omits description when it was not provided (exactOptionalPropertyTypes)", () => {
    const set = createCapsuleSet(store, {
      id: "set-no-desc" as CapsuleSetId,
      displayName: "thin",
      tags: [],
      capsuleIds: [aId],
    });
    expect("description" in set).toBe(false);
  });
});

describe("listCapsuleSets", () => {
  it("returns empty before any insert and lists rows in composed_at order", () => {
    expect(listCapsuleSets(store)).toStrictEqual([]);

    let t = 100;
    Object.defineProperty(store._internal, "now", { value: (): number => t, configurable: true });
    createCapsuleSet(store, {
      id: "s1" as CapsuleSetId,
      displayName: "s1",
      tags: [],
      capsuleIds: [aId],
    });
    t = 200;
    createCapsuleSet(store, {
      id: "s2" as CapsuleSetId,
      displayName: "s2",
      tags: [],
      capsuleIds: [bId],
    });
    const ids = listCapsuleSets(store).map((s) => s.id);
    expect(ids).toStrictEqual(["s1", "s2"]);
  });
});

describe("deleteCapsuleSet", () => {
  it("removes the set but leaves the underlying capsules in place", () => {
    createCapsuleSet(store, {
      id: "set-x" as CapsuleSetId,
      displayName: "x",
      tags: [],
      capsuleIds: [aId, bId],
    });
    deleteCapsuleSet(store, "set-x" as CapsuleSetId);
    expect(getCapsuleSet(store, "set-x" as CapsuleSetId)).toBeUndefined();
    expect(getCapsule(store, aId)).toBeDefined();
    expect(getCapsule(store, bId)).toBeDefined();
  });

  it("raises KnowledgeNotFoundError on unknown set id", () => {
    expect(() => { deleteCapsuleSet(store, "ghost" as CapsuleSetId); }).toThrow(
      KnowledgeNotFoundError,
    );
  });
});

describe("capsule deletion cascades into set membership", () => {
  it("removes the capsule's member row from any set that referenced it", () => {
    createCapsuleSet(store, {
      id: "set-y" as CapsuleSetId,
      displayName: "y",
      tags: [],
      capsuleIds: [aId, bId],
    });
    deleteCapsule(store, aId);
    const set = getCapsuleSet(store, "set-y" as CapsuleSetId);
    expect(set?.capsuleIds).toStrictEqual([bId]);
  });
});
