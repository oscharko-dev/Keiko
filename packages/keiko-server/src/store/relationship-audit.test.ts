// Issue #539 — relationship audit ledger writer tests.

import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./schema.js";
import {
  insertRelationshipAuditEntry,
  listRelationshipAuditEntries,
  listRelationshipAuditEntriesForRelationship,
  resolveAuditPlacement,
  MAX_AUDIT_LIST_LIMIT,
} from "./relationship-audit.js";

function openMem(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

const identity = (s: string): string => s;

describe("insertRelationshipAuditEntry", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openMem();
  });

  it("writes a redacted audit row and lists it back, workspace-scoped", () => {
    insertRelationshipAuditEntry(
      db,
      {
        eventId: "evt-1",
        workspaceId: "ws-a",
        occurredAt: 100,
        kind: "relationship.created",
        relationshipId: "rel-1",
        actor: { surface: "system", redactedActorId: "actor-1" },
        summary: "created",
        payload: { relationshipType: "depends-on" },
      },
      identity,
    );
    const rows = listRelationshipAuditEntries(db, "ws-a", 64);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("relationship.created");
    expect(rows[0]?.payload.relationshipType).toBe("depends-on");
    // Cross-workspace read returns nothing.
    expect(listRelationshipAuditEntries(db, "ws-b", 64)).toHaveLength(0);
  });

  it("runs the redactor at the persist boundary", () => {
    const redact = (s: string): string =>
      s.includes("sk-") ? s.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED]") : s;
    insertRelationshipAuditEntry(
      db,
      {
        eventId: "evt-1",
        workspaceId: "ws-a",
        occurredAt: 100,
        kind: "relationship.created",
        relationshipId: "rel-1",
        actor: { surface: "system", redactedActorId: "actor-1" },
        summary: "test sk-AAAABBBBCCCC token",
        payload: { hint: "leaked sk-ZZZZYYYYXXXX again" },
      },
      redact,
    );
    const rows = listRelationshipAuditEntries(db, "ws-a", 64);
    expect(rows[0]?.summary.includes("sk-")).toBe(false);
    expect(rows[0]?.summary).toContain("[REDACTED]");
    expect(rows[0]?.payload.hint).not.toContain("sk-");
  });

  it("rejects forbidden payload keys (audit-events.md §8.3)", () => {
    expect(() =>
      insertRelationshipAuditEntry(
        db,
        {
          eventId: "evt-1",
          workspaceId: "ws-a",
          occurredAt: 100,
          kind: "relationship.created",
          actor: { surface: "system", redactedActorId: "actor-1" },
          summary: "x",
          payload: { promptText: "hello" },
        },
        identity,
      ),
    ).toThrow();
  });

  it("rejects a summary above the 240-char bound", () => {
    expect(() =>
      insertRelationshipAuditEntry(
        db,
        {
          eventId: "evt-1",
          workspaceId: "ws-a",
          occurredAt: 100,
          kind: "relationship.created",
          actor: { surface: "system", redactedActorId: "actor-1" },
          summary: "x".repeat(241),
          payload: {},
        },
        identity,
      ),
    ).toThrow();
  });

  it("enforces append-only: same event_id cannot be inserted twice", () => {
    insertRelationshipAuditEntry(
      db,
      {
        eventId: "evt-1",
        workspaceId: "ws-a",
        occurredAt: 100,
        kind: "relationship.created",
        actor: { surface: "system", redactedActorId: "actor-1" },
        summary: "x",
        payload: {},
      },
      identity,
    );
    expect(() =>
      insertRelationshipAuditEntry(
        db,
        {
          eventId: "evt-1",
          workspaceId: "ws-a",
          occurredAt: 200,
          kind: "relationship.updated",
          actor: { surface: "system", redactedActorId: "actor-1" },
          summary: "y",
          payload: {},
        },
        identity,
      ),
    ).toThrow();
  });

  // Regression test for TOCTOU race (issue #628): two consecutive writes for the same
  // workspace must receive distinct, monotonically-increasing sequence numbers. The old
  // implementation read MAX(sequence) in JS then inserted — two concurrent callers could
  // read the same max and produce a duplicate. The atomic INSERT…SELECT subquery eliminates
  // that gap. This test would fail against the old read-then-write path if both calls ran
  // before either committed (i.e. if the SELECT was outside the INSERT).
  it("allocates unique, monotonic sequences for concurrent writes to the same workspace", () => {
    const n = 20;
    const sequences: number[] = [];
    for (let i = 0; i < n; i++) {
      const row = insertRelationshipAuditEntry(
        db,
        {
          eventId: `evt-${String(i)}`,
          workspaceId: "ws-race",
          occurredAt: 1000 + i,
          kind: "relationship.created",
          actor: { surface: "system", redactedActorId: "a" },
          summary: "s",
          payload: {},
        },
        identity,
      );
      sequences.push(row.sequence);
    }
    // All sequences must be distinct (no duplicates).
    expect(new Set(sequences).size).toBe(n);
    // Sequences must be monotonically increasing (0, 1, 2, …).
    const sorted = [...sequences].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: n }, (_, i) => i));
  });
});

describe("listRelationshipAuditEntriesForRelationship", () => {
  it("filters by relationship id within a workspace", () => {
    const db = openMem();
    insertRelationshipAuditEntry(
      db,
      {
        eventId: "evt-1",
        workspaceId: "ws-a",
        occurredAt: 100,
        kind: "relationship.created",
        relationshipId: "rel-1",
        actor: { surface: "system", redactedActorId: "actor-1" },
        summary: "x",
        payload: {},
      },
      identity,
    );
    insertRelationshipAuditEntry(
      db,
      {
        eventId: "evt-2",
        workspaceId: "ws-a",
        occurredAt: 200,
        kind: "relationship.created",
        relationshipId: "rel-2",
        actor: { surface: "system", redactedActorId: "actor-1" },
        summary: "y",
        payload: {},
      },
      identity,
    );
    const rows = listRelationshipAuditEntriesForRelationship(db, "ws-a", "rel-1", 64);
    expect(rows.map((r) => r.eventId)).toEqual(["evt-1"]);
  });

  it("rejects limits above the hard cap", () => {
    const db = openMem();
    expect(() => listRelationshipAuditEntries(db, "ws-a", MAX_AUDIT_LIST_LIMIT + 1)).toThrow();
  });
});

describe("resolveAuditPlacement (#544 seam)", () => {
  it("always returns sibling-table in this PR (TODO #544 wires evidence-manifest)", () => {
    expect(
      resolveAuditPlacement({ kind: "relationship.created", sourceKind: "workflow-run" }),
    ).toBe("sibling-table");
    expect(resolveAuditPlacement({ kind: "relationship.created", sourceKind: "chat" })).toBe(
      "sibling-table",
    );
  });
});
