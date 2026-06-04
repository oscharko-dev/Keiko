import { describe, expect, it } from "vitest";
import { KEIKO_WORKSPACE_VERSION } from "./version.js";

describe("KEIKO_WORKSPACE_VERSION", () => {
  it("is a semver-shaped constant", () => {
    expect(KEIKO_WORKSPACE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
