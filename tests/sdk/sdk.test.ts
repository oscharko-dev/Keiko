import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../../src/sdk/index.js";
import * as root from "../../src/index.js";

describe("SDK surface", () => {
  it("exposes a semver SDK_VERSION", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("re-exports the SDK from the package root", () => {
    expect(root.SDK_VERSION).toBe(SDK_VERSION);
  });
});
