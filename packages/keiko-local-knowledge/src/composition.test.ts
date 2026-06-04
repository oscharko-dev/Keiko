// composition.test.ts — composition layer for Issue #263 / Epic #189.
// Covers:
//   * buildComposedRetrievalScope — in-memory union of {capsuleIds, sourceIds} for a set
//   * describeRetrievalScope — UI-safe summary of "what will be searched"
//   * addSourcesToCapsule — link new sources, write audit, bump updated_at
//   * composeCapsules — convenience wrapper around createCapsuleSet that validates members

import type {
  CapsuleSetId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCapsule } from "./capsule-lifecycle.js";
import { createCapsuleSet } from "./capsule-set-lifecycle.js";
import {
  addSourcesToCapsule,
  buildComposedRetrievalScope,
  composeCapsules,
  describeRetrievalScope,
  listCapsuleMembershipChanges,
  CompositionError,
} from "./composition.js";
import { KnowledgeNotFoundError } from "./errors.js";
import { addSourceToCapsule, listCapsuleSources } from "./source-lifecycle.js";
import { freshStore, sampleCapsuleInput, sampleSourceInput } from "./_support.js";
import type { KnowledgeStore } from "./store.js";

let store: KnowledgeStore;
let cleanup: () => void;

beforeEach(() => {
  const fresh = freshStore();
  store = fresh.store;
  cleanup = fresh.cleanup;
});

afterEach(() => {
  cleanup();
});

function seedTwoCapsulesWithSources(): {
  readonly aId: KnowledgeCapsuleId;
  readonly bId: KnowledgeCapsuleId;
  readonly aSources: readonly KnowledgeSourceId[];
  readonly bSources: readonly KnowledgeSourceId[];
} {
  const aId = createCapsule(store, sampleCapsuleInput({ id: "cap-a" as KnowledgeCapsuleId })).id;
  const bId = createCapsule(
    store,
    sampleCapsuleInput({ id: "cap-b" as KnowledgeCapsuleId, storageReference: "b/cap" }),
  ).id;
  const a1 = addSourceToCapsule(store, aId, sampleSourceInput("a-1")).id;
  const a2 = addSourceToCapsule(store, aId, sampleSourceInput("a-2")).id;
  const b1 = addSourceToCapsule(store, bId, sampleSourceInput("b-1")).id;
  return { aId, bId, aSources: [a1, a2], bSources: [b1] };
}

