// Golden and injection tests for the plain-text→storage-format composer (Issue #2244). The
// hostile-input suite proves markup in the input can only ever appear as escaped text.

import { describe, expect, it } from "vitest";
import { MARKDOWN_LITE_MAX_INPUT_CHARS } from "./markdown-lite-blocks.js";
import {
  composePlainTextToStorageFormat,
  escapeStorageFormatText,
} from "./plain-text-to-storage-format.js";

function xhtmlOf(input: string): string {
  const composed = composePlainTextToStorageFormat(input);
  if (!composed.ok) throw new Error(`expected ok, got ${composed.reason}`);
  return composed.xhtml;
}

describe("composePlainTextToStorageFormat — goldens", () => {
  it("composes paragraphs with <br/> line separators", () => {
    expect(xhtmlOf("line one\nline two\n\nsecond")).toBe(
      "<p>line one<br/>line two</p><p>second</p>",
    );
  });

  it("composes headings, bullet lists, and ordered lists", () => {
    expect(xhtmlOf("## Section")).toBe("<h2>Section</h2>");
    expect(xhtmlOf("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(xhtmlOf("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
    expect(xhtmlOf("4. four")).toBe('<ol start="4"><li>four</li></ol>');
  });

  it("composes code fences into escaped pre/code blocks (language hint dropped by design)", () => {
    expect(xhtmlOf("```ts\nconst a = 1 < 2;\n```")).toBe(
      "<pre><code>const a = 1 &lt; 2;</code></pre>",
    );
  });

  it("composes empty input to an empty string and stays deterministic", () => {
    expect(xhtmlOf("")).toBe("");
    const input = "# T\n\npara & more\n\n- item";
    expect(xhtmlOf(input)).toBe(xhtmlOf(input));
  });
});

describe("composePlainTextToStorageFormat — injection hostility", () => {
  it("escapes <script> in every block position — input markup never becomes markup", () => {
    const payload = '<script>alert("x")</script>';
    expect(xhtmlOf(payload)).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
    expect(xhtmlOf(`# ${payload}`)).toBe(
      "<h1>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</h1>",
    );
    expect(xhtmlOf(`- ${payload}`)).toBe(
      "<ul><li>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</li></ul>",
    );
    expect(xhtmlOf("```\n" + payload + "\n```")).toBe(
      "<pre><code>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</code></pre>",
    );
  });

  it("escapes attribute-breaking quotes and entity-forming ampersands", () => {
    expect(xhtmlOf(`" onmouseover="steal()`)).toBe("<p>&quot; onmouseover=&quot;steal()</p>");
    expect(xhtmlOf("a & b &amp; c")).toBe("<p>a &amp; b &amp;amp; c</p>");
    expect(xhtmlOf("it's <b>bold</b>")).toBe("<p>it&#39;s &lt;b&gt;bold&lt;/b&gt;</p>");
  });

  it("cannot be escaped from via a hostile code-fence language", () => {
    const composed = xhtmlOf('```"><script>x</script>\nbody\n```');
    expect(composed).toBe("<pre><code>body</code></pre>");
    expect(composed).not.toContain("<script>");
  });

  it("never emits a raw < or & from input anywhere in the output", () => {
    const hostile = "<img src=x onerror=alert(1)>\n\n- <svg/onload=x>\n\n# <iframe>&";
    const composed = xhtmlOf(hostile);
    expect(composed).not.toContain("<img");
    expect(composed).not.toContain("<svg");
    expect(composed).not.toContain("<iframe");
    // Every '<' in the output opens one of the composer's own closed tag set.
    const tags = composed.match(/<[^&]*?>/gu) ?? [];
    for (const tag of tags) {
      expect(tag).toMatch(/^<\/?(?:p|br\/|h[1-6]|ul|ol(?: start="\d+")?|li|pre|code)>$/u);
    }
  });

  it("rejects oversized and control-character input with typed reasons", () => {
    expect(composePlainTextToStorageFormat("a".repeat(MARKDOWN_LITE_MAX_INPUT_CHARS + 1))).toEqual({
      ok: false,
      reason: "input-too-large",
    });
    expect(composePlainTextToStorageFormat("x\u0007y")).toEqual({
      ok: false,
      reason: "control-characters",
    });
  });

  it("exposes the single escaper used at every text position", () => {
    expect(escapeStorageFormatText(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
