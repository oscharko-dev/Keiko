import { describe, expect, it } from "vitest";
import { KEIKO_TOOLS_VERSION } from "./version.js";

describe("KEIKO_TOOLS_VERSION", () => {
  it("is the literal 0.2.15-beta.0", () => {
    expect(KEIKO_TOOLS_VERSION).toBe("0.2.15-beta.0");
  });
});
