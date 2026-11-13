import { describe, expect, it } from "vitest";
import {
  checkProperty,
  LINEAR_RATIO_MAX,
  measureScaling,
  scalingRatio,
  type Generator,
} from "../../../../../../tests/support/property-testing";
import { jiraReadableText } from "./jira-readable-text";

// Every expectation is a literal: a helper that drops or rewrites content cannot agree with it.
describe("jiraReadableText recognised markup", () => {
  it.each([
    ["heading", "h2. Ziel\nDas Ziel ist klar.", "Ziel\nDas Ziel ist klar."],
    [
      "bullets, nesting and emphasis",
      "h3. Scope\n* first *important* point\n** nested _detail_",
      "Scope\n• first important point\n  • nested detail",
    ],
    [
      "monospace and links keep their target",
      "See {{config.json}} and [the guide|https://docs.example.test/guide] or [https://x.example.test].",
      "See config.json and the guide (https://docs.example.test/guide) or https://x.example.test.",
    ],
    [
      "a code fence keeps its content untouched",
      "{code:java}\nint a = 1; *x* [y|z]\n{code}\nafter *b*",
      "int a = 1; *x* [y|z]\nafter b",
    ],
    [
      "a noformat fence keeps its content untouched",
      "{noformat}\n*raw* _text_\n{noformat}",
      "*raw* _text_",
    ],
    [
      "a panel keeps its title as text",
      "{panel:title=Hinweis|borderStyle=dashed}\nText\n{panel}",
      "Hinweis\nText",
    ],
    ["a quote fence is markup only", "{quote}\nzitiert\n{quote}", "zitiert"],
    [
      "a code fence title stays as text",
      "{code:title=Beispiel.java|language=java}\nx\n{code}",
      "Beispiel.java\nx",
    ],
    ["a colour span", "{color:red}warn{color} ok", "warn ok"],
    ["a body row of cells", "|alpha|1|", "alpha · 1"],
    ["a rule becomes an empty line", "a\n----\nb", "a\n\nb"],
    ["nested emphasis", "*bold _inner_ end*", "bold inner end"],
    ["escapes lose only their backslash", String.raw`a \[b\] \*c\* \{d\}`, "a [b] *c* {d}"],
    [
      "tables keep every column, an empty cell too",
      "||Name||Value||\n|a||c|\n| |x|",
      "Name · Value\na · – · c\n– · x",
    ],
    [
      "a link inside a table cell is not split",
      "|[docs|https://x.example/a]|plain|",
      "docs (https://x.example/a) · plain",
    ],
  ])("%s", (_name, wiki, readable) => {
    expect(jiraReadableText(wiki)).toBe(readable);
  });
});

describe("jiraReadableText line endings", () => {
  // A line ending is not content: every line-level construct reads the same with CRLF and CR.
  it.each([
    ["a heading", "h2. Ziel\nText", "Ziel\nText"],
    ["a bullet", "* one\n** two", "• one\n  • two"],
    ["a rule", "a\n----\nb", "a\n\nb"],
    ["a table", "||Name||Value||\n|a||c|", "Name · Value\na · – · c"],
    ["a code fence", "{code}\n*kept*\n{code}\nafter *b*", "*kept*\nafter b"],
    ["a panel", "{panel:title=Hinweis}\nText\n{panel}", "Hinweis\nText"],
    ["a quote", "{quote}\nzitiert\n{quote}", "zitiert"],
  ])("%s", (_name, wiki, readable) => {
    expect(jiraReadableText(wiki.replaceAll("\n", "\r\n"))).toBe(readable);
    expect(jiraReadableText(wiki.replaceAll("\n", "\r"))).toBe(readable);
  });
});

