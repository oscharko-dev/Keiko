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

function cssBlock(selector: string, opts: { readonly fromLast?: boolean } = {}): string {
  const idx = opts.fromLast === true ? css.lastIndexOf(selector) : css.indexOf(selector);
  expect(idx, `selector "${selector}" not found`).toBeGreaterThan(-1);
  return css.slice(idx, css.indexOf("}", idx) + 1);
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

  it(".rail-btn:focus-visible sets outline: 2px solid var(--accent-text)", () => {
    // Find the rule block after .rail-btn:focus-visible
    const selectorIdx = css.indexOf(".rail-btn:focus-visible");
    expect(selectorIdx).toBeGreaterThan(-1);
    const block = css.slice(selectorIdx, css.indexOf("}", selectorIdx) + 1);
    expect(block).toContain("outline: 2px solid var(--accent-text)");
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

  // .chat-spin removed as dead legacy-sidebar code (uiux-fix F037 C327)

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

  // .tm-cursor removed as dead terminal-mock code (uiux-fix F049 C335)

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

describe("design a11y — prefers-contrast token step-up (accessibility.html §01)", () => {
  it("steps up neutral borders + faint/dim text at the token level, not just components", () => {
    // accessibility.html promises: "when the OS asks for more contrast, borders,
    // faint text … step up automatically". That requires a token-level override,
    // not only the component-scoped .rb-edge-badge block.
    const marker = css.indexOf("Step the neutral ramp");
    expect(marker, "token-level prefers-contrast step-up not found").toBeGreaterThan(-1);
    const open = css.indexOf("@media (prefers-contrast: more)", marker);
    expect(open).toBeGreaterThan(-1);
    const block = css.slice(open, open + 900);
    // dark: brighter borders + faint/dim text
    expect(block).toContain("--line: oklch(0.55 0.004 160)");
    expect(block).toContain("--fg-faint: oklch(0.74 0.004 160)");
    // light: darker borders + faint/dim text
    expect(block).toContain("--fg-faint: oklch(0.42 0.01 160)");
  });
});

describe("design foundations — JetBrains Mono webfont (foundations.html §02)", () => {
  it("self-hosts JetBrains Mono via @font-face so --font-mono actually renders it", () => {
    // The token referenced "JetBrains Mono" but the face was never loaded — mono text fell
    // back to the system monospace. The @font-face makes the brand mono real and offline.
    const idx = css.indexOf("@font-face");
    expect(idx, "no @font-face — JetBrains Mono is referenced but never loaded").toBeGreaterThan(
      -1,
    );
    const block = css.slice(idx, css.indexOf("}", idx) + 1);
    expect(block).toContain('font-family: "JetBrains Mono"');
    expect(block).toContain("/fonts/jetbrains-mono-latin-wght-normal.woff2");
    expect(block).toContain('format("woff2")');
    // --font-mono must list the loaded face first so it is actually used.
    expect(css).toMatch(/--font-mono:\s*"JetBrains Mono"/);
  });
});

describe("design a11y — skip link (WCAG 2.4.1, accessibility.html §04)", () => {
  it("ships a .skip-link that hides off-screen and reveals on focus", () => {
    const block = cssBlock(".skip-link {");
    expect(block).toContain("position: fixed");
    expect(block).toContain("transform: translateY(-180%)");
    expect(cssBlock(".skip-link:focus {")).toContain("transform: none");
  });
});

describe("Visual quality — workspace text rendering", () => {
  it(".ws-scene does not force transform layer promotion", () => {
    const block = cssBlock(".ws-scene");
    expect(block).not.toContain("will-change: transform");
  });
});

describe("WCAG 2.5.8 — footer target size", () => {
  it(".ft-window-trigger keeps at least a 24px hit target", () => {
    const block = cssBlock(".ft-window-trigger");
    expect(block).toContain("min-height: 24px");
  });
});

describe("Issue #748 — QI quality badge and weak-test contrast hooks", () => {
  it("quality score tiers use the state tokens that are contrast-pinned in both themes", () => {
    const highBlock = cssBlock(".qi-quality-high {");
    expect(highBlock).toContain("background: var(--accent-dim)");
    expect(highBlock).toContain("color: var(--accent-text)");

    const midBlock = cssBlock(".qi-quality-mid {");
    expect(midBlock).toContain("background: color-mix(in oklch, var(--warn) 20%, transparent)");
    expect(midBlock).toContain("color: var(--warn)");

    const lowBlock = cssBlock(".qi-quality-low {");
    expect(lowBlock).toContain("background: color-mix(in oklch, var(--danger) 22%, transparent)");
    expect(lowBlock).toContain("color: var(--fg)");
  });

  it("weak-test flag text stays on primary or muted foreground tokens over a card-tinted surface", () => {
    const flagBlock = cssBlock(".qi-weak-flag {");
    expect(flagBlock).toContain("background: color-mix(in oklch, var(--danger) 10%, var(--card))");

    const badgeBlock = cssBlock(".qi-weak-flag-badge {");
    expect(badgeBlock).toContain("color: var(--fg)");

    const reasonBlock = cssBlock(".qi-weak-flag-reason {");
    expect(reasonBlock).toContain("color: var(--fg-muted)");
  });
});

describe("Conversation memory switch target size (WCAG 2.5.8)", () => {
  it(".auto-toggle is at least 24px tall and has a larger hit area", () => {
    const block = cssBlock(".auto-toggle {");
    expect(block).toContain("width: 42px");
    expect(block).toContain("height: 24px");
  });

  it(".auto-toggle thumb uses the enlarged 18px geometry", () => {
    const block = cssBlock(".auto-toggle span");
    expect(block).toContain("width: 18px");
    expect(block).toContain("height: 18px");
  });
});

// ─── Fix 4: dense desktop text clarity ───────────────────────────────────────

describe("Fix 4 — dense desktop text clarity", () => {
  it("keeps native font rasterization instead of forcing thin grayscale antialiasing", () => {
    const bodyBlock = cssBlock("body");
    expect(bodyBlock).toContain("-webkit-font-smoothing: auto");
    expect(bodyBlock).toContain("-moz-osx-font-smoothing: auto");
    expect(bodyBlock).toContain("text-rendering: auto");
    expect(bodyBlock).not.toContain("-webkit-font-smoothing: antialiased");
    expect(bodyBlock).not.toContain("text-rendering: optimizeLegibility");
  });

  it("keeps Files root controls above the micro-text floor", () => {
    const inputBlock = cssBlock(".files-root-input");
    expect(inputBlock).toContain("height: 28px");
    expect(inputBlock).toContain("font-size: 12.5px");
    expect(inputBlock).toContain("font-weight: 500");

    const openBlock = cssBlock(".files-root-open");
    expect(openBlock).toContain("height: 28px");
    expect(openBlock).toContain("font-size: 12.5px");
    expect(openBlock).toContain("font-weight: 700");
  });

  it("keeps workspace tree rows legible on 1x displays", () => {
    const rowBlock = cssBlock(".tr-row");
    expect(rowBlock).toContain("min-height: 26px");
    expect(rowBlock).toContain("font-size: 13.5px");
    expect(rowBlock).toContain("font-weight: 450");

    const folderBlock = cssBlock(".tr-folder");
    expect(folderBlock).toContain("font-weight: 600");
  });

  it("keeps window chrome labels strong enough for daily-use desktop work", () => {
    const titleBlock = cssBlock(".win-title");
    expect(titleBlock).toContain("font-size: 13.5px");
    expect(titleBlock).toContain("font-weight: 650");

    const subtitleBlock = cssBlock(".win-sub");
    expect(subtitleBlock).toContain("font-size: 11.5px");
    expect(subtitleBlock).toContain("font-weight: 500");
  });

  it("keeps window controls large enough for full-screen cards (WCAG 2.5.8)", () => {
    const buttonBlock = cssBlock(".win-traffic-btn");
    expect(buttonBlock).toContain("width: 28px");
    expect(buttonBlock).toContain("height: 28px");

    const maxButtonBlock = cssBlock('.window[data-max="true"] .win-traffic-btn');
    expect(maxButtonBlock).toContain("width: 30px");
    expect(maxButtonBlock).toContain("height: 30px");
  });

  it("draws window controls in the Lift hand — monochrome at rest, whisper on hover", () => {
    // Design/Keiko Icon System §03: the three controls are Lift glyphs in
    // currentColor, not borrowed Apple dots. At rest the "ring halo" chip is
    // hidden — no permanent colour, no fill.
    const chipBlock = cssBlock(".win-traffic-btn::before");
    expect(chipBlock).toContain("inset: 3px");
    expect(chipBlock).toContain("opacity: 0");
    expect(chipBlock).toContain("box-shadow: 0 0 0 1px var(--line-soft) inset");

    // The meaning only whispers on hover: full screen tints accent, close tints
    // danger — always paired with the glyph + the button aria-label, never colour
    // alone.
    expect(cssBlock(".win-traffic-maximize:hover")).toContain("color: var(--accent-text)");
    expect(cssBlock(".win-traffic-close:hover")).toContain("color: var(--danger)");

    // The old always-on Apple traffic-light dots (amber minimize fill) are gone.
    expect(css).not.toContain("oklch(0.78 0.15 82)");
  });

  it("keeps file metadata readable without widened tracking", () => {
    const badgeBlock = cssBlock(".tr-badge", { fromLast: true });
    expect(badgeBlock).toContain("font-size: 10px");
    expect(badgeBlock).toContain("letter-spacing: 0");
    expect(badgeBlock).toContain("font-weight: 650");

    const metaBlock = cssBlock(".tr-meta", { fromLast: true });
    expect(metaBlock).toContain("font-size: 11.5px");
    expect(metaBlock).toContain("font-weight: 500");
  });
});

// ─── Fix 5: mobile root toolbar no-clip behavior ────────────────────────────

describe("Fix 5 — mobile root toolbar compression", () => {
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

// ─── uiux-fix F010 — context-budget indicator + scope-pill focus ring ─────────

describe("uiux-fix F010 — cmp-budget styling and scope-pill focus visibility", () => {
  it("defines the cmp-budget layout and badge rules (C044/C081 — classes were orphaned)", () => {
    expect(css).toContain(".cmp-budget-row");
    expect(css).toContain(".cmp-budget-badge-exceeded");
    expect(css).toContain(".cmp-budget-clear:focus-visible");
    expect(css).toContain(".cmp-budget-clear:disabled");
    // The flex row is what un-merges the inline text run ("tokensLowiClear history").
    const rowIdx = css.indexOf(".cmp-budget-row");
    const rowBlock = css.slice(rowIdx, css.indexOf("}", rowIdx) + 1);
    expect(rowBlock).toContain("display: flex");
    expect(rowBlock).toContain("gap: 8px");
  });

  it("light theme overrides the low-badge text to ink-inverse (raw accent ≈1.97:1 on the tint)", () => {
    expect(css).toContain('[data-theme="light"] .cmp-budget-badge-low');
  });

  it("reveals the cmp-budget-info data-tip on focus-visible as well as hover (C321)", () => {
    expect(css).toContain(".cmp-budget-info[data-tip]:focus-visible::after");
    expect(css).toContain(".cmp-budget-info[data-tip]:hover::after");
  });

  it("styles the connector pill modifier distinctly from folder pills (C326)", () => {
    expect(css).toContain(".scope-pill--connector");
  });

  it("scope-pill disconnect focus ring is NOT accent-on-accent (C045, WCAG 2.4.7)", () => {
    const idx = css.indexOf(".scope-pill-disconnect:focus-visible");
    expect(idx).toBeGreaterThan(-1);
    const block = css.slice(idx, css.indexOf("}", idx) + 1);
    // The × sits inside the accent-filled pill: its ring must use ink-inverse, not accent.
    expect(block).toContain("outline: 2px solid var(--ink-inverse)");
    expect(block).not.toContain("outline: 2px solid var(--accent)");
    // The shared selector (which gave both buttons the accent ring) must be gone.
    expect(css).not.toMatch(
      /\.scope-pill-disconnect:focus-visible,\s*\.scope-connect-btn:focus-visible/,
    );
  });
});

// ── Verify indexOfNth helper is unused externally (suppress unused-import lint) ─
void indexOfNth;

// ─── uiux-fix F013 — header responsive stages + project-tab truncation ────────

describe("uiux-fix F013 — header responsive stages and tab truncation", () => {
  it("adds the 1100px/1000px header visibility stages (C101, WCAG 1.4.10)", () => {
    // search from the F013 marker — the footer has its own (earlier) 1000px stage
    const marker = css.indexOf("uiux-fix F013: header responsive");
    expect(marker).toBeGreaterThan(-1);
    const idx1100 = css.indexOf("@media (max-width: 1100px)", marker);
    const idx1000 = css.indexOf("@media (max-width: 1000px)", marker);
    expect(idx1100).toBeGreaterThan(-1);
    expect(idx1000).toBeGreaterThan(-1);
    expect(css.slice(idx1000, idx1000 + 400)).toContain(".header .tb-btn");
  });

  it("truncates the project-tab label instead of overflowing/wrapping (C157/C225)", () => {
    const marker = css.indexOf("uiux-fix F013: header responsive");
    expect(marker).toBeGreaterThan(-1);
    const f013Section = css.slice(marker);
    const selectorBlock = f013Section.match(/\.tb-tab\s*>\s*span\s*\{[\s\S]*?\}/);
    expect(selectorBlock).not.toBeNull();
    const block = selectorBlock?.[0] ?? "";
    expect(block).toContain("text-overflow: ellipsis");
    expect(block).toContain("max-width: 220px");
  });

  it("drops all orphaned .tb-newtab rules with the dead button (C059)", () => {
    expect(css).not.toContain(".tb-newtab {");
    expect(css).not.toContain(".tb-newtab:hover");
    expect(css).not.toContain(".tb-newtab:focus-visible");
  });
});

// ─── uiux-fix A11Y (WCAG 2.2 AA audit) — focus rings, reduced-motion, contrast ──

describe("uiux-fix A11Y — focus rings for keyboard focus targets (WCAG 2.4.7)", () => {
  it("adds a visible .footer:focus-visible ring (SH-02 Alt+S jump target)", () => {
    const block = cssBlock(".footer:focus-visible");
    expect(block).toContain("outline: 2px solid var(--accent-text)");
  });

  it("adds a visible .workspace:focus-visible ring (WC-01 keyboard pan surface)", () => {
    const block = cssBlock(".workspace:focus-visible");
    expect(block).toContain("outline: 2px solid var(--accent-text)");
  });

  it(".tr-caret-btn:focus-visible keeps a dark separator so it contrasts on accent-dim rows (CC-01)", () => {
    const block = cssBlock(".tr-caret-btn:focus-visible");
    expect(block).toContain("box-shadow: 0 0 0 1px var(--bg)");
  });
});

describe("uiux-fix A11Y — reduced-motion transition gating (WCAG 2.3.3, MO-ALL)", () => {
  const gated = [
    ".cmp-box",
    ".cmp-send",
    ".ws-shader",
    ".proj-caret",
    ".tr-caret",
    ".auto-toggle span",
    ".attach-drop-zone",
    ".win-zoom",
    ".arun-prog i",
    ".pal-card",
    ".mc-row",
    ".connector-picker-retry",
    ".files-retry",
    ".scope-grounding-select",
  ];

  // Isolate the appended MO-ALL no-preference block by its marker comment, then
  // brace-match to its close so the membership checks can't leak into other blocks.
  const marker = css.indexOf("MO-ALL — gate remaining interaction transitions");
  const blockOpen = css.indexOf("@media (prefers-reduced-motion: no-preference)", marker);
  let depth = 0;
  let blockEnd = blockOpen;
  let started = false;
  for (let i = css.indexOf("{", blockOpen); i < css.length; i++) {
    if (css[i] === "{") {
      depth++;
      started = true;
    } else if (css[i] === "}") {
      depth--;
    }
    if (started && depth === 0) {
      blockEnd = i;
      break;
    }
  }
  const moBlock = css.slice(blockOpen, blockEnd + 1);

  it("the MO-ALL no-preference block exists after its marker", () => {
    expect(marker).toBeGreaterThan(-1);
    expect(blockOpen).toBeGreaterThan(marker);
  });

  for (const sel of gated) {
    it(`${sel} transition is opted back in only inside the no-preference block`, () => {
      expect(moBlock).toContain(`${sel} {`);
    });
  }

  it("composer, send button and pal-card no longer carry an ungated base transition", () => {
    // Reverting any of these (re-adding the base transition) re-fails this guard.
    expect(cssBlock(".cmp-box {")).not.toContain("transition");
    expect(cssBlock(".cmp-send {")).not.toContain("transition");
    expect(cssBlock(".pal-card {")).not.toContain("transition");
  });
});

describe("uiux-fix A11Y — contrast fixes (WCAG 1.4.3)", () => {
  it("dark .hl-com uses --fg-dim, not the sub-AA #6b7787 (CC-04)", () => {
    const block = cssBlock(".hl-com {");
    expect(block).toContain("var(--fg-dim)");
    expect(block).not.toContain("#6b7787");
  });

  it("invalid connect-target window is dimmed to 0.7, not the sub-AA 0.42 (TZ-01)", () => {
    const block = cssBlock('.window[data-conn="invalid"] {');
    expect(block).toContain("opacity: 0.7");
    expect(block).not.toContain("opacity: 0.42");
  });

  it("required-field marker is a CSS ::after glyph keyed off data-required (QI-01)", () => {
    const block = cssBlock('.qi-edit-label[data-required="true"]::after');
    expect(block).toContain('content: " *"');
  });
});

// ─── Figma snapshot button target size (WCAG 2.5.8) — #756 audit ─────────────

describe("Figma snapshot button target size (WCAG 2.5.8) — #756 audit", () => {
  it(".figma-snapshot-cancel-btn meets the 24px minimum height (WCAG 2.5.8)", () => {
    const block = cssBlock(".figma-snapshot-cancel-btn {");
    expect(block).toContain("min-height: 24px");
  });

  it(".figma-snapshot-cancel-btn:focus-visible has an accent outline (WCAG 2.4.7)", () => {
    const block = cssBlock(".figma-snapshot-cancel-btn:focus-visible");
    expect(block).toContain("outline: 2px solid var(--accent-text)");
  });

  it(".figma-snapshot-revoke-btn meets the 24px minimum height (WCAG 2.5.8)", () => {
    const block = cssBlock(".figma-snapshot-revoke-btn,");
    expect(block).toContain("min-height: 24px");
  });

  it(".figma-snapshot-revoke-confirm-btn:focus-visible has an accent outline (WCAG 2.4.7)", () => {
    const block = cssBlock(".figma-snapshot-revoke-btn:focus-visible,");
    expect(block).toContain("outline: 2px solid var(--accent-text)");
  });

  it(".figma-snapshot-revoke-confirm-btn is covered by the shared revoke block (WCAG 2.5.8)", () => {
    // The shared selector block names all three revoke buttons.
    const idx = css.indexOf(".figma-snapshot-revoke-btn,");
    expect(idx, ".figma-snapshot-revoke-btn shared block not found").toBeGreaterThan(-1);
    const block = css.slice(idx, css.indexOf("}", idx) + 1);
    expect(block).toContain(".figma-snapshot-revoke-confirm-btn");
    expect(block).toContain(".figma-snapshot-revoke-cancel-btn");
    expect(block).toContain("min-height: 24px");
  });

  it(".figma-snapshot-revoke-cancel-btn focus ring is covered by the shared revoke focus block (WCAG 2.4.7)", () => {
    const idx = css.indexOf(".figma-snapshot-revoke-btn:focus-visible,");
    expect(idx, ".figma-snapshot-revoke-btn:focus-visible shared block not found").toBeGreaterThan(
      -1,
    );
    const block = css.slice(idx, css.indexOf("}", idx) + 1);
    expect(block).toContain(".figma-snapshot-revoke-cancel-btn:focus-visible");
    expect(block).toContain("outline: 2px solid var(--accent-text)");
  });

  it(".figma-snapshot-code-file-path meets the 24px minimum height (WCAG 2.5.8)", () => {
    const block = cssBlock(".figma-snapshot-code-file-path {");
    expect(block).toContain("min-height: 24px");
  });

  it(".figma-snapshot-scopes-summary meets the 24px minimum height (WCAG 2.5.8)", () => {
    const block = cssBlock(".figma-snapshot-scopes-summary {");
    expect(block).toContain("min-height: 24px");
  });

  it(".figma-snapshot-screen-image has stable thumbnail dimensions for the gallery", () => {
    const block = cssBlock(".figma-snapshot-screen-image {");
    expect(block).toContain("width: 72px");
    expect(block).toContain("height: 54px");
    expect(block).toContain("object-fit: contain");
  });

  it(".figma-snapshot-error-card uses the contrast-pinned danger token, not raw red HSL", () => {
    const card = cssBlock(".figma-snapshot-error-card {");
    const title = cssBlock(".figma-snapshot-error-title {");
    const detail = cssBlock(".figma-snapshot-error-detail {");
    expect(card).toContain("var(--danger)");
    expect(card).not.toMatch(/hsl\(/u);
    expect(title).toContain("color: var(--danger)");
    expect(detail).toContain("color: var(--fg)");
  });
});
