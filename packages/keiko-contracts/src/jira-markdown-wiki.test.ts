import { describe, expect, it } from "vitest";
import {
  LINEAR_RATIO_MAX,
  measureScaling,
  scalingRatio,
} from "../../../tests/support/property-testing.js";
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

// CodeQL alerts 106-111: each input made one pattern backtrack quadratically; at this size the old
// patterns took seconds per input, the linear ones take milliseconds.
describe("hostile input converts in linear time", () => {
  const repeats = 60_000;
  const hostile: readonly (readonly [string, string])[] = [
    ["bullet", `*\t${"\t\t".repeat(repeats)}`],
    ["ordered item", `1.\t${"\t\t".repeat(repeats)}`],
    ["fence", `\`\`\`${"\t".repeat(repeats * 2)}\``],
    ["table rule", `|---${"\t".repeat(repeats * 2)}x\n|a|`],
    ["Markdown link target", `[\\](/${"[!](#".repeat(repeats)}`],
    ["link label", "[".repeat(repeats * 2)],
    ["wiki link", "[\\|".repeat(repeats)],
  ];

  for (const [name, text] of hostile) {
    it(`finishes a hostile ${name} quickly`, { timeout: 2_000 }, () => {
      const started = performance.now();
      markdownBlocksToJiraWiki(text);
      readsAsMarkdownOnly(text);
      expect(performance.now() - started).toBeLessThan(1_000);
    });
  }

  it("keeps the meaning of the rewritten patterns", () => {
    expect(markdownBlocksToJiraWiki("-\t\titem\n1.  first\n- ")).toBe("* item\n# first\n* ");
    expect(markdownBlocksToJiraWiki("~~~ ts {x}\nconst a = 1;\n~~~")).toBe(
      "{code:ts}\nconst a = 1;\n{code}",
    );
    // A backtick in the info string makes it no fence: the line stays prose with a code span.
    expect(markdownBlocksToJiraWiki("``` a`b\ntext")).toBe("``{{ a}}b\ntext");
    expect(markdownBlocksToJiraWiki("| A | B |\n| :--- | ---: |\n| 1 | 2 |")).toBe(
      "||A||B||\n|1|2|",
    );
    expect(markdownBlocksToJiraWiki("| A |\n||---|")).toBe("|A|\n||---|");
    expect(markdownInlineToJiraWiki("[Docs](https://example.test/a_(b))")).toBe(
      "[Docs|https://example.test/a_(b)]",
    );
    expect(readsAsMarkdownOnly("See [Docs](https://example.test/x).")).toBe(true);
    expect(readsAsMarkdownOnly("See [Docs|https://example.test/x] and **this**.")).toBe(false);
  });
});

describe("an active code block keeps its content literal (F5)", () => {
  it("keeps a fenced example inside a {code} macro literal", () => {
    const text = "# Goal\n\n{code}\n```js\n**literal**\n```\n{code}";
    expect(projectJiraDescriptionInput({ format: "markdown", text })?.text).toBe(
      "h1. Goal\n\n{code}\n```js\n**literal**\n```\n{code}",
    );
  });

  it("keeps fence lines inside a {noformat} block literal", () => {
    expect(markdownBlocksToJiraWiki("{noformat}\n~~~\n**x**\n```\n{noformat}\n**y**")).toBe(
      "{noformat}\n~~~\n**x**\n```\n{noformat}\n*y*",
    );
  });

  it("does not close a fence with another marker character or trailing text", () => {
    expect(markdownBlocksToJiraWiki("```\ncode\n```~\n~~~\n``` x\n```")).toBe(
      "{code}\ncode\n```~\n~~~\n``` x\n{code}",
    );
    expect(markdownBlocksToJiraWiki("```\ncode\n```~")).toBeUndefined();
  });

  it("closes a fence with the same character at an equal or longer length only", () => {
    expect(markdownBlocksToJiraWiki("````\n```\n````\n**a**")).toBe("{code}\n```\n{code}\n*a*");
    expect(markdownBlocksToJiraWiki("```\nx\n`````  \n**a**")).toBe("{code}\nx\n{code}\n*a*");
    expect(markdownBlocksToJiraWiki("~~~~\nx\n~~~\n")).toBeUndefined();
  });
});

