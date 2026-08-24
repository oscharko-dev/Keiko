// KEIKO-0413 regression pin: design-system/Keiko Icon System.html must not depend on any
// third-party CDN (React, ReactDOM, Babel Standalone were previously loaded from unpkg).
// Keiko's targeted deployment posture is offline / air-gapped / restricted-egress; a page
// that only renders after three CDN scripts execute cannot open at all in that environment.
//
// This pin is deliberately narrower than "no <script> without src=…": we only prohibit
// external hosts (any src="http…" or "//…"), because same-origin sibling scripts like
// `lift-glyphs.js`, `ds-nav.js`, and `theme-control.js` are legitimate. Also asserts the
// canonical unpkg/CDN hostnames are absent from the entire file (including comments), so a
// future stray reference or example URL is caught before it lands.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const dsDir = resolve(repoRoot, "design-system");
const iconSystemHtmlPath = resolve(dsDir, "Keiko Icon System.html");
const liftGlyphsPath = resolve(dsDir, "lift-glyphs.js");

describe("design-system/Keiko Icon System.html — no third-party CDN (KEIKO-0413)", () => {
  it("has zero external-host script or style references", () => {
    const html = readFileSync(iconSystemHtmlPath, "utf8");
    // Any <script src="http…"> or <script src="//…"> is a hard fail — network access is
    // exactly what the offline deployment posture cannot provide.
    const externalScripts = html.match(/<script[^>]+src\s*=\s*"(https?:|\/\/)[^"]+"/gu) ?? [];
    expect(
      externalScripts,
      `unexpected external <script> refs: ${externalScripts.join(", ")}`,
    ).toEqual([]);
    const externalStyles = html.match(/<link[^>]+href\s*=\s*"(https?:|\/\/)[^"]+"/gu) ?? [];
    expect(externalStyles, `unexpected external <link> refs: ${externalStyles.join(", ")}`).toEqual(
      [],
    );
  });

  it("does not name unpkg.com or a generic CDN host anywhere in the file", () => {
    // Mirrors the KEIKO-0413 disposition's exact verification command:
    //   grep -c 'unpkg.com\|cdn\.' 'design-system/Keiko Icon System.html' (must be 0)
    const html = readFileSync(iconSystemHtmlPath, "utf8");
    expect(html).not.toMatch(/unpkg\.com/u);
    expect(html).not.toMatch(/cdn\./u);
  });

  it("still includes the sibling lift-glyphs.js renderer (icons must render on load)", () => {
    // Removing the CDN scripts is only correct if the page still renders. lift-glyphs.js is
    // the design-system-wide vanilla renderer used by every other doc page.
    const html = readFileSync(iconSystemHtmlPath, "utf8");
    expect(html).toMatch(/<script\s+src="lift-glyphs\.js"><\/script>/u);
  });

  it("renders the icon library and window-control table under jsdom (proof of no-CDN)", async () => {
    // The strongest possible proof that the CDN removal preserved behaviour: load the page
    // in a headless DOM with EVERY external resource unavailable except lift-glyphs.js
    // (which is a sibling file, not a CDN dep). Assert the library grid, window-control
    // buttons, and keyline-grid diagrams all render — those are the surfaces the deleted
    // React/JSX/Babel code owned before.
    let html = readFileSync(iconSystemHtmlPath, "utf8");
    // Inline lift-glyphs.js so jsdom doesn't have to fetch it. Strip <link> refs (external
    // stylesheets) and the two sibling scripts we don't need for a render test.
    html = html
      .replace(
        '<script src="lift-glyphs.js"></script>',
        "<script>" + readFileSync(liftGlyphsPath, "utf8") + "</script>",
      )
      .replace('<script src="ds-nav.js"></script>', "")
      .replace('<script src="theme-control.js"></script>', "")
      .replaceAll(/<link[^>]*>/gu, "");
    const errors = [];
    const virtualConsole = new VirtualConsole().on("jsdomError", (e) => errors.push(String(e)));
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole,
    });
    await new Promise((r) => {
      if (dom.window.document.readyState === "complete") r();
      else dom.window.addEventListener("load", () => r());
    });
    expect(errors).toEqual([]);
    const doc = dom.window.document;
    // The icon library grid must be populated — every glyph is one .lib-cell.
    const libCells = doc.querySelectorAll(".lib-cell");
    expect(libCells.length).toBeGreaterThan(50);
    // The window-control state table must be built (4 rows × [row-h + 3 cells] + 4 <th>).
    expect(doc.querySelectorAll(".kx-ctl").length).toBeGreaterThan(6);
    // The keyline-grid placeholder <div>s must be upgraded to <svg> — none may remain.
    expect(doc.querySelectorAll("[data-keyline-grid]")).toHaveLength(0);
    // Sanity: at least one <svg> was produced by lift-glyphs render() — a broken renderer
    // would leave `data-licon` spans empty.
    const someIcon = doc.querySelector(".lib-cell [data-licon]");
    expect(someIcon?.innerHTML).toMatch(/^<svg\b/u);
    dom.window.close();
  });
});
