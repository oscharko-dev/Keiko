import { describe, expect, it } from "vitest";
import { KnowledgeStoreError } from "./errors.js";
import {
  capsuleIdColumn,
  capsuleSetIdColumn,
  chunkIdColumn,
  documentIdColumn,
  isCapsuleSetId,
  isChunkId,
  isDocumentId,
  isKnowledgeCapsuleId,
  isKnowledgeSourceId,
  isVectorId,
  mintedId,
  nullableChunkIdColumn,
  nullableSourceIdColumn,
  sourceIdColumn,
} from "./knowledge-ids.js";
import type { KnowledgeSqlRow } from "./sql-row.js";

const PREDICATES = [
  ["isKnowledgeCapsuleId", isKnowledgeCapsuleId],
  ["isKnowledgeSourceId", isKnowledgeSourceId],
  ["isCapsuleSetId", isCapsuleSetId],
  ["isDocumentId", isDocumentId],
  ["isChunkId", isChunkId],
  ["isVectorId", isVectorId],
] as const;

const READERS = [
  ["capsuleIdColumn", capsuleIdColumn],
  ["sourceIdColumn", sourceIdColumn],
  ["capsuleSetIdColumn", capsuleSetIdColumn],
  ["documentIdColumn", documentIdColumn],
  ["chunkIdColumn", chunkIdColumn],
  ["nullableSourceIdColumn", nullableSourceIdColumn],
  ["nullableChunkIdColumn", nullableChunkIdColumn],
] as const;

const ROW: KnowledgeSqlRow = {
  id: "doc:a:b:c",
  padded: " id ",
  blank: "   ",
  empty: "",
  none: null,
};

describe("knowledge id predicates", () => {
  it.each(PREDICATES)("%s admits a non-blank id as written", (_name, isId) => {
    expect(isId("cap-1")).toBe(true);
    expect(isId(" padded ")).toBe(true);
  });

  it.each(PREDICATES)("%s refuses an id that is blank after trimming", (_name, isId) => {
    expect(isId("")).toBe(false);
    expect(isId("  \t\n")).toBe(false);
  });
});

describe("mintedId", () => {
  it("brands a non-blank minted value unchanged", () => {
    expect(mintedId("doc:a:b:c", isDocumentId)).toBe("doc:a:b:c");
  });

  it("refuses a blank minted value", () => {
    expect(() => mintedId(" ", isChunkId)).toThrow(KnowledgeStoreError);
  });
});

describe("knowledge id column readers", () => {
  it.each(READERS)("%s reads a stored id unchanged", (_name, read) => {
    expect(read(ROW, "id")).toBe("doc:a:b:c");
    expect(read(ROW, "padded")).toBe(" id ");
  });

  it.each(READERS)("%s refuses a stored blank id", (_name, read) => {
    expect(() => read(ROW, "blank")).toThrow(/does not admit/u);
    expect(() => read(ROW, "empty")).toThrow(KnowledgeStoreError);
  });

  it("reads a stored NULL only through the nullable readers", () => {
    expect(nullableSourceIdColumn(ROW, "none")).toBeNull();
    expect(nullableChunkIdColumn(ROW, "none")).toBeNull();
    expect(() => sourceIdColumn(ROW, "none")).toThrow(/unexpected type/u);
  });
});