describe("nested lists keep the ancestor marker path (F6)", () => {
  it.each([
    ["- Parent\n  1. First step\n  2. Second step", "* Parent\n*# First step\n*# Second step"],
    ["1. Parent\n   - a\n   - b", "# Parent\n#* a\n#* b"],
    ["- a\n  1. b\n     - c\n       1. d", "* a\n*# b\n*#* c\n*#*# d"],
    ["- a\n  1. b\n     - c\n- e\n  - f", "* a\n*# b\n*#* c\n* e\n** f"],
    ["- a\n  1. b\n     - c\n  2. d", "* a\n*# b\n*#* c\n*# d"],
    ["10. ten\n    - child\n1. one\n   - child", "# ten\n#* child\n# one\n#* child"],
  ])("%j", (markdown, wiki) => {
    expect(markdownBlocksToJiraWiki(markdown)).toBe(wiki);
  });

  it("keeps the list open across a wrapped continuation line", () => {
    expect(markdownBlocksToJiraWiki("- a\n  wrapped\n  - b")).toBe("* a\n  wrapped\n** b");
    // A blank line ends a Jira wiki list, so a loose nested item stays in the same list.
    expect(markdownBlocksToJiraWiki("- a\n\n  - b")).toBe("* a\n** b");
  });

  it.each([
    ["a wiki heading", "- a\n\nh2. T\n  - b", "* a\n\nh2. T\n* b"],
    ["a rule", "- a\n---\n  - b", "* a\n----\n* b"],
    ["a quote", "- a\n> q\n  - b", "* a\n> q\n* b"],
    ["unindented prose", "- a\ntext\n  - b", "* a\ntext\n* b"],
  ])("ends the list at %s", (_name, markdown, wiki) => {
    expect(markdownBlocksToJiraWiki(markdown)).toBe(wiki);
  });

  it("starts a new list after a paragraph", () => {
    expect(markdownBlocksToJiraWiki("1. a\ntext\n  - b")).toBe("# a\ntext\n* b");
  });
});

describe("a link with balanced URL parentheses is Markdown (F11)", () => {
  it("projects the balanced URL the converter already supports", () => {
    expect(projectJiraDescriptionInput("See [Docs](https://example.test/a_(b)).")?.text).toBe(
      "See [Docs|https://example.test/a_(b)].",
    );
  });

  it.each([
    ["See [Docs](https://example.test/x).", true],
    ["[Docs](/a_(b)(c)) tail", true],
    ["[Docs](#top)", true],
    ["[Docs](mailto:a@example.test)", true],
    ["[Docs](https://example.test/a_(b(c)))", false],
    ["[Docs](https://example.test/a_(b)", false],
    ["[Docs](ftp://example.test/x)", false],
    ["[](https://example.test/x)", false],
    ["[a [b](https://example.test/x)", true],
    ["[a\nb](https://example.test/x)", false],
    ["[Docs](https://example.test/a b)", false],
  ])("%j reads as Markdown: %s", (text, expected) => {
    expect(readsAsMarkdownOnly(text)).toBe(expected);
  });

  it.each([
    ["a balanced-URL link", "[Docs](https://example.test/a_(b)) "],
    ["nested link openers", "[a](/("],
    ["closers without openers", "](/("],
    ["empty labels", "[](("],
    ["unclosed labels", "[a"],
    ["unclosed targets", "[a](/b("],
  ])("reads %s in linear time", { timeout: 60_000 }, (_name, piece) => {
    const scaling = measureScaling({
      build: (size) => piece.repeat(Math.ceil(size / piece.length)),
      run: (text) => {
        readsAsMarkdownOnly(text);
        return markdownBlocksToJiraWiki(text);
      },
      size: 1_000,
      maximumSize: 400_000,
    });
    expect(scaling.measurable, JSON.stringify(scaling)).toBe(true);
    expect(scalingRatio(scaling), JSON.stringify(scaling)).toBeLessThan(LINEAR_RATIO_MAX);
  });
});

