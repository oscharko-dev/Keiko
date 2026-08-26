import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// KEIKO-0984: rustrover.svg carried width/height attributes alongside viewBox; every sibling
// editor icon (goland/intellij/pycharm/vscode/webstorm) declares viewBox only, letting the
// consumer size it. The width/height pair overrode that in a subset of consumers and made
// rustrover the odd one out.
// KEIKO-1014: properties.svg carried an invisible <path d="M0 0h24v24H0z"> bounding-box path
// alongside the visible glyph — an Illustrator export artifact that shipped as dead markup
// (default fill, no stroke) and made the file 66 bytes larger than the drawn glyph needs.

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function svgText(rel) {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

describe("keiko-ui SVG hygiene pins", () => {
  it("rustrover.svg declares viewBox but no explicit width/height (sibling editor-icon shape)", () => {
    const svg = svgText("packages/keiko-ui/public/assets/editors/rustrover.svg");
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).not.toMatch(/<svg\b[^>]*\swidth="/u);
    expect(svg).not.toMatch(/<svg\b[^>]*\sheight="/u);
  });

  it("properties.svg carries no invisible full-viewBox bounding-box path", () => {
    const svg = svgText("packages/keiko-ui/public/assets/icons/properties.svg");
    expect(svg).not.toContain('<path d="M0 0h24v24H0z"></path>');
    expect(svg).not.toContain('<path d="M0 0h24v24H0z"/>');
  });
});
