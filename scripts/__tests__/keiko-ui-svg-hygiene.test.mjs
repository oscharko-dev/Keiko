import { readdirSync, readFileSync } from "node:fs";
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
// KEIKO-0946: 8 of the 38 files under packages/keiko-ui/public/assets/icons/ carried an inner
// <title> plus role="img" while the other 30 didn't. Every consumer (PlugIcon, FileIcon) loads
// icons via <img src=... alt="">, and a browser never surfaces an <img>-loaded SVG's internal
// <title> as the image's accessible name, so the mismatched pair was inert, inconsistent bytes.
// KEIKO-0942: design-system/assets/file-icons/nodejs.svg had no .ev-ft CSS rule (unlike its 14
// siblings) and no demo file tree renders a filename that would need a Node-specific icon — an
// orphaned asset with nothing pointing at it.

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

function svgText(rel) {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

function svgFileNames(rel) {
  return readdirSync(resolve(REPO_ROOT, rel)).filter((name) => name.endsWith(".svg"));
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

  it('packages/keiko-ui/public/assets/icons/*.svg carry no role="img" or inner <title> (KEIKO-0946)', () => {
    const dir = "packages/keiko-ui/public/assets/icons";
    const files = svgFileNames(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const svg = svgText(`${dir}/${file}`);
      expect(svg).not.toMatch(/\srole="img"/u);
      expect(svg).not.toMatch(/<title[\s>]/u);
    }
  });

  it("design-system/assets/file-icons/*.svg are all referenced by keiko-editor-views.css (KEIKO-0942)", () => {
    const dir = "design-system/assets/file-icons";
    const files = svgFileNames(dir);
    expect(files.length).toBeGreaterThan(0);
    const css = svgText("design-system/keiko-editor-views.css");
    for (const file of files) {
      expect(css).toContain(`url(assets/file-icons/${file})`);
    }
  });
});
