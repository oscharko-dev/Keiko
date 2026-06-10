/**
 * globals.css regression tests — Issue #627
 *
 * These tests parse the raw CSS text to assert the three WCAG 2.2 AA fixes:
 *   1. WCAG 2.4.7 focus-visible: .arun-btn:focus-visible is global (not scoped
 *      to .rv-controls), and rail buttons have focus rings.
 *   2. WCAG 2.3.3 reduced-motion: unconditional animation declarations are
 *      wrapped in @media (prefers-reduced-motion: no-preference).
 *   3. WCAG 1.4.3 light-theme contrast: --accent-text, --danger, --warn are
 *      overridden to ≥4.5:1-on-white values inside [data-theme="light"].
 *
 * Each assertion is crafted so that reverting the specific fix causes the test
 * to fail (mutation-robustness).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "globals.css"), "utf8");

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Return the index of the nth occurrence of `needle` in `haystack`. */
function indexOfNth(haystack: string, needle: string, n: number): number {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = haystack.indexOf(needle, idx + 1);
    if (idx === -1) return -1;
  }
  return idx;
}

// ─── Fix 1: WCAG 2.4.7 — focus-visible ───────────────────────────────────────

describe("Fix 1 — focus-visible (WCAG 2.4.7)", () => {
  it("adds a global .arun-btn:focus-visible rule (not scoped to .rv-controls)", () => {
    // The global rule must exist somewhere in the file.
    expect(css).toContain(".arun-btn:focus-visible");

    // The old scoped form must NOT exist; the rule must be at selector root.
    // If .rv-controls .arun-btn:focus-visible appears, the scope was restored.
    expect(css).not.toContain(".rv-controls .arun-btn:focus-visible");
  });

  it("adds a .rail-btn:focus-visible focus ring rule", () => {
    expect(css).toContain(".rail-btn:focus-visible");
  });

  it("adds a .rail-new:focus-visible focus ring rule", () => {
    expect(css).toContain(".rail-new:focus-visible");
  });

  it(".rail-btn:focus-visible sets outline: 2px solid var(--accent)", () => {
    // Find the rule block after .rail-btn:focus-visible
    const selectorIdx = css.indexOf(".rail-btn:focus-visible");
    expect(selectorIdx).toBeGreaterThan(-1);
    const block = css.slice(selectorIdx, css.indexOf("}", selectorIdx) + 1);
    expect(block).toContain("outline: 2px solid var(--accent)");
    expect(block).toContain("outline-offset: 2px");
  });
});

// ─── Fix 2: WCAG 2.3.3 — reduced motion ──────────────────────────────────────

/**
 * For each animation, assert:
 *  a) the base selector contains `animation: none` (reduced-motion off by default), AND
 *  b) the animation value appears inside a prefers-reduced-motion: no-preference block.
 *
 * Strategy: the no-preference blocks always follow their base selector in the
 * file, so we verify the keyframe name only occurs inside those blocks.
 */
