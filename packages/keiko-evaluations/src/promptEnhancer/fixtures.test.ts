// Prompt Enhancer fixture registry tests (Epic #1307, Issue #1315). Asserts the registry invariants and
// the selectors, so a malformed or duplicate fixture is caught at build time.

import { describe, expect, it } from "vitest";
import {
  ALL_PROMPT_ENHANCER_FIXTURES,
  PROMPT_ENHANCER_FIXTURE_CATEGORIES,
  fixturesForCategory,
  promptEnhancerFixtureByName,
} from "./index.js";

describe("Prompt Enhancer fixture registry", () => {
  it("has unique fixture names", () => {
    const names = ALL_PROMPT_ENHANCER_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every fixture has a non-empty draft, at least one dimension, and at least one expected class", () => {
    for (const f of ALL_PROMPT_ENHANCER_FIXTURES) {
      expect(f.request.text.length, f.name).toBeGreaterThan(0);
      expect(f.dimensions.size, f.name).toBeGreaterThan(0);
      expect(f.oracle.expectedTaskClasses.length, f.name).toBeGreaterThan(0);
      expect(PROMPT_ENHANCER_FIXTURE_CATEGORIES, f.name).toContain(f.category);
    }
  });

  it("fixturesForCategory partitions the registry across all categories", () => {
    let total = 0;
    for (const category of PROMPT_ENHANCER_FIXTURE_CATEGORIES) {
      const subset = fixturesForCategory(category);
      for (const f of subset) {
        expect(f.category).toBe(category);
      }
      total += subset.length;
    }
    expect(total).toBe(ALL_PROMPT_ENHANCER_FIXTURES.length);
  });

  it("promptEnhancerFixtureByName resolves a known name and returns undefined otherwise", () => {
    expect(promptEnhancerFixtureByName("task-factual-qa")?.name).toBe("task-factual-qa");
    expect(promptEnhancerFixtureByName("does-not-exist")).toBeUndefined();
  });
});
