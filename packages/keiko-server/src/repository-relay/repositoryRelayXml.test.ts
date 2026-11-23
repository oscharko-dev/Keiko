import { describe, expect, it } from "vitest";
import { childElements, childText, decodeXmlText, parseXmlElements } from "./repositoryRelayXml.js";

describe("parseXmlElements attributes (#4522)", () => {
  it("reads a `>` inside a quoted attribute value as part of the value, not as the end of the tag", () => {
    const root = parseXmlElements(
      `<server note="a > b" other='>'><password id="x>y">secret</password></server>`,
    );
    expect(root?.name).toBe("server");
    expect(root?.text).toBe("");
    expect(childText(root ?? { name: "", children: [], text: "" }, "password")).toBe("secret");
  });

  it("keeps ordinary attributes, a self-closing element and whitespace before the end of a tag", () => {
    const root = parseXmlElements(`<a x="1"  y='2' ><b/><c z = "3" /><d>t</d ></a>`);
    expect(root?.children.map((child) => child.name)).toEqual(["b", "c", "d"]);
  });

  it.each([
    ["an unquoted value", `<a x=1><b>t</b></a>`],
    ["a `<` inside a value", `<a x="<"><b>t</b></a>`],
    ["an attribute without a value", `<a x><b>t</b></a>`],
    ["an unterminated value", `<a x="1><b>t</b></a>`],
  ])("refuses a document with %s", (_name, xml) => {
    expect(parseXmlElements(xml)).toBeUndefined();
  });
});

describe("parseXmlElements scanning (#4522)", () => {
  it("reads text, CDATA, entity references, comments and processing instructions", () => {
    const root = parseXmlElements(
      `<?xml version="1.0"?><!-- c --><a><b>x &amp; &#65;&#x42;</b><c><![CDATA[<raw>]]></c><?pi data?></a>`,
    );
    expect(root?.children.map((child) => child.text)).toEqual(["x & AB", "<raw>"]);
  });

  it.each([
    ["a DOCTYPE", `<!DOCTYPE a><a/>`],
    ["an entity it does not model", `<a>&custom;</a>`],
    ["a reference to a surrogate", `<a>&#xD800;</a>`],
    ["an unterminated CDATA section", `<a><![CDATA[x</a>`],
    ["an unterminated comment", `<a><!-- x</a>`],
    ["an unterminated processing instruction", `<a><?x </a>`],
    ["a tag that is not closed", `<a x="1"`],
    ["a stray less-than sign", `<a>1 < 2</a>`],
    ["a mismatched closing tag", `<a><b></a></b>`],
    ["an unclosed element", `<a><b></b>`],
    ["a closing tag with nothing open", `</a>`],
    ["text before the root", `text<a/>`],
    ["a second root element", `<a/><b/>`],
    ["a document that is too large", `<a>${"x".repeat(1024 * 1024)}</a>`],
    ["a nesting deeper than the bound", `${"<a>".repeat(70)}${"</a>".repeat(70)}`],
  ])("refuses %s", (_name, xml) => {
    expect(parseXmlElements(xml)).toBeUndefined();
  });

  it("accepts whitespace and a comment around the root", () => {
    expect(parseXmlElements(`\n  <!-- c -->\n<a/>\n`)?.name).toBe("a");
  });

  it("reads child text through its accessors", () => {
    const root = parseXmlElements(`<a><b>1</b><b>2</b><c/></a>`);
    expect(root).toBeDefined();
    if (root === undefined) return;
    expect(childElements(root, "b")).toHaveLength(2);
    expect(childText(root, "b")).toBe("1");
    expect(childText(root, "missing")).toBeUndefined();
  });

  it("decodes text exactly as the parser does and refuses what it refuses", () => {
    expect(decodeXmlText("x&#121;z &lt;&amp;&gt;&quot;&apos;")).toBe(`xyz <&>"'`);
    expect(decodeXmlText("&custom;")).toBeUndefined();
    expect(decodeXmlText("&#0;")).toBeUndefined();
  });

  it("scans hostile input in one pass: long runs of spaces, attributes and unclosed tags", () => {
    // A tokenizer that backtracks over these runs takes quadratic time and would outlive the test.
    const size = 200_000;
    expect(parseXmlElements(`<a${" ".repeat(size)}x`)).toBeUndefined();
    expect(parseXmlElements(`<a ${'x="1" '.repeat(size / 8)}`)).toBeUndefined();
    expect(parseXmlElements(`<a ${'x="1" '.repeat(size / 8)}/>`)?.name).toBe("a");
    expect(parseXmlElements(`<a>${"<b>".repeat(size / 4)}`)).toBeUndefined();
    expect(parseXmlElements(`<a>${"<!-- ".repeat(size / 5)}`)).toBeUndefined();
  });
});
