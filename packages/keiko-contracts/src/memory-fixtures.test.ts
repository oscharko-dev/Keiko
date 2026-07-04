import { describe, expect, it } from "vitest";
import { FIXED_NOW_MS, makeMemoryRecord } from "./memory-fixtures.js";
import { validateMemoryRecord } from "./memory-record-validation.js";

describe("makeMemoryRecord (GEN-DX-001)", () => {
  it("produces a record that validates against the real contract validator", () => {
    const result = validateMemoryRecord(makeMemoryRecord());
    expect(result.ok).toBe(true);
  });

  it("matches the golden defaults", () => {
    const record = makeMemoryRecord();
    expect(record.id).toBe("m-1");
    expect(record.schemaVersion).toBe("1");
    expect(record.scope).toEqual({ kind: "user", userId: "u-1" });
    expect(record.type).toBe("preference");
    expect(record.status).toBe("accepted");
    expect(record.pinned).toBe(false);
    expect(record.tags).toEqual([]);
    expect(record.provenance.sensitivity).toBe("confidential");
    expect(record.provenance.confidence).toBe(0.9);
    expect(record.provenance.capturedAt).toBe(FIXED_NOW_MS);
    expect(record.validity.validFrom).toBe(FIXED_NOW_MS);
    expect(record.createdAt).toBe(FIXED_NOW_MS);
    expect(record.updatedAt).toBe(FIXED_NOW_MS);
    expect(FIXED_NOW_MS).toBe(1_700_000_000_000);
  });

  it("applies overrides last and still validates", () => {
    const record = makeMemoryRecord({ type: "semantic-fact", body: "The API base is v2." });
    expect(record.type).toBe("semantic-fact");
    expect(record.body).toBe("The API base is v2.");
    // Untouched defaults survive the override merge.
    expect(record.status).toBe("accepted");
    expect(validateMemoryRecord(record).ok).toBe(true);
  });
});
