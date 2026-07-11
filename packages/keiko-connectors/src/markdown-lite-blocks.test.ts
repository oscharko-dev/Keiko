// Hermetic tests for the shared markdown-lite block parser (Issue #2244). The dialect is the
// single source both composers render from, so these goldens pin its meaning.

import { describe, expect, it } from "vitest";
import {
  MARKDOWN_LITE_MAX_INPUT_CHARS,
  parseMarkdownLiteBlocks,
  type MarkdownLiteBlock,
} from "./markdown-lite-blocks.js";

function blocksOf(input: string): readonly MarkdownLiteBlock[] {
  const parsed = parseMarkdownLiteBlocks(input);
  if (!parsed.ok) throw new Error(`expected ok, got ${parsed.reason}`);
  return parsed.blocks;
}

describe("parseMarkdownLiteBlocks — dialect goldens", () => {
  it("splits paragraphs on blank lines and keeps intra-paragraph line breaks", () => {
    expect(blocksOf("first line\nsecond line\n\nnext paragraph")).toEqual([
      { kind: "paragraph", lines: ["first line", "second line"] },
      { kind: "paragraph", lines: ["next paragraph"] },
    ]);
  });

  it("parses headings by hash count and treats seven hashes as plain text", () => {
    expect(blocksOf("# Title\n\n###### Deep")).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "heading", level: 6, text: "Deep" },
    ]);
    expect(blocksOf("####### too deep")).toEqual([
      { kind: "paragraph", lines: ["####### too deep"] },
    ]);
  });

  it("groups consecutive bullet items into one list", () => {
    expect(blocksOf("- one\n- two\ntail")).toEqual([
      { kind: "bulletList", items: ["one", "two"] },
      { kind: "paragraph", lines: ["tail"] },
    ]);
  });

  it("groups ordered items and keeps the first number as the start", () => {
    expect(blocksOf("3. three\n4. four")).toEqual([
      { kind: "orderedList", start: 3, items: ["three", "four"] },
    ]);
  });

  it("switches list kind on marker change instead of merging", () => {
    expect(blocksOf("- bullet\n1. ordered")).toEqual([
      { kind: "bulletList", items: ["bullet"] },
      { kind: "orderedList", start: 1, items: ["ordered"] },
    ]);
  });

  it("captures code fences verbatim with the bounded language word", () => {
    expect(blocksOf("```ts\nconst x = 1;\n\n# not a heading\n```\nafter")).toEqual([
      { kind: "codeBlock", language: "ts", lines: ["const x = 1;", "", "# not a heading"] },
      { kind: "paragraph", lines: ["after"] },
    ]);
  });

  it("drops a non-word fence language and keeps the fence", () => {
    expect(blocksOf('```js" onload="x\nbody\n```')).toEqual([
      { kind: "codeBlock", language: "", lines: ["body"] },
    ]);
  });

  it("runs an unterminated fence to end of input", () => {
    expect(blocksOf("```\nline one\nline two")).toEqual([
      { kind: "codeBlock", language: "", lines: ["line one", "line two"] },
    ]);
  });

  it("normalizes CRLF and lone CR to LF before parsing", () => {
    expect(blocksOf("a\r\nb\rc")).toEqual([{ kind: "paragraph", lines: ["a", "b", "c"] }]);
  });

  it("accepts tabs and returns an empty block list for empty input", () => {
    expect(blocksOf("col\tcol")).toEqual([{ kind: "paragraph", lines: ["col\tcol"] }]);
    expect(blocksOf("")).toEqual([]);
    expect(blocksOf("\n\n\n")).toEqual([]);
  });
});

describe("parseMarkdownLiteBlocks — hostile input", () => {
  it("rejects oversized input with the typed reason", () => {
    const oversized = "a".repeat(MARKDOWN_LITE_MAX_INPUT_CHARS + 1);
    expect(parseMarkdownLiteBlocks(oversized)).toEqual({ ok: false, reason: "input-too-large" });
    expect(parseMarkdownLiteBlocks("a".repeat(MARKDOWN_LITE_MAX_INPUT_CHARS)).ok).toBe(true);
  });

  it.each([
    { label: "NUL", value: "before\u0000after" },
    { label: "escape", value: "text\u001b[31m" },
    { label: "DEL", value: "text\u007f" },
    { label: "C1 control", value: "text\u0085" },
    { label: "vertical tab", value: "text\u000b" },
  ])("rejects control characters: $label", ({ value }) => {
    expect(parseMarkdownLiteBlocks(value)).toEqual({ ok: false, reason: "control-characters" });
  });

  it("is deterministic: repeated parses produce deep-equal block lists", () => {
    const input = "# T\n\npara\n\n- a\n- b\n\n```py\nx\n```";
    expect(parseMarkdownLiteBlocks(input)).toEqual(parseMarkdownLiteBlocks(input));
  });
});