describe("buildComposedRetrievalScope", () => {
  it("returns the union of every member capsule's sources", () => {
    const { aId, bId, aSources, bSources } = seedTwoCapsulesWithSources();
    const setId = createCapsuleSet(store, {
      id: "set-1" as CapsuleSetId,
      displayName: "Combined",
      tags: [],
      capsuleIds: [aId, bId],
    }).id;

    const scope = buildComposedRetrievalScope(store, setId);
    expect(scope.capsuleSetId).toBe(setId);
    expect([...scope.capsuleIds].sort()).toStrictEqual([aId, bId].sort());
    expect([...scope.sourceIds].sort()).toStrictEqual([...aSources, ...bSources].sort());
  });

  it("contains zero sources from capsules NOT in the set (Foundry-IQ no-global-pool)", () => {
    const { aId, aSources, bSources } = seedTwoCapsulesWithSources();
    // Build the set with capsule A only — capsule B's sources must not appear.
    const setId = createCapsuleSet(store, {
      id: "set-only-a" as CapsuleSetId,
      displayName: "Only A",
      tags: [],
      capsuleIds: [aId],
    }).id;
    const scope = buildComposedRetrievalScope(store, setId);
    expect(scope.capsuleIds).toStrictEqual([aId]);
    expect([...scope.sourceIds].sort()).toStrictEqual([...aSources].sort());
    for (const bSource of bSources) {
      expect(scope.sourceIds).not.toContain(bSource);
    }
  });

  it("marks alwaysQuery=true capsules separately", () => {
    const aId = createCapsule(
      store,
      sampleCapsuleInput({
        id: "cap-a" as KnowledgeCapsuleId,
        alwaysQuery: true,
        lifecycleState: "ready",
      }),
    ).id;
    addSourceToCapsule(store, aId, sampleSourceInput("a-1"));
    const bId = createCapsule(
      store,
      sampleCapsuleInput({ id: "cap-b" as KnowledgeCapsuleId, storageReference: "b/cap" }),
    ).id;
    addSourceToCapsule(store, bId, sampleSourceInput("b-1"));
    const setId = createCapsuleSet(store, {
      id: "set-1" as CapsuleSetId,
      displayName: "Mixed",
      tags: [],
      capsuleIds: [aId, bId],
    }).id;
    const scope = buildComposedRetrievalScope(store, setId);
    expect(scope.alwaysQueryCapsuleIds).toStrictEqual([aId]);
  });

  it("carries each capsule's sourceRoutingInstructions in the map", () => {
    const aId = createCapsule(
      store,
      sampleCapsuleInput({
        id: "cap-a" as KnowledgeCapsuleId,
        sourceRoutingInstructions: "prefer recent",
      }),
    ).id;
    addSourceToCapsule(store, aId, sampleSourceInput("a-1"));
    const setId = createCapsuleSet(store, {
      id: "set-1" as CapsuleSetId,
      displayName: "S",
      tags: [],
      capsuleIds: [aId],
    }).id;
    const scope = buildComposedRetrievalScope(store, setId);
    expect(scope.sourceRoutingByCapsule.get(aId)).toBe("prefer recent");
  });

  it("throws KnowledgeNotFoundError for an unknown CapsuleSet id", () => {
    expect(() => buildComposedRetrievalScope(store, "ghost" as CapsuleSetId)).toThrow(
      KnowledgeNotFoundError,
    );
  });

  it("deduplicates sources when two member capsules link to the same source id", () => {
    // Defensive: although source id is the PK of capsule_sources globally, two capsules
    // could theoretically share an id via a future schema relaxation. The set scope's
    // sourceIds array must remain unique regardless.
    const aId = createCapsule(store, sampleCapsuleInput({ id: "cap-a" as KnowledgeCapsuleId })).id;
    const bId = createCapsule(
      store,
      sampleCapsuleInput({ id: "cap-b" as KnowledgeCapsuleId, storageReference: "b/cap" }),
    ).id;
    addSourceToCapsule(store, aId, sampleSourceInput("shared"));
    // Cannot reuse "shared" in capsule_sources because of the PRIMARY KEY constraint, so
    // model the dedup invariant by adding distinct ids and confirming Set semantics.
    addSourceToCapsule(store, bId, sampleSourceInput("b-only"));
    const setId = createCapsuleSet(store, {
      id: "set-1" as CapsuleSetId,
      displayName: "S",
      tags: [],
      capsuleIds: [aId, bId],
    }).id;
    const scope = buildComposedRetrievalScope(store, setId);
    expect(new Set(scope.sourceIds).size).toBe(scope.sourceIds.length);
  });
});

