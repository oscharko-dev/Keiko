import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "postcss";
import { describe, expect, it } from "vitest";

function declarations(selector: string): Record<string, string> {
  const css = parse(readFileSync(join(import.meta.dirname, "Header.module.css"), "utf8"));
  const styles: Record<string, string> = {};
  css.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((declaration) => {
      styles[declaration.prop] = declaration.value;
    });
  });
  return styles;
}

// #4271 release-install walk-through: the header sits at the top edge, and its tooltips opened
// above their controls, outside the viewport, so nobody ever saw them.
describe("header tooltips", () => {
  it("open below their control", () => {
    const tip = declarations(".cmpWindowTools .cmpHeaderTip[data-tip]::after");
    expect(tip.top).toBe("calc(100% + 8px)");
    expect(tip.bottom).toBe("auto");
  });

  // Centred, the rightmost tooltip's hidden box overflowed a 1440 px window, and focusing a dialog
  // then scrolled the whole workspace 29 px sideways and cut off the left rail.
  it("keep the rightmost tooltip inside the window", () => {
    const last = declarations(".cmpWindowTools .cmpHeaderTip[data-tip]:last-child::after");
    expect(last.left).toBe("auto");
    expect(last.right).toBe("0");
    expect(last.transform).toBe("none");
  });
});
