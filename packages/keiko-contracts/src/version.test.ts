import { describe, expect, it } from "vitest";
import { compareProductVersions, isStableProductVersion, isProductVersion } from "./version.js";

describe("shared product version compatibility", () => {
  it.each([
    ["1.1.9", "1.1.13"],
    ["1.1.13", "1.2.0"],
    ["1.2.0", "2.0.0"],
    ["1.1.13-alpha", "1.1.13-alpha.1"],
    ["1.1.13-alpha.1", "1.1.13-alpha.beta"],
    ["1.1.13-alpha.beta", "1.1.13-beta"],
    ["1.1.13-beta.2", "1.1.13-beta.10"],
    ["1.1.13-beta.10", "1.1.13-beta.999999999999999999999"],
    ["1.1.13-beta.999999999999999999998", "1.1.13-beta.999999999999999999999"],
    ["1.1.13-beta.999999999999999999999", "1.1.13-rc.1"],
    ["1.1.13-rc.1", "1.1.13"],
  ])("orders %s before %s in both directions", (older, newer) => {
    expect(compareProductVersions(older, newer)).toBe(-1);
    expect(compareProductVersions(newer, older)).toBe(1);
    expect(compareProductVersions(older, older)).toBe(0);
    expect(compareProductVersions(newer, newer)).toBe(0);
  });

  it.each([
    "private-value",
    "01.1.13",
    "1.1",
    "1.1.13-alpha..1",
    "1.1.13-alpha.01",
    "1.1.13-alpha.",
    "1.1.13-",
    "9007199254740992.1.13",
    `${"9".repeat(129)}.1.13`,
  ])("refuses malformed or unbounded %s", (value) => {
    expect(isStableProductVersion(value)).toBe(false);
    expect(isProductVersion(value)).toBe(false);
    expect(() => compareProductVersions(value, "1.1.13")).toThrow(TypeError);
    expect(() => compareProductVersions("1.1.13", value)).toThrow(TypeError);
  });

  it("distinguishes stable releases from valid prereleases", () => {
    expect(isStableProductVersion("1.1.13")).toBe(true);
    expect(isStableProductVersion("1.1.13-alpha.0")).toBe(false);
    expect(isProductVersion("1.1.13-alpha.0")).toBe(true);
    expect(isProductVersion(null)).toBe(false);
    expect(compareProductVersions("1.1.13-alpha.0", "1.1.13-alpha.1")).toBe(-1);
  });
});
