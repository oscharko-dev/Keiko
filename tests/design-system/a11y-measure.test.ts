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

  // KEIKO-0860 hardening: the 1:1 and 21:1 references only pin lum(x) = lum(x) and the SUM of
  // the R/G/B coefficients, and pass unchanged if a future edit rebalances 0.2126/0.7152/0.0722
  // as long as their sum stays ~1. Pinning each channel against a black background exercises
  // exactly one weight per test, so any per-coefficient tampering (a swap, a rounding change,
  // WCAG 3's Bradford-adjusted weights) flips the corresponding test independently. Values from
  // WCAG 2.x: ratio(pure-R, black) = (0.2126 + 0.05) / 0.05 = 5.252; pure-G = 15.304;
  // pure-B = 2.444. Kept at ~0.005 tolerance to catch even a 0.001 coefficient drift.
  it("pure red on black is 5.252:1 (pins the R coefficient 0.2126)", () => {
    const contrast = keikoA11y().ratio([255, 0, 0], [0, 0, 0]);
    expect(contrast).toBeGreaterThan(5.247);
    expect(contrast).toBeLessThan(5.257);
  });

  it("pure green on black is 15.304:1 (pins the G coefficient 0.7152)", () => {
    const contrast = keikoA11y().ratio([0, 255, 0], [0, 0, 0]);
    expect(contrast).toBeGreaterThan(15.299);
    expect(contrast).toBeLessThan(15.309);
  });

  it("pure blue on black is 2.444:1 (pins the B coefficient 0.0722)", () => {
    const contrast = keikoA11y().ratio([0, 0, 255], [0, 0, 0]);
    expect(contrast).toBeGreaterThan(2.439);
    expect(contrast).toBeLessThan(2.449);
  });

  // Non-boundary midtone value that also exercises the sRGB gamma branch (c > 0.03928 → the
  // Math.pow((c + 0.055) / 1.055, 2.4) path, not the c/12.92 linear branch). Grey-127 on white:
  // lin(127/255) ≈ 0.2122, lum ≈ 0.2122, ratio = (1 + 0.05) / (0.2122 + 0.05) ≈ 4.004.
  // Value verified against the live formula rather than by hand — any drift in the 2.4 exponent,
  // the 0.055 sRGB offset, or the 1.055 divisor flips this test.
  it("grey #7F7F7F on white is ~4.00:1 (pins the sRGB gamma branch)", () => {
    const contrast = keikoA11y().ratio([127, 127, 127], [255, 255, 255]);
    expect(contrast).toBeGreaterThan(3.999);
    expect(contrast).toBeLessThan(4.009);
  });
});
