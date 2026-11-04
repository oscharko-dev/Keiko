import { describe, expect, it } from "vitest";
import { readJiraDescriptionSections } from "./jira-description-sections.js";
import { parseJiraIssueTemplate } from "./jira-issue-template.js";

function summary(text: string): readonly string[] {
  return readJiraDescriptionSections(text).map(
    (section) =>
      `${String(section.level)}:${section.title}:${section.hasContent ? "full" : "empty"}`,
  );
}

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
