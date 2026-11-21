import type {
  CapsuleSetId,
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  VectorId,
} from "@oscharko-dev/keiko-contracts/runtime/local-knowledge";
import { KnowledgeStoreError } from "./errors.js";
import {
  admittedTextColumn,
  type KnowledgeSqlRow,
  nullableAdmittedTextColumn,
  type TextAdmission,
} from "./sql-row.js";

// The local-knowledge contracts brand every id as a plain string, and the brands are erased at
// runtime. The contract validators admit a capsule, source or capsule-set id only when it is a
// non-empty string after trimming. This package mints document, chunk, vector and capsule-set ids
// from non-empty templates or UUIDs. Non-emptiness after trimming is therefore the whole definition
// an id predicate can check; each brand's admission is built from this one rule.
function idAdmission<T extends string>(): TextAdmission<T> {
  return (value: string): value is T => value.trim().length > 0;
}

export const isKnowledgeCapsuleId = idAdmission<KnowledgeCapsuleId>();
export const isKnowledgeSourceId = idAdmission<KnowledgeSourceId>();
export const isCapsuleSetId = idAdmission<CapsuleSetId>();
export const isDocumentId = idAdmission<DocumentId>();
export const isChunkId = idAdmission<ChunkId>();
export const isVectorId = idAdmission<VectorId>();

// Brands a freshly minted id. Callers build the value from a non-empty template or a UUID, so the
// check cannot fail for them; it keeps the brand's definition in one place instead of an assertion.
export function mintedId<T extends string>(value: string, isId: TextAdmission<T>): T {
  if (!isId(value)) throw new KnowledgeStoreError("A minted knowledge id is blank");
  return value;
}

type IdColumnReader<T extends string> = (row: KnowledgeSqlRow, column: string) => T;
type NullableIdColumnReader<T extends string> = (row: KnowledgeSqlRow, column: string) => T | null;

function idColumnReader<T extends string>(admits: TextAdmission<T>): IdColumnReader<T> {
  return (row, column) => admittedTextColumn(row, column, admits);
}

function nullableIdColumnReader<T extends string>(
  admits: TextAdmission<T>,
): NullableIdColumnReader<T> {
  return (row, column) => nullableAdmittedTextColumn(row, column, admits);
}

export const capsuleIdColumn = idColumnReader(isKnowledgeCapsuleId);
export const sourceIdColumn = idColumnReader(isKnowledgeSourceId);
export const nullableSourceIdColumn = nullableIdColumnReader(isKnowledgeSourceId);
export const capsuleSetIdColumn = idColumnReader(isCapsuleSetId);
export const documentIdColumn = idColumnReader(isDocumentId);
export const chunkIdColumn = idColumnReader(isChunkId);
export const nullableChunkIdColumn = nullableIdColumnReader(isChunkId);
