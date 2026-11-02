import { describe, expect, expectTypeOf, it } from "vitest";
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

import { makeMemoryRecord as publicMemoryRecord } from "@oscharko-dev/keiko-contracts/memory-fixtures";

type PublicMemoryRecord = ReturnType<typeof publicMemoryRecord>;
type PublicUserScope = Extract<PublicMemoryRecord["scope"], { kind: "user" }>;

it("retains distinct genuine Memory and User nominal domains at the public builder", () => {
  expectTypeOf<PublicMemoryRecord["id"]>().toExtend<string>();
  expectTypeOf<PublicMemoryRecord["id"]>().not.toEqualTypeOf<string>();
  expectTypeOf<PublicUserScope["userId"]>().toExtend<string>();
  expectTypeOf<PublicUserScope["userId"]>().not.toEqualTypeOf<string>();
  expectTypeOf<PublicMemoryRecord["id"]>().not.toExtend<PublicUserScope["userId"]>();
  expectTypeOf<PublicMemoryRecord["createdAt"]>().toEqualTypeOf<number>();
});

describe.each([
  ["source", makeMemoryRecord],
  ["public", publicMemoryRecord],
])("%s actual nominal fixture preservation", (_label, build) => {
  it("keeps validated defaults, override identity and nested references", () => {
    const initial = build();
    expect(validateMemoryRecord(initial).ok).toBe(true);
    expect(initial.id).toBe("m-1");
    expect(initial.scope).toEqual({ kind: "user", userId: "u-1" });
    const overrides = { tags: ["owned"] };
    const output = build(overrides);
    expect(output.tags).toBe(overrides.tags);
    expect(validateMemoryRecord(output).ok).toBe(true);
  });
});

it("preserves genuinely public nested override references", () => {
  const provenance = publicMemoryRecord().provenance;
  const output = publicMemoryRecord({ provenance });
  expect(output.provenance).toBe(provenance);
  expect(validateMemoryRecord(output).ok).toBe(true);
});