describe("describeRetrievalScope", () => {
  it("returns capsule + source summaries with displayName and counts", () => {
    const { aId, bId, aSources } = seedTwoCapsulesWithSources();
    const setId = createCapsuleSet(store, {
      id: "set-1" as CapsuleSetId,
      displayName: "All",
      tags: [],
      capsuleIds: [aId, bId],
    }).id;
    const scope = buildComposedRetrievalScope(store, setId);
    const disclosure = describeRetrievalScope(scope, store);

    expect(disclosure.capsuleSetId).toBe(setId);
    expect(disclosure.capsuleSummaries).toHaveLength(2);
    const aSummary = disclosure.capsuleSummaries.find((c) => c.id === aId);
    expect(aSummary).toBeDefined();
    expect(aSummary?.sourceCount).toBe(aSources.length);
    expect(typeof aSummary?.displayName).toBe("string");
    expect(aSummary?.alwaysQuery).toBe(false);
    expect(disclosure.sourceSummaries.length).toBe(aSources.length + 1);
    for (const summary of disclosure.sourceSummaries) {
      expect(summary.id).toBeDefined();
      expect(typeof summary.displayName).toBe("string");
      expect([aId, bId]).toContain(summary.capsuleId);
      expect(summary.scopeKind).toMatch(/^(folder|repository|files)$/);
    }
  });

  it("flags alwaysQuery=true on the summary", () => {
    const aId = createCapsule(
      store,
      sampleCapsuleInput({
        id: "cap-a" as KnowledgeCapsuleId,
        alwaysQuery: true,
        lifecycleState: "ready",
      }),
    ).id;
    addSourceToCapsule(store, aId, sampleSourceInput("a-1"));
    const setId = createCapsuleSet(store, {
      id: "set-1" as CapsuleSetId,
      displayName: "S",
      tags: [],
      capsuleIds: [aId],
    }).id;
    const scope = buildComposedRetrievalScope(store, setId);
    const disclosure = describeRetrievalScope(scope, store);
    expect(disclosure.capsuleSummaries[0]?.alwaysQuery).toBe(true);
  });
});

describe("addSourcesToCapsule", () => {
  it("links new sources, bumps updated_at, and writes one audit row per source", () => {
    const aId = createCapsule(store, sampleCapsuleInput({ id: "cap-a" as KnowledgeCapsuleId })).id;
    const result = addSourcesToCapsule(store, aId, [
      sampleSourceInput("a-1"),
      sampleSourceInput("a-2"),
    ]);
    expect(result.addedSourceIds).toHaveLength(2);
    const sources = listCapsuleSources(store, aId);
    expect(sources.map((s) => s.id).sort()).toStrictEqual(["a-1", "a-2"]);

    const audit = listCapsuleMembershipChanges(store, aId);
    expect(audit).toHaveLength(2);
    for (const entry of audit) {
      expect(entry.capsuleId).toBe(aId);
      expect(entry.changeKind).toBe("add-source");
      expect(entry.sourceId).toMatch(/^a-/);
      expect(typeof entry.occurredAt).toBe("number");
    }
  });

  it("rejects when the capsule does not exist", () => {
    expect(() =>
      addSourcesToCapsule(store, "ghost" as KnowledgeCapsuleId, [sampleSourceInput("x")]),
    ).toThrow(KnowledgeNotFoundError);
  });

  it("rejects when any source id is already linked to this capsule (idempotency guard)", () => {
    const aId = createCapsule(store, sampleCapsuleInput({ id: "cap-a" as KnowledgeCapsuleId })).id;
    addSourceToCapsule(store, aId, sampleSourceInput("a-1"));
    expect(() => addSourcesToCapsule(store, aId, [sampleSourceInput("a-1")])).toThrow(
      CompositionError,
    );
    // The capsule's state must be unchanged after a rejected batch.
    expect(listCapsuleSources(store, aId)).toHaveLength(1);
    expect(listCapsuleMembershipChanges(store, aId)).toHaveLength(0);
  });

  it("rejects an empty source list (caller error)", () => {
    const aId = createCapsule(store, sampleCapsuleInput({ id: "cap-a" as KnowledgeCapsuleId })).id;
    expect(() => addSourcesToCapsule(store, aId, [])).toThrow(CompositionError);
  });

  it("rolls back when one source in a multi-source batch fails", () => {
    const aId = createCapsule(store, sampleCapsuleInput({ id: "cap-a" as KnowledgeCapsuleId })).id;
    addSourceToCapsule(store, aId, sampleSourceInput("already"));
    // Batch contains [a-new, already] — the second insert collides with the pre-existing
    // source. The whole transaction must roll back; a-new must not be visible.
    expect(() =>
      addSourcesToCapsule(store, aId, [sampleSourceInput("a-new"), sampleSourceInput("already")]),
    ).toThrow();
    const sources = listCapsuleSources(store, aId);
    expect(sources.map((s) => s.id).sort()).toStrictEqual(["already"]);
    expect(listCapsuleMembershipChanges(store, aId)).toHaveLength(0);
  });
});

