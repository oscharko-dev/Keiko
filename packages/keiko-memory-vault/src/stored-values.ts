// Typed reads of the memory vocabularies and id brands the vault stores as plain TEXT columns.
// Every value here was written from an already validated record, edge, scope or delete option, so
// valid data reads exactly as before; a drifted or tampered value fails closed with schema-mismatch.

import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import {
  MEMORY_EDGE_KINDS,
  MEMORY_SCOPE_KINDS,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCE_KINDS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
} from "@oscharko-dev/keiko-contracts/memory";
import { closedVocabulary, idColumn, type VaultSqlRow } from "./statements.js";

export const STORED_MEMORY_EDGE_KINDS = closedVocabulary(MEMORY_EDGE_KINDS);
export const STORED_MEMORY_SCOPE_KINDS = closedVocabulary(MEMORY_SCOPE_KINDS);
export const STORED_MEMORY_SENSITIVITIES = closedVocabulary(MEMORY_SENSITIVITIES);
export const STORED_MEMORY_SOURCE_KINDS = closedVocabulary(MEMORY_SOURCE_KINDS);
export const STORED_MEMORY_STATUSES = closedVocabulary(MEMORY_STATUSES);
export const STORED_MEMORY_TYPES = closedVocabulary(MEMORY_TYPES);

// The memory contracts brand every vault id as a plain string, and the brands are erased at
// runtime. The record, edge and provenance validators admit an id only when it is a non-empty
// string after trimming, so that is the definition a stored-id predicate can check. Each reader
// declares its brand's predicate over this check; the reviewer id has its own, looser rule.
export function isAdmittedIdText(value: string): boolean {
  return value.trim().length > 0;
}

export function isStoredMemoryId(value: string): value is MemoryId {
  return isAdmittedIdText(value);
}

export function memoryIdColumn(row: VaultSqlRow, column: string): MemoryId {
  return idColumn(row, column, isStoredMemoryId);
}
