// Regression pins for #4235: the HTML projection keeps the document structure (blocks, lists,
// headings, key-value tables), drops only what a reader does not see, and never loses a wrapper or
// the text after a look-alike tag. Synthetic documents only.

import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import { htmlParser } from "./html-parser.js";
import { selectionFromText } from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";
import type { InternalParserResult } from "./types.js";

type Parsed = InternalParserResult & { readonly text: string };

function parse(html: string, overrides: Parameters<typeof buildParserOptions>[0] = {}): Parsed {
  const result = htmlParser.parse(
    selectionFromText(html, { extension: "html" }),
    buildParserOptions({ now: () => 0, ...overrides }),
  ) as InternalParserResult;
  return { ...result, text: result.normalizedText ?? "" };
}

function unitTexts(result: Parsed): readonly string[] {
  return result.units.map((unit) => result.text.slice(spanOf(unit).start, spanOf(unit).end));
}

function spanOf(unit: ParsedUnit): { readonly start: number; readonly end: number } {
  if (unit.kind !== "html-block") throw new Error(`expected html-block, got ${unit.kind}`);
  return { start: unit.characterStart, end: unit.characterEnd };
}

function pathOf(unit: ParsedUnit | undefined): readonly string[] {
  if (unit?.kind !== "html-block") throw new Error("expected html-block");
  return unit.headingPath ?? [];
}

describe("html block structure (#4235 F1)", () => {
  it("separates paragraphs, list items and line breaks", () => {
    const result = parse(
      "<p>Alpha</p><p>Beta</p><ul><li>eins</li><li>zwei</li></ul>Zeile1<br>Zeile2",
    );
    expect(result.text).toBe("Alpha\n\nBeta\n\n- eins\n- zwei\n\nZeile1\n\nZeile2");
  });

  it("keeps inline elements inline and splits only at block boundaries", () => {
    const result = parse(
      "<p>Ge<b>sch</b>&auml;ft <i>und</i> <a href='#'>mehr</a></p><div>zwei</div>",
    );
    expect(result.text).toBe("Geschäft und mehr\n\nzwei");
  });

  it("numbers ordered lists and indents nested items", () => {
    const result = parse("<ol><li>a</li><li>b<ul><li>c</li></ul></li></ol><ul><li>d</li></ul>");
    expect(result.text).toBe("1. a\n2. b\n  - c\n- d");
  });

  it("gives every block its own unit and keeps a list marker with its text", () => {
    const result = parse("<ul><li><p>erster</p></li><li>zweiter</li></ul>");
    expect(unitTexts(result)).toEqual(["- erster", "- zweiter"]);
  });

  it("does not carry an empty list item's marker into the next block", () => {
    const result = parse("<ul><li></li></ul><p>danach</p>");
    expect(result.text).toBe("danach");
  });

  it("splits blocks that omit their end tags", () => {
    const result = parse("<p>eins<p>zwei<ul><li>drei<li>vier</ul>");
    expect(result.text).toBe("eins\n\nzwei\n\n- drei\n- vier");
  });

  it("reads a minified requirement page so each identifier line stands alone", () => {
    const result = parse(
      "<h2>REQ-1: Login</h2><p>Der Nutzer muss sich anmelden.</p><h2>REQ-2: Logout</h2><p>x</p>",
    );
    expect(result.text.split("\n\n")).toEqual([
      "REQ-1: Login",
      "Der Nutzer muss sich anmelden.",
      "REQ-2: Logout",
      "x",
    ]);
  });
});

describe("html headings are part of the text (#4235 F2)", () => {
  it("emits the heading text, owned by its own section path", () => {
    const result = parse("<h1 id='top'>Titel</h1><p>x</p><h2>Unter</h2><p>y</p>");
    expect(result.text).toBe("Titel\n\nx\n\nUnter\n\ny");
    expect(unitTexts(result)).toEqual(["Titel", "x", "Unter", "y"]);
    expect(result.units.map((unit) => pathOf(unit))).toEqual([
      ["Titel"],
      ["Titel"],
      ["Titel", "Unter"],
      ["Titel", "Unter"],
    ]);
    expect(result.units[0]).toMatchObject({ anchorId: "top" });
  });

  it("joins heading words across inline tags and line breaks", () => {
    const result = parse("<h2>Kredit<br>antrag <em>online</em></h2><p>x</p>");
    expect(result.text).toBe("Kredit antrag online\n\nx");
  });

  it("closes an unterminated heading at the next block instead of swallowing the page", () => {
    const result = parse("<h2>Offen<p>Text danach</p>");
    expect(result.text).toBe("Offen\n\nText danach");
  });

  it("keeps every word of a heading findable in the text a chunk is cut from", () => {
    const result = parse("<h1>Zahlungsverkehr</h1><p>Ablauf</p>");
    expect(result.text).toContain("Zahlungsverkehr");
  });
});

