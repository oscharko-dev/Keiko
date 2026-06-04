import type { ParsedUnit } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";

import { htmlParser } from "./html-parser.js";
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

  it("DROPS <script> contents entirely — no JS leaks into any unit", () => {
    const result = htmlParser.parse(
      selectionFromText(HTML_DANGEROUS, { extension: "html" }),
      buildParserOptions({ now: () => 0 }),
    );
    const text = HTML_DANGEROUS;
    for (const unit of result.units) {
      const block = asBlock(unit);
      const span = text.slice(block.span.start, block.span.end);
      expect(span).not.toContain("alert(");
      expect(span).not.toContain("display:none");
      expect(span).not.toContain("fallback");
    }
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
    for (const unit of result.units) {
      const block = asBlock(unit);
      expect(html.slice(block.span.start, block.span.end)).not.toContain("unterminated");
    }
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
