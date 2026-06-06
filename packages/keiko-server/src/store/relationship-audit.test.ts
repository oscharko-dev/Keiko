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
        sequence: 1,
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
        sequence: 1,
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
          sequence: 1,
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
          sequence: 1,
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

  it("enforces append-only via (workspace_id, sequence) unique index", () => {
    insertRelationshipAuditEntry(
      db,
      {
        eventId: "evt-1",
        workspaceId: "ws-a",
        sequence: 1,
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
          eventId: "evt-2",
          workspaceId: "ws-a",
          sequence: 1,
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
});

describe("listRelationshipAuditEntriesForRelationship", () => {
  it("filters by relationship id within a workspace", () => {
    const db = openMem();
    insertRelationshipAuditEntry(
      db,
      {
        eventId: "evt-1",
        workspaceId: "ws-a",
        sequence: 1,
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
        sequence: 2,
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
