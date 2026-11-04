// Fidelity of the ADF parser on real Jira content (parser audit #4235): every node type a Jira
// description or comment carries must keep the text and structure a requirement needs.

import { describe, expect, it } from "vitest";

import { AdfParserError, parseAdfDocument, renderAdfDocumentText } from "../adfParser.js";

const text = (value: string, marks?: readonly object[]): object => ({
  type: "text",
  text: value,
  ...(marks === undefined ? {} : { marks }),
});
const para = (...content: object[]): object => ({ type: "paragraph", content });
const item = (...content: object[]): object => ({ type: "listItem", content });
const doc = (...content: object[]): object => ({ type: "doc", version: 1, content });
const render = (input: object, options?: Parameters<typeof parseAdfDocument>[1]): string =>
  renderAdfDocumentText(parseAdfDocument(input, options));

describe("ADF inline nodes", () => {
  it("renders a hard break as a line break", () => {
    expect(render(doc(para(text("one"), { type: "hardBreak" }, text("two"))))).toBe("one\ntwo");
  });

  it("keeps mention, emoji, date, card and status text", () => {
    const rendered = render(
      doc(
        para(
          text("Ask "),
          { type: "mention", attrs: { id: "u1", text: "@Ann" } },
          text(" "),
          { type: "emoji", attrs: { shortName: ":smile:", text: "ok" } },
          text(" by "),
          { type: "date", attrs: { timestamp: "1700000000000" } },
          text(" see "),
          { type: "inlineCard", attrs: { url: "https://example.invalid/browse/A-1" } },
          text(" "),
          { type: "status", attrs: { text: "DONE" } },
        ),
      ),
    );
    expect(rendered).toBe("Ask @Ann ok by 2023-11-14 see https://example.invalid/browse/A-1 DONE");
  });

  it("falls back to the mention id and ignores an unparsable date", () => {
    expect(
      render(
        doc(
          para({ type: "mention", attrs: { id: "u9" } }, text(" "), {
            type: "date",
            attrs: { timestamp: "nope" },
          }),
        ),
      ),
    ).toBe("@u9");
  });

  it("renders the UTC calendar date across epoch, leap day and pre-epoch timestamps", () => {
    const dateOf = (timestamp: unknown): string =>
      render(doc(para({ type: "date", attrs: { timestamp } })));
    expect(dateOf("0")).toBe("1970-01-01");
    expect(dateOf(-1)).toBe("1969-12-31");
    expect(dateOf(1709164800000)).toBe("2024-02-29");
    expect(dateOf("951782400000")).toBe("2000-02-29");
    expect(dateOf("4102444799999")).toBe("2099-12-31");
  });

  it("keeps the text of an unknown inline node", () => {
    const rendered = render(
      doc(para(text("a "), { type: "futureInline", content: [text("inner")] }, text(" b"))),
    );
    expect(rendered).toBe("a inner b");
  });

  it("keeps a link without a usable href as plain text", () => {
    expect(render(doc(para(text("t", [{ type: "link", attrs: {} }]))))).toBe("t");
  });
});