describe("Fix 2 — reduced-motion wrapping (WCAG 2.3.3)", () => {
  const noPreferenceBlock = "@media (prefers-reduced-motion: no-preference)";

  /**
   * Assert that a selector's base rule contains `animation: none`.
   * Uses a newline-anchored search so `.gw-setup` does not match `.gw-setup-backdrop`.
   */
  function assertBaseIsNone(selector: string): void {
    // Match the selector as the start of a line (after newline or start of file)
    const pattern = new RegExp(
      `(?:^|\\n)(${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{)`,
    );
    const match = pattern.exec(css);
    expect(match, `selector "${selector}" not found as line-start`).toBeTruthy();
    const idx = css.indexOf(match![1]!, match!.index);
    // Grab the rule block (up to first closing brace after selector)
    const block = css.slice(idx, css.indexOf("}", idx) + 1);
    expect(block, `"${selector}" base rule should contain animation: none`).toContain(
      "animation: none",
    );
  }

  /** Assert that a keyframe name appears ONLY inside a no-preference block, not at root level */
  function assertAnimationInsideNoPreference(animationName: string, selector: string): void {
    // Find all occurrences of the animation usage inside the no-preference blocks
    const noPreferenceIdx = css.indexOf(noPreferenceBlock);
    expect(
      noPreferenceIdx,
      "at least one prefers-reduced-motion: no-preference block expected",
    ).toBeGreaterThan(-1);

    // The selector + animation pair must exist somewhere inside a no-preference block
    const searchFor = `animation: ${animationName}`;
    const animIdx = css.indexOf(searchFor);
    expect(animIdx, `"${searchFor}" not found in CSS`).toBeGreaterThan(-1);

    // Walk backwards to confirm it is inside a no-preference block
    const preceding = css.slice(0, animIdx);
    const lastNoPreferenceOpen = preceding.lastIndexOf(noPreferenceBlock);
    expect(
      lastNoPreferenceOpen,
      `"${searchFor}" for selector "${selector}" must be inside a no-preference block`,
    ).toBeGreaterThan(-1);

    // Confirm the no-preference block has NOT been closed before the animation usage
    const afterBlock = preceding.slice(lastNoPreferenceOpen);
    // Count open vs close braces after the @media opening to see if we are inside it
    let depth = 0;
    for (const ch of afterBlock) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    expect(
      depth,
      `"${searchFor}" must be inside an open @media block (depth=${depth})`,
    ).toBeGreaterThan(0);
  }

  it(".chat-spin base has animation: none", () => {
    assertBaseIsNone(".chat-spin");
  });
  it(".chat-spin animation is inside no-preference block", () => {
    assertAnimationInsideNoPreference("spin 1.6s linear infinite", ".chat-spin");
  });

  it(".conn-dot base has animation: none", () => {
    assertBaseIsNone(".conn-dot");
  });
  it(".conn-dot animation is inside no-preference block", () => {
    assertAnimationInsideNoPreference("conn-dot-pulse 1s ease-in-out infinite", ".conn-dot");
  });

  it(".arun-spin base has animation: none", () => {
    assertBaseIsNone(".arun-spin");
  });
  it(".arun-spin animation is inside no-preference block", () => {
    assertAnimationInsideNoPreference("spin 1.4s linear infinite", ".arun-spin");
  });

  it(".arun .dot[data-live=true] base has animation: none", () => {
    const selector = '.arun .dot[data-live="true"]';
    const idx = css.indexOf(selector);
    expect(idx).toBeGreaterThan(-1);
    const block = css.slice(idx, css.indexOf("}", idx) + 1);
    expect(block).toContain("animation: none");
  });

  it(".chat-typing i base has animation: none", () => {
    assertBaseIsNone(".chat-typing i");
  });

  it(".cmp-loading-dot base has animation: none", () => {
    assertBaseIsNone(".cmp-loading-dot");
  });

  it(".chatw-empty base has animation: none", () => {
    assertBaseIsNone(".chatw-empty");
  });
  it(".chatw-empty fadeUp is inside no-preference block", () => {
    assertAnimationInsideNoPreference("fadeUp 0.25s ease both", ".chatw-empty");
  });

  it(".rv-skel base has animation: none", () => {
    assertBaseIsNone(".rv-skel");
  });

  it(".tm-cursor base has animation: none", () => {
    assertBaseIsNone(".tm-cursor");
  });

  it(".gw-setup base has animation: none", () => {
    assertBaseIsNone(".gw-setup");
  });
  it(".gw-setup fadeUp is inside no-preference block", () => {
    assertAnimationInsideNoPreference("fadeUp 0.22s ease-out", ".gw-setup");
  });
});

// ─── Fix 3: WCAG 1.4.3 — light-theme text contrast ───────────────────────────

