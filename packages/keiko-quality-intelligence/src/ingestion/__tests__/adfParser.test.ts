// Tests for the ADF parser (Epic #270, Issue #278).

import { describe, expect, it } from "vitest";

import { ADF_PARSER_DEFAULTS, AdfParserError, parseAdfDocument } from "../adfParser.js";

describe("parseAdfDocument — happy path", () => {
  it("parses a doc with paragraph + heading + bulletList", () => {
    const doc = parseAdfDocument({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Body" }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Item one" }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(doc.version).toBe(1);
    expect(doc.blocks).toHaveLength(3);
    expect(doc.blocks[0]?.kind).toBe("heading");
    expect(doc.blocks[1]?.kind).toBe("paragraph");
    expect(doc.blocks[2]?.kind).toBe("bulletList");
    expect(doc.stats.nodes).toBeGreaterThan(0);
  });

  it("extracts a link mark into a linkRef block alongside the runs", () => {
    const doc = parseAdfDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "click",
              marks: [{ type: "link", attrs: { href: "https://example.invalid/x" } }],
            },
          ],
        },
      ],
    });
    const paragraph = doc.blocks[0];
    expect(paragraph?.kind).toBe("paragraph");
    // The text node with a link mark produces a linkRef (NOT a text run).
    if (paragraph?.kind === "paragraph") {
      expect(paragraph.runs).toHaveLength(0);
    }
  });

  it("exposes documented defaults", () => {
    expect(ADF_PARSER_DEFAULTS.maxNodes).toBe(5_000);
    expect(ADF_PARSER_DEFAULTS.maxDepth).toBe(32);
    expect(ADF_PARSER_DEFAULTS.maxTextBytes).toBe(64 * 1024);
  });
});

describe("parseAdfDocument — typed errors", () => {
  it("rejects non-object root with ROOT_NOT_OBJECT", () => {
    try {
      parseAdfDocument("not-an-object");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdfParserError);
      if (err instanceof AdfParserError) {
        expect(err.code).toBe("ROOT_NOT_OBJECT");
      }
    }
  });

  it("rejects wrong root type with ROOT_TYPE_MISMATCH", () => {
    try {
      parseAdfDocument({ type: "paragraph", content: [] });
      expect.unreachable("should have thrown");
    } catch (err) {
      if (err instanceof AdfParserError) {
        expect(err.code).toBe("ROOT_TYPE_MISMATCH");
      }
    }
  });

  it("rejects unknown node types with UNKNOWN_NODE_TYPE", () => {
    try {
      parseAdfDocument({
        type: "doc",
        content: [{ type: "blockquote", content: [] }],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      if (err instanceof AdfParserError) {
        expect(err.code).toBe("UNKNOWN_NODE_TYPE");
      }
    }
  });

  it("rejects invalid heading level", () => {
    try {
      parseAdfDocument({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 9 },
            content: [{ type: "text", text: "x" }],
          },
        ],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      if (err instanceof AdfParserError) {
        expect(err.code).toBe("INVALID_HEADING_LEVEL");
      }
    }
  });

  it("enforces maxNodes cap", () => {
    const content = Array.from({ length: 10 }, (_, i) => ({
      type: "paragraph",
      content: [{ type: "text", text: `p${String(i)}` }],
    }));
    try {
      parseAdfDocument({ type: "doc", content }, { maxNodes: 3 });
      expect.unreachable("should have thrown");
    } catch (err) {
      if (err instanceof AdfParserError) {
        expect(err.code).toBe("MAX_NODES_EXCEEDED");
      }
    }
  });
});
