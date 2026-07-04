// Regression guard for the GEN-DX-001 migration: `makeRecord` now wraps the shared contracts
// fixture builder (`@oscharko-dev/keiko-contracts/memory-fixtures`). This test pins the no-arg
// default record plus the governance-specific `sensitivity` / `sourceConversationId` override
// paths so a change to the shared builder's defaults cannot silently shift this suite's
// fixtures. The `ctx()` GovernanceContext builder stays local (its type is owned here).

import { describe, expect, it } from "vitest";
import { FIXED_NOW_MS, makeRecord } from "./_support.js";

describe("_support makeRecord (GEN-DX-001 wrapper)", () => {
  it("reproduces the pre-migration no-arg default record", () => {
    expect(makeRecord()).toEqual({
      id: "m-1",
      schemaVersion: "1",
      scope: { kind: "user", userId: "u-1" },
      type: "preference",
      body: "prefers dark mode",
      provenance: {
        sourceKind: "explicit-user-instruction",
        capturedAt: FIXED_NOW_MS,
        confidence: 0.9,
        sensitivity: "confidential",
      },
      validity: { validFrom: FIXED_NOW_MS },
      status: "accepted",
      pinned: false,
      tags: [],
      createdAt: FIXED_NOW_MS,
      updatedAt: FIXED_NOW_MS,
    });
  });

  it("honours the flat sensitivity override on provenance", () => {
    expect(makeRecord({ sensitivity: "restricted" }).provenance.sensitivity).toBe("restricted");
  });

  it("attaches sourceConversationId only when supplied", () => {
    expect(makeRecord().provenance.sourceConversationId).toBeUndefined();
    expect(makeRecord({ sourceConversationId: "conv-1" }).provenance.sourceConversationId).toBe(
      "conv-1",
    );
  });
});
