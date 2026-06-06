// Issue #539 — relationship store layer tests. Mirrors the projects.test.ts pattern with
// :memory: SQLite via createInMemoryUiStore's underlying DatabaseSync. We instantiate the
// DB directly (the public UiStore does not surface relationship CRUD) so the tests exercise
// the SQL barrier honestly.

import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./schema.js";
import {
  insertRelationship,
  getRelationship,
  listRelationships,
  updateRelationshipLifecycle,
  reconnectRelationship,
  findRelationshipsBySource,
  findRelationshipsByTarget,
  walkDependencies,
  computeImpact,
  graphHealth,
  relationshipCardinalitySnapshot,
  listRelationshipLifecycleHistory,
  MAX_LIST_LIMIT,
  type NewRelationship,
  type RelationshipScope,
} from "./relationships.js";

function openMem(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

const workspaceA = "ws-a";
const workspaceB = "ws-b";
const scopeA: RelationshipScope = { kind: "workspace", workspaceId: workspaceA };
const scopeB: RelationshipScope = { kind: "workspace", workspaceId: workspaceB };

function makeRel(overrides: Partial<NewRelationship> = {}): NewRelationship {
  const id = overrides.id ?? "rel-1";
  return {
    id,
    workspaceId: workspaceA,
    scope: scopeA,
    type: "depends-on",
    source: { kind: "capsule", id: "cap-1", workspaceId: workspaceA },
    target: { kind: "capsule", id: "cap-2", workspaceId: workspaceA },
    lifecycleState: "active",
    createdAt: 1000,
    updatedAt: 1000,
    etag: `etag-${id}`,
    ...overrides,
  };
}

describe("insertRelationship + getRelationship", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openMem();
  });

  it("inserts a relationship and reads it back", () => {
    const inserted = insertRelationship(db, makeRel());
    expect(inserted.id).toBe("rel-1");
    expect(inserted.lifecycleState).toBe("active");
    const fetched = getRelationship(db, "rel-1", workspaceA);
    expect(fetched?.id).toBe("rel-1");
  });

  it("workspace-scopes reads — workspaceB cannot see workspaceA's row", () => {
    insertRelationship(db, makeRel());
    expect(getRelationship(db, "rel-1", workspaceB)).toBeUndefined();
  });

  it("writes a draft→<lifecycle> history row on insert", () => {
    insertRelationship(db, makeRel({ lifecycleState: "active" }));
    const history = listRelationshipLifecycleHistory(db, "rel-1");
    expect(history).toHaveLength(1);
    expect(history[0]?.fromState).toBe("draft");
    expect(history[0]?.toState).toBe("active");
  });

  it("rejects a duplicate produces-evidence relationship on the same source (cardinality)", () => {
    insertRelationship(
      db,
      makeRel({
        id: "rel-prod-1",
        type: "produces-evidence",
        source: { kind: "workflow-run", id: "run-1", workspaceId: workspaceA },
        target: { kind: "evidence-run", id: "ev-1", workspaceId: workspaceA },
      }),
    );
    expect(() =>
      insertRelationship(
        db,
        makeRel({
          id: "rel-prod-2",
          type: "produces-evidence",
          source: { kind: "workflow-run", id: "run-1", workspaceId: workspaceA },
          target: { kind: "evidence-run", id: "ev-2", workspaceId: workspaceA },
        }),
      ),
    ).toThrow();
  });
});

describe("updateRelationshipLifecycle", () => {
  it("transitions active → archived and records a history row", () => {
    const db = openMem();
    insertRelationship(db, makeRel());
    updateRelationshipLifecycle(db, {
      id: "rel-1",
      workspaceId: workspaceA,
      to: "archived",
      previous: "active",
      newEtag: "etag-2",
      updatedAt: 2000,
      summary: "operator archived",
    });
    const fetched = getRelationship(db, "rel-1", workspaceA);
    expect(fetched?.lifecycleState).toBe("archived");
    const history = listRelationshipLifecycleHistory(db, "rel-1");
    expect(history).toHaveLength(2);
    expect(history[0]?.toState).toBe("archived");
  });

  it("workspace-scopes updates — wrong workspaceId surfaces not_found", () => {
    const db = openMem();
    insertRelationship(db, makeRel());
    expect(() =>
      updateRelationshipLifecycle(db, {
        id: "rel-1",
        workspaceId: workspaceB,
        to: "archived",
        previous: "active",
        newEtag: "etag-2",
        updatedAt: 2000,
      }),
    ).toThrow();
  });
});

describe("reconnectRelationship", () => {
  it("changes target endpoint for a reconnectable type", () => {
    const db = openMem();
    insertRelationship(
      db,
      makeRel({
        type: "references-document",
        source: { kind: "chat", id: "chat-1", workspaceId: workspaceA },
        target: { kind: "workspace-path", id: "src/old.ts", workspaceId: workspaceA },
      }),
    );
    const updated = reconnectRelationship(db, {
      id: "rel-1",
      workspaceId: workspaceA,
      target: { kind: "workspace-path", id: "src/new.ts" },
      newEtag: "etag-3",
      updatedAt: 3000,
    });
    expect(updated.target.id).toBe("src/new.ts");
  });
});

