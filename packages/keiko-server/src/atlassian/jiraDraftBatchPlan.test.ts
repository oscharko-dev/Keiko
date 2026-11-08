import { describe, expect, it } from "vitest";
import { JIRA_DRAFT_PAGE_ITEMS_MAX } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  draftPageSize,
  exhaustedItemTokens,
  initialItemTokens,
  measuredItemTokens,
  splitPage,
} from "./jiraDraftBatchPlan.js";

describe("initialItemTokens", () => {
  it("plans a base cost plus one block per required section and a smaller one per field", () => {
    expect(initialItemTokens({ requiredSections: ["A", "B"], requiredFields: ["x"] })).toBe(
      160 + 2 * 140 + 40,
    );
  });

  it("plans at least one section block when the template has no required section", () => {
    expect(initialItemTokens({ requiredSections: [], requiredFields: [] })).toBe(160 + 140);
  });

  it("grows with every section and field", () => {
    const small = initialItemTokens({ requiredSections: ["A"], requiredFields: [] });
    const moreSections = initialItemTokens({ requiredSections: ["A", "B"], requiredFields: [] });
    const moreFields = initialItemTokens({ requiredSections: ["A"], requiredFields: ["f"] });
    expect(moreSections).toBeGreaterThan(small);
    expect(moreFields).toBeGreaterThan(small);
  });
});

describe("draftPageSize", () => {
  it("fills about half of the output budget", () => {
    expect(draftPageSize(8192, 440)).toBe(Math.floor((8192 * 0.55) / 440));
    expect(draftPageSize(8192, 440)).toBe(10);
  });

  it("never exceeds the staging page limit", () => {
    expect(draftPageSize(10_000_000, 60)).toBe(JIRA_DRAFT_PAGE_ITEMS_MAX);
    expect(JIRA_DRAFT_PAGE_ITEMS_MAX).toBe(50);
  });

  it("is at least one when a single issue does not fit", () => {
    expect(draftPageSize(100, 5000)).toBe(1);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "falls back to one issue for an unusable output budget %s",
    (budget) => {
      expect(draftPageSize(budget, 100)).toBe(1);
    },
  );

  it("treats a zero or negative item cost as one token", () => {
    expect(draftPageSize(100, 0)).toBe(JIRA_DRAFT_PAGE_ITEMS_MAX);
    expect(draftPageSize(100, -10)).toBe(JIRA_DRAFT_PAGE_ITEMS_MAX);
  });

  it("shrinks monotonically as the item cost grows", () => {
    let last = Number.POSITIVE_INFINITY;
    for (const cost of [60, 120, 240, 480, 960, 1920]) {
      const size = draftPageSize(8192, cost);
      expect(size).toBeLessThanOrEqual(last);
      last = size;
    }
  });
});

describe("measuredItemTokens", () => {
  it("pads the measured cost per issue by a quarter", () => {
    expect(measuredItemTokens(440, 1000, 10)).toBe(125);
  });

  it("rounds up", () => {
    expect(measuredItemTokens(440, 1001, 10)).toBe(Math.ceil(100.1 * 1.25));
  });

  it("keeps the previous plan when the provider reported no usage", () => {
    expect(measuredItemTokens(440, undefined, 10)).toBe(440);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps the previous plan for a non-finite measurement %s",
    (tokens) => {
      expect(measuredItemTokens(440, tokens, 10)).toBe(440);
    },
  );

  it.each([0, -1])("keeps the previous plan for an item count of %s", (count) => {
    expect(measuredItemTokens(440, 1000, count)).toBe(440);
  });

  it("never plans below the floor", () => {
    expect(measuredItemTokens(440, 10, 10)).toBe(60);
    expect(measuredItemTokens(440, 0, 10)).toBe(60);
  });
});

describe("exhaustedItemTokens", () => {
  it("doubles the cost per issue", () => {
    expect(exhaustedItemTokens(300)).toBe(600);
  });

  it("never plans below the floor", () => {
    expect(exhaustedItemTokens(10)).toBe(60);
  });
});

describe("splitPage", () => {
  it("halves an even page", () => {
    expect(splitPage([1, 2, 3, 4])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("gives the first half the larger share of an odd page", () => {
    expect(splitPage([1, 2, 3])).toEqual([[1, 2], [3]]);
  });

  it("leaves the second half empty for a single entry", () => {
    expect(splitPage([1])).toEqual([[1], []]);
  });

  it("returns two empty halves for an empty page", () => {
    expect(splitPage([])).toEqual([[], []]);
  });

  it("does not mutate the page", () => {
    const page = [1, 2, 3];
    splitPage(page);
    expect(page).toEqual([1, 2, 3]);
  });
});
