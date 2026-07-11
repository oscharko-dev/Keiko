// Golden tests for the plain-text→ADF composer (Issue #2244). The expected documents are pinned
// literally so any rendering drift is a visible diff, and the reverse converter
// (`convertAdfToText`) round-trips the composed output as a symmetry check.

import { describe, expect, it } from "vitest";
import { convertAdfToText } from "./adf-to-text.js";
import { MARKDOWN_LITE_MAX_INPUT_CHARS } from "./markdown-lite-blocks.js";
import { composePlainTextToAdf, type AdfComposedDocument } from "./plain-text-to-adf.js";

function docOf(input: string): AdfComposedDocument {
  const composed = composePlainTextToAdf(input);
  if (!composed.ok) throw new Error(`expected ok, got ${composed.reason}`);
  return composed.doc;
}

describe("composePlainTextToAdf — goldens", () => {
  it("composes paragraphs with hardBreak line separators", () => {
    expect(docOf("line one\nline two\n\nsecond")).toEqual({
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "line one" },
            { type: "hardBreak" },
            { type: "text", text: "line two" },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "second" }] },
      ],
    });
  });

  it("composes headings with the level attribute", () => {
    expect(docOf("## Section")).toEqual({
      version: 1,
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Section" }] },
      ],
    });
  });

  it("composes bullet lists of single-paragraph items", () => {
    expect(docOf("- alpha\n- beta")).toEqual({
      version: 1,
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "alpha" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "beta" }] }],
            },
          ],
        },
      ],
    });
  });

  it("composes ordered lists and records a non-default start as the order attribute", () => {
    expect(docOf("1. one")).toEqual({
      version: 1,
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
            },
          ],
        },
      ],
    });
    const started = docOf("5. five");
    expect(started.content[0]).toMatchObject({ type: "orderedList", attrs: { order: 5 } });
  });

  it("composes code fences into codeBlock nodes with the optional language", () => {
    expect(docOf("```ts\nconst x = 1;\n```")).toEqual({
      version: 1,
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    });
    expect(docOf("```\n\n```")).toEqual({
      version: 1,
      type: "doc",
      content: [{ type: "codeBlock", content: [] }],
    });
  });

  it("never emits an empty text node (empty heading, empty list item)", () => {
    expect(docOf("# ")).toEqual({
      version: 1,
      type: "doc",
      content: [{ type: "heading", attrs: { level: 1 }, content: [] }],
    });
    expect(docOf("- ")).toEqual({
      version: 1,
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [] }] }],
        },
      ],
    });
  });

  it("composes empty input to an empty document", () => {
    expect(docOf("")).toEqual({ version: 1, type: "doc", content: [] });
  });
});

describe("composePlainTextToAdf — determinism, bounds, and symmetry", () => {
  it("is deterministic: byte-identical JSON for repeated composition", () => {
    const input = "# T\n\npara one\npara two\n\n- a\n- b\n\n```py\nprint(1)\n```";
    expect(JSON.stringify(docOf(input))).toBe(JSON.stringify(docOf(input)));
  });

  it("round-trips through the reverse converter (adf-to-text symmetry)", () => {
    const outcome = convertAdfToText(docOf("# Title\n\nbody text\n\n- item"));
    expect(outcome.docShape).toBe("doc");
    expect(outcome.truncated).toBe(false);
    expect(outcome.unknownNodeTypes).toEqual([]);
    expect(outcome.text).toBe("# Title\n\nbody text\n\n- item");
  });

  it("bounds output linearly: serialized size stays proportional to input size", () => {
    const input = "line\n\n".repeat(10_000).trimEnd();
    expect(input.length).toBeLessThanOrEqual(MARKDOWN_LITE_MAX_INPUT_CHARS);
    const serialized = JSON.stringify(docOf(input));
    expect(serialized.length).toBeLessThan(input.length * 15);
  });

  it("rejects hostile input with the typed reasons and composes nothing", () => {
    expect(composePlainTextToAdf("a".repeat(MARKDOWN_LITE_MAX_INPUT_CHARS + 1))).toEqual({
      ok: false,
      reason: "input-too-large",
    });
    expect(composePlainTextToAdf("nul\u0000")).toEqual({
      ok: false,
      reason: "control-characters",
    });
  });
});
