import { describe, expect, it } from "vitest";
import { markupText } from "./jiraAttachmentMarkupText.js";

describe("the text a markup reader recovers", () => {
  it.each([
    ["joined text runs", "<a>one</a><b>two</b>", "onetwo"],
    ["decoded references", "<a>x&amp;y &#x41;&#66; &lt;</a>", "x&y AB <"],
    ["unwrapped CDATA, left as written", "<a><![CDATA[a &amp; <b>]]></a>", "a &amp; <b>"],
    ["no comment or processing instruction", "<?xml v?><!-- a > b --><a>t</a>", "t"],
    ["a closing angle bracket inside a quoted attribute", `<a x=">" y='>'>t</a>`, "t"],
    ["a comparison in prose", "if a < b then", "if a < b then"],
    ["an unterminated tag", "text <a b", "text "],
    ["an unterminated comment", "text <!-- b", "text "],
    ["an unterminated CDATA", "<![CDATA[tail", "tail"],
  ])("%s", (_label, source, expected) => {
    expect(markupText(source)).toBe(expected);
  });
  it.each([
    ["unterminated tags", "<a '".repeat(200_000)],
    ["unterminated quotes", "<a \"'".repeat(200_000)],
    ["open comments", "<!--".repeat(200_000)],
    ["stray angle brackets", "<".repeat(400_000)],
  ])("is linear for %s", (_label, source) => {
    const started = Date.now();
    markupText(source);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
