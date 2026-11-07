import { describe, expect, it } from "vitest";
import {
  markdownBlocksToJiraWiki,
  markdownInlineToJiraWiki,
  readsAsMarkdownOnly,
} from "./jira-markdown-wiki.js";
import {
  projectJiraDescriptionInput,
  serializeJiraMarkdownDescription,
} from "./jira-description-sections.js";

// The description of KER-1 as Gemma wrote it (#4173 AC2): Markdown sent as a plain string, which
// Data Center rendered with literal asterisks. Synthetic project text, no customer data.
const EPIC = [
  "**Ziel**",
  "Die förmliche Initiierung des Programms.",
  "",
  "**Umfang**",
  "* **Organisatorisches Setup:** Etablierung der Programmstruktur.",
  "* **Planung & Governance:** Abstimmung über den Phasenplan.",
].join("\n");

describe("Markdown written as Jira Data Center wiki markup", () => {
  it("converts the KER-1 description so Jira shows bold text instead of asterisks", () => {
    expect(projectJiraDescriptionInput(EPIC)?.text).toBe(
      [
        "*Ziel*",
        "Die förmliche Initiierung des Programms.",
        "",
        "*Umfang*",
        "* *Organisatorisches Setup:* Etablierung der Programmstruktur.",
        "* *Planung & Governance:* Abstimmung über den Phasenplan.",
      ].join("\n"),
    );
  });

  it("converts headings, lists, rules, links and inline code of tagged Markdown", () => {
    const source = [
      "## Ziel",
      "Text mit *Betonung*, `code`, ~~alt~~ und [Lastenheft](https://example.invalid/doc).",
      "- eins",
      "  - zwei",
      "1. erstens",
      "   1. zweitens",
      "> Zitat **wörtlich**",
      "---",
      "![Bild](https://example.invalid/a.png)",
    ].join("\n");
    expect(projectJiraDescriptionInput({ format: "markdown", text: source })).toEqual({
      text: [
        "h2. Ziel",
        "Text mit _Betonung_, {{code}}, -alt- und [Lastenheft|https://example.invalid/doc].",
        "* eins",
        "** zwei",
        "# erstens",
        "## zweitens",
        "> Zitat **wörtlich**",
        "----",
        "!https://example.invalid/a.png!",
      ].join("\n"),
      convertedHeadingCount: 1,
    });
  });

  it("writes a Markdown table with a header row and drops the rule line", () => {
    expect(markdownBlocksToJiraWiki("| A | B |\n|---|:---:|\n| **1** | 2 |\nnach")).toBe(
      "||A||B||\n|*1*|2|\nnach",
    );
  });

  it("keeps fenced code verbatim inside a code macro and leaves wiki macros untouched", () => {
    expect(markdownBlocksToJiraWiki("```ts\nconst a = **b**;\n```\n**x**")).toBe(
      "{code:ts}\nconst a = **b**;\n{code}\n*x*",
    );
    expect(markdownBlocksToJiraWiki("{noformat}\n**raw**\n{noformat}\n**x**")).toBe(
      "{noformat}\n**raw**\n{noformat}\n*x*",
    );
  });

  it("keeps the heading-only result when a fence is left open", () => {
    expect(markdownBlocksToJiraWiki("```\n**x**")).toBeUndefined();
    expect(serializeJiraMarkdownDescription("## A\n```\n**x**")).toEqual({
      text: "h2. A\n```\n**x**",
      convertedHeadingCount: 1,
    });
  });

  it("preserves every line ending", () => {
    expect(markdownBlocksToJiraWiki("**a**\r\n- b\r\n| x |\r\n|---|\r\nend")).toBe(
      "*a*\r\n* b\r\n||x||\r\nend",
    );
  });

  it("converts inline Markdown without touching code spans", () => {
    expect(markdownInlineToJiraWiki("**a** und `**b**` und __c__")).toBe(
      "*a* und {{**b**}} und *c*",
    );
  });
});

describe("ordinary technical text survives the conversion", () => {
  it.each([
    ["**Datei** `__init__.py` und __init__.py", "*Datei* {{__init__.py}} und __init__.py"],
    ["**Glob** src/*.ts und lib/*.ts", "*Glob* src/*.ts und lib/*.ts"],
    [
      "**Siehe** [Foo](https://example.invalid/wiki/Foo_(bar)) und [x](https://example.invalid/a__b__c)",
      "*Siehe* [Foo|https://example.invalid/wiki/Foo_(bar)] und [x|https://example.invalid/a__b__c]",
    ],
    ['**JSON** `{"a":1}`', '*JSON* {{\\{"a":1\\}}}'],
  ])("%j", (source, expected) => {
    expect(markdownBlocksToJiraWiki(source)).toBe(expected);
  });

  it("reads a fence whose info string carries attributes and nests tab-indented items", () => {
    expect(markdownBlocksToJiraWiki("```js title=x\n**a**\n```\n- eins\n\t- zwei")).toBe(
      "{code:js}\n**a**\n{code}\n* eins\n** zwei",
    );
  });

  it("keeps a horizontal rule after a table row", () => {
    expect(markdownBlocksToJiraWiki("| a |\n---\nnach")).toBe("|a|\n----\nnach");
  });
});

describe("a plain string is Markdown only when it uses what wiki markup never writes", () => {
  it.each([
    ["**Ziel**\nText", true],
    ["Siehe [Dokument](https://example.invalid/d).", true],
    ["```\ncode\n```", true],
    ["# criterion one\n# criterion two", false],
    ["## nested criterion", false],
    ["h2. Ziel\n**fett** bleibt wiki", false],
    ["*fett* und [Link|https://example.invalid]", false],
    ["** nested item", false],
    ["{code}\n**x**\n{code}", false],
    ["# erstens\n# zweitens\n**fett**", false],
  ])("%j reads as Markdown: %s", (text, expected) => {
    expect(readsAsMarkdownOnly(text)).toBe(expected);
  });

  it("leaves native wiki strings byte for byte", () => {
    for (const text of [
      "h2. Ziel\n* eins\n# zwei",
      "*fett* _kursiv_ [Link|https://example.invalid]",
    ]) {
      expect(projectJiraDescriptionInput(text)).toEqual({ text, convertedHeadingCount: 0 });
    }
  });
});
