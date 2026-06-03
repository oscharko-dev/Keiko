import { describe, it, expect } from "vitest";
import { KEIKO_CONTRACTS_VERSION } from "./index.js";

describe("keiko-contracts package surface", () => {
  it("exposes the version constant pinned at 0.0.1", () => {
    expect(KEIKO_CONTRACTS_VERSION).toBe("0.0.1");
  });
});
