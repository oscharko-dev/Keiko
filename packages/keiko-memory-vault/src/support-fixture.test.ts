// Regression guard for the GEN-DX-001 migration: `makeRecord` now wraps the shared
// contracts fixture builder (`@oscharko-dev/keiko-contracts/memory-fixtures`). This test pins
// the suite-default record so a change to the shared builder's defaults cannot silently shift
// this package's fixtures. The vault builder requires an `id`, so there is no true no-arg
// default; `{ id: "m-1" }` is the minimal invocation.

import { describe, expect, it } from "vitest";
import { makeRecord, memId } from "./_support.js";

describe("_support makeRecord (GEN-DX-001 wrapper)", () => {
  it("reproduces the pre-migration suite-default record", () => {
    expect(makeRecord({ id: memId("m-1") })).toEqual({
      id: "m-1",
      schemaVersion: "1",
      scope: { kind: "user", userId: "u-1" },
      type: "preference",
      body: "prefers dark mode",
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: 1_700_000_000_000,
        confidence: 0.9,
        sensitivity: "confidential",
      },
      validity: { validFrom: 1_700_000_000_000 },
      status: "accepted",
      pinned: false,
      tags: [],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
  });

  it("lets caller overrides win over the wrapped body default", () => {
    const record = makeRecord({ id: memId("m-2"), body: "custom", type: "semantic-fact" });
    expect(record.id).toBe("m-2");
    expect(record.body).toBe("custom");
    expect(record.type).toBe("semantic-fact");
  });
});