describe("a typical batch description renders as Jira wiki", () => {
  it("renders sections, acceptance criteria with bold and code", () => {
    const text = [
      "## Ziel",
      "Das **Login** funktioniert.",
      "",
      "## Akzeptanzkriterien",
      "- Der Nutzer sieht **Willkommen** nach `POST /login`",
      "- Fehler liefern `401`",
    ].join("\n");
    expect(projectJiraDescriptionInput({ format: "markdown", text })?.text).toBe(
      [
        "h2. Ziel",
        "Das *Login* funktioniert.",
        "",
        "h2. Akzeptanzkriterien",
        "* Der Nutzer sieht *Willkommen* nach {{POST /login}}",
        "* Fehler liefern {{401}}",
      ].join("\n"),
    );
  });
});

// Cases from the #4287/#4291 strict Markdown projector, consolidated into the one converter above.
function project(text: string): string | undefined {
  return projectJiraDescriptionInput({ format: "markdown", text })?.text;
}

describe("explicit Markdown stays inert where wiki would activate it (#4291)", () => {
  it.each([
    ["- First\n  1. Nested\n  2. Next\n- Last", "* First\n*# Nested\n*# Next\n* Last"],
    ["1. First\n   - Nested\n2. Last", "# First\n#* Nested\n# Last"],
    ["[Guide](https://example.invalid/a_(b))", "[Guide|https://example.invalid/a_(b)]"],
    ["Text\n\n---\n\n~~Removed~~", "Text\n\n----\n\n-Removed-"],
    ["| Name | Value |\n| --- | --- |\n| A\\|B | `x\\|y` |", "||Name||Value||\n|A\\|B|{{x\\|y}}|"],
    ["~~~js\nconst x = '**literal**';\n~~~", "{code:js}\nconst x = '**literal**';\n{code}"],
  ])("projects %j", (input, expected) => {
    expect(project(input)).toBe(expected);
  });

  it("escapes wiki braces and brackets in prose instead of activating macros or links", () => {
    expect(project("Literal {panel}, [42] and \\*star\\*.")).toBe(
      "Literal \\{panel\\}, \\[42\\] and \\*star\\*.",
    );
  });

  it("keeps a link with an unsafe destination as inert prose", () => {
    expect(project("[Link](javascript:alert(1))")).toBe("\\[Link\\](javascript:alert(1))");
  });

  it.each([
    ["[~user]", "\\[\\~user\\]"],
    ["!https://example.invalid/image.png!", "\\!https://example.invalid/image.png\\!"],
    ["[x|https://example.invalid]", "\\[x\\|https://example.invalid\\]"],
  ])("keeps wiki control characters inert inside inline code: %s", (text, escaped) => {
    expect(project(`\`${text}\``)).toBe(`{{${escaped}}}`);
  });

  it.each(["a  \nb", "a\\\nb"])("preserves an actual Markdown hard break: %j", (text) => {
    expect(project(text)).toBe("a\\\\\nb");
  });

  it.each([
    ["| | B | C |", "| x | y | z |", "|| ||B||C||\n|x|y|z|"],
    ["| A | | C |", "| x | y | z |", "||A|| ||C||\n|x|y|z|"],
    ["| A | B | |", "| x | y | z |", "||A||B|| ||\n|x|y|z|"],
    ["| A | B | C |", "| | y | z |", "||A||B||C||\n| |y|z|"],
    ["| A | B | C |", "| x | | z |", "||A||B||C||\n|x| |z|"],
    ["| A | B | C |", "| x | y | |", "||A||B||C||\n|x|y| |"],
  ])(
    "preserves empty table cells without changing delimiter semantics: %s / %s",
    (head, row, wiki) => {
      expect(project(`${head}\n| --- | --- | --- |\n${row}`)).toBe(wiki);
    },
  );

  it("keeps blank lines between top-level blocks", () => {
    expect(project("- a\n- b\n\npara")).toBe("* a\n* b\n\npara");
  });
});