describe("html tables: orientation and spans (#4235 F5)", () => {
  it("reads a key-value table without th as label=value rows", () => {
    const result = parse(
      "<table><tr><td>Anforderung</td><td>REQ-1</td></tr><tr><td>Titel</td><td>Login</td></tr></table>",
    );
    expect(result.text).toBe("Table!1: Anforderung=REQ-1 | Titel=Login");
  });

  it("reads th cells of the first column as row headers", () => {
    const result = parse(
      "<table><tr><th>ID</th><td>REQ-1</td></tr><tr><th scope='row'>Titel</th><td>Login</td><td>extra</td></tr></table>",
    );
    expect(result.text).toBe("Table!1: ID=REQ-1\nTable!2: Titel=Login | extra");
  });

  it("still uses the first row as header when it is made of th cells", () => {
    const result = parse(
      "<table><tr><th>ID</th><th>Titel</th></tr><tr><td>REQ-1</td><td>Login</td></tr></table>",
    );
    expect(result.text).toBe("Table!2: ID=REQ-1 | Titel=Login");
  });

  it("uses a thead row as header even when its cells are td", () => {
    const result = parse(
      "<table><thead><tr><td>Rolle</td><td>Recht</td></tr></thead><tbody><tr><td>Admin</td><td>alles</td></tr><tr><td>Gast</td><td>lesen</td></tr></tbody></table>",
    );
    expect(result.text).toBe(
      "Table!2: Rolle=Admin | Recht=alles\nTable!3: Rolle=Gast | Recht=lesen",
    );
  });

  it("falls back to the first row as header for a wider table without th", () => {
    const result = parse(
      "<table><tr><td>Name</td><td>Typ</td><td>Pflicht</td></tr><tr><td>id</td><td>text</td><td>ja</td></tr></table>",
    );
    expect(result.text).toBe("Table!2: Name=id | Typ=text | Pflicht=ja");
  });

  it("carries a rowspan data cell down to the rows it spans", () => {
    const result = parse(
      "<table><tr><th>Bereich</th><th>Regel</th></tr><tr><td rowspan='2'>Kredit</td><td>R1</td></tr><tr><td>R2</td></tr></table>",
    );
    expect(result.text).toBe(
      "Table!2: Bereich=Kredit | Regel=R1\nTable!3: Bereich=Kredit | Regel=R2",
    );
  });

  it("combines a two-row header with a spanning header cell and no longer warns about it", () => {
    const result = parse(
      "<table><tr><th rowspan='2'>Bereich</th><th colspan='2'>Regel</th></tr><tr><th>A</th><th>B</th></tr><tr><td>Kredit</td><td>1</td><td>2</td></tr></table>",
    );
    expect(result.text).toBe("Table!3: Bereich=Kredit | Regel A=1 | Regel B=2");
    expect(result.diagnostics.map((entry) => entry.code)).not.toContain(
      "HTML_TABLE_SPAN_UNSUPPORTED",
    );
  });

  it("sets a table off from the text after it by an empty line and numbers later tables", () => {
    const result = parse(
      "<table><tr><th>A</th></tr><tr><td>1</td></tr></table><p>danach</p>" +
        "<table><tr><th>B</th></tr><tr><td>2</td></tr></table>",
    );
    expect(result.text).toBe("Table!2: A=1\n\ndanach\n\nTable 2!2: B=2");
  });

  it("keeps a long label/value table as one row per line instead of one record", () => {
    const rows = Array.from(
      { length: 70 },
      (_, index) => `<tr><td>Begriff${String(index)}</td><td>Text${String(index)}</td></tr>`,
    ).join("");
    const lines = parse(`<table>${rows}</table>`).text.split("\n");
    expect(lines).toHaveLength(70);
    expect(lines[0]).toBe("Table!1: Begriff0=Text0");
  });

  it("skips rows without any text", () => {
    const result = parse(
      "<table><tr><th>A</th><th>B</th></tr><tr><td></td><td> </td></tr><tr><td>1</td><td>2</td></tr></table>",
    );
    expect(result.text).toBe("Table!3: A=1 | B=2");
  });
});

