import { describe, expect, it } from "vitest";
import {
  BETA_INDEX,
  GOVERNED_BETA_TAG_RE,
  isAcceptedReleaseTag,
  isExactReleaseTag,
  isGovernedBetaTag,
} from "../release-tag-contract.mjs";

describe("release tag contract", () => {
  it("accepts the exact tag for a stable version", () => {
    expect(isExactReleaseTag("v0.3.0", "0.3.0")).toBe(true);
    expect(isAcceptedReleaseTag("v0.3.0", "0.3.0")).toBe(true);
  });

  it("accepts the exact tag for an npm PRERELEASE version", () => {
    // The npm beta/RC flow sets package.json to a prerelease version and pushes the exact tag;
    // it must receive the full verification, not the portable-beta treatment (#3043).
    expect(isExactReleaseTag("v0.3.1-rc.1", "0.3.1-rc.1")).toBe(true);
    expect(isGovernedBetaTag("v0.3.1-rc.1", "0.3.1-rc.1")).toBe(false);
  });

  it("accepts the governed portable beta layered over the package version", () => {
    expect(isGovernedBetaTag("v0.3.0-beta.0", "0.3.0")).toBe(true);
    expect(isGovernedBetaTag("v0.3.0-beta.10", "0.3.0")).toBe(true);
  });

  it("refuses a leading-zero beta index", () => {
    // One tag, one spelling: the producer may not mint v0.3.0-beta.00 either — both sides read
    // this module, so the shapes cannot drift apart (#3043).
    expect(isGovernedBetaTag("v0.3.0-beta.00", "0.3.0")).toBe(false);
    expect(isAcceptedReleaseTag("v0.3.0-beta.00", "0.3.0")).toBe(false);
    expect(GOVERNED_BETA_TAG_RE.test("v0.3.0-beta.00")).toBe(false);
  });

  it("refuses a foreign version, an RC suffix, and a malformed index", () => {
    expect(isAcceptedReleaseTag("v0.9.9-beta.1", "0.3.0")).toBe(false);
    expect(isAcceptedReleaseTag("v0.3.0-rc.1", "0.3.0")).toBe(false);
    expect(isAcceptedReleaseTag("v0.3.0-beta.x", "0.3.0")).toBe(false);
    expect(isAcceptedReleaseTag("v0.3.0-beta.", "0.3.0")).toBe(false);
  });

  it("treats the version as a literal, not a pattern", () => {
    // An unescaped '.' would make 'v0Q3P0' pass as 'v0.3.0'.
    expect(isAcceptedReleaseTag("v0Q3P0", "0.3.0")).toBe(false);
    expect(isAcceptedReleaseTag("v0Q3P0-beta.1", "0.3.0")).toBe(false);
  });

  it("exposes the index shape the producer reuses", () => {
    expect(new RegExp(`^${BETA_INDEX}$`, "u").test("0")).toBe(true);
    expect(new RegExp(`^${BETA_INDEX}$`, "u").test("00")).toBe(false);
    expect(new RegExp(`^${BETA_INDEX}$`, "u").test("12")).toBe(true);
  });
});
