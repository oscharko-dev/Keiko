import { describe, expect, it } from "vitest";
import {
  compactIssueKeys,
  KEY_RANGE_ENTRY_CHARS,
  listIssueKeys,
  packIssueKeys,
} from "./jiraDraftKeyRanges.js";

describe("compactIssueKeys (#4178)", () => {
  it("collapses consecutive keys of one project and keeps every other key exactly", () => {
    expect(
      compactIssueKeys(["SYN-3", "SYN-1", "SYN-2", "SYN-7", "ABC-10", "ABC-11", "SYN-9", "SYN-8"]),
    ).toEqual(["SYN-1..SYN-3", "SYN-7..SYN-9", "ABC-10..ABC-11"]);
  });

  it("ignores duplicates and leaves a value that is not an issue key as it is", () => {
    expect(compactIssueKeys(["SYN-1", "SYN-1", "odd key", "SYN-2"])).toEqual([
      "SYN-1..SYN-2",
      "odd key",
    ]);
  });

  it("stays small for thousands of keys and is empty for none", () => {
    const keys = Array.from({ length: 20_000 }, (_, index) => `SYN-${String(index + 1)}`);
    expect(compactIssueKeys(keys)).toEqual(["SYN-1..SYN-20000"]);
    expect(compactIssueKeys([])).toEqual([]);
  });
});

describe("packIssueKeys (#4175, #4178)", () => {
  const scattered = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `SYN-${String(index * 2 + 1)}`);

  it("packs scattered keys and ranges several to an entry, losing none and counting each", () => {
    const packed = packIssueKeys(["SYN-1", "SYN-3", "SYN-5", "SYN-6", "SYN-7", "ABC-2"]);
    expect(packed).toEqual([{ text: "SYN-1,SYN-3,SYN-5..SYN-7,ABC-2", keys: 6 }]);
  });

  it("keeps every entry within the schema's bound and every key in exactly one entry", () => {
    const packed = packIssueKeys(scattered(5000));
    expect(packed.length).toBeLessThan(200);
    for (const entry of packed)
      expect(entry.text.length).toBeLessThanOrEqual(KEY_RANGE_ENTRY_CHARS);
    expect(packed.reduce((total, entry) => total + entry.keys, 0)).toBe(5000);
    expect(packed.flatMap((entry) => entry.text.split(",")).sort()).toEqual(
      [...compactIssueKeys(scattered(5000))].sort(),
    );
  });
});

describe("listIssueKeys (#4175, #4178)", () => {
  const scattered = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `SYN-${String(index * 2 + 1)}`);

  it("lists 1,001 non-consecutive keys without cutting any", () => {
    const listed = listIssueKeys({ created: scattered(1001), existing: [] }, 200_000, 1000);
    expect(listed.unlisted).toBe(0);
    expect(listed.created.reduce((total, entry) => total + entry.keys, 0)).toBe(1001);
  });

  it("counts every key the budget cannot carry, in either list, and never lists a partial entry", () => {
    const listed = listIssueKeys({ created: scattered(3000), existing: scattered(40) }, 4000, 1000);
    const kept = [...listed.created, ...listed.existing].reduce(
      (total, entry) => total + entry.keys,
      0,
    );
    expect(listed.unlisted).toBeGreaterThan(0);
    expect(kept + listed.unlisted).toBe(3040);
    // The shorter list keeps its fair half instead of being starved by the longer one.
    expect(listed.existing.reduce((total, entry) => total + entry.keys, 0)).toBe(40);
  });

  it("honours the array ceiling by counting what lies beyond it", () => {
    const listed = listIssueKeys({ created: scattered(3000), existing: [] }, 10_000_000, 2);
    expect(listed.created).toHaveLength(2);
    expect(listed.unlisted).toBe(3000 - listed.created.reduce((n, entry) => n + entry.keys, 0));
  });
});
