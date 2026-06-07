// Prepared SQL for the memory_edges table. Same shape pattern as memories.ts: validator gate sits
// in vault.ts before these run; FK enforcement (foreign_keys = ON via db.ts) rejects edges whose
// endpoints don't exist; ON DELETE CASCADE removes incident edges when an endpoint memory is
// hard-deleted.

import type { DatabaseSync } from "node:sqlite";
import type { MemoryEdge, MemoryEdgeId, MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import type { MemoryContentCipher } from "./cipher.js";

interface EdgeRow {
  readonly id: string;
  readonly schema_version: string;
  readonly from_memory_id: string;
  readonly to_memory_id: string;
  readonly kind: string;
  readonly created_at: number;
  readonly confidence: number | null;
  readonly provenance_summary: string | null;
}

const INSERT_SQL = `
INSERT INTO memory_edges (
  id, schema_version, from_memory_id, to_memory_id, kind, created_at,
  confidence, provenance_summary
) VALUES (?,?,?,?,?,?,?,?)
`;

const LIST_OUT_SQL = "SELECT * FROM memory_edges WHERE from_memory_id = ? ORDER BY created_at ASC";
const LIST_IN_SQL = "SELECT * FROM memory_edges WHERE to_memory_id = ? ORDER BY created_at ASC";
const DELETE_SQL = "DELETE FROM memory_edges WHERE id = ?";

// provenance_summary is the only free-text edge column, so it is the only sealed one (ADR-0035).
function rowToEdge(row: EdgeRow, cipher: MemoryContentCipher): MemoryEdge {
  const base = {
    id: row.id as MemoryEdgeId,
    schemaVersion: "1" as const,
    fromMemoryId: row.from_memory_id as MemoryId,
    toMemoryId: row.to_memory_id as MemoryId,
    kind: row.kind as MemoryEdge["kind"],
    createdAt: row.created_at,
  } satisfies Omit<MemoryEdge, "confidence" | "provenanceSummary">;
  return {
    ...base,
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    ...(row.provenance_summary !== null
      ? { provenanceSummary: cipher.openString(row.provenance_summary) }
      : {}),
  };
}

export function insertEdgeRow(
  db: DatabaseSync,
  edge: MemoryEdge,
  cipher: MemoryContentCipher,
): void {
  const provenanceSummary =
    edge.provenanceSummary === undefined ? null : cipher.sealString(edge.provenanceSummary);
  db.prepare(INSERT_SQL).run(
    edge.id,
    edge.schemaVersion,
    edge.fromMemoryId,
    edge.toMemoryId,
    edge.kind,
    edge.createdAt,
    edge.confidence ?? null,
    provenanceSummary,
  );
}

export function listOutgoingEdgeRows(
  db: DatabaseSync,
  memoryId: MemoryId,
  cipher: MemoryContentCipher,
): readonly MemoryEdge[] {
  const rows = db.prepare(LIST_OUT_SQL).all(memoryId) as unknown as readonly EdgeRow[];
  return rows.map((row) => rowToEdge(row, cipher));
}

export function listIncomingEdgeRows(
  db: DatabaseSync,
  memoryId: MemoryId,
  cipher: MemoryContentCipher,
): readonly MemoryEdge[] {
  const rows = db.prepare(LIST_IN_SQL).all(memoryId) as unknown as readonly EdgeRow[];
  return rows.map((row) => rowToEdge(row, cipher));
}

export function deleteEdgeRow(db: DatabaseSync, edgeId: MemoryEdgeId): boolean {
  const info = db.prepare(DELETE_SQL).run(edgeId);
  return info.changes > 0;
}
