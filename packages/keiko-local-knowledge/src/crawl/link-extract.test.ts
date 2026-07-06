import { describe, expect, it } from "vitest";
import { extractManualLinks, extractManualTitle } from "./link-extract.js";

function bytes(html: string): Uint8Array {
  return new TextEncoder().encode(html);
}

describe("extractManualLinks", () => {
  it("extracts anchors, frames, iframes, area, and canonical links", () => {
    const html = `
      <a href="a.html">A</a>
      <area href='b.html'>
      <frame src="c.html">
      <iframe src=d.html></iframe>
      <link rel="canonical" href="e.html">
    `;
    expect(extractManualLinks(bytes(html), 64)).toEqual([
      "a.html",
      "b.html",
      "c.html",
      "d.html",
      "e.html",
    ]);
  });

  it("deduplicates identical raw values and skips empty/fragment-only links", () => {
    const html = `<a href="x.html">1</a><a href="x.html">2</a><a href="#top">top</a><a href="">empty</a>`;
    expect(extractManualLinks(bytes(html), 64)).toEqual(["x.html"]);
  });

  it("decodes &amp; entities inside attribute values", () => {
    const html = `<a href="p.html?a=1&amp;b=2">x</a>`;
    expect(extractManualLinks(bytes(html), 64)).toEqual(["p.html?a=1&b=2"]);
  });

  it("does not double-unescape a nested entity (js/double-escaping)", () => {
    // `&amp;#x2f;` must decode to the LITERAL text `&#x2f;`, never to `/` via a second pass.
    const html = `<a href="a&amp;#x2f;b">x</a>`;
    expect(extractManualLinks(bytes(html), 64)).toEqual(["a&#x2f;b"]);
  });

  it("bounds the sample to maxLinks", () => {
    const html = Array.from({ length: 10 }, (_, i) => `<a href="p${String(i)}.html">x</a>`).join(
      "",
    );
    expect(extractManualLinks(bytes(html), 3)).toHaveLength(3);
    expect(extractManualLinks(bytes(html), 0)).toEqual([]);
  });
});

describe("extractManualTitle", () => {
  it("extracts and collapses whitespace in a title", () => {
    expect(extractManualTitle(bytes("<title>  Hello\n  World </title>"))).toBe("Hello World");
  });

  it("returns null when there is no title or it is empty", () => {
    expect(extractManualTitle(bytes("<h1>no title</h1>"))).toBeNull();
    expect(extractManualTitle(bytes("<title>   </title>"))).toBeNull();
  });

  it("bounds a very long title", () => {
    const long = "x".repeat(500);
    expect(extractManualTitle(bytes(`<title>${long}</title>`))?.length).toBe(200);
  });

  it("extracts a title with attributes and decodes numeric entities", () => {
    expect(extractManualTitle(bytes(`<title lang="en" dir="ltr">A&#38;B</title>`))).toBe("A&B");
  });

  it("returns null when the title tag is unterminated (no backtracking)", () => {
    expect(extractManualTitle(bytes("<title>never closed"))).toBeNull();
    // A pathological repetition must not hang (js/polynomial-redos): completes well under the timeout.
    expect(extractManualTitle(bytes("<title".repeat(20000)))).toBeNull();
  });
});
