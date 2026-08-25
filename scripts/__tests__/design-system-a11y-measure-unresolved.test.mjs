// KEIKO-0404 regression pin: design-system/a11y-measure.js resolveLive() must fail closed
// when a CSS colour expression cannot be resolved (e.g. `var(--nonexistent-token)`), rather
// than silently return a plausible RGBA and let measure() feed the fabricated value into
// over()/ratio() to produce a fake pass/fail verdict on the accessibility audit page.
//
// The fix installs an "unresolved" sentinel colour on a probe-parent element. An unresolved
// var() reference in a color property is treated as `unset` at computed-value time, which
// then INHERITS from the probe-parent — so getComputedStyle(probe).color === sentinel means
// resolution failed. A legitimate token that happens to be the sentinel value is
// distinguished by checking that the expression itself does not literally contain the
// sentinel triple. The pure sentinel-comparison helper is exported on the KeikoA11y global
// so this pin can exercise it without jsdom (which does not implement spec-accurate CSS
// custom-property fallback, per the KEIKO-0404 disposition).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const scriptPath = resolve(repoRoot, "design-system", "a11y-measure.js");

function loadA11yMeasure() {
  const source = readFileSync(scriptPath, "utf8");
  // Minimal DOM shim — the sentinel helper is a pure string comparator, so we don't need a
  // real document. The IIFE calls document.createElement / body.appendChild lazily via
  // getProbe(), which we only trigger by calling resolve()/measure(); the helper we test
  // never touches the DOM.
  const noop = () => undefined;
  const documentStub = {
    createElement: () => ({ setAttribute: noop, style: { cssText: "", setProperty: noop } }),
    documentElement: {
      setAttribute: noop,
      removeAttribute: noop,
      getAttribute: () => null,
    },
    body: { appendChild: noop },
  };
  const canvasStub = {
    width: 0,
    height: 0,
    getContext: () => ({
      clearRect: noop,
      fillRect: noop,
      fillStyle: "",
      getImageData: () => ({ data: [0, 0, 0, 255] }),
    }),
  };
  const windowStub = {};
  const context = vm.createContext({
    document: {
      ...documentStub,
      createElement: (tag) => (tag === "canvas" ? canvasStub : documentStub.createElement()),
    },
    getComputedStyle: () => ({ color: "rgb(0, 0, 0)" }),
    window: windowStub,
  });
  vm.runInContext(source, context);
  return windowStub.KeikoA11y;
}

describe("design-system/a11y-measure.js — resolveLive fails closed on unresolved var() (KEIKO-0404)", () => {
  it("exposes the pure sentinel-comparison helper for regression coverage", () => {
    const api = loadA11yMeasure();
    expect(typeof api._isUnresolvedColor).toBe("function");
  });

  it("classifies a computed sentinel colour with a non-sentinel expression as unresolved", () => {
    const api = loadA11yMeasure();
    expect(api._isUnresolvedColor("rgb(1, 2, 3)", "var(--this-token-does-not-exist)")).toBe(true);
    expect(api._isUnresolvedColor("rgb(1, 2, 3)", "var(--card)")).toBe(true);
  });

  it("does NOT flag a legitimate token that literally names the sentinel triple", () => {
    // Someone could reasonably use rgb(1,2,3) as an actual design-token value. Since the
    // sentinel is inherited, we must distinguish "unresolved" from "resolved to sentinel"
    // by inspecting the source expression — if it literally contains the sentinel triple,
    // the match is real, not the fingerprint of a failed resolution.
    const api = loadA11yMeasure();
    expect(api._isUnresolvedColor("rgb(1, 2, 3)", "rgb(1, 2, 3)")).toBe(false);
    expect(api._isUnresolvedColor("rgb(1, 2, 3)", "rgb(1,2,3)")).toBe(false);
  });

  it("does NOT flag a resolved colour that isn't the sentinel", () => {
    const api = loadA11yMeasure();
    expect(api._isUnresolvedColor("rgb(255, 0, 0)", "var(--danger)")).toBe(false);
    expect(api._isUnresolvedColor("rgb(0, 0, 0)", "var(--fg)")).toBe(false);
  });
});