describe("html wrappers and boilerplate (#4235 F6)", () => {
  it("keeps a content wrapper whose class merely contains a hint word", () => {
    const result = parse(
      '<div class="content-sidebar-wrap"><h2>REQ-1 Login</h2><p>Der Nutzer muss sich anmelden.</p></div><p>Ende</p>',
    );
    expect(result.text).toContain("REQ-1 Login");
    expect(result.text).toContain("Der Nutzer muss sich anmelden.");
  });

  it("does not read a hint word out of an unrelated attribute", () => {
    const result = parse(
      '<section data-track="consent-manager"><h2>Inhalt</h2><p>sichtbar</p></section>',
    );
    expect(result.text).toBe("Inhalt\n\nsichtbar");
    expect(result.diagnostics).toEqual([]);
  });

  it("still removes a small banner and reports the count without naming it", () => {
    const body = "<p>Haupttext mit genug Inhalt, damit der Banner klein bleibt.</p>".repeat(8);
    const result = parse(
      `<div class="cookie-banner">Cookies?</div><nav>Menue</nav>${body}<aside>Seitenleiste</aside>`,
    );
    expect(result.text).not.toContain("Cookies");
    expect(result.text).not.toContain("Menue");
    expect(result.text).not.toContain("Seitenleiste");
    const excluded = result.diagnostics.find((entry) => entry.code === "HTML_CONTENT_EXCLUDED");
    expect(excluded?.severity).toBe("info");
    expect(excluded?.message).toContain("3");
    expect(excluded?.message).not.toContain("Cookies");
  });

  it("never removes a hint-named subtree that holds most of the page", () => {
    const result = parse(
      `<div id="footer"><h1>Das ganze Dokument</h1><p>${"Inhalt ".repeat(40)}</p></div><p>kurz</p>`,
    );
    expect(result.text).toContain("Das ganze Dokument");
  });

  it("matches class and id tokens, not substrings", () => {
    const result = parse(
      '<div class="unfooterable"><p>bleibt</p></div><div id="my-footer"><p>weg</p></div><p>' +
        "x".repeat(200) +
        "</p>",
    );
    expect(result.text).toContain("bleibt");
    expect(result.text).not.toContain("weg");
  });
});

describe("html hidden content (#4235 F14)", () => {
  it("excludes hidden and display:none elements and counts them", () => {
    const filler = `<p>${"sichtbar ".repeat(30)}</p>`;
    const result = parse(
      `${filler}<p hidden>versteckt A</p><div style="color:red; DISPLAY : none">versteckt B</div><p>danach</p>`,
    );
    expect(result.text).not.toContain("versteckt");
    expect(result.text).toContain("danach");
    const excluded = result.diagnostics.find((entry) => entry.code === "HTML_CONTENT_EXCLUDED");
    expect(excluded?.message).toContain("2 hidden");
    expect(excluded?.message).not.toContain("versteckt");
  });

  it("keeps visible content of look-alike attributes", () => {
    const result = parse(
      `<p>${"sichtbar ".repeat(30)}</p><input type="hidden" value="x"><p title="not hidden">bleibt</p><p style="display:block">auch</p>`,
    );
    expect(result.text).toContain("bleibt");
    expect(result.text).toContain("auch");
    expect(result.diagnostics).toEqual([]);
  });

  it("does not swallow the rest of a page when a hidden element never closes", () => {
    const result = parse(`<p>${"a ".repeat(40)}</p><div hidden>offen<p>danach</p>`);
    expect(result.text).toContain("danach");
  });
});

describe("html <main> selection (#4235 F9)", () => {
  it("does not read <main> inside a script as the main element", () => {
    const result = parse(
      '<body><script>var t = "<main>";</script><p>Vorne</p><main><p>Haupt</p></main></body>',
    );
    expect(result.text).toBe("Haupt");
    expect(result.text).not.toContain('";');
  });

  it("is not cut by <mainframe> or <main-nav>", () => {
    const result = parse(
      "<body><mainframe>x</mainframe><p>Alles</p><main-nav>n</main-nav><p>bleibt</p></body>",
    );
    expect(result.text).toContain("Alles");
    expect(result.text).toContain("bleibt");
  });

  it("ends the main element at its own close tag", () => {
    const result = parse("<body><p>vor</p><main><p>in</p></main><p>nach</p></body>");
    expect(result.text).toBe("in");
  });
});

describe("html entities and images (#4235 F14)", () => {
  it("turns &nbsp; into a space and drops &shy; so a word stays one word", () => {
    const result = parse("<p>3&nbsp;Tage und Ge&shy;sch&shy;&auml;ft</p>");
    expect(result.text).toBe("3 Tage und Geschäft");
  });

  it("keeps the alt text of an image in the flow", () => {
    const result = parse('<p>Siehe <img src="a.png" alt="Ablaufdiagramm Antrag"> unten</p>');
    expect(result.text).toBe("Siehe Ablaufdiagramm Antrag unten");
  });

  it("ignores an image without alt text", () => {
    expect(parse('<p>a<img src="x.png">b</p>').text).toBe("ab");
  });
});

describe("html stays linear on hostile markup (#4235)", () => {
  it.each([
    ["nested hint wrappers", '<div class="cookie">'.repeat(20_000) + "x" + "</div>".repeat(20_000)],
    ["nested hidden wrappers", "<div hidden>".repeat(20_000) + "x" + "</div>".repeat(20_000)],
    ["unclosed hint wrappers", '<div class="sidebar">'.repeat(20_000) + "x"],
  ])("measures %s within a linear budget", (_name, html) => {
    const started = Date.now();
    const result = parse(html);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.text.length).toBeGreaterThanOrEqual(0);
  });

  it("handles a very long single line and many unclosed tags", () => {
    const started = Date.now();
    const long = `<p>${"wort ".repeat(1_000_000)}</p>`;
    const unclosed = "<div><li><p>".repeat(20_000);
    expect(parse(long).text.length).toBeGreaterThan(1_000_000);
    expect(parse(unclosed).units.length).toBeGreaterThanOrEqual(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
