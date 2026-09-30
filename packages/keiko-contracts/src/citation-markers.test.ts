import { describe, expect, it } from "vitest";

import { citationMarkerIndices, findCitationMarkerGroups } from "./citation-markers.js";

describe("findCitationMarkerGroups", () => {
  it("reads a single ASCII marker with its offsets", () => {
    const groups = findCitationMarkerGroups("Alpha [2] beta");

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ start: 6, end: 9, text: "[2]", indices: [2] });
    expect(groups[0]?.entries).toEqual([{ index: 2, marker: "[2]" }]);
  });

  it("reads a comma-separated group as one group with one entry per index", () => {
    const [group] = findCitationMarkerGroups("Java 17 wird verwendet [1, 7, 8].");

    expect(group?.text).toBe("[1, 7, 8]");
    expect(group?.indices).toEqual([1, 7, 8]);
    expect(group?.entries.map((entry) => entry.marker)).toEqual(["[1]", "[7]", "[8]"]);
  });

  it.each([
    ["[1,7]", [1, 7]],
    ["[1; 2]", [1, 2]],
    ["[ 3 ,4 ]", [3, 4]],
    ["[5，6]", [5, 6]],
    ["[1、2；3]", [1, 2, 3]],
  ])("accepts the separator style of %s", (text, indices) => {
    expect(citationMarkerIndices(text)).toEqual(indices);
  });

  it("accepts CJK lenticular and fullwidth glyphs and keeps them in the per-index marker", () => {
    const [cjk] = findCitationMarkerGroups("see 【1, 2】");
    const [wide] = findCitationMarkerGroups("see ［3］");

    expect(cjk?.entries.map((entry) => entry.marker)).toEqual(["【1】", "【2】"]);
    expect(wide?.entries).toEqual([{ index: 3, marker: "［3］" }]);
  });

  it("tolerates a mismatched bracket pair", () => {
    const [group] = findCitationMarkerGroups("see [1】 and [2, 3］");

    expect(group?.text).toBe("[1】");
    expect(citationMarkerIndices("see [1】 and [2, 3］")).toEqual([1, 2, 3]);
  });

  it("keeps the literal of a lone marker, leading zeros included", () => {
    const [group] = findCitationMarkerGroups("see [01]");

    expect(group?.entries).toEqual([{ index: 1, marker: "[01]" }]);
  });

  it("names a padded lone marker by its canonical literal", () => {
    const [group] = findCitationMarkerGroups("see [ 1 ] here");

    expect(group?.text).toBe("[ 1 ]");
    expect(group?.entries).toEqual([{ index: 1, marker: "[1]" }]);
  });

  it("keeps duplicates in document order", () => {
    expect(citationMarkerIndices("[1] and again [1, 2] and [2]")).toEqual([1, 1, 2, 2]);
  });

  it.each([
    "[]",
    "[ ]",
    "[note]",
    "[1, x]",
    "[1,]",
    "[,1]",
    "[1 2]",
    "[a.ts:1-2]",
    "[1-3]",
    "[0-9]",
    "[2020-2024]",
    "[1",
    "1]",
    "[99999999999999999999]",
  ])("does not treat %s as a citation marker", (text) => {
    expect(findCitationMarkerGroups(text)).toEqual([]);
  });

  it("finds a marker nested inside stray brackets", () => {
    expect(citationMarkerIndices("[[1]] and [x [2]")).toEqual([1, 2]);
  });

  it("finds adjacent markers separately", () => {
    const groups = findCitationMarkerGroups("[1][2, 3]");

    expect(groups.map((group) => group.text)).toEqual(["[1]", "[2, 3]"]);
  });

  it("returns an empty list for text without markers", () => {
    expect(findCitationMarkerGroups("")).toEqual([]);
    expect(findCitationMarkerGroups("plain prose without markers")).toEqual([]);
  });

  it("stays linear on hostile bracket and whitespace runs", () => {
    const hostile = `${"[ ".repeat(20_000)}${" ".repeat(20_000)}[1${" ".repeat(20_000)}x`;
    const started = performance.now();

    expect(findCitationMarkerGroups(hostile)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