describe("listRelationships (bounded query)", () => {
  it("applies workspace scope and at-least-one selective filter", () => {
    const db = openMem();
    insertRelationship(db, makeRel({ id: "rel-1" }));
    insertRelationship(
      db,
      makeRel({
        id: "rel-2",
        scope: scopeB,
        workspaceId: workspaceB,
        source: { kind: "capsule", id: "cap-1", workspaceId: workspaceB },
        target: { kind: "capsule", id: "cap-2", workspaceId: workspaceB },
      }),
    );
    const a = listRelationships(db, {
      workspaceId: workspaceA,
      type: "depends-on",
      limit: 64,
    });
    expect(a.entries).toHaveLength(1);
    expect(a.entries[0]?.workspaceId).toBe(workspaceA);
  });

  it("rejects limits above the hard cap", () => {
    const db = openMem();
    expect(() =>
      listRelationships(db, {
        workspaceId: workspaceA,
        type: "depends-on",
        limit: MAX_LIST_LIMIT + 1,
      }),
    ).toThrow();
  });

  it("returns truncated=true and a nextCursor when more rows match than the limit", () => {
    const db = openMem();
    for (let i = 0; i < 4; i++) {
      insertRelationship(
        db,
        makeRel({
          id: `rel-${String(i)}`,
          etag: `etag-${String(i)}`,
          source: { kind: "capsule", id: `cap-${String(i)}`, workspaceId: workspaceA },
        }),
      );
    }
    const result = listRelationships(db, {
      workspaceId: workspaceA,
      type: "depends-on",
      limit: 2,
    });
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(typeof result.nextCursor).toBe("string");
  });
});

describe("walkDependencies + computeImpact", () => {
  it("walks outgoing edges within maxDepth", () => {
    const db = openMem();
    // capsule cap-1 -depends-on-> capsule cap-2 -depends-on-> capsule cap-3
    insertRelationship(
      db,
      makeRel({
        id: "rel-a",
        source: { kind: "capsule", id: "cap-1", workspaceId: workspaceA },
        target: { kind: "capsule", id: "cap-2", workspaceId: workspaceA },
      }),
    );
    insertRelationship(
      db,
      makeRel({
        id: "rel-b",
        source: { kind: "capsule", id: "cap-2", workspaceId: workspaceA },
        target: { kind: "capsule", id: "cap-3", workspaceId: workspaceA },
      }),
    );
    const result = walkDependencies(db, {
      workspaceId: workspaceA,
      originId: "rel-a",
      direction: "outgoing",
      maxDepth: 2,
      maxNodes: 256,
      maxRelationships: 512,
    });
    const ids = result.relationships.map((r) => r.id).sort();
    expect(ids).toContain("rel-a");
    expect(ids).toContain("rel-b");
  });

  it("computeImpact returns walk from an endpoint without requiring a focal relationship id", () => {
    const db = openMem();
    insertRelationship(
      db,
      makeRel({
        id: "rel-a",
        source: { kind: "capsule", id: "cap-1", workspaceId: workspaceA },
        target: { kind: "capsule", id: "cap-2", workspaceId: workspaceA },
      }),
    );
    const result = computeImpact(db, {
      workspaceId: workspaceA,
      endpoint: { kind: "capsule", id: "cap-1" },
      direction: "outgoing",
      maxDepth: 1,
      maxNodes: 256,
      maxRelationships: 512,
    });
    expect(result.relationships.map((r) => r.id)).toContain("rel-a");
  });
});

describe("findRelationshipsBySource + findRelationshipsByTarget", () => {
  it("returns workspace-scoped matches only", () => {
    const db = openMem();
    insertRelationship(db, makeRel({ id: "rel-1" }));
    const fromSource = findRelationshipsBySource(
      db,
      workspaceA,
      { kind: "capsule", id: "cap-1" },
      64,
    );
    expect(fromSource.map((r) => r.id)).toEqual(["rel-1"]);
    const wrongWs = findRelationshipsBySource(db, workspaceB, { kind: "capsule", id: "cap-1" }, 64);
    expect(wrongWs).toHaveLength(0);
    const toTarget = findRelationshipsByTarget(
      db,
      workspaceA,
      { kind: "capsule", id: "cap-2" },
      64,
    );
    expect(toTarget.map((r) => r.id)).toEqual(["rel-1"]);
  });
});

describe("graphHealth + relationshipCardinalitySnapshot", () => {
  it("returns lifecycle totals and zero counts for unknown endpoints", () => {
    const db = openMem();
    insertRelationship(db, makeRel({ id: "rel-1", lifecycleState: "active" }));
    insertRelationship(db, makeRel({ id: "rel-2", lifecycleState: "archived" }));
    const health = graphHealth(db, workspaceA);
    expect(health.totals.active).toBe(1);
    expect(health.totals.archived).toBe(1);
    const snap = relationshipCardinalitySnapshot(
      db,
      workspaceA,
      { kind: "workflow-run", id: "run-ghost" },
      { kind: "workflow-run", id: "run-ghost" },
    );
    expect(snap.producesEvidenceForSource).toBe(0);
    expect(snap.startsWorkflowForTarget).toBe(0);
  });
});
