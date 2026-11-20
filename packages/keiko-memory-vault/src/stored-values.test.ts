import { describe, expect, it } from "vitest";
import { MemoryStorageError } from "./errors.js";
import {
  isAdmittedIdText,
  isStoredMemoryId,
  memoryIdColumn,
  STORED_MEMORY_EDGE_KINDS,
  STORED_MEMORY_SCOPE_KINDS,
  STORED_MEMORY_SENSITIVITIES,
  STORED_MEMORY_SOURCE_KINDS,
  STORED_MEMORY_STATUSES,
  STORED_MEMORY_TYPES,
} from "./stored-values.js";

const ID_PREDICATES = [isAdmittedIdText, isStoredMemoryId];

describe("stored memory id predicates", () => {
  it("admit every non-empty id, including one the write gate admitted with spaces", () => {
    for (const isId of ID_PREDICATES) {
      expect(isId("m-1")).toBe(true);
      expect(isId(" r ")).toBe(true);
    }
  });

  it("refuse the empty string no write gate admits", () => {
    for (const isId of ID_PREDICATES) expect(isId("")).toBe(false);
  });

  it("read a memory id column and fail closed on an empty one", () => {
    expect(memoryIdColumn({ memory_id: "m-1" }, "memory_id")).toBe("m-1");
    expect(() => memoryIdColumn({ memory_id: "" }, "memory_id")).toThrow(MemoryStorageError);
    expect(() => memoryIdColumn({ memory_id: 1 }, "memory_id")).toThrow(MemoryStorageError);
  });
});

describe("stored memory vocabularies", () => {
  it("hold exactly the contract vocabularies", () => {
    expect([...STORED_MEMORY_EDGE_KINDS.keys()]).toContain("supersedes");
    expect([...STORED_MEMORY_SCOPE_KINDS.keys()]).toEqual([
      "user",
      "workspace",
      "project",
      "workflow",
      "global",
    ]);
    expect(STORED_MEMORY_SENSITIVITIES.get("restricted")).toBe("restricted");
    expect(STORED_MEMORY_SOURCE_KINDS.get("consolidation")).toBe("consolidation");
    expect(STORED_MEMORY_STATUSES.get("forgotten")).toBe("forgotten");
    expect(STORED_MEMORY_TYPES.get("preference")).toBe("preference");
    expect(STORED_MEMORY_TYPES.get("bogus")).toBeUndefined();
  });
});
