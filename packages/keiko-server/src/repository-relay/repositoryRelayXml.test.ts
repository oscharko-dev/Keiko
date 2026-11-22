import { describe, expect, it } from "vitest";
import { childText, parseXmlElements } from "./repositoryRelayXml.js";

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
