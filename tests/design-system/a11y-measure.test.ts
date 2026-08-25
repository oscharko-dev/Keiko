// @vitest-environment jsdom
// KEIKO-0860: design-system/a11y-measure.js exposes window.KeikoA11y.ratio, the WCAG 2.x
// relative-luminance + contrast-ratio formula every number on the design-system audit pages is
// computed from. It sits outside every package and has no co-located test harness (design-system
// is a static reference site, not a TypeScript package), so this spec loads the plain script
// under jsdom and pins the two reference values verifiable by inspection against the spec:
// black-on-white (21:1) and identical colours (1:1). See design-system/a11y-measure.js:43-56.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const a11yMeasureScriptPath = resolve(repoRoot, "design-system", "a11y-measure.js");

declare global {
  interface Window {
    KeikoA11y?: {
      ratio: (
        fg: readonly [number, number, number],
        bg: readonly [number, number, number],
      ) => number;
    };
  }
}

beforeAll(() => {
  const code = readFileSync(a11yMeasureScriptPath, "utf8");
  // design-system/a11y-measure.js is a plain browser <script> (an IIFE, not an ES module), so
  // loading it under jsdom to exercise window.KeikoA11y means evaluating its source directly;
  // there is no export to import instead. Indirect eval runs it in true global scope, which is
  // how a real <script> tag would execute it.
  (0, eval)(code);
});

function keikoA11y(): NonNullable<Window["KeikoA11y"]> {
  if (!window.KeikoA11y) {
    throw new Error("window.KeikoA11y was not installed by design-system/a11y-measure.js");
  }
  return window.KeikoA11y;
}

describe("design-system/a11y-measure.js KeikoA11y.ratio (WCAG 2.x contrast formula)", () => {
  // toRGBA, resolve, and measure all call canvas.getContext("2d"), which jsdom does not
  // implement without the optional `canvas` npm package (absent from this repo's
  // node_modules) — calling them here would throw. ratio/lum/lin are pure math with no
  // canvas dependency, so they are the only surface this spec exercises. See KEIKO-0860.
  it("black-on-white is ~21:1", () => {
    const contrast = keikoA11y().ratio([0, 0, 0], [255, 255, 255]);
    expect(contrast).toBeGreaterThan(20.9);
    expect(contrast).toBeLessThan(21.1);
  });

  it("identical colours are exactly 1:1", () => {
    const contrast = keikoA11y().ratio([255, 255, 255], [255, 255, 255]);
    expect(contrast).toBeCloseTo(1, 5);
  });
});
