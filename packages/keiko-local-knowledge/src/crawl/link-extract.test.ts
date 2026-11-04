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

describe("extractManualLinks — what is a navigational link", () => {
  it("ignores assets, data attributes, scripts, comments and prose, and keeps real links", () => {
    const html = `<!doctype html><html><head><title>t</title>
      <link rel="stylesheet" href="/style.css"><link rel="canonical" href="/canon">
      <script src="/app.js"></script><script>var x = "see href=/in-script";</script>
      <!-- <a href="/commented-out">no</a> --></head>
      <body><img src="/logo.png"><a data-href="/data">d</a><p>text with href=notalink inside</p>
      <video src="/v.mp4"></video><source src="/s.webm"><a href="/docs/a.html">A</a>
      <textarea><a href="/in-textarea"></a></textarea><a href=/bare>bare</a></body></html>`;
    expect(extractManualLinks(bytes(html), 64)).toEqual(["/canon", "/docs/a.html", "/bare"]);
  });

  it("matches rel=canonical as a token, in any case, and ignores other link relations", () => {
    const html = `<link rel="Alternate CANONICAL" href="/c1"><link rel="next" href="/n"><link href="/no-rel">`;
    expect(extractManualLinks(bytes(html), 64)).toEqual(["/c1"]);
  });

  it("spends the sample on links, not on assets that precede them", () => {
    const assets = Array.from({ length: 10 }, (_, i) => `<img src="/i${String(i)}.png">`).join("");
    const html = `${assets}<a href="/real1">1</a><a href="/real2">2</a>`;
    expect(extractManualLinks(bytes(html), 2)).toEqual(["/real1", "/real2"]);
  });

  it("reads quotes, case and an unquoted value that contains a slash", () => {
    const html = `<A HREF='/Upper.html'>x</A><a  href = "/spaced">y</a><a\nhref=/x/y/z>z</a>`;
    expect(extractManualLinks(bytes(html), 64)).toEqual(["/Upper.html", "/spaced", "/x/y/z"]);
  });

  it("keeps a '>' inside a quoted attribute value", () => {
    expect(extractManualLinks(bytes(`<a title="a>b" href="/after">x</a>`), 64)).toEqual(["/after"]);
  });

  it("skips a script body that mentions a closing tag of another element", () => {
    const html = `<script>document.write("</p><a href='/in-js'>")</script><a href="/ok">x</a>`;
    expect(extractManualLinks(bytes(html), 64)).toEqual(["/ok"]);
  });

  it("decodes a page that declares a legacy charset instead of producing replacement characters", () => {
    const html = Buffer.from(
      `<meta charset="windows-1252"><a href="/gr\xf6\xdfe.html">x</a>`,
      "latin1",
    );
    expect(extractManualLinks(html, 64)).toEqual(["/größe.html"]);
  });

  it("terminates on unterminated and hostile markup", () => {
    const hostile = [
      "<a href='/never-closed",
      "<a".repeat(20000),
      "<script>".repeat(20000),
      "<!--".repeat(20000),
      "<a href=".repeat(20000),
    ];
    for (const html of hostile) expect(extractManualLinks(bytes(html), 64)).toBeDefined();
  });
});

describe("extractManualTitle", () => {
  it("decodes named and numeric entities as text, with non-breaking spaces collapsed", () => {
    expect(
      extractManualTitle(
        bytes("<title>M&uuml;ller&nbsp;&amp; S&ouml;hne &#8211; Handbuch</title>"),
      ),
    ).toBe("Müller & Söhne – Handbuch");
  });

  it("ignores a title inside a comment and finds the real one", () => {
    expect(extractManualTitle(bytes("<!-- <title>old</title> --><title>new</title>"))).toBe("new");
  });

  it("reads the title of a page with a declared legacy charset", () => {
    const html = Buffer.from(`<meta charset="iso-8859-1"><title>Gr\xf6\xdfe</title>`, "latin1");
    expect(extractManualTitle(html)).toBe("Größe");
  });

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
