import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { projectFixtureHtml } from "../../docs/design-system/evidence/sonarcloud-2026-10-24/fixture-html.mjs";

describe("Sonar preservation fixture script projection", () => {
  it("removes uppercase and malformed script elements without creating executable tags", () => {
    const input =
      "<SCRIPT>globalThis.uppercaseRan=true;</SCRIPT><script>globalThis.inlineRan=true;</script>" +
      "<scr<script></script>ipt>globalThis.nestedRan=true;</script>";
    const dom = new JSDOM(projectFixtureHtml(input));
    try {
      expect(dom.window.document.querySelectorAll("script")).toHaveLength(0);
    } finally {
      dom.window.close();
    }
  });

  it("keeps the grid's owned inline handlers while removing external scripts in either case", () => {
    const input =
      '<SCRIPT SRC="https://example.invalid/fixture.js"></SCRIPT>' +
      '<script src="https://example.invalid/other.js"></script>' +
      "<script>globalThis.inlineRan=true;</script>";
    const dom = new JSDOM(projectFixtureHtml(input, { scriptSelector: "script[src]" }));
    try {
      expect(dom.window.document.querySelectorAll("script[src]")).toHaveLength(0);
      expect(dom.window.document.querySelectorAll("script")).toHaveLength(1);
      expect(dom.window.document.querySelector("script").textContent).toBe(
        "globalThis.inlineRan=true;",
      );
    } finally {
      dom.window.close();
    }
  });

  it("retains stylesheet links, named controls and SVG geometry", () => {
    const input =
      '<link rel="stylesheet" href="ds.css"><button aria-label="Preview">Preview</button>' +
      '<svg role="img" aria-label="Trend" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>';
    const dom = new JSDOM(projectFixtureHtml(input));
    try {
      expect(dom.window.document.querySelector("link").getAttribute("href")).toBe("ds.css");
      expect(dom.window.document.querySelector("button").getAttribute("aria-label")).toBe(
        "Preview",
      );
      expect(dom.window.document.querySelector("svg").getAttribute("viewBox")).toBe("0 0 10 10");
      expect(dom.window.document.querySelector("path").getAttribute("d")).toBe("M0 0L10 10");
    } finally {
      dom.window.close();
    }
  });
  it("inlines stylesheet links regardless of case, attribute order or closing slash", () => {
    const read = [];
    const html = projectFixtureHtml('<LINK HREF="ds.css" REL="STYLESHEET" media="screen">', {
      readStylesheet: (name) => {
        read.push(name);
        return "body { margin: 0; }";
      },
    });
    const dom = new JSDOM(html);
    try {
      expect(read).toEqual(["ds.css"]);
      expect(dom.window.document.querySelectorAll("link")).toHaveLength(0);
      expect(dom.window.document.querySelector("style").textContent).toBe("body { margin: 0; }");
      expect(dom.window.document.querySelector("style").getAttribute("media")).toBe("screen");
    } finally {
      dom.window.close();
    }
  });

  it("rejects stylesheet paths outside the local CSS namespace before reading them", () => {
    let reads = 0;
    const readStylesheet = () => {
      reads++;
      return "";
    };
    for (const href of ["../outside.css", "https://example.invalid/style.css"]) {
      expect(() =>
        projectFixtureHtml(`<link rel="stylesheet" href="${href}">`, { readStylesheet }),
      ).toThrow(TypeError);
    }
    expect(reads).toBe(0);
  });
});
