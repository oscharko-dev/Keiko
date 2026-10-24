import { describe, expect, it } from "vitest";

import { parseSafeMarkdown, parseSafeUserInput, type SafeMarkdownNode } from "./safe-markdown";
import { SAFE_MARKDOWN_MAX_MATH_CHARS, scanMathSpan } from "./safe-markdown-math";

function mathNodes(nodes: readonly SafeMarkdownNode[]): SafeMarkdownNode[] {
  const found: SafeMarkdownNode[] = [];
  for (const node of nodes) {
    if (node.kind === "math") found.push(node);
    if (node.children !== undefined) found.push(...mathNodes(node.children));
  }
  return found;
}

function paragraphChildren(source: string, math = true): readonly SafeMarkdownNode[] {
  const [first] = parseSafeMarkdown(source, { math });
  return first?.children ?? [];
}

describe("scanMathSpan", () => {
  it.each([
    ["$x^2$", { text: "x^2", display: false, end: 5 }],
    ["$$x^2$$", { text: "x^2", display: true, end: 7 }],
    ["\\(x^2\\)", { text: "x^2", display: false, end: 7 }],
    ["\\[x^2\\]", { text: "x^2", display: true, end: 7 }],
    ["$\\rightarrow$ done", { text: "\\rightarrow", display: false, end: 13 }],
    ["$$\n  \\int_0^1 x\\,dx\n$$", { text: "\\int_0^1 x\\,dx", display: true, end: 22 }],
  ])("claims the complete span in %j", (source, expected) => {
    const found = scanMathSpan(source, 0);
    expect(found).toMatchObject(expected);
    expect(found?.raw).toBe(source.slice(0, expected.end));
  });

  it.each([
    ["a bare dollar sign", "$"],
    ["a dollar before whitespace", "$ x$"],
    ["a closing dollar after whitespace", "$x $"],
    ["a closing dollar before a digit", "$x$5"],
    ["an empty display span", "$$$$"],
    ["an empty inline paren span", "\\(  \\)"],
    ["an opener whose partner has not arrived", "$$x^2"],
    ["an unfinished bracket span", "\\[x^2"],
    ["an ordinary backslash", "\\alpha"],
    ["prices", "$5 and $6 total"],
    ["shell variables", "$HOME and $PATH"],
  ])("leaves %s as prose", (_name, source) => {
    expect(scanMathSpan(source, 0)).toBeNull();
  });

  it("does not look past the bounded window for a partner", () => {
    const body = "x".repeat(SAFE_MARKDOWN_MAX_MATH_CHARS + 10);
    expect(scanMathSpan(`$$${body}$$`, 0)).toBeNull();
    expect(scanMathSpan(`\\(${body}\\)`, 0)).toBeNull();
    expect(scanMathSpan(`$${body}$`, 0)).toBeNull();
  });

  it("accepts a span exactly as long as the bound", () => {
    const body = "x".repeat(SAFE_MARKDOWN_MAX_MATH_CHARS);
    expect(scanMathSpan(`$$${body}$$`, 0)?.text).toBe(body);
    expect(scanMathSpan(`\\(${body}\\)`, 0)?.text).toBe(body);
    expect(scanMathSpan(`$${body}$`, 0)?.text).toBe(body);
    expect(scanMathSpan(`$$${body}x$$`, 0)).toBeNull();
  });

  it("finishes a hostile run of unmatched openers in bounded time", () => {
    const source = "\\(".repeat(20_000);
    const started = performance.now();
    for (let pos = 0; pos < source.length; pos += 2) scanMathSpan(source, pos);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("parseSafeMarkdown math option", () => {
  it("emits no math node unless asked to, so existing output is unchanged", () => {
    const nodes = parseSafeMarkdown("It is $x_1 * y_2$ here.");
    expect(mathNodes(nodes)).toEqual([]);
    expect(JSON.stringify(nodes)).toBe(
      JSON.stringify(parseSafeMarkdown("It is $x_1 * y_2$ here.", { math: false })),
    );
  });

  it("claims a span before emphasis can split it", () => {
    const children = paragraphChildren("It is $a_b * c_d * e$ here.");
    expect(children.map((child) => child.kind)).toEqual(["text", "math", "text"]);
    expect(children[1]).toEqual({
      kind: "math",
      text: "a_b * c_d * e",
      raw: "$a_b * c_d * e$",
      display: false,
    });
  });

  it("claims display math that spans lines inside one paragraph", () => {
    const children = paragraphChildren("Before:\n$$\nx^2 + y^2\n$$\nAfter.");
    expect(children.map((child) => child.kind)).toEqual(["text", "math", "text"]);
    expect(children[1]).toMatchObject({ text: "x^2 + y^2", display: true });
  });

  it("turns a backslash-escaped dollar into a literal one", () => {
    const children = paragraphChildren("It costs \\$5 and \\$6 in $x$ total");
    expect(children.map((child) => child.kind)).toEqual([
      "text",
      "text",
      "text",
      "text",
      "text",
      "math",
      "text",
    ]);
    expect(children.filter((child) => child.kind === "text").map((child) => child.text)).toEqual([
      "It costs ",
      "$",
      "5 and ",
      "$",
      "6 in ",
      " total",
    ]);
  });

  it("keeps math out of inline code and reaches headings, lists, tables and quotes", () => {
    const source = [
      "# Energy $E=mc^2$",
      "",
      "- item $a$",
      "",
      "| h $b$ |",
      "| --- |",
      "| c $d$ |",
      "",
      "> quoted $e$",
      "",
      "Code `$not math$` stays code.",
    ].join("\n");
    const nodes = parseSafeMarkdown(source, { math: true });
    expect(mathNodes(nodes).map((node) => node.text)).toEqual(["E=mc^2", "a", "b", "d", "e"]);
  });

  it("claims math inside emphasis", () => {
    const children = paragraphChildren("**bold $x$** and _italic $y$_");
    expect(mathNodes(children).map((node) => node.text)).toEqual(["x", "y"]);
  });

  it("never claims math through user-input parsing", () => {
    expect(mathNodes(parseSafeUserInput("literal $x$ text"))).toEqual([]);
  });
});

describe("parseSafeMarkdown fences", () => {
  it("marks a fence whose closing line has not arrived", () => {
    const [block] = parseSafeMarkdown("```mermaid\ngraph TD\nA-->B");
    expect(block).toMatchObject({ kind: "code-block", language: "mermaid", unterminated: true });
  });

  it("does not mark a closed fence", () => {
    const [block] = parseSafeMarkdown("```mermaid\ngraph TD\nA-->B\n```\nafter");
    expect(block).toEqual({ kind: "code-block", language: "mermaid", text: "graph TD\nA-->B" });
    expect(block).not.toHaveProperty("unterminated");
  });

  it("treats a shorter inner fence as content of a longer one", () => {
    const [block] = parseSafeMarkdown("````diff\n+```\n````");
    expect(block).toEqual({ kind: "code-block", language: "diff", text: "+```" });
  });
});
