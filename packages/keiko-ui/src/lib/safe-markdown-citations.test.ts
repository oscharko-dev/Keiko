import { describe, expect, it } from "vitest";
import { citationMarkerIndices } from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import { parseSafeMarkdown, type SafeMarkdownNode } from "./safe-markdown";

// The citations the chat shows: SafeMarkdown renders marker groups inside text nodes only, never
// inside inline code, a code block or a link label.
function renderedCitationIndices(nodes: readonly SafeMarkdownNode[]): readonly number[] {
  return nodes.flatMap((node): readonly number[] => {
    if (node.kind === "text") return citationMarkerIndices(node.text ?? "");
    if (node.kind === "inline-code" || node.kind === "code-block" || node.kind === "link") {
      return [];
    }
    return renderedCitationIndices(node.children ?? []);
  });
}

const TICK = "An unmatched ` appears here.";

// PR #3678 review: the shared marker grammar must see exactly the markers the renderer shows, so a
// cited claim between literal backticks of two blocks keeps its citation and a marker inside a
// rendered code span never counts.
describe("citation markers follow the rendered Markdown blocks", () => {
  it.each([
    ["thematic breaks", `${TICK}\n---\nThe API uses TLS [1].\n---\n${TICK}`],
    ["star and underscore rules", `${TICK}\n***\nThe API uses TLS [1].\n___\n${TICK}`],
    ["blank lines", `${TICK}\n\nThe API uses TLS [1].\n\n${TICK}`],
    ["a heading", `${TICK}\n# The API uses TLS [1]\n${TICK}`],
    ["the line after a heading", "# Heading ` here\nThe API uses TLS [1] ` there"],
    ["an indented list item", `${TICK}\n      - The API uses TLS [1]\n${TICK}`],
    ["an ordered list item", `${TICK}\n2. The API uses TLS [1]\n${TICK}`],
    ["a block quote", `${TICK}\n> The API uses TLS [1]\n${TICK}`],
    ["table rows", "| a ` | b |\n| --- | :-: |\n| TLS [1] | c ` |"],
    ["table cells", "| a ` | TLS [1] | c ` |\n|---|---|---|"],
    ["a fence", "Tick ` here [1]\n```\ncode\n```\nand ` there [2]."],
    ["a paragraph continuation", "A ` tick\n1) item [1] ` end [2]"],
    ["a setext-like underline", "A ` tick\n===\nitem [1] ` end [2]"],
    ["quoted lines of one paragraph", "> A ` tick\n> item [1] ` end [2]"],
    ["quoted paragraphs", "> A ` tick\n>\n> item [1] ` end [2]"],
    // Past its nesting cap the renderer emits the quoted body as one text node.
    ["a quote past the nesting cap", `${"> ".repeat(17)}A \` tick [1] \` end [2]`],
  ])("agrees with the renderer across %s", (_name, answer) => {
    const rendered = renderedCitationIndices(parseSafeMarkdown(answer));

    expect(rendered.length).toBeGreaterThan(0);
    expect(citationMarkerIndices(answer)).toEqual(rendered);
  });
});
