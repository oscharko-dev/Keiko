// KEIKO-0477 regression pin: design-system/lift-icons.jsx (JSX/spec mirror) and
// design-system/lift-glyphs.js (vanilla-JS renderer used by every design-system page) must
// stay geometry-identical for every shared icon key. Before this gate, either file could be
// hand-edited without the other's copy updating, silently desyncing the icon rendered on
// the JSX-driven Icon System page from every other design-system doc page.
//
// The gate is scripts/check-lift-icon-parity.mjs. This pin covers the two invariants that
// the gate is worthless without:
//   1. The gate PASSES against the current on-disk sources (there is no divergence today).
//   2. The gate BITES: a mutated fixture where one icon's path-data byte differs must
//      produce a divergence report. Without this, the gate could silently degrade into a
//      no-op that always passes.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkParity } from "../check-lift-icon-parity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const originalJsxPath = resolve(repoRoot, "design-system", "lift-icons.jsx");
const originalJsPath = resolve(repoRoot, "design-system", "lift-glyphs.js");

let scratchDir;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "keiko-0477-parity-"));
});
afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function fixtureCopy() {
  const jsxCopy = join(scratchDir, "lift-icons.jsx");
  const jsCopy = join(scratchDir, "lift-glyphs.js");
  writeFileSync(jsxCopy, readFileSync(originalJsxPath, "utf8"));
  writeFileSync(jsCopy, readFileSync(originalJsPath, "utf8"));
  return { jsxCopy, jsCopy };
}

describe("scripts/check-lift-icon-parity.mjs — lift-icons.jsx ↔ lift-glyphs.js parity", () => {
  it("passes against the current on-disk design-system sources", () => {
    // Uses the default paths — the real production files must be parity-clean right now.
    expect(checkParity()).toEqual([]);
  });

  it("bites when a single path-data literal is hand-edited in lift-glyphs.js", () => {
    // Mutate one glyph's `d` string on the JS side to a different value. The corresponding
    // JSX entry still names the untouched value, so the gate must report a divergence for
    // this key (and only this key). If the mutation slips through, the gate is a no-op.
    const { jsxCopy, jsCopy } = fixtureCopy();
    const original = readFileSync(jsCopy, "utf8");
    // Target "plus" — a small, single-path glyph on the JS side.
    const mutated = original.replace(
      'plus: P("M12 5 V19 M5 12 H19")',
      'plus: P("M12 5 V19 M6 13 H18")',
    );
    expect(mutated, "sanity: the target string must exist in lift-glyphs.js").not.toBe(original);
    writeFileSync(jsCopy, mutated);

    const divergences = checkParity({ jsxPath: jsxCopy, jsPath: jsCopy });
    expect(divergences.length).toBeGreaterThan(0);
    expect(divergences.some((d) => d.startsWith("plus:"))).toBe(true);
  });

  it("bites when a helper call argument is changed on the JSX side", () => {
    // Change one integer inside a helper call — same helper, different geometry. This is
    // the second class of edit the gate must catch (the first is a literal path-data byte).
    const { jsxCopy, jsCopy } = fixtureCopy();
    const original = readFileSync(jsxCopy, "utf8");
    // Target the "search" icon's `ring(10.5, 10.5, 6)` — well-known and unique.
    const mutated = original.replace("ring(10.5, 10.5, 6)", "ring(10.5, 10.5, 7)");
    expect(mutated, "sanity: the target ring call must exist in lift-icons.jsx").not.toBe(original);
    writeFileSync(jsxCopy, mutated);

    const divergences = checkParity({ jsxPath: jsxCopy, jsPath: jsCopy });
    expect(divergences.length).toBeGreaterThan(0);
    expect(divergences.some((d) => d.startsWith("search:"))).toBe(true);
  });
});
