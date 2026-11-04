// Findings of the fourth independent review of the HTML parser (#4235). Synthetic documents only.

import { describe, expect, it } from "vitest";

import { htmlParser } from "./html-parser.js";
import { selectionFromText } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";
import type { InternalParserResult } from "./types.js";

function textOf(html: string): string {
  const result = htmlParser.parse(
    selectionFromText(html, { extension: "html" }),
    buildParserOptions({ now: () => 0 }),
  ) as InternalParserResult;
  return result.normalizedText ?? "";
}

describe("attribute values written without quotes", () => {
  it("carries an unquoted rowspan down to the rows it spans", () => {
    expect(
      textOf(
        "<table><tr><th>ID</th><th>Titel</th></tr><tr><td rowspan=2>FR-1</td><td>Foo</td></tr><tr><td>Bar</td></tr></table>",
      ),
    ).toBe("Table!2: ID=FR-1 | Titel=Foo\nTable!3: ID=FR-1 | Titel=Bar");
  });

  it("spreads an unquoted colspan header over its columns", () => {
    expect(
      textOf("<table><tr><th colspan=2>Head</th></tr><tr><td>a</td><td>b</td></tr></table>"),
    ).toBe("Table!2: Head=a | Head 2=b");
  });

  it("reads an unquoted code language", () => {
    expect(textOf("<pre><code class=language-js>let a = 1;</code></pre>")).toBe(
      "Code (js):\nlet a = 1;",
    );
  });

  it("does not read an attribute that sits inside another attribute's value", () => {
    expect(
      textOf(
        "<table><tr><th>A</th><th>B</th></tr><tr><td title=\"x rowspan='3'\">1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>",
      ),
    ).toBe("Table!2: A=1 | B=2\nTable!3: A=3 | B=4");
  });
});
