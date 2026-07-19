import { describe, expect, it } from "vitest";

import { classifyDeniedCategory } from "./classify-denied-category.js";
import type { CapturePolicyOptions } from "./types.js";

type Categories = NonNullable<CapturePolicyOptions["deniedCategoryMatchers"]>;

const HEALTH_CATEGORY: Categories[number] = {
  category: "health-data",
  matchers: [/\bmedical record\b/iu, /\bdiagnosis\b/iu],
};

describe("classifyDeniedCategory", () => {
  it("returns only the content-free rejection reason when a named category matches", () => {
    expect(classifyDeniedCategory("The medical record changed.", [HEALTH_CATEGORY])).toBe(
      "denied-category",
    );
  });

  it("returns null when no category matches", () => {
    expect(classifyDeniedCategory("The user prefers Vitest.", [HEALTH_CATEGORY])).toBeNull();
    expect(classifyDeniedCategory("The user prefers Vitest.", [])).toBeNull();
  });

  it("is deterministic for caller matchers with mutable global cursors", () => {
    const categories: Categories = [{ category: "health-data", matchers: [/\bdiagnosis\b/giu] }];
    const body = "A diagnosis must not be retained.";
    expect(classifyDeniedCategory(body, categories)).toBe("denied-category");
    expect(classifyDeniedCategory(body, categories)).toBe("denied-category");
  });

  it("is monotonic when categories are added", () => {
    const bodies = [
      "The user prefers Vitest.",
      "The medical record changed.",
      "A diagnosis must not be retained.",
    ];
    const stronger: Categories = [
      HEALTH_CATEGORY,
      { category: "third-party", matchers: [/\bcolleague\b/iu] },
    ];
    for (const body of bodies) {
      const baseline = classifyDeniedCategory(body, [HEALTH_CATEGORY]);
      const strengthened = classifyDeniedCategory(body, stronger);
      if (baseline === "denied-category") {
        expect(strengthened).toBe("denied-category");
      }
    }
  });
});
