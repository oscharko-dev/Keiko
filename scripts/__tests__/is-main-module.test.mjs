import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { isMainModule } from "../lib/is-main-module.mjs";

describe("isMainModule", () => {
  it("is true when import.meta.url matches the canonical URL for a plain path", () => {
    const argv1 = "/repo/scripts/check-adr-index.mjs";
    expect(isMainModule(pathToFileURL(argv1).href, argv1)).toBe(true);
  });

  it("is false when the module was imported rather than executed directly", () => {
    expect(isMainModule("file:///repo/scripts/check-adr-index.mjs", "/repo/other-script.mjs")).toBe(
      false,
    );
  });

  it("is false when argv1 is undefined (e.g. a REPL or worker context)", () => {
    expect(isMainModule("file:///repo/scripts/check-adr-index.mjs", undefined)).toBe(false);
  });

  it("matches a path containing a space, unlike naive file:// string interpolation", () => {
    const argv1 = "/repo/has space/check-adr-index.mjs";
    const naiveInterpolation = `file://${argv1}`;
    expect(isMainModule(pathToFileURL(argv1).href, argv1)).toBe(true);
    // Prove this is a real bug class, not a hypothetical: naive interpolation actually
    // disagrees with the canonical URL for exactly this input.
    expect(naiveInterpolation).not.toBe(pathToFileURL(argv1).href);
  });

  it("matches a path containing %, #, and ?, unlike naive file:// string interpolation", () => {
    for (const argv1 of [
      "/repo/has%percent/check-adr-index.mjs",
      "/repo/has#hash/check-adr-index.mjs",
      "/repo/has?query/check-adr-index.mjs",
    ]) {
      const naiveInterpolation = `file://${argv1}`;
      expect(isMainModule(pathToFileURL(argv1).href, argv1)).toBe(true);
      expect(naiveInterpolation).not.toBe(pathToFileURL(argv1).href);
    }
  });

  it("defaults argv1 to the real process.argv[1] when not supplied", () => {
    // process.argv[1] under the vitest worker is this test file (or a runner shim), never
    // the module under test, so calling with only the URL argument must return false.
    expect(isMainModule("file:///not-the-real-entry-point.mjs")).toBe(false);
  });
});
