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

  it("never reads a marker inside an inline code span", () => {
    const text = "Use `const ports = [80, 443];` as shown [2] and ``a ` [3] `` here [4].";

    expect(citationMarkerIndices(text)).toEqual([2, 4]);
  });

  it("never reads a marker inside a fenced code block, backtick or tilde", () => {
    const text = [
      "Configure it [1]:",
      "```ts",
      "const a = [1, 2, 3];",
      "```",
      "  ~~~",
      "[5]",
      "  ~~~~",
      "Then restart [2].",
    ].join("\n");

    expect(citationMarkerIndices(text)).toEqual([1, 2]);
  });

  // PR #3678 review: an inline code span never reaches across a paragraph or a fence, so literal
  // unmatched backticks in two paragraphs do not hide the cited prose between them.
  it("never pairs backticks across a blank line or a fence", () => {
    const paragraphs = [
      "An unmatched ` appears here.",
      "",
      "The API uses TLS [1].",
      "",
      "Another unmatched ` appears here.",
    ].join("\n");
    const fenced = "Tick ` here [1]\n```\ncode\n```\nand ` there [2].";

    expect(citationMarkerIndices(paragraphs)).toEqual([1]);
    expect(citationMarkerIndices(fenced)).toEqual([1, 2]);
    expect(citationMarkerIndices("One `[1]\nstill one span` [2].")).toEqual([2]);
    // A heading, a list item and a block quote start a block of their own as well.
    for (const block of [
      "# The API uses TLS [1]",
      "- The API uses TLS [1]",
      "2. The API uses TLS [1]",
      "> The API uses TLS [1]",
    ]) {
      const text = `An unmatched \` appears here.\n${block}\nAnother unmatched \` appears here.`;
      expect(citationMarkerIndices(text)).toEqual([1]);
    }
  });

  // PR #3678 review: the breaks follow the renderer's blocks, so a thematic break, a table row, an
  // indented list item and a line after a heading end a span exactly where they end in the chat.
  it("ends a code span wherever the chat renderer ends an inline context", () => {
    const tick = "An unmatched ` appears here.";
    const between = (block: string): string => `${tick}\n${block}\nAnother unmatched \` appears.`;

    for (const rule of ["---", "***", "___", "  ---  "]) {
      expect(
        citationMarkerIndices(`${tick}\n${rule}\nThe API uses TLS [1].\n${rule}\n${tick}`),
      ).toEqual([1]);
    }
    expect(citationMarkerIndices(between("      - The API uses TLS [1]"))).toEqual([1]);
    expect(citationMarkerIndices(`# Heading \` here\nThe API uses TLS [1] \` there`)).toEqual([1]);
    const table = "| a ` | b |\n| --- | :-: |\n| TLS [1] | c ` |";
    expect(citationMarkerIndices(table)).toEqual([1]);
    expect(citationMarkerIndices("| a ` | TLS [1] | c ` |\n|---|---|---|")).toEqual([1]);
  });

  it("keeps a code span across lines the chat renderer joins into one paragraph", () => {
    // Neither `1)` nor a setext underline starts a block there, and quoted lines form one paragraph.
    expect(citationMarkerIndices("A ` tick\n1) item [1] ` end [2]")).toEqual([2]);
    expect(citationMarkerIndices("A ` tick\n===\nitem [1] ` end [2]")).toEqual([2]);
    expect(citationMarkerIndices("> A ` tick\n> item [1] ` end [2]")).toEqual([2]);
    expect(citationMarkerIndices("> A ` tick\n>\n> item [1] ` end [2]")).toEqual([1, 2]);
    // Past the renderer's quote nesting cap, the quoted lines form one text node, read as one
    // paragraph; the cap also bounds the scan on hostile nesting.
    const deep = "> ".repeat(17);
    expect(citationMarkerIndices(`${deep}A \` tick\n${deep}\n${deep}[1] \` end [2]`)).toEqual([2]);
    expect(citationMarkerIndices(`${"> ".repeat(50_000)}TLS [1]`)).toEqual([1]);
  });

  it("runs an unclosed fence to the end of the text, like the Markdown renderer", () => {
    expect(citationMarkerIndices("Intro [1]\n```\nconst a = [2];\nstill code [3]")).toEqual([1]);
  });

  it("does not close a fence on a line that carries text after the fence", () => {
    const text = "```\nx = [1]\n``` not a close [2]\n```\nAfter [3]";

    expect(citationMarkerIndices(text)).toEqual([3]);
  });

  it("treats an unmatched backtick or a short tilde run as literal text", () => {
    expect(citationMarkerIndices("A lone ` backtick [1] and ~~strike~~ [2]")).toEqual([1, 2]);
    expect(citationMarkerIndices("Mid-line ``` is inline code `[1]` [2]")).toEqual([2]);
  });

  it("stays linear on hostile runs of unmatched backticks of distinct lengths", () => {
    // Mid-line, so no run opens a fence; every run length occurs once and never closes.
    const runs = Array.from({ length: 1_500 }, (_, index) => `${"`".repeat(index + 1)}x`);
    const hostile = `Text ${runs.reverse().join(" [1] ")}`;
    const started = performance.now();

    expect(citationMarkerIndices(hostile)).toHaveLength(1_499);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("stays linear on hostile bracket and whitespace runs", () => {
    const hostile = `${"[ ".repeat(20_000)}${" ".repeat(20_000)}[1${" ".repeat(20_000)}x`;
    const started = performance.now();

    expect(findCitationMarkerGroups(hostile)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