describe("Fix 3 — light-theme text contrast tokens (WCAG 1.4.3)", () => {
  // Isolate the [data-theme="light"] block content
  const lightBlockStart = css.indexOf('[data-theme="light"]');
  expect(lightBlockStart).toBeGreaterThan(-1);
  // Find the matching closing brace
  let depth = 0;
  let lightBlockEnd = lightBlockStart;
  for (let i = lightBlockStart; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        lightBlockEnd = i;
        break;
      }
    }
  }
  const lightBlock = css.slice(lightBlockStart, lightBlockEnd + 1);

  it('[data-theme="light"] defines --accent-text', () => {
    expect(lightBlock).toContain("--accent-text:");
  });

  it('[data-theme="light"] --accent-text uses an oklch value (darker shade)', () => {
    // Must contain an oklch() value — not just a var() alias
    const line = lightBlock
      .split("\n")
      .find((l) => l.includes("--accent-text:") && l.includes("oklch"));
    expect(
      line,
      "--accent-text in light theme must be an oklch() dark shade, not a variable alias",
    ).toBeTruthy();
  });

  it('[data-theme="light"] --accent-text oklch lightness is ≤0.55 (ensures ≥4.5:1 on white)', () => {
    const match = lightBlock.match(/--accent-text:\s*oklch\(\s*([\d.]+)/);
    expect(match, "--accent-text: oklch(...) declaration not found in light block").toBeTruthy();
    const lightness = parseFloat(match![1]!);
    // oklch lightness ≤0.55 for green hue 160 gives ≥4.5:1 on white
    expect(lightness).toBeLessThanOrEqual(0.55);
  });

  it('[data-theme="light"] overrides --danger to a darker oklch shade', () => {
    const match = lightBlock.match(/--danger:\s*oklch\(\s*([\d.]+)/);
    expect(match, "--danger: oklch(...) not found in light theme block").toBeTruthy();
    const lightness = parseFloat(match![1]!);
    // Must be darker than the dark-theme value (0.68) to pass 4.5:1 on white
    expect(lightness).toBeLessThanOrEqual(0.55);
  });

  it('[data-theme="light"] overrides --warn to a darker oklch shade', () => {
    const match = lightBlock.match(/--warn:\s*oklch\(\s*([\d.]+)/);
    expect(match, "--warn: oklch(...) not found in light theme block").toBeTruthy();
    const lightness = parseFloat(match![1]!);
    // Must be darker than the dark-theme value (0.78) to pass 4.5:1 on white
    expect(lightness).toBeLessThanOrEqual(0.5);
  });

  it(".ft-accent uses --accent-text (not raw --accent)", () => {
    const idx = css.indexOf(".ft-accent");
    expect(idx).toBeGreaterThan(-1);
    const block = css.slice(idx, css.indexOf("}", idx) + 1);
    expect(block).toContain("var(--accent-text)");
    expect(block).not.toContain("var(--accent)");
  });

  it(":root defines --accent-text (dark-theme fallback alias)", () => {
    // The :root block ends before [data-theme=...], so check the portion before light theme
    const rootSection = css.slice(0, lightBlockStart);
    expect(rootSection).toContain("--accent-text:");
  });
});

// ─── Fix 4: mobile root toolbar no-clip behavior ────────────────────────────

describe("Fix 4 — mobile root toolbar compression", () => {
  const mobileMedia = "@media (max-width: 680px)";
  const mediaIdx = css.indexOf(mobileMedia);

  it("adds a mobile breakpoint for the root header", () => {
    expect(mediaIdx).toBeGreaterThan(-1);
  });

  function ruleBlockAfter(mediaStart: number, selector: string): string {
    const selectorIdx = css.indexOf(selector, mediaStart);
    expect(selectorIdx, `missing rule for ${selector} inside mobile block`).toBeGreaterThan(-1);
    return css.slice(selectorIdx, css.indexOf("}", selectorIdx) + 1);
  }

  it("lets the header wrap instead of clipping horizontally", () => {
    const block = ruleBlockAfter(mediaIdx, ".header {");
    expect(block).toContain("flex-wrap: wrap");
    expect(block).toContain("height: auto");
    expect(block).toContain("align-items: flex-start");
  });

  it("hides the wordmark and spacer on narrow widths", () => {
    expect(ruleBlockAfter(mediaIdx, ".hd-wordmark {")).toContain("display: none");
    expect(ruleBlockAfter(mediaIdx, ".spacer {")).toContain("display: none");
  });

  it("compresses secondary toolbar labels on narrow widths", () => {
    expect(ruleBlockAfter(mediaIdx, ".hd-tool-cta span {")).toContain("display: none");
    expect(ruleBlockAfter(mediaIdx, ".edm-trigger-label {")).toContain("display: none");
  });

  it("hides the status pill and window chrome buttons on narrow widths", () => {
    const statusBlock = ruleBlockAfter(mediaIdx, ".tb-status,");
    expect(statusBlock).toContain("display: none");
    expect(ruleBlockAfter(mediaIdx, ".tb-btn {")).toContain("display: none");
  });

  it("keeps the tab strip and mode switch shrinkable", () => {
    expect(ruleBlockAfter(mediaIdx, ".tb-tabs {")).toContain("min-width: 0");
    expect(ruleBlockAfter(mediaIdx, ".modesw {")).toContain("min-width: 0");
  });
});

// ── Verify indexOfNth helper is unused externally (suppress unused-import lint) ─
void indexOfNth;
