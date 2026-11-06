import { describe, expect, it } from "vitest";
import {
  readJiraDescriptionSections,
  serializeJiraDescriptionHeadings,
  projectJiraDescriptionInput,
  readJiraMarkdownDescription,
} from "./jira-description-sections.js";
import { parseJiraIssueTemplate } from "./jira-issue-template.js";

function summary(text: string): readonly string[] {
  return readJiraDescriptionSections(text).map(
    (section) =>
      `${String(section.level)}:${section.title}:${section.hasContent ? "full" : "empty"}`,
  );
}

describe("Data Center description heading serialization", () => {
  it("never infers Markdown from a legacy string, including native wiki lists", () => {
    for (const text of [
      "# criterion one\n# criterion two",
      "## nested criterion",
      "h2. Section\n# criterion",
      "## Markdown-looking heading\nBody",
    ]) {
      expect(projectJiraDescriptionInput(text)).toEqual({ text, convertedHeadingCount: 0 });
    }
    expect(projectJiraDescriptionInput({ format: "markdown", text: "## Heading\nBody" })).toEqual({
      text: "h2. Heading\nBody",
      convertedHeadingCount: 1,
    });
  });

  it("accepts only the exact explicit data wrapper and refuses prototype or accessor tricks", () => {
    const plain = { format: "markdown", text: "## Heading\nBody" };
    expect(readJiraMarkdownDescription(plain)).toBe(plain.text);
    const nullPrototype: unknown = Object.assign(Object.create(null) as object, plain);
    expect(readJiraMarkdownDescription(nullPrototype)).toBe(plain.text);
    let getterCalls = 0;
    const accessor = {
      get format(): string {
        getterCalls++;
        return "markdown";
      },
      text: plain.text,
    };
    for (const invalid of [
      null,
      [],
      { ...plain, extra: true },
      { format: "Markdown", text: plain.text },
      { format: "markdown", text: 3 },
      Object.assign(Object.create({ inherited: true }) as object, plain),
      accessor,
      { ...plain, [Symbol("extra")]: true },
      { ...plain, text: "x".repeat(32769) },
    ]) {
      expect(readJiraMarkdownDescription(invalid)).toBeUndefined();
    }
    expect(getterCalls).toBe(0);
  });

  it("writes real wiki headings while retaining every criterion, source and footer byte", () => {
    const source =
      "## Requirement\nExact requirement.\n\n## Acceptance criteria\n* one\n* two\n* three\n* four\n* five\n\n## Source\n[Source|https://source.example.invalid]\n\nKeiko trace: unchanged.";
    const expected =
      "h2. Requirement\nExact requirement.\n\nh2. Acceptance criteria\n* one\n* two\n* three\n* four\n* five\n\nh2. Source\n[Source|https://source.example.invalid]\n\nKeiko trace: unchanged.";
    const result = serializeJiraDescriptionHeadings(source);
    expect(result).toEqual({ text: expected, convertedHeadingCount: 3 });
    expect(summary(result.text)).toEqual(summary(source));
    expect(serializeJiraDescriptionHeadings(result.text)).toEqual({
      text: expected,
      convertedHeadingCount: 0,
    });
  });

  it("shares ATX and setext recognition and preserves surrounding line endings", () => {
    const source = "# Title #\r\nBody\r\n\r\nSection\r\n---\r\nExact body\r\n\r\nDeep\n===\nTail";
    expect(serializeJiraDescriptionHeadings(source)).toEqual({
      text: "h1. Title\r\nBody\r\n\r\nh2. Section\r\nExact body\r\n\r\nh1. Deep\nTail",
      convertedHeadingCount: 3,
    });
  });

  it.each([
    "```ts\n## code\n```",
    "~~~~\n## code\n~~~~",
    "{code:java}\n## code\n{code}",
    "{noformat}\n## literal\n{noformat}",
    "> ## Source quote",
    "    ## indented code",
    "\\## escaped heading",
    "> Quoted source\n---",
    "h2. Existing wiki\nExact body",
  ])("preserves protected or already serialized text: %s", (protectedText) => {
    const source = `${protectedText}\n\n## Actual section\nExact content`;
    expect(serializeJiraDescriptionHeadings(source)).toEqual({
      text: `${protectedText}\n\nh2. Actual section\nExact content`,
      convertedHeadingCount: 1,
    });
  });

  it("keeps unfinished code and over-bound input intact instead of partially rewriting them", () => {
    for (const source of [
      "```\n## Code to end",
      "~~~\n## Code to end",
      "{code}\n## Code to end",
      "x".repeat((1 << 20) + 1) + "\n## Tail",
    ]) {
      expect(serializeJiraDescriptionHeadings(source)).toEqual({
        text: source,
        convertedHeadingCount: 0,
      });
    }
  });

  it.each([
    "- criterion",
    "* criterion",
    "** nested criterion",
    "+ criterion",
    "1. criterion",
    "1) criterion",
    "\tcode",
    " \tcode",
    "    code",
    "----",
    "***",
    "___",
  ])("does not promote a list, rule or code line into setext: %s", (line) => {
    const source = `${line}\n---\nExact body`;
    expect(serializeJiraDescriptionHeadings(source)).toEqual({
      text: source,
      convertedHeadingCount: 0,
    });
  });
});

