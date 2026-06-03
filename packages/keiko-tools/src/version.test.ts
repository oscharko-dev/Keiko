import { describe, expect, it } from "vitest";
import { KEIKO_TOOLS_VERSION } from "./version.js";

describe("KEIKO_TOOLS_VERSION", () => {
  it("is the literal 0.1.0", () => {
    expect(KEIKO_TOOLS_VERSION).toBe("0.1.0");
  });
});
