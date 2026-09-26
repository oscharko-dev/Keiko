import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "CodingWorkbenchWindow.module.css"), "utf8");

function cssBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing CSS rule ${selector}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  expect(end, `unterminated CSS rule ${selector}`).toBeGreaterThan(start);
  return css.slice(start, end + 1);
}

describe("Coding Workbench window frame styles", () => {
  // 1.1.9 lab: the Workbench scrolls inside its own session stream, and its window body only frames
  // it. With `overflow: hidden` the body was still a scroll container, so focusing the composer
  // after an approval scrolled it 675 px past its 560 px of content: the window showed nothing, and
  // a wheel cannot scroll a hidden overflow back. `clip` makes the body no scroll container at all.
  it("clips the window body so no focus or scrollIntoView can scroll it", () => {
    const block = cssBlock(":global(.win-body):has(> .shell)");

    expect(block).toContain("overflow: clip;");
    expect(block).not.toContain("overflow: hidden");
  });
});
