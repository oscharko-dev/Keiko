import katex from "katex";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SAFE_MARKDOWN_MAX_MATH_CHARS } from "@/lib/safe-markdown-math";
import {
  mathFenceSource,
  typesetMath,
  type KatexRenderer,
  type MathTypesetting,
} from "./codingWorkbenchMath";

function markupOf(result: MathTypesetting): string {
  if (result.status !== "typeset") return "";
  const host = document.createElement("div");
  host.replaceChildren(...result.nodes.map((node) => node.cloneNode(true)));
  return host.innerHTML;
}

function rendererReturning(markup: string): KatexRenderer {
  return { renderToString: () => markup };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("typesetMath", () => {
  it("typesets valid TeX as MathML and keeps the source as an annotation", () => {
    const result = typesetMath(katex, "\\frac{a}{b} + \\sum_{i=1}^n x_i", false);
    expect(result.status).toBe("typeset");
    const host = document.createElement("div");
    if (result.status === "typeset") {
      host.replaceChildren(...result.nodes.map((node) => node.cloneNode(true)));
    }
    const math = host.querySelector("math");
    expect(math?.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
    expect(math?.hasAttribute("display")).toBe(false);
    expect(host.querySelector("mfrac")).not.toBeNull();
    expect(host.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe(
      "\\frac{a}{b} + \\sum_{i=1}^n x_i",
    );
  });

  it("typesets display math as a block", () => {
    const result = typesetMath(katex, "\\int_0^1 x^2\\,dx", true);
    expect(markupOf(result)).toContain('display="block"');
  });

  it.each([
    ["an unclosed group", "\\frac{1"],
    ["an unknown command", "\\notacommand{x}"],
    [
      "a macro expansion bomb",
      String.raw`\def\a{\b\b}\def\b{\c\c}\def\c{\d\d}\def\d{\e\e}\def\e{\f\f}\def\f{\g\g}\def\g{\h\h}\def\h{\i\i}\def\i{x}\a\a\a\a`,
    ],
    ["an unsupported link command", "\\href{javascript:alert(1)}{click}"],
    ["an unsupported url command", "\\url{javascript:alert(1)}"],
    ["an unsupported image command", "\\includegraphics{http://example.invalid/x.png}"],
    ["an unsupported html attribute command", "\\htmlData{onclick=alert(1)}{y}"],
    ["an unsupported html class command", "\\htmlClass{x}{y}"],
    ["an unsupported html style command", "\\htmlStyle{color:red}{y}"],
  ])("shows %s as written", (_name, tex) => {
    expect(typesetMath(katex, tex, false)).toEqual({ status: "verbatim", reason: "rejected" });
  });

  it("does not let a macro defined by one formula reach the next", () => {
    expect(typesetMath(katex, "\\gdef\\leaky{42}\\leaky", false).status).toBe("typeset");
    expect(typesetMath(katex, "\\leaky", false)).toEqual({
      status: "verbatim",
      reason: "rejected",
    });
  });

  it("caps user-specified sizes", () => {
    const host = document.createElement("div");
    host.innerHTML = markupOf(typesetMath(katex, "\\rule{99999em}{99999em}", false));
    const rule = host.querySelector("mspace");
    expect(rule?.getAttribute("width")).toBe("20em");
    expect(rule?.getAttribute("height")).toBe("20em");
  });

  it("escapes markup typed inside a formula instead of emitting it", () => {
    const hostile = "<script>alert(1)</script>\\text{<img src=x onerror=alert(1)>}";
    const markup = markupOf(typesetMath(katex, hostile, false));
    const host = document.createElement("div");
    host.innerHTML = markup;
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelectorAll("[onerror]")).toHaveLength(0);
    expect(host.textContent).toContain("<script>alert(1)</script>");
  });

  it("refuses an empty formula and one past the bound without calling the typesetter", () => {
    const spy = vi.fn(() => "<span>never</span>");
    const renderer: KatexRenderer = { renderToString: spy };
    expect(typesetMath(renderer, "   ", false)).toEqual({ status: "verbatim", reason: "empty" });
    expect(typesetMath(renderer, "x".repeat(SAFE_MARKDOWN_MAX_MATH_CHARS + 1), false)).toEqual({
      status: "verbatim",
      reason: "too-long",
    });
    expect(spy).not.toHaveBeenCalled();
    expect(typesetMath(katex, "x".repeat(SAFE_MARKDOWN_MAX_MATH_CHARS), false).status).toBe(
      "typeset",
    );
  });

  it("shows the source when the typesetter throws instead of failing the answer", () => {
    const renderer: KatexRenderer = {
      renderToString: () => {
        throw new RangeError("Maximum call stack size exceeded");
      },
    };
    expect(typesetMath(renderer, "x", false)).toEqual({ status: "verbatim", reason: "rejected" });
  });
});

describe("typesetMath markup gate", () => {
  const MATHML = (inner: string): string =>
    `<span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML">${inner}</math></span>`;

  it("admits the markup KaTeX itself produces", () => {
    const result = typesetMath(
      rendererReturning(MATHML("<mi>x</mi><mo>+</mo><mn>1</mn>")),
      "x",
      false,
    );
    expect(result.status).toBe("typeset");
  });

  it.each([
    ["a script element", "<script>alert(1)</script>"],
    ["an event handler attribute", '<mtext onclick="alert(1)">a</mtext>'],
    ["an embedded HTML image", "<mtext><img src=x></mtext>"],
    ["an anchor", '<mtext><a href="https://example.invalid">a</a></mtext>'],
    ["a link attribute on a MathML element", '<mrow href="javascript:alert(1)"><mi>a</mi></mrow>'],
    ["an xlink attribute", '<mrow xlink:href="javascript:alert(1)"><mi>a</mi></mrow>'],
    ["an action element", '<maction actiontype="statusline"><mi>a</mi></maction>'],
    [
      "embedded HTML in an annotation",
      '<annotation-xml encoding="text/html"><b>a</b></annotation-xml>',
    ],
    ["a style that loads a URL", '<mi style="background:url(https://example.invalid/x)">a</mi>'],
    [
      "a style with an obfuscated expression",
      '<mi style="width: ex pr ession(alert(1))">a</mi>'.replace("ex pr ession", "expression"),
    ],
    ["a comment node", "<!-- hidden --><mi>a</mi>"],
    ["an SVG island", "<svg><circle /></svg>"],
  ])("rejects %s", (_name, inner) => {
    expect(typesetMath(rendererReturning(MATHML(inner)), "x", false)).toEqual({
      status: "verbatim",
      reason: "unsafe-markup",
    });
  });

  it("rejects markup nested past the depth bound", () => {
    const depth = 200;
    const nested = "<mrow>".repeat(depth) + "<mi>x</mi>" + "</mrow>".repeat(depth);
    expect(typesetMath(rendererReturning(MATHML(nested)), "x", false)).toEqual({
      status: "verbatim",
      reason: "unsafe-markup",
    });
  });

  it("rejects empty markup", () => {
    expect(typesetMath(rendererReturning(""), "x", false)).toEqual({
      status: "verbatim",
      reason: "unsafe-markup",
    });
  });

  it("fails closed where there is no DOM parser", () => {
    vi.stubGlobal("DOMParser", undefined);
    expect(typesetMath(katex, "x", false)).toEqual({
      status: "verbatim",
      reason: "unsafe-markup",
    });
  });
});

describe("mathFenceSource", () => {
  it.each([
    ["x^2", "x^2"],
    ["  x^2\n", "x^2"],
    ["$$x^2$$", "x^2"],
    ["$$\n x^2 \n$$", "x^2"],
    ["\\[x^2\\]", "x^2"],
    ["\\(x^2\\)", "x^2"],
    ["$x^2$", "x^2"],
    ["$$", "$$"],
    ["$5 and $6", "$5 and $6"],
  ])("reduces %j to %j", (text, expected) => {
    expect(mathFenceSource(text)).toBe(expected);
  });
});
