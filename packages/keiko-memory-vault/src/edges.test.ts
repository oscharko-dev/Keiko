import { describe, expect, it } from "vitest";
import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
  UserId,
} from "@oscharko-dev/keiko-contracts/memory";
import { insertMemoryRow } from "./memories.js";
import { openTestDb, TEST_CIPHER } from "./_support.js";
import {
  deleteEdgeRow,
  insertEdgeRow,
  listIncomingEdgeRows,
  listOutgoingEdgeRows,
} from "./edges.js";

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
    const db = openTestDb();
    insertMemoryRow(db, makeMemory("a"), TEST_CIPHER);
    insertMemoryRow(db, makeMemory("b"), TEST_CIPHER);
    insertMemoryRow(db, makeMemory("c"), TEST_CIPHER);
    insertEdgeRow(db, makeEdge("e1", "a", "b", "supersedes", 1), TEST_CIPHER);
    insertEdgeRow(db, makeEdge("e2", "b", "c", "related", 2), TEST_CIPHER);
    expect(listOutgoingEdgeRows(db, "a" as MemoryId, TEST_CIPHER)).toEqual([
      makeEdge("e1", "a", "b", "supersedes", 1),
    ]);
    expect(listIncomingEdgeRows(db, "c" as MemoryId, TEST_CIPHER)).toEqual([
      makeEdge("e2", "b", "c", "related", 2),
    ]);
    db.close();
  });

  it("orders by created_at ASC", () => {
    const db = openTestDb();
    insertMemoryRow(db, makeMemory("a"), TEST_CIPHER);
    insertMemoryRow(db, makeMemory("b"), TEST_CIPHER);
    insertEdgeRow(db, makeEdge("e2", "a", "b", "related", 200), TEST_CIPHER);
    insertEdgeRow(db, makeEdge("e1", "a", "b", "supersedes", 100), TEST_CIPHER);
    const out = listOutgoingEdgeRows(db, "a" as MemoryId, TEST_CIPHER);
    expect(out.map((e) => e.id)).toEqual(["e1", "e2"]);
    db.close();
  });

  it("round-trips confidence and provenanceSummary when set", () => {
    const db = openTestDb();
    insertMemoryRow(db, makeMemory("a"), TEST_CIPHER);
    insertMemoryRow(db, makeMemory("b"), TEST_CIPHER);
    const edge: MemoryEdge = {
      ...makeEdge("e1", "a", "b", "supersedes"),
      confidence: 0.42,
      provenanceSummary: "consolidation",
    };
    insertEdgeRow(db, edge, TEST_CIPHER);
    expect(listOutgoingEdgeRows(db, "a" as MemoryId, TEST_CIPHER)).toEqual([edge]);
    db.close();
  });
});

describe("edges FK enforcement", () => {
  it("rejects an edge whose from_memory_id does not exist", () => {
    const db = openTestDb();
    insertMemoryRow(db, makeMemory("b"), TEST_CIPHER);
    expect(() => {
      insertEdgeRow(db, makeEdge("e1", "missing", "b", "supersedes"), TEST_CIPHER);
    }).toThrow();
    db.close();
  });

  it("rejects an edge whose to_memory_id does not exist", () => {
    const db = openTestDb();
    insertMemoryRow(db, makeMemory("a"), TEST_CIPHER);
    expect(() => {
      insertEdgeRow(db, makeEdge("e1", "a", "missing", "supersedes"), TEST_CIPHER);
    }).toThrow();
    db.close();
  });
});

describe("edges ON DELETE CASCADE", () => {
  it("removes incident edges when an endpoint memory is deleted", () => {
    const db = openTestDb();
    insertMemoryRow(db, makeMemory("a"), TEST_CIPHER);
    insertMemoryRow(db, makeMemory("b"), TEST_CIPHER);
    insertMemoryRow(db, makeMemory("c"), TEST_CIPHER);
    insertEdgeRow(db, makeEdge("e1", "a", "b", "supersedes", 1), TEST_CIPHER);
    insertEdgeRow(db, makeEdge("e2", "b", "c", "related", 2), TEST_CIPHER);
    db.prepare("DELETE FROM memories WHERE id = ?").run("b");
    expect(listOutgoingEdgeRows(db, "a" as MemoryId, TEST_CIPHER)).toEqual([]);
    expect(listIncomingEdgeRows(db, "c" as MemoryId, TEST_CIPHER)).toEqual([]);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM memory_edges").get() as { n: number };
    expect(remaining.n).toBe(0);
    db.close();
  });
});

describe("deleteEdgeRow", () => {
  it("returns true when an edge is removed and false otherwise", () => {
    const db = openTestDb();
    insertMemoryRow(db, makeMemory("a"), TEST_CIPHER);
    insertMemoryRow(db, makeMemory("b"), TEST_CIPHER);
    insertEdgeRow(db, makeEdge("e1", "a", "b", "supersedes"), TEST_CIPHER);
    expect(deleteEdgeRow(db, "e1" as MemoryEdgeId)).toBe(true);
    expect(deleteEdgeRow(db, "e1" as MemoryEdgeId)).toBe(false);
    db.close();
  });
});
