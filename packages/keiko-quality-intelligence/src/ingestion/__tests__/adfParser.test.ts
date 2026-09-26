// Tests for the ADF parser (Epic #270, Issue #278).

import { describe, expect, it } from "vitest";

import {
  ADF_PARSER_DEFAULTS,
  AdfParserError,
  parseAdfDocument,
  renderAdfDocumentText,
} from "../adfParser.js";

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
    expect(ADF_PARSER_DEFAULTS.maxDocumentBytes).toBe(2 * 1024 * 1024);
  });

  it("degrades table, panel, and status nodes into renderable text", () => {
    const doc = parseAdfDocument({
      type: "doc",
      content: [
        {
          type: "panel",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Freigabe " },
                { type: "status", attrs: { text: "P1" } },
              ],
            },
          ],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Feld" }] }],
                },
                {
                  type: "tableHeader",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Regel" }] }],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "IBAN" }] }],
                },
                {
                  type: "tableCell",
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "Prüfziffer gültig" }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(doc.blocks.map((block) => block.kind)).toEqual(["panel", "table"]);
    const rendered = renderAdfDocumentText(doc);
    expect(rendered).toContain("Freigabe P1");
    expect(rendered).toContain("| Feld | Regel |");
    expect(rendered).toContain("| IBAN | Prüfziffer gültig |");
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

  it("rejects an inline child of a recognised BLOCK type (neither text nor status) with UNKNOWN_NODE_TYPE", () => {
    // "heading" is a known top-level node type, so it clears getNodeType's whitelist check, but it
    // is not a valid INLINE child — this reaches parseInlineChild's fallthrough (neither "text" nor
    // "status"), which is otherwise never exercised by the block-level "unknown type" test above.
    try {
      parseAdfDocument({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "heading", attrs: { level: 1 }, content: [] }],
          },
        ],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdfParserError);
      if (err instanceof AdfParserError) {
        expect(err.code).toBe("UNKNOWN_NODE_TYPE");
        expect(err.message).toContain('Expected inline text, got "heading"');
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

  // KEIKO-0891: the node/depth/text-run bounds above only examine fields the parser actually
  // reads (type/content/attrs/marks/text) — a huge value sitting in an unvisited property (a key
  // outside that whitelist) would sail through unexamined. maxDocumentBytes closes that gap by
  // measuring the whole serialised input up front.
  it("rejects a document whose serialised size exceeds maxDocumentBytes, even in an unvisited field", () => {
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
      // Not a field the walker reads (type/content/attrs/marks/text) — proves the cap inspects the
      // whole payload, not just node-visited data.
      unvisitedJunk: "x".repeat(1_000),
    };
    try {
      parseAdfDocument(doc, { maxDocumentBytes: 100 });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdfParserError);
      if (err instanceof AdfParserError) {
        expect(err.code).toBe("DOCUMENT_TOO_LARGE");
      }
    }
  });

  it("accepts a document within maxDocumentBytes unchanged", () => {
    const doc = parseAdfDocument(
      {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
      },
      { maxDocumentBytes: 100 },
    );
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]?.kind).toBe("paragraph");
  });

  it("rejects at the default 2 MiB ceiling with no override needed", () => {
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
      unvisitedJunk: "x".repeat(3 * 1024 * 1024),
    };
    try {
      parseAdfDocument(doc);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdfParserError);
      if (err instanceof AdfParserError) {
        expect(err.code).toBe("DOCUMENT_TOO_LARGE");
      }
    }
  });
});
