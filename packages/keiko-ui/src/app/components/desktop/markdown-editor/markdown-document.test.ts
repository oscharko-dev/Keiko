import { afterEach, describe, expect, it, vi } from "vitest";
import {
  joinMarkdownDocument,
  parseMarkdownDocument,
  serializeMarkdownDocument,
  splitMarkdownDocument,
  supportsFormattedEditing,
} from "./markdown-document";

const diagnostics = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: diagnostics.report }));

afterEach(() => {
  diagnostics.report.mockClear();
});

describe("splitMarkdownDocument / joinMarkdownDocument", () => {
  it("returns the whole text as body when there is no front matter", () => {
    expect(splitMarkdownDocument("# Title\n\ntext")).toEqual({
      frontMatter: undefined,
      body: "# Title\n\ntext",
    });
    expect(splitMarkdownDocument("")).toEqual({ frontMatter: undefined, body: "" });
  });

  it("splits YAML front matter from the body", () => {
    expect(splitMarkdownDocument("---\nname: a\nversion: 2\n---\n\n# Body\n")).toEqual({
      frontMatter: "name: a\nversion: 2",
      body: "# Body\n",
    });
  });

  it("splits CRLF documents", () => {
    const parts = splitMarkdownDocument("---\r\nname: a\r\n---\r\n\r\nbody");
    expect(parts.frontMatter).toBe("name: a");
    expect(parts.body).toBe("body");
  });

  it("treats empty front matter as present but empty", () => {
    expect(splitMarkdownDocument("---\n\n---\nbody")).toEqual({ frontMatter: "", body: "body" });
  });

  it("does not split an unterminated front matter fence", () => {
    const text = "---\nname: a\nbody without closing fence";
    expect(splitMarkdownDocument(text)).toEqual({ frontMatter: undefined, body: text });
  });

  it("does not treat a thematic break later in the file as front matter", () => {
    const text = "intro\n\n---\nname: a\n---\n";
    expect(splitMarkdownDocument(text).frontMatter).toBeUndefined();
  });

  it("allows trailing spaces after the closing fence and a document with no body", () => {
    expect(splitMarkdownDocument("---\na: 1\n---  ")).toEqual({ frontMatter: "a: 1", body: "" });
  });

  it("joins parts back into the same text", () => {
    for (const text of [
      "# Title\n\ntext",
      "---\nname: a\n---\n\n# Body\n",
      "---\nname: a\n---\n",
      "---\n\n---\n\nbody",
    ]) {
      expect(joinMarkdownDocument(splitMarkdownDocument(text))).toBe(text);
    }
  });

  it("joins without a body or without front matter", () => {
    expect(joinMarkdownDocument({ frontMatter: "a: 1", body: "" })).toBe("---\na: 1\n---\n");
    expect(joinMarkdownDocument({ frontMatter: undefined, body: "x" })).toBe("x");
  });

  it("handles a very long front matter line", () => {
    const line = `key: ${"x".repeat(200_000)}`;
    const text = `---\n${line}\n---\n\nbody`;
    expect(splitMarkdownDocument(text).frontMatter).toBe(line);
    expect(joinMarkdownDocument(splitMarkdownDocument(text))).toBe(text);
  });
});

describe("serializeMarkdownDocument / parseMarkdownDocument", () => {
  function roundTrip(markdown: string): string {
    return serializeMarkdownDocument(parseMarkdownDocument(markdown));
  }

  it.each([
    ["headings", "# One\n\n## Two\n\n### Three"],
    ["paragraphs", "First\n\nSecond"],
    ["bullet lists", "* a\n* b\n* c"],
    ["ordered lists", "1. a\n2. b\n3. c"],
    ["block quotes", "> quoted text"],
    ["fenced code with a language", "```ts\nconst a = 1;\n```"],
    ["fenced code without a language", "```\nplain\n```"],
    ["inline marks", "**bold** and *italic* and `code`"],
  ])("round-trips %s", (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it("keeps an unlabelled code fence unlabelled", () => {
    expect(roundTrip("```\nconst a = 1;\n```")).toBe("```\nconst a = 1;\n```");
  });

  it("escapes literal Markdown characters", () => {
    const serialized = serializeMarkdownDocument(
      parseMarkdownDocument("\\*not emphasis\\* and 1\\. not a list"),
    );
    expect(serialized).toContain("\\*not emphasis\\*");
    expect(parseMarkdownDocument(serialized).textContent).toBe("*not emphasis* and 1. not a list");
  });

  it("parses very long lines", () => {
    const line = "word ".repeat(40_000).trim();
    expect(parseMarkdownDocument(line).textContent).toBe(line);
  });
});

describe("supportsFormattedEditing", () => {
  it.each([
    ["plain prose", "Just a paragraph."],
    ["empty", ""],
    ["headings and lists", "# Title\n\n* a\n* b\n\n1. x\n2. y"],
    ["a quote and code", "> q\n\n```ts\nx\n```"],
    ["a thematic break", "a\n\n---\n\nb"],
  ])("is true for %s", (_name, body) => {
    expect(supportsFormattedEditing(body)).toBe(true);
    expect(diagnostics.report).not.toHaveBeenCalled();
  });

  it.each([
    ["a GFM table", "| a | b |\n| - | - |\n| 1 | 2 |"],
    ["an aligned table delimiter row", "a | b\n:-: | --:\n1 | 2"],
    ["a task list", "- [ ] todo\n- [x] done"],
    ["an uppercase task item", "* [X] done"],
    ["strikethrough", "this is ~~gone~~"],
    ["a footnote", "text[^1]\n\n[^1]: note"],
    ["inline HTML", "text <b>bold</b>"],
    ["an HTML comment", "<!-- hidden -->\n\ntext"],
    ["a block of HTML", "<div>\nx\n</div>"],
  ])("is false for %s", (_name, body) => {
    expect(supportsFormattedEditing(body)).toBe(false);
  });

  it("does not mistake prose with a pipe or dash for a table", () => {
    expect(supportsFormattedEditing("a | b - c")).toBe(true);
  });

  it("handles a hostile very long line quickly and without a verdict error", () => {
    expect(typeof supportsFormattedEditing("<".repeat(50_000))).toBe("boolean");
    expect(supportsFormattedEditing("a".repeat(200_000))).toBe(true);
  });

  it("keeps reference links formattable because the rendered result is unchanged", () => {
    expect(supportsFormattedEditing("[a][ref]\n\n[ref]: https://example.com")).toBe(true);
  });
});