describe("ADF block structure", () => {
  it("keeps nested lists indented under their parent item", () => {
    const rendered = render(
      doc({
        type: "bulletList",
        content: [
          item(para(text("a")), {
            type: "bulletList",
            content: [item(para(text("a1"))), item(para(text("a2")))],
          }),
          item(para(text("b"))),
        ],
      }),
    );
    expect(rendered).toBe("- a\n  - a1\n  - a2\n- b");
  });

  it("keeps a second paragraph inside the list item that owns it", () => {
    const rendered = render(
      doc({ type: "bulletList", content: [item(para(text("first")), para(text("more")))] }),
    );
    expect(rendered).toBe("- first\n  more");
  });

  it("honours the start number of an ordered list", () => {
    const rendered = render(
      doc({
        type: "orderedList",
        attrs: { order: 3 },
        content: [item(para(text("x"))), item(para(text("y")))],
      }),
    );
    expect(rendered).toBe("3. x\n4. y");
  });

  it("marks a header row and keeps a hard break inside a cell on one row", () => {
    const rendered = render(
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [para(text("ID"))] },
              { type: "tableHeader", content: [para(text("Rule"))] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [para(text("FR-1"))] },
              {
                type: "tableCell",
                content: [para(text("must"), { type: "hardBreak" }, text("hold"))],
              },
            ],
          },
        ],
      }),
    );
    expect(rendered).toBe("| ID | Rule |\n| --- | --- |\n| FR-1 | must hold |");
  });

  it("renders blockquote, rule, expand and media", () => {
    const rendered = render(
      doc(
        { type: "blockquote", content: [para(text("quoted"))] },
        { type: "rule" },
        { type: "expand", attrs: { title: "Details" }, content: [para(text("inside"))] },
        {
          type: "mediaSingle",
          content: [{ type: "media", attrs: { type: "file", id: "x", alt: "diagram" } }],
        },
      ),
    );
    expect(rendered).toBe("> quoted\n---\nDetails\ninside\n[media: diagram]");
  });

  it("renders task and decision lists with their state", () => {
    const rendered = render(
      doc(
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { state: "DONE" }, content: [text("shipped")] },
            { type: "taskItem", attrs: { state: "TODO" }, content: [text("open")] },
          ],
        },
        { type: "decisionList", content: [{ type: "decisionItem", content: [text("use X")] }] },
      ),
    );
    expect(rendered).toBe("[x] shipped\n[ ] open\nDecision: use X");
  });

  it("keeps a block that sits where a list item or table row is expected", () => {
    const rendered = render(
      doc(
        { type: "bulletList", content: [para(text("loose"))] },
        { type: "table", content: [para(text("stray"))] },
      ),
    );
    expect(rendered).toContain("- loose");
    expect(rendered).toContain("| stray |");
  });

  it("keeps inline text that sits directly in a container", () => {
    expect(render(doc({ type: "panel", content: [text("bare")] }))).toBe("bare");
  });

  it("returns empty text for an empty document", () => {
    expect(render({ type: "doc", version: 1, content: [] })).toBe("");
    expect(render({ type: "doc" })).toBe("");
  });
});

describe("ADF unknown nodes and limits", () => {
  it("names each unknown node type once, bounded, without any content", () => {
    const parsed = parseAdfDocument(
      doc(
        { type: "alpha", content: [para(text("secret one"))] },
        { type: "alpha", content: [para(text("secret two"))] },
        { type: "b".repeat(200), content: [] },
      ),
    );
    expect(parsed.stats.unknownNodeTypes).toEqual(["alpha", "b".repeat(60)]);
    expect(JSON.stringify(parsed.stats)).not.toContain("secret");
  });

  it("reports cut text in the stats instead of hiding it", () => {
    const parsed = parseAdfDocument(doc(para(text("x".repeat(500)))), { maxTextBytes: 64 });
    expect(parsed.stats.truncatedBlocks).toBe(1);
    const code = parseAdfDocument(doc({ type: "codeBlock", content: [text("y".repeat(500))] }), {
      maxTextBytes: 64,
    });
    expect(code.stats.truncatedBlocks).toBe(1);
  });

  it("reports no truncation for text within the limit", () => {
    expect(parseAdfDocument(doc(para(text("short")))).stats.truncatedBlocks).toBe(0);
  });

  it("still rejects a block node in inline position and structural bombs", () => {
    expect(() => parseAdfDocument(doc(para({ type: "heading", attrs: { level: 1 } })))).toThrow(
      AdfParserError,
    );
    let nested: object = para(text("deep"));
    for (let i = 0; i < 40; i += 1) nested = { type: "unknownWrapper", content: [nested] };
    expect(() => parseAdfDocument(doc(nested))).toThrow(/MAX_DEPTH_EXCEEDED/u);
    expect(() => parseAdfDocument(doc(nested), { maxNodes: 5 })).toThrow(AdfParserError);
  });

  it("rejects a non-object child and a node without a string type", () => {
    expect(() => parseAdfDocument(doc("text"))).toThrow(/NODE_NOT_OBJECT/u);
    expect(() => parseAdfDocument(doc({ content: [] }))).toThrow(/NODE_NOT_OBJECT/u);
  });
});
