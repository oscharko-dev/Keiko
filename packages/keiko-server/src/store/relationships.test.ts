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

// Issue #542 AC4 — the six finding categories (stale, blocked, failed/revoked,
// invalid, cycle, orphaned) must each be populated independently. Each test
// below isolates one category so that a single-line mutation of the
// corresponding `selectFindings*` call (or its filter predicate) in
// `computeHealthFindings` would surface as a unique failure.
describe("graphHealth categorized findings (issue #542 AC4)", () => {
  it("surfaces stale relationships in findings.staleRelationships", () => {
    const db = openMem();
    insertRelationship(db, makeRel({ id: "rel-stale", lifecycleState: "stale" }));
    const { findings } = graphHealth(db, workspaceA);
    expect(findings.staleRelationships.map((r) => r.id)).toContain("rel-stale");
    expect(findings.staleRelationshipsTruncated).toBe(false);
    expect(findings.blockedRelationships).toHaveLength(0);
    expect(findings.failedRelationships).toHaveLength(0);
  });

  it("surfaces blocked relationships in findings.blockedRelationships", () => {
    const db = openMem();
    insertRelationship(db, makeRel({ id: "rel-blocked", lifecycleState: "blocked" }));
    const { findings } = graphHealth(db, workspaceA);
    expect(findings.blockedRelationships.map((r) => r.id)).toContain("rel-blocked");
    expect(findings.blockedRelationshipsTruncated).toBe(false);
  });

  it("surfaces revoked relationships in findings.failedRelationships (alias)", () => {
    const db = openMem();
    insertRelationship(db, makeRel({ id: "rel-revoked", lifecycleState: "revoked" }));
    const { findings } = graphHealth(db, workspaceA);
    expect(findings.failedRelationships.map((r) => r.id)).toContain("rel-revoked");
    expect(findings.failedRelationships[0]?.lifecycle).toBe("revoked");
  });

  it("surfaces relationships referencing unsupported object kinds in findings.invalidReferences", () => {
    // `agent` is in the DB CHECK list but not in RELATIONSHIP_SUPPORTED_OBJECT_KINDS
    // (taxonomy.md §4.2: forward-looking kinds awaiting their owning registry). The
    // invalid-reference scan returns rows whose endpoint kind is in the CHECK set but
    // not in the JS-runtime supported set, modelling data drift across registries.
    const db = openMem();
    db.prepare(
      `INSERT INTO relationships(
         id, schema_version, workspace_scope_id, scope_kind, scope_coordinate, type,
         source_kind, source_id, target_kind, target_id, lifecycle,
         created_at, updated_at, etag
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "rel-invalid",
      "1",
      workspaceA,
      "workspace",
      workspaceA,
      "depends-on",
      "agent",
      "agent-1",
      "capsule",
      "cap-2",
      "active",
      1000,
      1000,
      "etag-invalid",
    );
    const { findings } = graphHealth(db, workspaceA);
    expect(findings.invalidReferences.map((r) => r.id)).toContain("rel-invalid");
    expect(findings.invalidReferencesTruncated).toBe(false);
  });

  it("surfaces cycle participants when two active relationships form a 2-cycle", () => {
    const db = openMem();
    insertRelationship(
      db,
      makeRel({
        id: "rel-cycle-a",
        source: { kind: "capsule", id: "cap-1", workspaceId: workspaceA },
        target: { kind: "capsule", id: "cap-2", workspaceId: workspaceA },
      }),
    );
    insertRelationship(
      db,
      makeRel({
        id: "rel-cycle-b",
        source: { kind: "capsule", id: "cap-2", workspaceId: workspaceA },
        target: { kind: "capsule", id: "cap-1", workspaceId: workspaceA },
      }),
    );
    const { findings } = graphHealth(db, workspaceA);
    const cycleIds = findings.cycleParticipants.map((r) => r.id).sort();
    expect(cycleIds).toEqual(["rel-cycle-a", "rel-cycle-b"]);
    expect(findings.cycleScanTruncated).toBe(false);
  });

  it("surfaces endpoints whose only relationships are inactive in findings.orphanedEndpoints", () => {
    const db = openMem();
    // Insert directly with lifecycle=revoked so the endpoint has any_total > 0 but
    // active_total = 0 (active here means lifecycle in {draft, active, archived}).
    insertRelationship(db, makeRel({ id: "rel-orphan", lifecycleState: "revoked" }));
    const { findings } = graphHealth(db, workspaceA);
    const orphanKeys = findings.orphanedEndpoints.map((e) => `${e.kind}/${e.id}`).sort();
    expect(orphanKeys).toContain("capsule/cap-1");
    expect(orphanKeys).toContain("capsule/cap-2");
    expect(findings.orphanedEndpointsTruncated).toBe(false);
  });

  it("isolates findings to the calling workspace", () => {
    const db = openMem();
    insertRelationship(db, makeRel({ id: "rel-a-stale", lifecycleState: "stale" }));
    const otherWorkspace = graphHealth(db, workspaceB);
    expect(otherWorkspace.totals.stale).toBe(0);
    expect(otherWorkspace.findings.staleRelationships).toHaveLength(0);
    expect(otherWorkspace.findings.blockedRelationships).toHaveLength(0);
    expect(otherWorkspace.findings.failedRelationships).toHaveLength(0);
    expect(otherWorkspace.findings.invalidReferences).toHaveLength(0);
    expect(otherWorkspace.findings.cycleParticipants).toHaveLength(0);
    expect(otherWorkspace.findings.orphanedEndpoints).toHaveLength(0);
  });
});

// Issue #542 AC1 — walk bounds. Each call site that passes through
// `validateWalkBounds` must reject out-of-range inputs at the store barrier,
// even when the handler-layer clamp is bypassed (tests injecting the store
// directly do that). The handler layer is a separate barrier and not under test
// here.
describe("validateWalkBounds boundary enforcement (issue #542 AC1)", () => {
  it("rejects maxDepth <= 0", () => {
    const db = openMem();
    insertRelationship(db, makeRel({ id: "rel-1" }));
    expect(() =>
      walkDependencies(db, {
        workspaceId: workspaceA,
        originId: "rel-1",
        direction: "outgoing",
        maxDepth: 0,
        maxNodes: 16,
        maxRelationships: 16,
      }),
    ).toThrow();
  });

  it("rejects maxDepth above the hard cap", () => {
    const db = openMem();
    insertRelationship(db, makeRel({ id: "rel-1" }));
    expect(() =>
      walkDependencies(db, {
        workspaceId: workspaceA,
        originId: "rel-1",
        direction: "outgoing",
        maxDepth: 4,
        maxNodes: 16,
        maxRelationships: 16,
      }),
    ).toThrow();
  });

  it("rejects maxNodes <= 0 and maxNodes above 1024", () => {
    const db = openMem();
    insertRelationship(db, makeRel({ id: "rel-1" }));
    for (const maxNodes of [0, 1025]) {
      expect(() =>
        walkDependencies(db, {
          workspaceId: workspaceA,
          originId: "rel-1",
          direction: "outgoing",
          maxDepth: 1,
          maxNodes,
          maxRelationships: 16,
        }),
      ).toThrow();
    }
  });

  it("rejects maxRelationships <= 0 and maxRelationships above 2048", () => {
    const db = openMem();
    insertRelationship(db, makeRel({ id: "rel-1" }));
    for (const maxRelationships of [0, 2049]) {
      expect(() =>
        walkDependencies(db, {
          workspaceId: workspaceA,
          originId: "rel-1",
          direction: "outgoing",
          maxDepth: 1,
          maxNodes: 16,
          maxRelationships,
        }),
      ).toThrow();
    }
  });
});

// Issue #542 AC1+AC3 — walk truncation reasons. Drive each truncation flag
// with the smallest legal limits so the test is fast and the cap classifier
// is exercised. A single-line mutation that erases the truncation reason or
// loosens the cap will surface here.
describe("dependency walk truncation flags (issue #542 AC1 + AC3)", () => {
  it("flags truncationReason 'max-relationships' when the relationship cap is reached", () => {
    const db = openMem();
    // cap-1 -> cap-2 and cap-1 -> cap-3; with maxRelationships=1 the second hop
    // is rejected and the walk reports truncation.
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
        source: { kind: "capsule", id: "cap-1", workspaceId: workspaceA },
        target: { kind: "capsule", id: "cap-3", workspaceId: workspaceA },
      }),
    );
    const result = computeImpact(db, {
      workspaceId: workspaceA,
      endpoint: { kind: "capsule", id: "cap-1" },
      direction: "outgoing",
      maxDepth: 2,
      maxNodes: 16,
      maxRelationships: 1,
    });
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max-relationships");
  });

  it("flags truncationReason 'max-nodes' when the node cap is reached", () => {
    const db = openMem();
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
        source: { kind: "capsule", id: "cap-1", workspaceId: workspaceA },
        target: { kind: "capsule", id: "cap-3", workspaceId: workspaceA },
      }),
    );
    const result = computeImpact(db, {
      workspaceId: workspaceA,
      endpoint: { kind: "capsule", id: "cap-1" },
      direction: "outgoing",
      maxDepth: 2,
      maxNodes: 1,
      maxRelationships: 16,
    });
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toBe("max-nodes");
  });
});

// `MAX_LIST_LIMIT` is referenced by the walk tests so its current value (256)
// stays observable from this file — guards against silent constant drift.
describe("MAX_LIST_LIMIT export", () => {
  it("is positive and finite", () => {
    expect(MAX_LIST_LIMIT).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_LIST_LIMIT)).toBe(true);
  });
});
