import { describe, expect, it } from "vitest";

import { newMemoryEdgeId } from "./memory-record-builders.js";

describe("newMemoryEdgeId", () => {
  it("mints distinct ids the vault's edge gate admits", () => {
    const first = newMemoryEdgeId();
    const second = newMemoryEdgeId();
    expect(first.trim().length).toBeGreaterThan(0);
    expect(first).not.toBe(second);
  });
});
