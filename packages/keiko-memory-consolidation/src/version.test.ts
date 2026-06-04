import { describe, expect, it } from "vitest";

import { KEIKO_MEMORY_CONSOLIDATION_VERSION } from "./version.js";

describe("KEIKO_MEMORY_CONSOLIDATION_VERSION", () => {
  it("pins the package's published version literal", () => {
    expect(KEIKO_MEMORY_CONSOLIDATION_VERSION).toBe("0.1.0");
  });
});
