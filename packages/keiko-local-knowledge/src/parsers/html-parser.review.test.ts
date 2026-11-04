// Findings of an independent review of the HTML parser (#4235). Synthetic documents only.

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

describe("a table whose end tags are left out", () => {
  it("reads rows and cells that end where the next one starts", () => {
    expect(
      textOf("<table><tr><th>ID<th>Text<tr><td>1<td>a<tr><td>2<td>b</table><p>after</p>"),
    ).toBe("Table!2: ID=1 | Text=a\nTable!3: ID=2 | Text=b\n\nafter");
  });

  it("keeps a nested table inside its cell", () => {
    expect(
      textOf("<table><tr><th>A<th>B<tr><td>x<table><tr><td>in1<td>in2</table><td>y</table>"),
    ).toBe("Table!2: A=x\nin1\nin2 | B=y");
  });

  it("ends a head that is left open at the body", () => {
    expect(
      textOf("<table><thead><tr><td>ID<td>Text<tbody><tr><td>1<td>a<tr><td>2<td>b</table>"),
    ).toBe("Table!2: ID=1 | Text=a\nTable!3: ID=2 | Text=b");
  });

  it("reads the terms and definitions of a list without end tags", () => {
    expect(textOf("<dl><dt>Term<dd>Def one<dt>T2<dd>D2</dl>")).toBe("Term: Def one\nT2: D2");
  });
});

describe("markup with many tag openings and no closing bracket", () => {
  it("is read in linear time and keeps its text", () => {
    const started = performance.now();
    const text = textOf("<a".repeat(100_000));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("a table cell with a heading or a preformatted block", () => {
  it("keeps the heading and the text after it apart", () => {
    expect(textOf("<table><tr><th>A</th></tr><tr><td><h2>In</h2>text</td></tr></table>")).toBe(
      "Table!2: A=In\ntext",
    );
  });
});

describe("content a reader does not see inside a table or a list", () => {
  it("leaves a hidden cell empty and keeps the columns aligned", () => {
    expect(
      textOf(
        "<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td><td hidden>2</td><td>3</td></tr></table>",
      ),
    ).toBe("Table!2: A=1 | B= | C=3");
  });

  it("drops a hidden row", () => {
    expect(
      textOf(
        "<table><tr><th>A</th></tr><tr hidden><td>secret</td></tr><tr><td>shown</td></tr></table>",
      ),
    ).not.toContain("secret");
  });

  it("drops a hidden element inside a cell", () => {
    expect(
      textOf(
        '<table><tr><th>A</th></tr><tr><td>vis<span hidden>secret</span>ible <b style="display: none">x</b>ok</td></tr></table>',
      ),
    ).toBe("Table!2: A=visible ok");
  });

  it("drops a hidden element inside a definition and a preformatted block", () => {
    expect(textOf("<dl><dt>T</dt><dd>shown<i hidden>secret</i></dd></dl>")).toBe("T: shown");
    expect(textOf("<pre>a<span hidden>secret</span>b</pre>")).toBe("ab");
  });

  it("counts what it left out", () => {
    const result = htmlParser.parse(
      selectionFromText(
        "<table><tr><th>A</th></tr><tr hidden><td>x</td></tr><tr><td>y<i hidden>z</i></td></tr></table>",
        { extension: "html" },
      ),
      buildParserOptions({ now: () => 0 }),
    );
    expect(
      result.diagnostics.find((entry) => entry.code === "HTML_CONTENT_EXCLUDED")?.message,
    ).toContain("2 hidden");
  });

  it("does not show the inert content of a template", () => {
    expect(textOf("<template><p>tpl</p></template><p>x</p>")).toBe("x");
  });
});

describe("a two-column table without header cells", () => {
  const table = (...rows: readonly (readonly [string, string])[]): string =>
    `<table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("")}</table>`;

  it("reads a row of labels above rows of data as the header", () => {
    expect(textOf(table(["ID", "Anforderung"], ["FR-1", "Export"], ["FR-2", "Import"]))).toBe(
      "Table!2: ID=FR-1 | Anforderung=Export\nTable!3: ID=FR-2 | Anforderung=Import",
    );
  });

  it("keeps rows of data apart when no row names the columns", () => {
    expect(textOf(table(["FR-1", "Export"], ["FR-2", "Import"]))).toBe(
      "Table!1: Column 1=FR-1 | Column 2=Export\nTable!2: Column 1=FR-2 | Column 2=Import",
    );
  });

  it("keeps numbered rows apart and does not read a number as a label", () => {
    expect(textOf(table(["1", "Export"], ["2", "Import"]))).toBe(
      "Table!1: Column 1=1 | Column 2=Export\nTable!2: Column 1=2 | Column 2=Import",
    );
  });

  it("reads an identifier of several parts as an identifier", () => {
    expect(textOf(table(["SYS-REQ-1", "Export"], ["SYS-REQ-2", "Import"]))).toBe(
      "Table!1: Column 1=SYS-REQ-1 | Column 2=Export\nTable!2: Column 1=SYS-REQ-2 | Column 2=Import",
    );
  });

  it("still reads rows of labels and values as one record", () => {
    expect(textOf(table(["ID", "FR-1"], ["Titel", "Export"], ["Priorität", "Hoch"]))).toBe(
      "Table!1: ID=FR-1 | Titel=Export | Priorität=Hoch",
    );
  });

  it("still reads a label holding a digit in a record of labels and values", () => {
    expect(textOf(table(["Version", "2.0"], ["ISO 20022", "ja"], ["Titel", "Export"]))).toBe(
      "Table!1: Version=2.0 | ISO 20022=ja | Titel=Export",
    );
  });
});

describe("the deadline of a document", () => {
  it("charges the time spent before the first block against the document", () => {
    let time = 0;
    const selection = selectionFromText("<p>Eins</p><p>Zwei</p>", { extension: "html" });
    const input = {
      ...selection,
      get bytes(): Uint8Array {
        time = 100;
        return selection.bytes;
      },
    };
    const result = htmlParser.parse(input, buildParserOptions({ now: () => time, timeoutMs: 10 }));
    expect(result.diagnostics.map((entry) => entry.code)).toContain("PARSER_TIMEOUT");
    expect(result.units).toEqual([]);
  });
});
