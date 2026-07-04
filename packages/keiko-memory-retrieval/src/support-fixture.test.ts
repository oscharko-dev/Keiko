// Regression guard for the GEN-DX-001 migration: `buildRecord` now wraps the shared contracts
// fixture builder (`@oscharko-dev/keiko-contracts/memory-fixtures`). This suite DELIBERATELY
// diverges from the shared majority defaults (semantic-fact / public / confidence 0.8 /
// timestamps 1000 / body "default body text"), so this test pins the no-arg default record to
// prove the wrapper still passes those divergent values as explicit overrides.

import { describe, expect, it } from "vitest";
import { buildRecord } from "./_support.js";

describe("_support buildRecord (GEN-DX-001 wrapper)", () => {
  it("reproduces the pre-migration divergent no-arg default record", () => {
    expect(buildRecord()).toEqual({
      id: "m1",
      schemaVersion: "1",
      scope: { kind: "user", userId: "u1" },
      type: "semantic-fact",
      body: "default body text",
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: 1_000,
        confidence: 0.8,
        sensitivity: "public",
      },
      validity: { validFrom: 1_000 },
      status: "accepted",
      pinned: false,
      tags: [],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  it("omits staleReason unless supplied", () => {
    expect("staleReason" in buildRecord()).toBe(false);
    expect(buildRecord({ staleReason: "superseded" }).staleReason).toBe("superseded");
  });
});