// A one-line macro or inline code opened a fence that nothing closed, so every heading after it
// was read as code and a section the description really has looked missing.
describe("one-line code does not open a fence", () => {
  it.each([
    ["{code}x = 1{code}", "wiki code macro"],
    ["{code:java}int x;{code}", "wiki code macro with a language"],
    ["{noformat}raw{noformat}", "wiki noformat macro"],
    ["```inline```", "markdown inline code"],
  ])("keeps the headings after %s (%s)", (line) => {
    expect(summary(`h2. A\n${line}\nh2. B\ntext`)).toEqual(["2:A:full", "2:B:full"]);
  });

  it("still hides the headings inside a real code block", () => {
    expect(summary("h2. A\n{code:java}\nh2. fake\n{code}\nh2. B\ntext")).toEqual([
      "2:A:full",
      "2:B:full",
    ]);
    expect(summary("## A\n```\n## fake\n```\n## B\ntext")).toEqual(["2:A:full", "2:B:full"]);
  });
});

describe("heading detection never backtracks", () => {
  it("reads a 100k character adversarial line in linear time", () => {
    const hostile = [
      `# a${" ".repeat(100_000)}b`,
      `## a${" ".repeat(50_000)}#${" ".repeat(50_000)}b`,
      `h2. a${" \t".repeat(50_000)}b`,
      `#${" ".repeat(100_000)}`,
      `${"#".repeat(100_000)} x`,
      "x".repeat(100_000),
    ].join("\n");
    const started = performance.now();
    readJiraDescriptionSections(hostile);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("treats a line over the heading bound as text, not as a heading", () => {
    expect(summary(`## Context\n## ${"x".repeat(600)}\nbody`)).toEqual(["2:Context:full"]);
  });
});

describe("one reader of description structure", () => {
  it("reads ATX, wiki and setext headings with their levels", () => {
    expect(
      summary("# One\ntext\n## Two ##\ntext\nh3. Three\ntext\nFour\n====\ntext\nFive\n-----\ntext"),
    ).toEqual(["1:One:full", "2:Two:full", "3:Three:full", "1:Four:full", "2:Five:full"]);
  });

  it("ignores headings inside fenced code and wiki code blocks", () => {
    expect(
      summary(
        "## Real\n```\n## Not a heading\n```\n~~~\n# also not\n~~~\n{code:java}\nh2. neither\n{code}\n## Next\ntext",
      ),
    ).toEqual(["2:Real:full", "2:Next:full"]);
  });

  it("lets a deeper heading belong to the enclosing section", () => {
    expect(summary("## Outer\n### Inner\ncontent\n## Sibling\n")).toEqual([
      "2:Outer:full",
      "3:Inner:full",
      "2:Sibling:empty",
    ]);
  });

  it("keeps a section of only an empty subsection non-empty and an unfilled one empty", () => {
    expect(summary("## Outer\n### Inner\n")).toEqual(["2:Outer:full", "3:Inner:empty"]);
    expect(summary("## Outer\n\ntbd\n## Next\ntext")).toEqual(["2:Outer:empty", "2:Next:full"]);
  });

  it("does not count the title of a setext heading as content of the section it closes", () => {
    expect(summary("## A\nB\n===\ntext")).toEqual(["2:A:empty", "1:B:full"]);
  });

  it("ignores indented code, empty headings and an over-long title", () => {
    expect(summary("    ## code\n#\n##   \n## Real\nx")).toEqual(["2:Real:full"]);
  });
});

describe("the template parser reads its body with the same reader", () => {
  const front =
    "---\nkeiko: jira-issue-template\nversion: 1\nproject: ABC\nissueType: Story\nactivateOn: [edit]\n---\n";
  function sections(body: string): readonly string[] {
    const parsed = parseJiraIssueTemplate(`${front}${body}`);
    if (!parsed.ok) throw new Error("fixture must parse");
    return parsed.template.requiredSections;
  }

  it("takes setext H2 sections and skips headings in fenced code", () => {
    expect(
      sections("Context\n-------\n```\n## Not required\n```\n## Acceptance criteria\n"),
    ).toEqual(["Context", "Acceptance criteria"]);
  });

  it("ignores H1 and H3 headings, which are structure and not required sections", () => {
    expect(sections("# Title\n### Detail\n## Required\n")).toEqual(["Required"]);
  });
});

describe("native Jira wiki section admission", () => {
  it("does not credit Markdown-looking numbered lists or setext text as native headings", () => {
    const native = "## Criteria\n* exact\nSource\n---\nReference";
    expect(readJiraDescriptionSections(native, "jira-wiki")).toEqual([]);
    expect(readJiraDescriptionSections(native).map((section) => section.title)).toEqual([
      "Criteria",
      "Source",
    ]);
  });

  it("retains native heading content while lists, code and quotes stay content", () => {
    const native =
      "h2. Criteria\n# first\n## nested\n{code}\nh2. Fake\n{code}\n> h2. Quoted\nh2. Source\nReference";
    expect(readJiraDescriptionSections(native, "jira-wiki")).toEqual([
      { level: 2, title: "Criteria", hasContent: true },
      { level: 2, title: "Source", hasContent: true },
    ]);
  });
});
