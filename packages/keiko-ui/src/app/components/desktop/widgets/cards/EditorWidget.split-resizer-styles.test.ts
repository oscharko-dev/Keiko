import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "EditorWidget.module.css"), "utf8");

function cssBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing CSS rule ${selector}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  expect(end, `unterminated CSS rule ${selector}`).toBeGreaterThan(start);
  return css.slice(start, end + 1);
}

describe("EditorWidget split-resizer styles", () => {
  it("pins row geometry independently of column ancestors", () => {
    const selector = '.paneResizer.paneResizerRow[aria-orientation="vertical"]';
    const block = cssBlock(selector);
    const lineBlock = cssBlock(`${selector}::before`);

    expect(block).toContain("width: 7px");
    expect(block).toContain("min-width: 7px");
    expect(block).toContain("height: 100%");
    expect(block).toContain("min-height: 0");
    expect(block).toContain("cursor: col-resize");
    expect(lineBlock).toContain("top: 14px");
    expect(lineBlock).toContain("right: auto");
    expect(lineBlock).toContain("bottom: 14px");
    expect(lineBlock).toContain("left: 50%");
    expect(lineBlock).toContain("width: 1px");
    expect(lineBlock).toContain("height: auto");
    expect(lineBlock).toContain("transform: translateX(-50%)");
  });

  it("pins column geometry independently of row ancestors", () => {
    const selector = '.paneResizer.paneResizerColumn[aria-orientation="horizontal"]';
    const block = cssBlock(selector);
    const lineBlock = cssBlock(`${selector}::before`);

    expect(block).toContain("width: 100%");
    expect(block).toContain("min-width: 0");
    expect(block).toContain("height: 7px");
    expect(block).toContain("min-height: 7px");
    expect(block).toContain("cursor: row-resize");
    expect(lineBlock).toContain("top: 50%");
    expect(lineBlock).toContain("right: 14px");
    expect(lineBlock).toContain("bottom: auto");
    expect(lineBlock).toContain("left: 14px");
    expect(lineBlock).toContain("width: auto");
    expect(lineBlock).toContain("height: 1px");
    expect(lineBlock).toContain("transform: translateY(-50%)");
  });

  it("does not depend on ancestor direction selectors", () => {
    expect(css).not.toContain(".ed-panes");
  });
});