describe("lists and gaps ported from the parallel converter (#4288)", () => {
  it.each([
    ["Before\n\n\n- a\n\n\nAfter", "Before\n\n* a\n\nAfter"],
    ["- a\n\n- b", "* a\n* b"],
    ["- a\n\n\n1. b\n\n- c", "* a\n# b\n* c"],
    ["- a\n  - b\n\n- d", "* a\n** b\n* d"],
  ])("collapses block gaps and keeps a loose list in one Jira list: %j", (text, expected) => {
    expect(project(text)).toBe(expected);
  });

  it("keeps a heading directly followed by its body without an inserted blank line", () => {
    expect(project("## Heading\nParagraph\n\n- a")).toBe("h2. Heading\nParagraph\n\n* a");
  });

  it("keeps blank lines inside code fences exactly as written", () => {
    expect(project("```\na\n\n\nb\n```")).toBe("{code}\na\n\n\nb\n{code}");
  });

  it("reads more than six nesting levels from the indentation", () => {
    const source = Array.from(
      { length: 8 },
      (_, depth) => `${"  ".repeat(depth)}- Level ${String(depth)}`,
    ).join("\n");
    const expected = Array.from(
      { length: 8 },
      (_, depth) => `${"*".repeat(depth + 1)} Level ${String(depth)}`,
    ).join("\n");
    expect(project(source)).toBe(expected);
  });

  it("reads four-space nesting and every bullet and number marker", () => {
    expect(project("- a\n    * b\n        + c\n1. d\n    1) e")).toBe(
      "* a\n** b\n*** c\n# d\n## e",
    );
  });

  it("keeps a finite nesting bound for hostile depth", () => {
    const source = Array.from({ length: 500 }, (_, depth) => `${" ".repeat(depth * 2)}- x`).join(
      "\n",
    );
    const longest = Math.max(...(project(source) ?? "").split("\n").map((line) => line.length));
    expect(longest).toBeLessThanOrEqual(18);
  });

  it("escapes literal wiki control characters in prose", () => {
    expect(project("Literal {panel}, [42], a_b and \\*star\\*.")).toBe(
      "Literal \\{panel\\}, \\[42\\], a_b and \\*star\\*.",
    );
  });

  it.each(["MIG_DAT-007", "snake_case", "a_b", "source_section_one", "__init__.py"])(
    "preserves literal identifier underscores byte for byte: %s",
    (identifier) => {
      expect(markdownInlineToJiraWiki(identifier)).toBe(identifier);
      expect(project(identifier)).toBe(identifier);
    },
  );

  it.each([String.raw`\_word\_`, String.raw`(\_word\_), \_next\_.`])(
    "keeps both delimiters of an escaped literal underscore pair inert: %s",
    (text) => {
      expect(markdownInlineToJiraWiki(text)).toBe(text);
      expect(project(text)).toBe(text);
    },
  );

  it.each([
    ["*word*", "_word_"],
    ["_word_", "_word_"],
    ["*snake_case*", "_snake_case_"],
    ["**MIG_DAT-007**", "*MIG_DAT-007*"],
    ["__word__", "*word*"],
    ["`MIG_DAT-007`", "{{MIG_DAT-007}}"],
  ])("retains actual Markdown emphasis and code around identifiers: %s", (text, expected) => {
    expect(markdownInlineToJiraWiki(text)).toBe(expected);
    expect(project(text)).toBe(expected);
  });
});
