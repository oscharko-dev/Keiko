import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
  UserId,
} from "@oscharko-dev/keiko-contracts/memory";
import { runMigrations } from "./schema.js";
import { insertMemoryRow } from "./memories.js";
import {
  deleteEdgeRow,
  insertEdgeRow,
  listIncomingEdgeRows,
  listOutgoingEdgeRows,
} from "./edges.js";

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

function makeMemory(id: string, capturedAt = 1_700_000_000_000): MemoryRecord {
  return {
    id: id as MemoryId,
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as UserId },
    type: "preference",
    body: `body-${id}`,
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt,
      confidence: 0.9,
      sensitivity: "confidential",
    },
    validity: { validFrom: capturedAt },
    status: "accepted",
    pinned: false,
    tags: [],
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
}

function makeEdge(
  id: string,
  from: string,
  to: string,
  kind: MemoryEdge["kind"],
  createdAt = 1_700_000_000_000,
): MemoryEdge {
  return {
    id: id as MemoryEdgeId,
    schemaVersion: "1",
    fromMemoryId: from as MemoryId,
    toMemoryId: to as MemoryId,
    kind,
    createdAt,
  };
}

describe("edges insert + list", () => {
  it("inserts and lists outgoing/incoming edges", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("a"));
    insertMemoryRow(db, makeMemory("b"));
    insertMemoryRow(db, makeMemory("c"));
    insertEdgeRow(db, makeEdge("e1", "a", "b", "supersedes", 1));
    insertEdgeRow(db, makeEdge("e2", "b", "c", "related", 2));
    expect(listOutgoingEdgeRows(db, "a" as MemoryId)).toEqual([
      makeEdge("e1", "a", "b", "supersedes", 1),
    ]);
    expect(listIncomingEdgeRows(db, "c" as MemoryId)).toEqual([
      makeEdge("e2", "b", "c", "related", 2),
    ]);
    db.close();
  });

  it("orders by created_at ASC", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("a"));
    insertMemoryRow(db, makeMemory("b"));
    insertEdgeRow(db, makeEdge("e2", "a", "b", "related", 200));
    insertEdgeRow(db, makeEdge("e1", "a", "b", "supersedes", 100));
    const out = listOutgoingEdgeRows(db, "a" as MemoryId);
    expect(out.map((e) => e.id)).toEqual(["e1", "e2"]);
    db.close();
  });

  it("round-trips confidence and provenanceSummary when set", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("a"));
    insertMemoryRow(db, makeMemory("b"));
    const edge: MemoryEdge = {
      ...makeEdge("e1", "a", "b", "supersedes"),
      confidence: 0.42,
      provenanceSummary: "consolidation",
    };
    insertEdgeRow(db, edge);
    expect(listOutgoingEdgeRows(db, "a" as MemoryId)).toEqual([edge]);
    db.close();
  });
});

describe("edges FK enforcement", () => {
  it("rejects an edge whose from_memory_id does not exist", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("b"));
    expect(() => {
      insertEdgeRow(db, makeEdge("e1", "missing", "b", "supersedes"));
    }).toThrow();
    db.close();
  });

  it("rejects an edge whose to_memory_id does not exist", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("a"));
    expect(() => {
      insertEdgeRow(db, makeEdge("e1", "a", "missing", "supersedes"));
    }).toThrow();
    db.close();
  });
});

describe("edges ON DELETE CASCADE", () => {
  it("removes incident edges when an endpoint memory is deleted", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("a"));
    insertMemoryRow(db, makeMemory("b"));
    insertMemoryRow(db, makeMemory("c"));
    insertEdgeRow(db, makeEdge("e1", "a", "b", "supersedes", 1));
    insertEdgeRow(db, makeEdge("e2", "b", "c", "related", 2));
    db.prepare("DELETE FROM memories WHERE id = ?").run("b");
    expect(listOutgoingEdgeRows(db, "a" as MemoryId)).toEqual([]);
    expect(listIncomingEdgeRows(db, "c" as MemoryId)).toEqual([]);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM memory_edges").get() as { n: number };
    expect(remaining.n).toBe(0);
    db.close();
  });
});

describe("deleteEdgeRow", () => {
  it("returns true when an edge is removed and false otherwise", () => {
    const db = openDb();
    insertMemoryRow(db, makeMemory("a"));
    insertMemoryRow(db, makeMemory("b"));
    insertEdgeRow(db, makeEdge("e1", "a", "b", "supersedes"));
    expect(deleteEdgeRow(db, "e1" as MemoryEdgeId)).toBe(true);
    expect(deleteEdgeRow(db, "e1" as MemoryEdgeId)).toBe(false);
    db.close();
  });
});