describe("jiraReadableText keeps whatever is not markup by position", () => {
  it.each([
    ["a mention", "ping [~jdoe] now"],
    ["an image", "see !pic.png! here"],
    ["strikethrough", "this is -old- text"],
    ["inserted text", "this is +new+ text"],
    ["a bracket pair in prose", "result [ok|fail] kept"],
    ["a Jira line break", String.raw`first\\second`],
    ["operators and a trailing underscore", "price * quantity and file_name_ here"],
    ["a lone colour macro", "a {color} b"],
    ["an unknown macro", "{foo:bar} text {toc} {anchor:x}"],
    ["an unclosed asterisk", "*unclosed and 2 * 3 = 6"],
    ["an unclosed underscore", "_unclosed and snake_case_name"],
    ["an unclosed bracket", "[no close and [another"],
    ["an unclosed monospace", "{{open mono"],
    ["an unclosed colour", "{color:red}text"],
    ["markdown bold and a heading line", "**markdown bold** and\n# a heading line"],
    ["text without any markup", "A plain sentence, with 2 * 3 = 6."],
  ])("%s", (_name, text) => {
    expect(jiraReadableText(text)).toBe(text);
  });

  it("keeps the content of a code fence that never closes", () => {
    expect(jiraReadableText("{code}\n*kept* [y|z]")).toBe("*kept* [y|z]");
  });
});

const WORDS = ["alpha", "Beta", "gamma7", "Ärger", "42", "delta"];
type Piece = { readonly source: string; readonly shown: string };

const piece: Generator<Piece> = (random) => {
  const word = random.pick(WORDS);
  return random.pick<Piece>([
    { source: word, shown: word },
    { source: `*${word}*`, shown: word },
    { source: `_${word}_`, shown: word },
    { source: `{{${word}}}`, shown: word },
    { source: `[${word}|https://e.example/p]`, shown: `${word} (https://e.example/p)` },
    { source: `{color:red}${word}{color}`, shown: word },
    { source: `-${word}-`, shown: `-${word}-` },
    { source: `[~${word}]`, shown: `[~${word}]` },
    { source: `!${word}!`, shown: `!${word}!` },
    { source: `[${word}|fail]`, shown: `[${word}|fail]` },
    { source: `{unknown}${word}`, shown: `{unknown}${word}` },
  ]);
};

function wordCharacters(text: string): string {
  return text.replaceAll(/[^\p{L}\p{N}]/gu, "");
}

describe("jiraReadableText property", () => {
  it("shows every word character of the source that is not part of a recognised markup token, in order", async () => {
    await checkProperty({
      name: "readable text keeps all non-markup word characters in order",
      generate: (random) => {
        const line = (): { lead: string; pieces: Piece[] } => ({
          lead: random.pick(["", "h2. ", "* ", "** "]),
          pieces: Array.from({ length: random.integer(1, 6) }, () => piece(random)),
        });
        return { first: line(), second: line(), eol: random.pick(["\n", "\r\n", "\r"]) };
      },
      property: ({ first, second, eol }) => {
        const render = (entry: { lead: string; pieces: Piece[] }): string =>
          entry.lead + entry.pieces.map((part) => part.source).join(" ");
        const shown = (entry: { pieces: Piece[] }): string =>
          entry.pieces.map((part) => part.shown).join(" ");
        const output = jiraReadableText(render(first) + eol + render(second));
        const expected = `${shown(first)}\n${shown(second)}`;
        expect(wordCharacters(output)).toBe(wordCharacters(expected));
        expect(output.split("\n")).toHaveLength(2);
        expect(output.endsWith(shown(second))).toBe(true);
      },
    });
  });
});

describe("jiraReadableText scales linearly on a hostile single line", () => {
  it.each([
    ["unclosed brackets", (size: number): string => "[a".repeat(size)],
    ["unclosed asterisks", (size: number): string => "*a ".repeat(size)],
    ["unclosed underscores", (size: number): string => "_a ".repeat(size)],
    ["unclosed monospace and colour", (size: number): string => "{{a {color:red}".repeat(size)],
    ["bracket pairs that are not links", (size: number): string => "[a|b]".repeat(size)],
  ])("%s", (_name, build) => {
    const scaling = measureScaling({
      build,
      run: (line) => jiraReadableText(line),
      size: 2_000,
      maximumSize: 64_000,
    });
    expect(scaling.measurable).toBe(true);
    expect(scalingRatio(scaling)).toBeLessThan(LINEAR_RATIO_MAX);
  });
});
