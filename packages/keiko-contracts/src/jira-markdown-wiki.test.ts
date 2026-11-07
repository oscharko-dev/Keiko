import { describe, expect, it } from "vitest";
import { projectJiraDescriptionInput } from "./jira-description-sections.js";

function project(text: string): string | undefined {
  return projectJiraDescriptionInput({ format: "markdown", text })?.text;
}

describe("explicit Markdown description projection", () => {
  it.each([
    [
      "## Goal\n**Strong** and *emphasis* with `code`.",
      "h2. Goal\n*Strong* and _emphasis_ with {{code}}.",
    ],
    ["- First\n  1. Nested\n  2. Next\n- Last", "* First\n*# Nested\n*# Next\n* Last"],
    ["1. First\n   - Nested\n2. Last", "# First\n#* Nested\n# Last"],
    ["[Guide](https://example.invalid/a_(b))", "[Guide|https://example.invalid/a_(b)]"],
    [
      "[Guide][ref]\n\n[ref]: https://example.invalid/guide",
      "[Guide|https://example.invalid/guide]",
    ],
    ["~~~js\nconst x = '**literal**';\n~~~", "{code:js}\nconst x = '**literal**';\n{code}"],
    ["    **literal**\n    ## code", "{code}\n**literal**\n## code\n{code}"],
    ["> Quoted **source**\n> stays quoted", "{quote}\nQuoted *source*\nstays quoted\n{quote}"],
    ["| Name | Value |\n| --- | --- |\n| A\\|B | `x\\|y` |", "||Name||Value||\n|A\\|B|{{x\\|y}}|"],
    ["Text\n\n---\n\n~~Removed~~", "Text\n\n----\n\n-Removed-"],
    ["Intro\nh1. ordinary\nbq. ordinary", "Intro\nh1\\. ordinary\nbq\\. ordinary"],
    ["Literal ??citation??", "Literal \\?\\?citation\\?\\?"],
  ])("projects supported structure without guessing from text: %s", (input, expected) => {
    expect(project(input)).toBe(expected);
    expect(projectJiraDescriptionInput(input)).toEqual({ text: input, convertedHeadingCount: 0 });
  });

  it.each([
    "```\n## literal\n~~~",
    "~~~\n## literal\n```",
    "```\nunterminated",
    "```\nliteral\n\t```",
    "```",
    "```\n{code}\n```",
    "<script>literal</script>",
    "![Image](https://example.invalid/image.png)",
    '[Link](https://example.invalid "Title")',
    "[Link](javascript:alert(1))",
    "| Heading |\n| :---: |\n| Value |",
    "| Name | Value |\n| --- | --- |\n| A | `x|y` |",
    "| Name | Value |\n| --- | --- |\n| A | B | discarded |",
    "3. Third item",
    "- A paragraph\n  continued on another line",
    "> ## Quoted heading",
    "{code}\n```\n## native code\n{code}",
  ])("refuses unsupported or ambiguous tagged input as a whole: %s", (text) => {
    expect(project(text)).toBeUndefined();
    expect(projectJiraDescriptionInput(text)).toEqual({ text, convertedHeadingCount: 0 });
  });

  it("escapes literal wiki control characters instead of activating macros or links", () => {
    expect(project("Literal {panel}, [42], a_b and \\*star\\*.")).toBe(
      "Literal \\{panel\\}, \\[42\\], a\\_b and \\*star\\*.",
    );
  });

  it("reads variable marker widths and more than six nesting levels from parser structure", () => {
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
});
