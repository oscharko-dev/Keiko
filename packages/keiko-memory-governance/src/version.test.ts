import { describe, expect, it } from "vitest";

import { KEIKO_MEMORY_GOVERNANCE_VERSION } from "./version.js";

describe("KEIKO_MEMORY_GOVERNANCE_VERSION", () => {
  it("pins the package version", () => {
    expect(KEIKO_MEMORY_GOVERNANCE_VERSION).toBe("0.1.0");
  });
});
