import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCOVERY_OPTIONS,
  MAX_DISCOVERY_FILES_CEILING,
  MAX_DISCOVERY_DEPTH_CEILING,
} from "./types.js";

// Owner decision 2026-11-24: a repository Pod indexes up to 50,000 files by default (was 5,000);
// the runaway ceilings an operator override may raise it to are unchanged.
describe("default discovery bounds", () => {
  it("admit a large repository and stay inside the unchanged ceilings", () => {
    expect(DEFAULT_DISCOVERY_OPTIONS.maxFiles).toBe(50_000);
    expect(MAX_DISCOVERY_FILES_CEILING).toBe(100_000);
    expect(MAX_DISCOVERY_DEPTH_CEILING).toBe(64);
    expect(DEFAULT_DISCOVERY_OPTIONS.maxFiles).toBeLessThanOrEqual(MAX_DISCOVERY_FILES_CEILING);
  });
});