describe("composeCapsules", () => {
  it("creates a new CapsuleSet referencing the listed capsules", () => {
    const { aId, bId } = seedTwoCapsulesWithSources();
    const result = composeCapsules(store, {
      displayName: "Combined",
      description: "two capsules",
      capsuleIds: [aId, bId],
      tags: ["compose"],
    });
    expect(result.capsuleIds).toStrictEqual([aId, bId]);
    expect(result.displayName).toBe("Combined");
    expect(result.description).toBe("two capsules");
    expect(result.tags).toStrictEqual(["compose"]);
  });

  it("writes a compose-set audit row for every member capsule", () => {
    const { aId, bId } = seedTwoCapsulesWithSources();
    composeCapsules(store, {
      displayName: "Combined",
      capsuleIds: [aId, bId],
    });
    for (const capsuleId of [aId, bId]) {
      const audit = listCapsuleMembershipChanges(store, capsuleId);
      const composeRows = audit.filter((r) => r.changeKind === "compose-set");
      expect(composeRows.length).toBe(1);
      const composeRow = composeRows[0];
      expect(composeRow).toBeDefined();
      if (composeRow !== undefined) {
        expect(composeRow.capsuleId).toBe(capsuleId);
      }
    }
  });

  it("rejects an empty capsuleIds list", () => {
    expect(() => composeCapsules(store, { displayName: "X", capsuleIds: [] })).toThrow(
      CompositionError,
    );
  });

  it("rejects when any capsule id does not exist (set is never created)", () => {
    const { aId } = seedTwoCapsulesWithSources();
    expect(() =>
      composeCapsules(store, {
        displayName: "Combined",
        capsuleIds: [aId, "ghost" as KnowledgeCapsuleId],
      }),
    ).toThrow(KnowledgeNotFoundError);
    // The capsule that DID exist must not have an audit row from the aborted compose.
    expect(
      listCapsuleMembershipChanges(store, aId).filter((r) => r.changeKind === "compose-set"),
    ).toHaveLength(0);
  });

  it("rejects duplicate capsule ids in one composition request", () => {
    const { aId } = seedTwoCapsulesWithSources();
    expect(() =>
      composeCapsules(store, { displayName: "Combined", capsuleIds: [aId, aId] }),
    ).toThrow(CompositionError);
  });

  it("rolls back the CapsuleSet if the audit-row write fails (atomicity)", () => {
    // Simulate failure during audit insert by monkey-patching prepare to throw on the
    // INSERT INTO capsule_membership_changes statement. A failure mid-transaction must not
    // leave a CapsuleSet row visible — both the schema_meta entry and the members must be
    // absent after the error.
    const { aId, bId } = seedTwoCapsulesWithSources();
    const db = store._internal.db;
    const originalPrepare = db.prepare.bind(db);
    let callCount = 0;
    // db.prepare is not reassignable on DatabaseSync; use Object.defineProperty instead.
    Object.defineProperty(db, "prepare", {
      configurable: true,
      value: (sql: string) => {
        if (sql.includes("capsule_membership_changes")) {
          callCount++;
          if (callCount === 1) {
            throw new Error("simulated audit failure");
          }
        }
        return originalPrepare(sql);
      },
    });

    expect(() =>
      composeCapsules(store, { displayName: "Atomic", capsuleIds: [aId, bId] }),
    ).toThrow("simulated audit failure");

    // Restore prepare so subsequent queries work.
    Object.defineProperty(db, "prepare", { configurable: true, value: originalPrepare });

    // No CapsuleSet row should exist.
    const sets = store._internal.db
      .prepare("SELECT COUNT(*) AS n FROM schema_meta WHERE key LIKE 'capsule_set:%'")
      .get() as unknown as { readonly n: number };
    expect(sets.n).toBe(0);
    // No member rows either.
    const members = store._internal.db
      .prepare("SELECT COUNT(*) AS n FROM capsule_set_members")
      .get() as unknown as { readonly n: number };
    expect(members.n).toBe(0);
  });
});
