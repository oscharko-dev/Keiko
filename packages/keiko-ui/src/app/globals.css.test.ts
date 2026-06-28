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
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "globals.css"), "utf8").replace(/\r\n?/g, "\n");
const currentCssSha256 = createHash("sha256").update(css).digest("hex");
const evidenceHarness1297 = readFileSync(
  resolve(here, "../../../..", "docs/design-system/evidence/1297/equivalence-harness.mjs"),
  "utf8",
);
const evidenceHarness1298 = readFileSync(
  resolve(here, "../../../..", "docs/design-system/evidence/1298/equivalence-harness.mjs"),
  "utf8",
);
const designSystemInputsHtml = readFileSync(
  resolve(here, "../../../..", "design-system/inputs.html"),
  "utf8",
);
const designSystemNavHtml = readFileSync(
  resolve(here, "../../../..", "design-system/nav-components.html"),
  "utf8",
);
interface Issue1298ComputedProof {
  readonly keyboardFocus: {
    readonly targetCount: number;
    readonly targets: Record<string, { readonly ok: boolean }>;
  };
  readonly screenshots: {
    readonly compactDensity: string;
    readonly focusVisible: string;
    readonly responsiveViewports: readonly {
      readonly fileName: string;
      readonly width: number;
      readonly height: number;
      readonly label: string;
    }[];
  };
}
const computedProof1298 = JSON.parse(
  readFileSync(
    resolve(here, "../../../..", "docs/design-system/evidence/1298/computed-value-proof.json"),
    "utf8",
  ),
) as unknown as Issue1298ComputedProof;

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

describe("Issue #1429 — Agents launcher action row and picker scrollbars", () => {
  it("keeps the Agents dialog actions sticky and unified inside the dialog flow", () => {
    const block = cssBlock(".dlg-agent-actions {");
    expect(block).toContain("justify-content: flex-end");
    expect(block).toContain("position: sticky");
    expect(block).toContain("bottom: 0");
    expect(block).toContain("border-top: 1px solid var(--border-subtle)");
    expect(block).toContain("background: var(--surface-overlay)");
    expect(cssBlock(".dlg-agent-actions .dlg-note {")).toContain("margin-right: auto");
  });

  it("uses token-backed thin scrollbar styling for directory and file pickers", () => {
    const dirList = cssBlock(".dir-list {");
    expect(dirList).toContain("scrollbar-width: thin");
    expect(dirList).toContain("scrollbar-color: var(--border-default) transparent");
    expect(cssBlock(".file-picker-list {")).toContain("max-height: 260px");

    const thumb = cssBlock(".dir-list::-webkit-scrollbar-thumb {");
    expect(thumb).toContain("background: var(--border-default)");
    expect(thumb).toContain("background-clip: padding-box");
    expect(cssBlock(".dir-list::-webkit-scrollbar-thumb:hover {")).toContain(
      "background: var(--border-strong)",
    );
  });
});

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

  it(".rail-btn:focus-visible sets outline: var(--focus-width, 2px) solid var(--focus-ring)", () => {
    // Find the actual focus-ring rule, not earlier :has(...) occurrences.
    // #1293: the shell focus rings now consume the --focus-ring semantic token
    // (--focus-ring: var(--accent-text)), so the resolved colour is byte-identical.
    const selectorIdx = css.indexOf(
      ".rail-btn:focus-visible,\n.rail-new:focus-visible,\n.rail-avatar:focus-visible",
    );
    expect(selectorIdx).toBeGreaterThan(-1);
    const block = css.slice(selectorIdx, css.indexOf("}", selectorIdx) + 1);
    expect(block).toContain("outline: var(--focus-width, 2px) solid var(--focus-ring)");
    expect(block).toContain("outline-offset: 2px");
  });
});

describe("Gateway credential dialog chrome", () => {
  it("hides workspace rails while the gateway setup dialog is open", () => {
    const block = cssBlock('html[data-keiko-gateway-setup-open="true"] .rail');
    expect(block).toContain("display: none");
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
  it(".chat-typing i animation is inside no-preference block", () => {
    assertAnimationInsideNoPreference("pulse 1.2s infinite", ".chat-typing i");
  });

  // Issue #1296 — the ported canonical .ai-* animations adopt the product's animation-off-by-default
  // convention (enabled only inside no-preference), not the reference's reduce-override pattern.
  it(".ai-thinking dots: base none + ai-blink inside no-preference", () => {
    assertBaseIsNone(".ai-thinking .dots i");
    assertAnimationInsideNoPreference("ai-blink 1.2s ease-in-out infinite", ".ai-thinking .dots i");
  });
  it(".ai-stream-cursor: base none + ai-caret inside no-preference", () => {
    assertBaseIsNone(".ai-stream-cursor");
    assertAnimationInsideNoPreference("ai-caret 1s steps(1) infinite", ".ai-stream-cursor");
  });
  it(".ai-tool spinner: base none + ai-spin inside no-preference", () => {
    assertBaseIsNone(".ai-tool-head .st.run::before");
    assertAnimationInsideNoPreference(
      "ai-spin 0.7s linear infinite",
      ".ai-tool-head .st.run::before",
    );
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

describe("Gateway setup constrained-height scrolling", () => {
  it("lets the backdrop recover on short viewports while the rounded frame clips", () => {
    expect(cssBlock(".gw-setup-backdrop")).toContain("overflow-y: auto");
    expect(cssBlock(".gw-setup {")).toContain("overflow: hidden");
  });

  it("uses the form as the internal scroll region", () => {
    const block = cssBlock(".gw-form");
    expect(block).toContain("flex: 1");
    expect(block).toContain("min-height: 0");
    expect(block).toContain("overflow-y: auto");
  });
});

describe("Compact model picker", () => {
  it("keeps the model icon visible while hiding compact-only text and caret chrome", () => {
    const triggerBlock = cssBlock(".cmp-model-compact .cmp-model-select");
    expect(triggerBlock).not.toContain("opacity: 0");
    expect(triggerBlock).toContain("width: 34px");
    expect(triggerBlock).toContain("height: 34px");
    expect(triggerBlock).toContain("max-width: 34px");
    expect(triggerBlock).toContain("display: flex");
    expect(triggerBlock).toContain("align-items: center");
    expect(triggerBlock).toContain("justify-content: center");
    expect(triggerBlock).toContain("gap: 0");

    const copyRule = css.indexOf(
      ".cmp-model-compact .cmp-model-select .ksel-trigger-copy,\n" +
        ".cmp-model-compact .cmp-model-select .ksel-trigger-caret",
    );
    expect(copyRule).toBeGreaterThan(-1);
    const copyBlock = css.slice(copyRule, css.indexOf("}", copyRule) + 1);
    expect(copyBlock).toContain("display: none");

    const leadingBlock = cssBlock(".cmp-model-compact .cmp-model-select .ksel-trigger-leading");
    expect(leadingBlock).toContain("width: 100%");
    expect(leadingBlock).toContain("height: 100%");
    expect(leadingBlock).toContain("display: grid");
    expect(leadingBlock).toContain("place-items: center");

    expect(cssBlock(".cmp-bar-compact .cmp-model-compact .cmp-model-select")).toContain(
      "max-width: 34px",
    );
  });
});

describe("Prompt Enhancer rendered prompt selection", () => {
  it("keeps the rendered prompt selectable despite window-level selection guards", () => {
    const panelBlock = cssBlock(".pe-panel {");
    expect(panelBlock).toContain("user-select: text");
    const sectionBlock = cssBlock(".pe-section {");
    expect(sectionBlock).toContain("user-select: text");
    const renderedBlock = cssBlock(".pe-rendered {");
    expect(renderedBlock).toContain("user-select: text");
    expect(renderedBlock).toContain("-webkit-user-select: text");
    expect(renderedBlock).toContain("cursor: text");
    const descendantBlock = cssBlock(".pe-rendered *");
    expect(descendantBlock).toContain("user-select: text");
    expect(descendantBlock).toContain("-webkit-user-select: text");
  });
});

describe("Chat grounded audit footer density", () => {
  it("keeps inline Evidence and Context disclosures visually tight inside assistant answers", () => {
    const inlineBlock = cssBlock(".chatw-grounded-inline {");
    expect(inlineBlock).toContain("gap: 0");
    expect(inlineBlock).toContain("padding: 6px 10px");

    const summaryBlock = cssBlock(".chatw-grounded-inline .grounded-evidence-summary {");
    expect(summaryBlock).toContain("min-height: 27px");
    expect(summaryBlock).toContain("padding: 3px 0");

    const contextBlock = cssBlock(".chatw-grounded-inline > .ctx-status {");
    expect(contextBlock).toContain("margin-top: 0");
    expect(contextBlock).toContain("border-top: 1px solid var(--border-subtle)");
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

  it(".ft-accent uses --text-accent (light-adapting, not raw --accent)", () => {
    // #1293: .ft-accent now consumes the --text-accent semantic alias
    // (--text-accent: var(--accent-text)); resolved colour is byte-identical and
    // still light-adapting. The raw brand --accent must never appear here.
    const idx = css.indexOf(".ft-accent");
    expect(idx).toBeGreaterThan(-1);
    const block = css.slice(idx, css.indexOf("}", idx) + 1);
    expect(block).toContain("var(--text-accent)");
    expect(block).not.toContain("var(--accent)");
  });

  it(":root defines --accent-text (dark-theme fallback alias)", () => {
    // The :root block ends before [data-theme=...], so check the portion before light theme
    const rootSection = css.slice(0, lightBlockStart);
    expect(rootSection).toContain("--accent-text:");
  });
});

describe("design a11y — prefers-contrast token step-up (accessibility.html §01)", () => {
  it("applies the full high-contrast primitive palette at the token level", () => {
    // accessibility.html treats High Contrast as a first-class palette, not only
    // a component-scoped border tweak. The detailed #1292 drift gate below pins
    // exact reference parity; this smoke assertion keeps the older regression
    // focused on the most user-visible primitives.
    const block = cssRule("@media (prefers-contrast: more) {");
    expect(block).toContain("--bg: oklch(0.11 0.004 160)");
    expect(block).toContain("--fg: oklch(1 0 0)");
    expect(block).toContain("--accent-text: oklch(0.86 0.16 160)");
    expect(block).toContain("--shadow-card: 0 0 0 1px var(--line)");
    expect(block).toContain("--fg-faint: oklch(0.36 0.012 160)");
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

describe("Issue #1426 — footer window chrome clears the right rail", () => {
  it("reserves the right rail width in the footer and lifts the palette above shell rails", () => {
    const footer = cssBlock(".footer {");
    expect(footer).toContain("z-index: var(--z-sticky)");
    expect(footer).toContain(
      "padding: 0 calc(var(--space-5) + var(--shell-right-rail-reserve)) 0 var(--space-5)",
    );

    const palette = cssBlock(".ft-window-palette {");
    expect(palette).toContain("z-index: var(--z-popover)");
  });

  it("shares the rail width between shell rails and the footer reserve, with a narrow reset", () => {
    expect(css).toContain("--shell-rail-width: 50px");
    expect(css).toContain("--shell-right-rail-reserve: var(--shell-rail-width)");
    expect(css).toContain("@media (max-width: 700px), (max-height: 430px) {\n  :root {");
    expect(css).toContain("--shell-rail-width: 44px");
    expect(css).toContain("@media (max-width: 420px) {\n  :root {");
    expect(css).toContain("--shell-right-rail-reserve: 0px");
    expect(cssRule('html[data-keiko-gateway-setup-open="true"] {')).toContain(
      "--shell-right-rail-reserve: 0px",
    );
  });

  it("routes footer and rail tooltips through the governed tooltip layer", () => {
    const shellTooltip = cssRule(".cmp-mode[data-tip]::after,");
    expect(shellTooltip).toContain("z-index: var(--z-tooltip)");

    const railTooltip = cssRule(".rail-btn[data-tip]::after,");
    expect(railTooltip).toContain("z-index: var(--z-tooltip)");
  });
});

describe("Issue #748 — QI quality badge and weak-test contrast hooks", () => {
  it("quality score tiers use the state tokens that are contrast-pinned in both themes", () => {
    const highBlock = cssBlock(".qi-quality-high {");
    expect(highBlock).toContain("background: var(--accent-dim)");
    // #1294: --accent-text → --text-accent (value-preserving alias)
    expect(highBlock).toContain("color: var(--text-accent)");

    const midBlock = cssBlock(".qi-quality-mid {");
    // #1294: --warn → --feedback-warning (value-preserving alias)
    expect(midBlock).toContain(
      "background: color-mix(in oklch, var(--feedback-warning) 20%, transparent)",
    );
    expect(midBlock).toContain("color: var(--feedback-warning)");

    const lowBlock = cssBlock(".qi-quality-low {");
    // #1294: --danger → --feedback-danger, --fg → --text-primary (value-preserving aliases)
    expect(lowBlock).toContain(
      "background: color-mix(in oklch, var(--feedback-danger) 22%, transparent)",
    );
    expect(lowBlock).toContain("color: var(--text-primary)");
  });

  it("weak-test flag text stays on primary or muted foreground tokens over a card-tinted surface", () => {
    const flagBlock = cssBlock(".qi-weak-flag {");
    // #1295 value-preserving migration: --danger→--feedback-danger, --card→--surface-primary
    // (pure :root aliases, identical resolved value — the danger-tinted card surface is unchanged).
    expect(flagBlock).toContain(
      "background: color-mix(in oklch, var(--feedback-danger) 10%, var(--surface-primary))",
    );

    const badgeBlock = cssBlock(".qi-weak-flag-badge {");
    expect(badgeBlock).toContain("color: var(--text-primary)");

    const reasonBlock = cssBlock(".qi-weak-flag-reason {");
    expect(reasonBlock).toContain("color: var(--text-secondary)");
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

describe("Issue #1227 — first-run gateway setup responsiveness", () => {
  it(".gw-setup-backdrop uses safe centering and vertical overflow scrolling", () => {
    const block = cssBlock(".gw-setup-backdrop {");
    expect(block).toContain("place-items: safe center");
    expect(block).toContain("overflow-y: auto");
  });

  it(".gw-setup clips scrollbar bleed while the form owns internal scrolling", () => {
    const setupBlock = cssBlock(".gw-setup {");
    expect(setupBlock).toContain("max-height: calc(100vh - 48px)");
    expect(setupBlock).toContain("max-height: calc(100dvh - 48px)");
    expect(setupBlock).toContain("overflow: hidden");

    const formBlock = cssBlock(".gw-form {");
    expect(formBlock).toContain("flex: 1");
    expect(formBlock).toContain("min-height: 0");
    expect(formBlock).toContain("overflow-y: auto");
  });
});

describe("Quality Intelligence source-type picker", () => {
  it("renders the source-type choices as a segmented grid instead of plain inline text", () => {
    const gridBlock = cssBlock(".qi-source-kind-grid {");
    expect(gridBlock).toContain("display: grid");
    expect(gridBlock).toContain("grid-template-columns: repeat(5, minmax(0, 1fr))");
    expect(gridBlock).toContain("gap: 2px");
    expect(gridBlock).toContain("height: 34px");
    // #1294: --card → --surface-primary (value-preserving alias)
    expect(gridBlock).toContain("background: var(--surface-primary)");

    const optionBlock = cssBlock(".qi-source-kind-option {");
    expect(optionBlock).toContain("display: flex");
    expect(optionBlock).not.toContain("flex-direction: column");
    expect(optionBlock).toContain("height: 100%");
    expect(optionBlock).toContain("border: 1px solid transparent");
    expect(optionBlock).toContain("align-items: center");
    expect(optionBlock).toContain("color: var(--text-secondary)");
    expect(optionBlock).toContain("line-height: 1");
  });

  it("prevents source-type labels from overflowing compact buttons", () => {
    const spanBlock = cssBlock(".qi-source-kind-label {");
    expect(spanBlock).toContain("overflow: hidden");
    expect(spanBlock).toContain("text-overflow: ellipsis");
    expect(spanBlock).toContain("white-space: nowrap");
    expect(css).not.toContain(".qi-source-kind-option span:last-child");

    const iconBlock = cssBlock(".qi-source-kind-icon {");
    expect(iconBlock).toContain("display: none");
    expect(iconBlock).toContain("color: currentColor");
    expect(cssBlock(".qi-source-kind-option > span:last-child")).toContain("color: currentColor");
    expect(cssBlock(".qi-source-kind-icon svg {", { fromLast: true })).toContain(
      "stroke-width: 3.1",
    );
    expect(css).toContain("@container (max-width: 620px)");

    const selectedBlock = cssBlock('.qi-source-kind-option[aria-checked="true"] {');
    expect(selectedBlock).toContain("border-color: transparent");
    expect(selectedBlock).toContain("background: transparent");
    expect(selectedBlock).toContain("color: var(--text-primary)");
    expect(selectedBlock).toContain("inset 0 0 0 1.5px");
  });

  it("shows source-type tooltips only in the compact icon state", () => {
    const compactStart = css.indexOf("@container (max-width: 620px)");
    expect(compactStart).toBeGreaterThan(-1);
    const tooltipIdx = css.indexOf(".qi-source-kind-option[data-tip]::after");
    expect(tooltipIdx).toBeGreaterThan(compactStart);
    expect(css.slice(compactStart, tooltipIdx)).toContain(".qi-source-kind-label");
    expect(cssBlock(".qi-source-kind-option[data-tip]::after")).toContain(
      "content: attr(data-tip)",
    );
    expect(css).toContain(".qi-source-kind-option[data-tip]:hover::after");
    expect(css).toContain(".qi-source-kind-option[data-tip]:focus-visible::after");
  });
});

// ─── Fix 4: dense desktop text clarity ───────────────────────────────────────

describe("Fix 4 — dense desktop text clarity", () => {
  it("keeps native font rasterization instead of forcing thin grayscale antialiasing", () => {
    // "body {" pins the element rule; bare "body" now also matches the
    // --text-body* scale tokens consolidated in :root by #1292.
    const bodyBlock = cssBlock("body {");
    expect(bodyBlock).toContain("-webkit-font-smoothing: auto");
    expect(bodyBlock).toContain("-moz-osx-font-smoothing: auto");
    expect(bodyBlock).toContain("text-rendering: auto");
    expect(bodyBlock).not.toContain("-webkit-font-smoothing: antialiased");
    expect(bodyBlock).not.toContain("text-rendering: optimizeLegibility");
  });

  it("keeps code and mono text free of programming-operator ligatures", () => {
    const selectors = [
      ".mono {",
      ".sm-inline-code",
      ".sm-pre",
      ".sm-pre code",
      ".sm-code-line-src",
    ];
    for (const selector of selectors) {
      const block = cssBlock(selector);
      expect(block).toContain("font-variant-ligatures: none");
      expect(block).toContain('"liga" 0');
      expect(block).toContain('"calt" 0');
    }
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
    // #1293: window labels consume the --weight-strong type-scale token
    // (--weight-strong: 650); the resolved weight is byte-identical.
    const titleBlock = cssBlock(".win-title");
    expect(titleBlock).toContain("font-size: 13.5px");
    expect(titleBlock).toContain("font-weight: var(--weight-strong)");

    const subtitleBlock = cssBlock(".win-sub {");
    expect(subtitleBlock).toContain("display: inline-flex");
    expect(subtitleBlock).toContain("align-items: center");
    expect(subtitleBlock).toContain("justify-content: center");
    expect(subtitleBlock).toContain("min-width: 72px");
    expect(subtitleBlock).toContain("font-size: 11.5px");
    expect(subtitleBlock).toContain("font-weight: 560");
    expect(subtitleBlock).toContain("max-width: clamp(128px, 26vw, 260px)");

    const subtitleTextBlock = cssBlock(".win-sub-text");
    expect(subtitleTextBlock).toContain("overflow: hidden");
    expect(subtitleTextBlock).toContain("text-overflow: ellipsis");
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
    // #1293: chip ring consumes --border-subtle (alias of --line-soft); identical.
    expect(chipBlock).toContain("box-shadow: 0 0 0 1px var(--border-subtle) inset");

    // The meaning only whispers on hover: full screen tints accent, close tints
    // danger — always paired with the glyph + the button aria-label, never colour
    // alone.
    // #1293: maximize tints --text-accent, close tints --feedback-danger
    // (aliases of --accent-text / --danger); resolved colours are identical.
    expect(cssBlock(".win-traffic-maximize:hover")).toContain("color: var(--text-accent)");
    expect(cssBlock(".win-traffic-close:hover")).toContain("color: var(--feedback-danger)");

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
    const rowIdx = css.lastIndexOf(".cmp-budget-row");
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
    // #1294: scope-pill ink routes through --text-on-accent (pure --ink-inverse alias)
    expect(block).toContain("outline: var(--focus-width, 2px) solid var(--text-on-accent)");
    expect(block).not.toContain("outline: var(--focus-width, 2px) solid var(--accent)");
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
    const spanIdx = css.indexOf(".tb-tab > span {", marker);
    expect(spanIdx).toBeGreaterThan(-1);
    const block = css.slice(spanIdx, css.indexOf("}", spanIdx) + 1);
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
  it("keeps shell chrome seamless without hard rail cutoff lines", () => {
    expect(cssBlock(".header {")).toContain("border-bottom: 0");
    expect(cssBlock(".footer {")).toContain("border-top: 0");
    // #1293: the rail divider consumes --border-subtle (alias of --line-soft); identical.
    expect(cssBlock(".rail-div {")).toContain(
      "background: color-mix(in oklch, var(--border-subtle) 68%, transparent)",
    );
  });

  it("molds the rails around the rounded workspace canvas", () => {
    // #1293: shell surfaces/radii consume semantic tokens (--space-4=8px,
    // --radius-surface=14px, --background-primary=--bg); resolved values identical.
    const stageBlock = cssBlock(".stage {");
    expect(stageBlock).toContain("gap: 0");
    expect(stageBlock).toContain("padding: var(--space-4)");

    const workspaceBlock = cssBlock(".workspace {");
    expect(workspaceBlock).toContain("border-radius: var(--radius-surface)");
    // AC2: the canvas surface routes through the warm-neutral --background-primary token.
    expect(workspaceBlock).toContain("var(--background-primary)");
    expect(workspaceBlock).toContain("var(--workspace-bg-brightness, 0%)");
    expect(workspaceBlock).not.toContain("color-mix(in oklch, var(--accent) 8%, transparent)");
    expect(workspaceBlock).not.toContain("0 22px 60px");

    expect(cssBlock(".rail-left")).toContain(
      "border-radius: 0 var(--radius-surface) var(--radius-surface) 0",
    );
    expect(cssBlock(".rail-right")).toContain(
      "border-radius: var(--radius-surface) 0 0 var(--radius-surface)",
    );
  });

  it("adds a visible .footer:focus-visible ring (SH-02 Alt+S jump target)", () => {
    // #1293: shell focus rings consume --focus-ring (alias of --accent-text); identical.
    const block = cssBlock(".footer:focus-visible");
    expect(block).toContain("outline: var(--focus-width, 2px) solid var(--focus-ring)");
  });

  it("adds a visible .workspace:focus-visible ring (WC-01 keyboard pan surface)", () => {
    const block = cssBlock(".workspace:focus-visible");
    expect(block).toContain("outline: var(--focus-width, 2px) solid var(--focus-ring)");
  });

  it(".tr-caret-btn:focus-visible keeps a dark separator so it contrasts on accent-dim rows (CC-01)", () => {
    const block = cssBlock(".tr-caret-btn:focus-visible");
    // #1294: --bg → --background-primary (value-preserving alias)
    expect(block).toContain("box-shadow: 0 0 0 1px var(--background-primary)");
  });
});

describe("uiux-fix A11Y — pointer vs keyboard focus modality", () => {
  it("globally suppresses mouse-click focus paint without disabling keyboard focus-visible", () => {
    const block = cssBlock(':root[data-input-modality="pointer"]');
    expect(block).toContain(":focus");
    expect(block).not.toContain(":focus-visible");
    expect(block).toContain("outline: none !important");

    const shadowBlock = cssBlock(
      ':root[data-input-modality="pointer"]\n  :where(button, a, input, textarea, select, [role="button"], [tabindex]:not([tabindex="-1"])):focus:not(',
    );
    expect(shadowBlock).toContain('[aria-pressed="true"]');
    expect(shadowBlock).toContain('[aria-checked="true"]');
    expect(shadowBlock).toContain("box-shadow: none !important");
  });

  it("keeps model dropdown seams direction-aware when opening up or down", () => {
    expect(cssBlock(".cmp-model-select.ksel-trigger-open-down")).toContain(
      "border-bottom-left-radius: 0",
    );
    expect(cssBlock(".cmp-model-select.ksel-trigger-open-up")).toContain(
      "border-top-left-radius: 0",
    );
    expect(cssBlock(".cmp-model-menu.ksel-menu-open-down")).toContain("border-top: none");
    expect(cssBlock(".cmp-model-menu.ksel-menu-open-up")).toContain("border-bottom: none");
    expect(css).not.toContain(".cmp-model-select.ksel-trigger-open {\n");
  });

  it("keeps chat composer ring keyboard-only", () => {
    expect(css).not.toContain(".cmp-box:focus-within {");

    const keyboardBlock = cssBlock(
      ':root[data-input-modality="keyboard"] .cmp-box:has(.cmp-input:focus)',
    );
    expect(keyboardBlock).toContain("border-color: var(--accent-line)");
    expect(keyboardBlock).toContain("0 0 0 3px var(--accent-glow)");

    const pointerBlock = cssBlock(
      ':root[data-input-modality="pointer"] .cmp-box:has(.cmp-input:focus)',
    );
    expect(pointerBlock).toContain("border-color: var(--line)");
    expect(pointerBlock).toContain("box-shadow: var(--shadow-card)");
  });

  it("keeps workflow dialog inputs pointer-neutral while preserving keyboard focus", () => {
    const keyboardBlock = cssBlock(':root[data-input-modality="keyboard"] .wf-dialog-input:focus');
    expect(keyboardBlock).toContain("border-color: var(--accent-line)");

    const pointerBlock = cssBlock(':root[data-input-modality="pointer"] .wf-dialog-input:focus');
    expect(pointerBlock).toContain("outline: none !important");
    expect(pointerBlock).toContain("border-color: var(--line) !important");
  });

  it("keeps chat history rename mouse focus neutral while preserving keyboard focus", () => {
    const keyboardInputBlock = cssBlock(
      ':root[data-input-modality="keyboard"] .chat-history-open:focus-visible,\n:root[data-input-modality="keyboard"] .chat-history-title-input:focus-visible',
    );
    expect(keyboardInputBlock).toContain(
      "outline: var(--focus-width, 2px) solid var(--accent-line)",
    );

    const pointerInputBlock = cssBlock(
      ':root[data-input-modality="pointer"] .chat-history-open:focus,\n:root[data-input-modality="pointer"] .chat-history-title-input:focus',
    );
    expect(pointerInputBlock).toContain("outline: none !important");
    expect(pointerInputBlock).toContain("box-shadow: none !important");

    const pointerRowBlock = cssBlock(
      ':root[data-input-modality="pointer"] .chat-history-row:focus-within',
    );
    // #1295 value-preserving migration (pure :root aliases): --line-soft→--border-subtle,
    // --card→--surface-primary, --line→--border-default. The neutral pointer-focus treatment
    // is unchanged (same resolved values).
    expect(pointerRowBlock).toContain("border-color: var(--border-subtle)");
    expect(pointerRowBlock).toContain("var(--surface-primary) 88%");
    expect(cssBlock(".chat-history-title-input", { fromLast: true })).toContain(
      "border: 1px solid var(--border-default)",
    );
  });

  it("keeps chat model and grounding selects pointer-neutral", () => {
    expect(cssBlock(':root[data-input-modality="pointer"] .cmp-model-select:focus')).toContain(
      "outline: none",
    );
    const groundingBlock = cssBlock(
      ':root[data-input-modality="pointer"] .scope-grounding-select:focus',
    );
    expect(groundingBlock).toContain("box-shadow: none !important");
    expect(groundingBlock).toContain("border-color: var(--line-soft) !important");
  });

  it("keeps the grounding select at its default width in compact chat layouts", () => {
    const baseBlock = cssBlock(".scope-grounding-select");
    expect(baseBlock).toContain("width: 180px");
    expect(baseBlock).toContain("min-width: 180px");

    const compactBlock = cssBlock(".chatw-compact .scope-grounding-select");
    expect(compactBlock).toContain("width: 180px");
    expect(compactBlock).toContain("min-width: 180px");
    expect(compactBlock).toContain("max-width: 180px");

    const minimalBlock = cssBlock(".chatw-minimal .scope-grounding-select");
    expect(minimalBlock).toContain("width: 180px");
    expect(minimalBlock).toContain("min-width: 180px");
    expect(minimalBlock).toContain("max-width: 180px");
  });

  it("keeps QI field focus rings keyboard-only", () => {
    const block = cssBlock(
      ':root[data-input-modality="keyboard"] .qi-input:focus-visible,\n:root[data-input-modality="keyboard"] .qi-textarea:focus-visible,\n:root[data-input-modality="keyboard"] .qi-select:focus-visible',
    );
    expect(block).toContain("outline: var(--focus-width, 2px) solid var(--accent-text)");
    expect(block).toContain("border-color: var(--accent)");
  });

  it("suppresses pointer focus rings on QI text fields", () => {
    const block = cssBlock(
      ':root[data-input-modality="pointer"] .qi-input:focus,\n:root[data-input-modality="pointer"] .qi-textarea:focus,\n:root[data-input-modality="pointer"] .qi-select:focus',
    );
    expect(block).toContain("outline: none !important");
    expect(block).toContain("border-color: var(--line) !important");
    expect(block).toContain("box-shadow: none !important");
  });

  it("suppresses pointer focus rings on dialog and gateway inputs", () => {
    expect(cssBlock(':root[data-input-modality="pointer"] .dlg-input:focus')).toContain(
      "box-shadow: none !important",
    );
    expect(cssBlock(':root[data-input-modality="pointer"] .gw-input:focus')).toContain(
      "box-shadow: none !important",
    );
  });

  it("suppresses pointer focus rings on memory and template manager fields", () => {
    const memoryBlock = cssBlock(':root[data-input-modality="pointer"] .mem-add input:focus');
    expect(memoryBlock).toContain("border-color: var(--line-soft) !important");
    expect(memoryBlock).toContain("box-shadow: none !important");

    const templateBlock = cssBlock(
      ':root[data-input-modality="pointer"] .tm-field input:focus,\n:root[data-input-modality="pointer"] .tm-field select:focus',
    );
    expect(templateBlock).toContain("border-color: var(--line-strong) !important");
    expect(templateBlock).toContain("box-shadow: none !important");
  });

  it("renders connector create actions as buttons, not text links", () => {
    const block = cssBlock(".connector-picker-create-link");
    expect(block).toContain("height: 36px");
    expect(block).toContain("padding: 0 18px");
    expect(block).toContain("border-radius: 10px");
    expect(block).toContain("font-weight: 650");
  });

  it("keeps the bottom-right new-window affordance and palette above workspace windows", () => {
    const fabSelector = ".ws-fab {\n  position: absolute;";
    const fabIdx = css.indexOf(fabSelector);
    expect(fabIdx, "base .ws-fab block not found").toBeGreaterThan(-1);
    const fabBlock = css.slice(fabIdx, css.indexOf("}", fabIdx) + 1);
    expect(fabBlock).toContain("z-index: 1");
    expect(css).toContain("z-index: 14000");
    expect(css).toContain("z-index: 99999");
  });

  it("makes MemoriaViva responsive to its window width, not only viewport width", () => {
    expect(cssBlock(".memoria-window")).toContain("container-type: inline-size");
    expect(css).toContain("@container (max-width: 430px)");
    expect(css).toContain(".memoria-window .lk-header");
    expect(css).toContain("grid-template-columns: 1fr");
    expect(css).toContain("@container (max-width: 360px)");
  });

  it("keeps modal dialog fields keyboard-only and pointer-neutral", () => {
    const keyboardBlock = cssBlock(
      ':root[data-input-modality="keyboard"] .mc-dialog-textarea:focus,\n:root[data-input-modality="keyboard"] .mc-dialog-input:focus,\n:root[data-input-modality="keyboard"] .mc-dialog-select:focus',
    );
    expect(keyboardBlock).toContain("border-color: var(--accent)");
    expect(keyboardBlock).toContain("box-shadow: 0 0 0 2px var(--accent-glow)");

    const pointerBlock = cssBlock(
      ':root[data-input-modality="pointer"] .mc-dialog-textarea:focus,\n:root[data-input-modality="pointer"] .mc-dialog-input:focus,\n:root[data-input-modality="pointer"] .mc-dialog-select:focus',
    );
    expect(pointerBlock).toContain("outline: none !important");
    expect(pointerBlock).toContain("box-shadow: none !important");
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
  it("dark .hl-com uses --text-tertiary (=--fg-dim alias), not the sub-AA #6b7787 (CC-04)", () => {
    const block = cssBlock(".hl-com {");
    // #1295 routed .hl-com to --text-tertiary, a pure :root alias of --fg-dim (the documented
    // 4.57:1 comment token) — same resolved value, so the contrast guarantee is preserved.
    expect(block).toContain("var(--text-tertiary)");
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

  it("settings tab hover does not compete with the selected green line", () => {
    const hoverBlock = cssBlock(".set-tab:hover");
    expect(hoverBlock).not.toContain("box-shadow");

    const selectedBlock = cssBlock('.set-tab[data-on="true"]');
    const activeBlock = cssBlock(".set-tab:active");
    expect(selectedBlock).toContain("box-shadow: inset 0 -2px 0 var(--accent)");
    expect(activeBlock).toContain("box-shadow: inset 0 -2px 0 var(--accent)");
  });

  it("keeps shared dropdown menus proportional to compact trigger buttons", () => {
    const headBlock = cssBlock(".ksel-menu-head");
    expect(headBlock).toContain("min-height: 26px");
    expect(headBlock).toContain("padding: 5px 8px");
    expect(cssBlock(".ksel-menu-scroll")).toContain("padding: 4px");

    const optionBlock = cssBlock(".ksel-option {");
    expect(optionBlock).toContain("min-height: var(--ksel-option-height, 30px)");
    expect(optionBlock).toContain("padding: 4px 7px");
    expect(optionBlock).toContain("font-size: 0.86em");
    expect(optionBlock).toContain("line-height: 1.2");
  });

  it("keeps the QI policy profile select capped while allowing narrow-window shrink", () => {
    const fieldBlock = cssBlock(".qi-policy-profile-field");
    expect(fieldBlock).toContain("flex: 1 1 300px");
    expect(fieldBlock).toContain("min-width: 0");
    expect(fieldBlock).toContain("max-width: 300px");
    expect(fieldBlock).toContain("justify-content: space-between");
    expect(cssBlock(".qi-policy-profile-field > .qi-field-label")).toContain("max-width: 56px");

    const selectBlock = cssBlock(".qi-policy-profile-field .qi-select");
    expect(selectBlock).toContain("width: min(236px, 100%)");
    expect(selectBlock).toContain("min-width: 0");
    expect(selectBlock).toContain("max-width: 236px");
    expect(cssBlock(".qi-number-control")).toContain("flex: 1 1 194px");

    expect(css).toContain(".qi-policy-profile-field {\n    flex: 1 1 300px;");
    expect(cssBlock("select.qi-select")).toContain("background-image:");
  });

  it("keeps the QI policy profile dropdown compact enough for narrow triggers", () => {
    expect(cssBlock(".qi-policy-profile-menu .ksel-menu-head")).toContain("min-height: 24px");
    expect(cssBlock(".qi-policy-profile-menu .ksel-menu-title")).toContain("font-size: 0.62em");

    const optionBlock = cssBlock(".qi-policy-profile-menu .ksel-option");
    expect(optionBlock).toContain("min-height: 28px");
    expect(optionBlock).toContain("font-size: 0.74em");
    expect(optionBlock).toContain("line-height: 1.15");
  });

  it("keeps custom number steppers clickable while preserving the Keiko chevron styling", () => {
    expect(cssBlock(".number-control {")).toContain("--number-stepper-size: 28px");

    const stepperBlock = cssBlock(".number-control-stepper");
    expect(stepperBlock).toContain("display: grid");
    expect(stepperBlock).toContain("top: 4px");
    expect(stepperBlock).toContain("bottom: 4px");
    expect(stepperBlock).not.toContain("pointer-events: none");

    const buttonBlock = cssBlock(".number-control-stepper-button");
    expect(buttonBlock).toContain("appearance: none");
    expect(buttonBlock).toContain("cursor: pointer");

    expect(cssBlock(".number-control-stepper-button::before")).toContain(
      "border-right: 1.5px solid currentColor",
    );
    expect(cssBlock(".number-control-stepper-up::before")).toContain("rotate(225deg)");
    expect(cssBlock(".number-control-stepper-down::before")).toContain("rotate(45deg)");
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
    // #1294: control focus ring → --focus-ring (value-preserving alias of --accent-text)
    expect(block).toContain("outline: var(--focus-width, 2px) solid var(--focus-ring)");
  });

  it(".figma-snapshot-input suppresses mouse-click focus paint while keeping keyboard focus-visible", () => {
    const keyboardBlock = cssBlock(".figma-snapshot-input:focus-visible");
    // #1294: control focus ring → --focus-ring (value-preserving alias of --accent-text)
    expect(keyboardBlock).toContain("outline: var(--focus-width, 2px) solid var(--focus-ring)");

    const pointerBlock = cssBlock(
      ':root[data-input-modality="pointer"] .figma-snapshot-input:focus',
    );
    expect(pointerBlock).toContain("outline: none !important");
    expect(pointerBlock).toContain("box-shadow: none !important");
  });

  it(".figma-snapshot-revoke-btn meets the 24px minimum height (WCAG 2.5.8)", () => {
    const block = cssBlock(".figma-snapshot-revoke-btn,");
    expect(block).toContain("min-height: 24px");
  });

  it(".figma-snapshot-revoke-confirm-btn:focus-visible has an accent outline (WCAG 2.4.7)", () => {
    const block = cssBlock(".figma-snapshot-revoke-btn:focus-visible,");
    // #1294: control focus ring → --focus-ring (value-preserving alias of --accent-text)
    expect(block).toContain("outline: var(--focus-width, 2px) solid var(--focus-ring)");
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
    // #1294: control focus ring → --focus-ring (value-preserving alias of --accent-text)
    expect(block).toContain("outline: var(--focus-width, 2px) solid var(--focus-ring)");
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

  it(".figma-view-json-drag-surface spans the free JSON inspector header area", () => {
    const block = cssBlock(".figma-view-json-drag-surface {");
    expect(block).toContain("flex: 1 1 auto");
    expect(block).toContain("align-self: stretch");
    expect(block).toContain("cursor: grab");
  });

  it(".figma-view-json-code grows with a resized Figma View card", () => {
    const viewBlock = cssBlock(".figma-view-window {");
    const inspectorBlock = cssBlock(".figma-view-json-inspector {");
    const codeBlock = cssBlock(".figma-view-json-code {");
    expect(viewBlock).toContain("height: 100%");
    expect(viewBlock).toContain("min-height: 0");
    expect(inspectorBlock).toContain("flex: 1 1 280px");
    expect(inspectorBlock).toContain("overflow: hidden");
    expect(codeBlock).toContain("flex: 1 1 auto");
    expect(codeBlock).toContain("max-height: none");
    expect(codeBlock).not.toContain("max-height: 360px");
  });

  it(".figma-snapshot-error-card uses the contrast-pinned danger token, not raw red HSL", () => {
    const card = cssBlock(".figma-snapshot-error-card {");
    const title = cssBlock(".figma-snapshot-error-title {");
    const detail = cssBlock(".figma-snapshot-error-detail {");
    // #1295 value-preserving migration: --danger→--feedback-danger, --fg→--text-primary
    // (pure :root aliases — the contrast-pinned danger ink is unchanged).
    expect(card).toContain("var(--feedback-danger)");
    expect(card).not.toMatch(/hsl\(/u);
    expect(title).toContain("color: var(--feedback-danger)");
    expect(detail).toContain("color: var(--text-primary)");
  });
});

// ─── Issue #1193 — editor theme tokens surfaced into the runtime (Addendum 3) ────

describe("Issue #1193 — Keiko Editor theme tokens (#1212) surfaced into the runtime", () => {
  it("surfaces the full 12-type syntax palette as --ed-syn-* custom properties", () => {
    for (const token of [
      "--ed-syn-comment",
      "--ed-syn-string",
      "--ed-syn-number",
      "--ed-syn-constant",
      "--ed-syn-keyword",
      "--ed-syn-type",
      "--ed-syn-function",
      "--ed-syn-property",
      "--ed-syn-variable",
      "--ed-syn-operator",
      "--ed-syn-punct",
      "--ed-syn-regexp",
    ]) {
      expect(css, `${token} must be surfaced into globals.css`).toContain(`${token}:`);
    }
  });

  it("surfaces the editor chrome / diff / ghost-text tokens the Monaco theme maps", () => {
    for (const token of [
      "--ed-bg:",
      "--ed-fg:",
      "--ed-bg-gutter:",
      "--ed-gutter-fg:",
      "--ed-gutter-fg-active:",
      "--ed-line-active:",
      "--ed-cursor:",
      "--ed-selection:",
      "--ed-selection-blur:",
      "--ed-find-match:",
      "--ed-find-match-active:",
      "--ed-focus:",
      "--ed-bracket-match:",
      "--ed-indent-guide:",
      "--ed-indent-guide-active:",
      "--ed-whitespace:",
      "--ed-diff-ins-line:",
      "--ed-diff-ins-text:",
      "--ed-diff-rem-line:",
      "--ed-diff-rem-text:",
      "--ed-diff-ins-gutter:",
      "--ed-diff-rem-gutter:",
      "--ed-error:",
      "--ed-warn:",
      "--ed-info:",
      "--ed-hint:",
      "--ed-ghost:",
      "--ed-suggest-bg:",
      "--ed-suggest-sel:",
      "--ed-suggest-match:",
      "--ed-minimap-bg:",
      "--ed-minimap-slider:",
    ]) {
      expect(css).toContain(token);
    }
  });

  it("extends the base palette rather than forking it (diagnostics reuse status tokens)", () => {
    expect(css).toContain("--ed-error: var(--danger)");
    expect(css).toContain("--ed-warn: var(--warn)");
    expect(css).toContain("--ed-info: var(--info)");
    expect(css).toContain("--ed-ghost: var(--fg-dim)");
  });

  it("surfaces the finalized #1212 tokens (#1232): two-tone focus ring + changed-diff state", () => {
    expect(css).toContain("--ed-focus: var(--accent-text)");
    expect(css).toContain("--ed-focus-inner: var(--ed-bg)");
    expect(css).toContain("--ed-diff-chg-line:");
    expect(css).toContain("--ed-diff-chg-text:");
    expect(css).toContain("--ed-diff-chg-gutter: var(--info)");
  });

  it("provides dark (default), light, and high-contrast editor surfaces from the token source", () => {
    // Scope the assertions to the editor token section + its own prefers-contrast block so the
    // high-contrast values cannot accidentally satisfy the test from :root/[data-theme] (mutation-robust).
    const edStart = css.indexOf("Editor theme tokens (#1212)");
    expect(edStart, "editor token section not found").toBeGreaterThan(-1);
    const edHcStart = css.indexOf("@media (prefers-contrast: more)", edStart);
    expect(edHcStart, "editor HC @media block not found").toBeGreaterThan(-1);

    let depth = 0;
    let edHcEnd = edHcStart;
    let started = false;
    for (let i = css.indexOf("{", edHcStart); i < css.length; i++) {
      if (css[i] === "{") {
        depth++;
        started = true;
      } else if (css[i] === "}") {
        depth--;
      }
      if (started && depth === 0) {
        edHcEnd = i;
        break;
      }
    }
    const edHcBlock = css.slice(edHcStart, edHcEnd + 1);
    const edBeforeHc = css.slice(edStart, edHcStart);

    // dark default + light overrides live before the HC block; HC dark/light live inside it.
    expect(edBeforeHc).toContain("--ed-fg: #c5cdd9"); // dark default (:root)
    expect(edBeforeHc).toContain("--ed-fg: #2b3440"); // [data-theme="light"]
    expect(edHcBlock).toContain("--ed-fg: #ffffff"); // prefers-contrast dark
    expect(edHcBlock).toContain("--ed-fg: #000000"); // prefers-contrast light
  });

  it("provides the explicit [data-hc] high-contrast hook from the design source", () => {
    expect(css).toContain('[data-hc="more"]');
    expect(css).toContain('[data-hc="more"][data-theme="light"]');
    expect(css).toContain("--ed-syn-keyword: #d8b6ff");
    expect(css).toContain("--ed-syn-keyword: #6f1b96");
  });
});

describe("Issue #1205 — editor tab truncation", () => {
  it("keeps the tab strip shrinkable inside compact editor cards", () => {
    expect(cssBlock(".ed-tabs {")).toContain("min-width: 0");
    expect(cssBlock(".ed-tablist {")).toContain("min-width: min(160px, 100%)");
    expect(cssBlock(".ed-tablist {")).toContain("overflow: visible");
  });

  it("truncates long editor tab labels instead of expanding the header", () => {
    for (const selector of [".ed-tab {", ".ed-tab-label {"]) {
      const block = cssBlock(selector);
      expect(block).toContain("min-width: 0");
      expect(block).toContain("overflow: hidden");
      expect(block).toContain("white-space: nowrap");
      expect(block).toContain("text-overflow: ellipsis");
    }
  });

  it("lets the compact hidden-tab chooser escape clipped split panes while open", () => {
    const overflowBlock = cssBlock(".editor-workspace:has(.ed-tab-summary-menu[open]) .ed-pane,");
    expect(overflowBlock).toContain(".ed-pane .editor");
    expect(overflowBlock).toContain("overflow: visible");

    const stackingBlock = cssBlock(
      ".editor-workspace:has(.ed-tab-summary-menu[open]) .ed-pane:has(.ed-tab-summary-menu[open])",
    );
    expect(stackingBlock).toContain("position: relative");
    expect(stackingBlock).toContain("z-index: var(--z-overlay)");
  });
});

describe("Issue #1424 — editor Monaco hover chrome", () => {
  it("skins diagnostic hovers with Keiko popover tokens inside an editor container query", () => {
    const hostBlock = cssBlock(".ed-host {");
    expect(hostBlock).toContain("container-type: inline-size");
    expect(hostBlock).toContain(
      "--ed-hover-max-width: min(520px, calc(100vw - 24px), calc(100cqw - 24px))",
    );

    const compactViewportBlock = cssRuleFrom(css, "@media (max-width: 800px)");
    expect(compactViewportBlock).toContain(
      "--ed-hover-max-width: min(280px, calc(100vw - 128px), calc(100cqw - 24px))",
    );

    const hoverFrameBlock = cssBlock(".ed-host .monaco-editor .monaco-resizable-hover,");
    expect(hoverFrameBlock).toContain("max-width: var(--ed-hover-max-width) !important");
    expect(hoverFrameBlock).toContain("overflow: hidden");

    const resizableHoverBlock = cssBlock(".ed-host .monaco-editor .monaco-resizable-hover {");
    expect(resizableHoverBlock).toContain("border: 1px solid var(--popover-border) !important");
    expect(resizableHoverBlock).toContain("border-radius: var(--radius-floating) !important");
    expect(resizableHoverBlock).toContain("background: var(--surface-primary) !important");
    expect(resizableHoverBlock).toContain("box-shadow: var(--popover-shadow)");

    const monacoHoverBlock = cssBlock(".ed-host .monaco-editor .monaco-hover {", {
      fromLast: true,
    });
    expect(monacoHoverBlock).toContain("color: var(--text-primary) !important");
    expect(monacoHoverBlock).toContain("font-size: var(--text-body-sm)");
    expect(monacoHoverBlock).toContain("line-height: var(--leading-normal)");
  });

  it("wraps Monaco hover content and action rows instead of letting browser-sized panels clip", () => {
    const contentBlock = cssBlock(".ed-host .monaco-editor .monaco-hover .monaco-hover-content,", {
      fromLast: true,
    });
    expect(contentBlock).toContain("white-space: normal !important");
    expect(contentBlock).toContain("overflow-wrap: anywhere");

    const codeBlock = cssBlock(".ed-host .monaco-editor .monaco-hover code,");
    expect(codeBlock).toContain("white-space: pre-wrap");
    expect(codeBlock).toContain("overflow-wrap: anywhere");
    expect(codeBlock).toContain("background: var(--surface-inset) !important");

    const actionsBlock = cssBlock(".ed-host .monaco-editor .monaco-hover .hover-row .actions {");
    expect(actionsBlock).toContain("flex-wrap: wrap");
    expect(actionsBlock).toContain("border-top: 1px solid var(--border-subtle)");
    expect(actionsBlock).toContain("background: var(--surface-secondary) !important");
  });

  it("skins Monaco copy affordances and nested copy tooltips with Keiko feedback states", () => {
    const copyButtonBlock = cssBlock(".ed-host .monaco-editor .monaco-hover .hover-copy-button {");
    expect(copyButtonBlock).toContain("border: 1px solid transparent");
    expect(copyButtonBlock).toContain("border-radius: var(--radius-control)");
    expect(copyButtonBlock).toContain("background: transparent");
    expect(copyButtonBlock).toContain("color: var(--text-secondary)");
    expect(copyButtonBlock).toContain("opacity: 1");
    expect(copyButtonBlock).toContain("box-shadow: none");

    const copyIconBlock = cssBlock(
      ".ed-host .monaco-editor .monaco-hover .hover-copy-button.codicon,",
    );
    expect(copyIconBlock).toContain("color: currentColor !important");

    const copyHoverBlock = cssBlock(
      ".ed-host .monaco-editor .monaco-hover .hover-copy-button:hover {",
    );
    expect(copyHoverBlock).toContain(
      "background: color-mix(in oklch, var(--text-primary) 10%, transparent) !important",
    );
    expect(copyHoverBlock).toContain("border-color: transparent");
    expect(copyHoverBlock).toContain("color: var(--text-primary)");
    expect(copyHoverBlock).toContain(
      "box-shadow: 0 8px 18px -14px rgb(var(--shadow-ink-rgb) / 0.85)",
    );
    expect(copyHoverBlock).not.toContain("var(--border-accent)");
    expect(copyHoverBlock).not.toContain("var(--text-accent)");

    const copyActiveBlock = cssBlock(
      ".ed-host .monaco-editor .monaco-hover .hover-copy-button:active {",
    );
    expect(copyActiveBlock).toContain("transform: translateY(1px) scale(0.98)");
    expect(copyActiveBlock).toContain(
      "background: var(--button-secondary-surface-hover) !important",
    );

    const workbenchHoverBlock = cssBlock(".monaco-hover.workbench-hover {");
    expect(workbenchHoverBlock).toContain("max-width: min(220px, calc(100vw - 24px))");
    expect(workbenchHoverBlock).toContain("border: 1px solid var(--popover-border) !important");
    expect(workbenchHoverBlock).toContain("border-radius: var(--radius-control) !important");
    expect(workbenchHoverBlock).toContain("background: var(--surface-primary) !important");
    expect(workbenchHoverBlock).toContain("box-shadow: var(--popover-shadow) !important");

    const workbenchPointerBlock = cssBlock(".workbench-hover-pointer:after {");
    expect(workbenchPointerBlock).toContain("background-color: var(--surface-primary) !important");
    expect(workbenchPointerBlock).toContain(
      "border-right: 1px solid var(--popover-border) !important",
    );
  });
});

// ─── Issue #1292 — runtime token consolidation + Light Mode foundations ───────
//
// #1292 is the foundation gate of the Design System epic (#1290, blueprint
// #1291). It lands the design-system's middle + top token tiers into the live
// product stylesheet (the single emitted globals.css) as aliases over the
// existing Tier-1 primitives, adds the two missing primitives (--grid-dot,
// --focus-w), and completes the neutral high-contrast + forced-colors mode
// blocks. Every assertion is crafted so that reverting the specific change makes
// the test fail (mutation-robust), per the suite's contract.

/** Brace-aware slice of the rule/at-rule beginning at the first `selector`. */
function cssRuleFrom(
  source: string,
  selector: string,
  opts: { readonly fromIndex?: number } = {},
): string {
  const start = source.indexOf(selector, opts.fromIndex ?? 0);
  expect(start, `selector "${selector}" not found`).toBeGreaterThan(-1);
  let depth = 0;
  let started = false;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      started = true;
    } else if (source[i] === "}") {
      depth--;
    }
    if (started && depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated rule for "${selector}"`);
}

function cssRule(selector: string, opts: { readonly fromIndex?: number } = {}): string {
  return cssRuleFrom(css, selector, opts);
}

describe("Issue #1292 — Tier-2 scale tokens consolidated into the product", () => {
  it("adds the spacing, radius, weight, leading and type-size scales", () => {
    for (const decl of [
      "--space-0: 0",
      "--space-4: 8px",
      "--space-8: 24px",
      "--space-16: 96px",
      "--radius-pill: 999px",
      "--radius-control: var(--radius-sm)",
      "--radius-surface: var(--radius)",
      "--radius-floating: var(--radius-lg)",
      "--weight-regular: 400",
      "--weight-strong: 650",
      "--leading-normal: 1.5",
      "--text-caption: 11px",
      "--text-body: 14px",
      "--text-display: 50px",
    ]) {
      expect(css, `${decl} must be consolidated into globals.css`).toContain(decl);
    }
  });

  it("adds the opacity, blur, motion and named z-index scales (closing the raw-z gap)", () => {
    for (const decl of [
      "--opacity-disabled: 0.42",
      "--opacity-scrim: 0.55",
      "--blur-md: 12px",
      "--dur-base: 180ms",
      "--ease-standard: cubic-bezier(0.2, 0, 0.2, 1)",
      "--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)",
      "--z-base: 0",
      "--z-modal: 300",
      "--z-popover: 400",
      "--z-tooltip: 600",
      "--shell-rail-width: 50px",
    ]) {
      expect(css, `${decl} must be consolidated into globals.css`).toContain(decl);
    }
  });
});

describe("Issue #1292 — Tier-3 semantic aliases resolve to primitives", () => {
  it("maps every semantic family onto an existing Tier-1 primitive (extend, not fork)", () => {
    for (const decl of [
      "--background-primary: var(--bg)",
      "--surface-primary: var(--card)",
      "--surface-inset: var(--inset)",
      "--text-primary: var(--fg)",
      "--text-secondary: var(--fg-muted)",
      "--text-inverse: var(--ink-inverse)",
      "--text-accent: var(--accent-text)",
      "--border-default: var(--line)",
      "--action-primary: var(--accent)",
      "--feedback-success: var(--ok)",
      "--feedback-danger: var(--danger)",
      "--focus-ring: var(--accent-text)",
      "--focus-width: var(--focus-w)",
      "--selection-surface: var(--accent-glow)",
    ]) {
      expect(css, `${decl} must resolve to a primitive`).toContain(decl);
    }
  });

  it("derives the feedback + overlay surfaces from primitives via color-mix/opacity", () => {
    expect(css).toContain(
      "--feedback-warning-surface: color-mix(in oklch, var(--warn) 12%, transparent)",
    );
    expect(css).toContain("--overlay-scrim: oklch(0 0 0 / var(--opacity-scrim))");
  });
});

describe("Issue #1292 — Tier-4 component aliases resolve to primitives", () => {
  it("maps representative component tokens across button/input/card/modal/ai/table/nav", () => {
    for (const decl of [
      "--button-primary-surface: var(--accent)",
      "--button-primary-text: var(--ink-inverse)",
      "--input-surface: var(--inset)",
      "--input-border-focus: var(--accent-line)",
      "--card-surface: var(--card)",
      "--card-shadow: var(--shadow-card)",
      "--modal-backdrop: var(--overlay-scrim)",
      "--popover-shadow: var(--shadow-pop)",
      "--ai-thinking-indicator: var(--accent-text)",
      "--ai-permission-surface: var(--feedback-warning-surface)",
      "--table-row-surface-selected: var(--accent-dim)",
      "--nav-item-indicator: var(--accent-text)",
    ]) {
      expect(css, `${decl} must resolve to a primitive`).toContain(decl);
    }
  });
});

describe("Issue #1292 — new Tier-1 primitives across every mode", () => {
  it("defines --grid-dot and --focus-w in the dark default :root", () => {
    const root = cssRule(":root {");
    expect(root).toContain("--grid-dot: oklch(0.34 0.005 160)");
    expect(root).toContain("--focus-w: 2px");
  });

  it("retones --grid-dot for Light Mode", () => {
    const light = cssRule('[data-theme="light"] {');
    expect(light).toContain("--grid-dot: oklch(0.78 0.012 160)");
  });

  it("thickens --focus-w and brightens --grid-dot under prefers-contrast (dark + light)", () => {
    const block = cssRule("@media (prefers-contrast: more) {");
    // dark branch
    expect(block).toContain("--grid-dot: oklch(0.52 0.006 160)");
    // both dark and light branches bump the ring to 3px
    expect((block.match(/--focus-w: 3px/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // light branch
    expect(block).toContain("--grid-dot: oklch(0.6 0.01 160)");
  });
});

describe("Issue #1292 — full [data-hc] hook (previously editor-only)", () => {
  it("steps the product palette on the in-app [data-hc] override, not just --ed-* tokens", () => {
    // The first [data-hc="more"] block in the file is the product palette; the
    // editor block (which sets --ed-* tokens) comes later. Asserting surface,
    // text, status and focus declarations proves the non-editor hook now exists.
    const block = cssRule('[data-hc="more"] {');
    expect(block).toContain("--bg: oklch(0.11 0.004 160)");
    expect(block).toContain("--line: oklch(0.62 0.006 160)");
    expect(block).toContain("--fg-faint: oklch(0.82 0.004 160)");
    expect(block).toContain("--warn: oklch(0.88 0.14 80)");
    expect(block).toContain("--grid-dot: oklch(0.52 0.006 160)");
    expect(block).toContain("--focus-w: 3px");
    expect(block, "neutral block must not be the editor block").not.toContain("--ed-");
  });

  it("steps the product palette for the light + in-app high-contrast pairing", () => {
    const block = cssRule('[data-hc="more"][data-theme="light"] {');
    expect(block).toContain("--bg: oklch(1 0 0)");
    expect(block).toContain("--line: oklch(0.45 0.008 160)");
    expect(block).toContain("--fg-faint: oklch(0.36 0.012 160)");
    expect(block).toContain("--warn: oklch(0.38 0.14 75)");
    expect(block).toContain("--grid-dot: oklch(0.6 0.01 160)");
    expect(block).toContain("--focus-w: 3px");
    expect(block).not.toContain("--ed-");
  });
});

describe("Issue #1292 — focus rings consume the focus-width primitive", () => {
  it("routes normal focus-visible outlines through --focus-width while preserving colour tokens", () => {
    expect(css).toContain("outline: var(--focus-width, 2px) solid var(--accent-text)");
    // #1294: control focus rings now route the colour through --focus-ring /
    // --input-border-error (value-preserving aliases of the ink-inverse / danger
    // primitives pinned here at #1292 time; --accent-text survives on non-control rings).
    expect(css).toContain("outline: var(--focus-width, 2px) solid var(--focus-ring)");
    expect(css).toContain("outline: var(--focus-width, 2px) solid var(--input-border-error)");
    expect(css).not.toMatch(
      /outline:\s*\d+px solid var\(--(?:accent-text|accent-line|ink-inverse|danger|focus)\)/,
    );
  });
});

describe("Issue #1292 — forced-colors fallback (WCAG 1.4.3 / Windows High Contrast)", () => {
  it("surfaces the focus ring and card/window/dialog edges in the system palette", () => {
    const block = cssRule("@media (forced-colors: active) {");
    expect(block).toContain("outline: 3px solid Highlight");
    expect(block).toContain("border: 1px solid CanvasText");
    // targets the product's real container surfaces, not the reference site's classes
    expect(block).toContain(".window");
    expect(block).toContain(".dlg");
  });
});

describe("Issue #1292 — design-system token drift gate", () => {
  function referenceCss(relativePath: string): string {
    return readFileSync(resolve(here, relativePath), "utf8");
  }

  /** Collect every custom-property *declaration* name from a design-system file. */
  function referenceTokenNames(relativePath: string): Set<string> {
    const refCss = referenceCss(relativePath);
    // Strip block comments so prose like "--background-primary" cannot register.
    const declarations = refCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const names = new Set<string>();
    for (const match of declarations.matchAll(/(--[a-z0-9-]+)\s*:/g)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
    return names;
  }

  /** Collect direct token declarations from one concrete rule. */
  function declarationMap(source: string, selector: string): Record<string, string> {
    const rule = cssRuleFrom(source, selector).replace(/\/\*[\s\S]*?\*\//g, "");
    const entries: Array<[string, string]> = [];
    for (const match of rule.matchAll(/^\s*(--[a-z0-9-]+|color-scheme)\s*:\s*([^;]+);/gm)) {
      const name = match[1];
      const value = match[2];
      if (name !== undefined && value !== undefined) entries.push([name, value.trim()]);
    }
    return Object.fromEntries(entries);
  }

  it("defines every Tier-2/3/4 token the design-system reference declares (no drift)", () => {
    const names = referenceTokenNames("../../../../design-system/keiko-semantic-tokens.css");
    expect(names.size, "expected the reference to declare the full token set").toBeGreaterThan(150);
    const missing = [...names].filter((name) => !css.includes(`${name}:`));
    expect(
      missing,
      `globals.css is missing design-system tokens (drift): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("defines every Tier-1 primitive the design-system reference declares (AC1, no drift)", () => {
    // AC1 names design-system/keiko-tokens.css explicitly: every primitive the
    // reference carries must exist in the live product source.
    const names = referenceTokenNames("../../../../design-system/keiko-tokens.css");
    expect(names.size, "expected the reference to declare the primitive set").toBeGreaterThan(25);
    const missing = [...names].filter((name) => !css.includes(`${name}:`));
    expect(
      missing,
      `globals.css is missing design-system primitives (drift): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("matches the design-system high-contrast primitive values for OS prefers-contrast", () => {
    const reference = referenceCss("../../../../design-system/keiko-tokens.css");
    const referenceMedia = cssRuleFrom(reference, "@media (prefers-contrast: more) {");
    const productMedia = cssRule("@media (prefers-contrast: more) {");

    expect(declarationMap(productMedia, ":root {")).toEqual(
      declarationMap(referenceMedia, ":root {"),
    );
    expect(declarationMap(productMedia, '[data-theme="light"] {')).toEqual(
      declarationMap(referenceMedia, '[data-theme="light"] {'),
    );
  });

  it("matches the design-system high-contrast primitive values for the in-app [data-hc] hook", () => {
    const reference = referenceCss("../../../../design-system/keiko-tokens.css");

    expect(declarationMap(css, '[data-hc="more"] {')).toEqual(
      declarationMap(reference, '[data-hc="more"] {'),
    );
    expect(declarationMap(css, '[data-hc="more"][data-theme="light"] {')).toEqual(
      declarationMap(reference, '[data-hc="more"][data-theme="light"] {'),
    );
  });
});

// ─── Issue #1293 — global shell + workspace chrome token migration ─────────────
//
// #1293 is the first consumer migration after #1292 landed the Tier-2/3/4 tokens.
// It routes the always-on shell — header, footer, rails, workspace canvas, window
// chassis, traffic controls, connection chrome, and the install banner — through
// the semantic (Tier-3) and component (Tier-4) tokens instead of raw primitives
// and raw scale literals. Every alias resolves to the same primitive #1292 added,
// so the migration is value-preserving in every mode (proven byte-identical by the
// 7-mode computed-value harness in docs/design-system/evidence/1293/). Each
// assertion is paired with a negative so reverting an alias re-fails the test.
describe("Issue #1293 — global shell + workspace chrome token migration", () => {
  // AC3 — window chrome matches the design-system card component anatomy.
  it("routes the window chassis through the card component tokens (AC3)", () => {
    // newline-anchored: ".window {" alone matches ".workspace .window {" first.
    const win = cssBlock("\n.window {");
    expect(win).toContain("background: var(--card-surface)");
    expect(win).toContain("border: 1px solid var(--card-border)");
    expect(win).toContain("box-shadow: var(--card-shadow)");
    expect(win).toContain("border-radius: var(--radius-surface)");
    // raw primitives must be gone (a revert re-fails).
    expect(win).not.toContain("var(--card)");
    expect(win).not.toContain("var(--line)");
    expect(win).not.toContain("var(--shadow-card)");

    const top = cssBlock('.window[data-top="true"] {');
    expect(top).toContain("box-shadow: var(--card-shadow-raised)");
    expect(top).toContain("border-color: var(--border-strong)");
    expect(top).not.toContain("var(--shadow-pop)");
    expect(top).not.toContain("var(--line-strong)");
  });

  // AC2 — Light Mode shell surfaces use the off-white / warm-neutral hierarchy via
  // the adaptive surface/background tokens (not generic white/gray fallbacks).
  it("routes shell surfaces through the semantic surface/background tokens (AC2)", () => {
    expect(cssBlock(".rail {")).toContain("background: var(--nav-surface)");
    expect(cssBlock(".rail {")).not.toContain("background: var(--surface)");

    const ws = cssBlock(".workspace {");
    expect(ws).toContain("border-radius: var(--radius-surface)");
    expect(ws).toContain("var(--background-primary)");
    expect(ws).toContain("var(--border-subtle)");

    expect(cssBlock(".header {")).toContain("var(--background-secondary)");
    expect(cssBlock(".footer {")).toContain("var(--background-secondary)");

    const banner = cssBlock(".install-banner {");
    expect(banner).toContain("background: var(--surface-primary)");
    expect(banner).toContain("border: 1px solid var(--border-default)");
    expect(banner).toContain("box-shadow: var(--card-shadow-raised)");
    expect(banner).not.toContain("var(--card)");
    expect(banner).not.toContain("var(--shadow-pop)");
  });

  // AC3 — shell focus treatment consumes the --focus-ring semantic token.
  it("routes workspace-chrome focus rings through --focus-ring (AC3)", () => {
    const group = cssRule(".win-btn:focus-visible,");
    expect(group).toContain("outline: var(--focus-width, 2px) solid var(--focus-ring)");
    expect(group).not.toContain("solid var(--accent-text)");
    // primary nav rail keeps a visible, tokenised focus ring too.
    const rail = cssRule(".rail-btn:focus-visible,\n.rail-new:focus-visible,\n.rail-avatar");
    expect(rail).toContain("solid var(--focus-ring)");
  });

  // AC3 — the primary navigation rail consumes the nav component tokens.
  it("routes the active rail item through the nav component tokens (AC3)", () => {
    const active = cssBlock('.rail-btn[data-active="true"] {');
    expect(active).toContain("background: var(--nav-item-surface-active)");
    expect(active).toContain("color: var(--nav-item-indicator)");
    expect(active).not.toContain("var(--card)");
  });

  // AC1 — migrated scopes no longer depend on raw scale literals (z-index, spacing,
  // type, radius, motion) where a token exists; they consume the Tier-2 scales.
  it("adopts the named z-index, spacing and radius scales in the shell (AC1)", () => {
    expect(cssBlock(".ws-shader {")).toContain("z-index: var(--z-base)");
    expect(cssBlock(".stage {")).toContain("z-index: var(--z-base)");
    expect(cssBlock(".conn-layer {")).toContain("z-index: var(--z-base)");
    expect(cssBlock(".win-port {")).toContain("z-index: var(--z-canvas-window-active)");
    expect(cssBlock(".rail {")).toContain("z-index: var(--z-rail)");
    expect(cssBlock(".rail {")).toContain("width: var(--shell-rail-width)");
    expect(cssRule(".rail:has(")).toContain("z-index: var(--z-nav)");
    expect(cssBlock(".footer {")).toContain("z-index: var(--z-sticky)");
    expect(cssBlock(".stage {")).toContain("padding: var(--space-4)");
    expect(cssBlock(".ws-zoom {")).toContain("backdrop-filter: blur(var(--blur-md))");
    expect(cssBlock(".ft-gov {")).toContain("border-radius: var(--radius-pill)");
  });

  // AC1 — positive pins for the canonical (non-responsive) window-head/title rules.
  // The bare ".win-head {" / ".win-title {" substrings match the @media(max-width:680px)
  // responsive copies first; newline-anchoring selects the canonical base rule so a
  // revert of the colour/border migration there still fails.
  it("pins the canonical window-head/title migrations (AC1, AC3)", () => {
    expect(cssBlock("\n.win-head {")).toContain("border-bottom: 1px solid var(--border-subtle)");
    expect(cssBlock("\n.win-title {")).toContain("color: var(--text-primary)");
  });

  // AC1 — scope-wide, mutation-robust drift guard. Instead of a hand-maintained
  // selector allowlist (which can silently miss un-migrated rules), this parses EVERY
  // CSS rule, keeps the ones whose every comma-separated selector is a shell/chrome
  // selector (base rules + responsive @media copies), and asserts none carries a raw
  // primitive that has a value-preserving semantic/component alias. The accent-family
  // primitives (--accent / --accent-line / --accent-dim / --accent-glow / --accent-bright)
  // are intentionally kept (no neutral alias exists) and are NOT in the forbidden list.
  // The 8 [data-theme="light"] shell overrides are approved deviations and are excluded.
  it("leaves no raw aliased primitives in any pure-shell rule (AC1, scope-wide)", () => {
    const forbidden = [
      "var(--card)",
      "var(--card-2)",
      "var(--inset)",
      "var(--fg)",
      "var(--fg-muted)",
      "var(--fg-dim)",
      "var(--fg-faint)",
      "var(--line)",
      "var(--line-soft)",
      "var(--line-strong)",
      "var(--shadow-card)",
      "var(--shadow-pop)",
      "var(--ink-inverse)",
      "var(--surface)",
      "var(--bg)",
      "var(--accent-text)",
      "var(--danger)",
      "var(--warn)",
      "var(--info)",
      "var(--ok)",
    ];
    const shellLead =
      /^\.(header|hd-|footer|ft-|stage|workspace|ws-|rail|win|window|tb-|conn-|install-banner|empty-workspace)/;
    const source = css.replace(/\/\*[\s\S]*?\*\//g, ""); // strip comments
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    let shellRulesChecked = 0;
    const offenders: string[] = [];
    while ((match = ruleRe.exec(source)) !== null) {
      const selector = (match[1] ?? "").trim().replace(/\s+/g, " ");
      const body = match[2] ?? "";
      if (selector === "" || /^(@|:root|html|body|\*|#)/.test(selector)) continue;
      if (selector.includes('[data-theme="light"]')) continue; // approved deviations
      const parts = selector
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length === 0) continue;
      // a rule qualifies only if EVERY comma-part leads with a shell class (mixed
      // groups that also style #1294/#1295 selectors are intentionally left untouched)
      const pureShell = parts.every((p) => {
        const lead = p.replace(/^[>+~\s]+/, "");
        return shellLead.test(lead) && !lead.startsWith(".connector");
      });
      if (!pureShell) continue;
      shellRulesChecked++;
      for (const raw of forbidden) {
        if (body.includes(raw)) offenders.push(`${selector} { … ${raw} … }`);
      }
    }
    // sanity: the parser must actually find a substantial number of shell rules.
    expect(shellRulesChecked).toBeGreaterThan(60);
    expect(
      offenders,
      `pure-shell rules still carry raw aliased primitives (migrate to the semantic token):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// ─── Issue #1294 — reusable controls + component primitives token migration ────
//
// #1294 is the component-primitive consumer migration (after #1293's shell/chrome).
// It routes the reusable controls — buttons, icon buttons, fields, selects, toggles,
// steppers, tabs, menus, badges, chips, pills, toasts, alerts, composer controls,
// cards, dialogs, popovers, tooltips, tree/command rows — through the 0.4.0
// semantic/component tokens instead of raw primitives. Value-preserving: every target
// token aliases the primitive it replaced (proven byte-identical by the 7-mode
// computed-value harness in docs/design-system/evidence/1294). Each assertion is
// crafted so that reverting the specific change fails the test (mutation-robust); the
// negative pins guard the wrong-token-by-value traps the scope-wide guard cannot see.
describe("Issue #1294 — reusable controls + component primitives token migration", () => {
  // AC: primary/accent buttons route their ink to the component token; the accent FILL
  // is a brand primitive and is intentionally kept.
  it("routes primary buttons through --button-primary-text (keeps the accent fill)", () => {
    const block = cssBlock("\n.dlg-primary {");
    expect(block).toContain("color: var(--button-primary-text)");
    expect(block).not.toContain("var(--ink-inverse)");
  });

  // AC: secondary/bordered buttons consume the full secondary token set.
  it("routes secondary buttons through --button-secondary-* / --text-secondary", () => {
    const block = cssBlock("\n.dlg-btn {");
    expect(block).toContain("background: var(--button-secondary-surface)");
    expect(block).toContain("var(--button-secondary-border)");
    expect(block).toContain("color: var(--text-secondary)");
    expect(block).not.toMatch(/var\(--card\)|var\(--line\)|var\(--fg-muted\)/);
  });

  // AC: danger affordances consume --feedback-danger; never the bare primitive.
  it("routes danger affordances through --feedback-danger", () => {
    const block = cssBlock("\n.bw-btn-danger {");
    expect(block).toContain("var(--feedback-danger)");
    expect(block).not.toMatch(/var\(--danger\)/);
  });

  // AC + R1 trap (d): input chrome consumes --input-*, but the placeholder is the
  // fg-faint→--text-faint case, NOT --input-placeholder (=fg-muted, a different value).
  it("routes inputs through --input-* and the placeholder through --text-faint (trap d)", () => {
    const field = cssBlock("\n.dlg-input {");
    expect(field).toContain("var(--input-surface)");
    expect(field).toContain("var(--input-border)");
    const ph = cssBlock(".dlg-input::placeholder");
    expect(ph).toContain("color: var(--text-faint)");
    expect(ph).not.toContain("--input-placeholder");
  });

  // AC: command palette / popover surfaces consume the popover token chain.
  it("routes the command palette through the --popover-* chain", () => {
    const block = cssBlock("\n.cmdk {");
    expect(block).toContain("var(--popover-surface)");
    expect(block).toContain("var(--popover-border)");
    expect(block).toContain("var(--popover-shadow)");
  });

  // R1 trap (b): dialog/modal panels consume --surface-overlay, NOT --modal-surface
  // (=card, a different value); tooltips consume --surface-primary, NOT --tooltip-surface.
  it("uses --surface-overlay for dialogs and --surface-primary for tooltips (trap b)", () => {
    const dlg = cssBlock("\n.dlg {");
    expect(dlg).toContain("background: var(--surface-overlay)");
    expect(dlg).not.toContain("--modal-surface");
    const tip = cssBlock("\n.ksel-overflow-tooltip {");
    expect(tip).toContain("background: var(--surface-primary)");
    expect(tip).not.toContain("--tooltip-surface");
  });

  // R1 trap (c): menu-item/option hover surfaces consume --surface-elevated, NOT
  // --menu-item-surface-hover (=card, a different value).
  it("uses --surface-elevated for menu-item hover (trap c)", () => {
    const block = cssBlock("\n.edm-item:hover {");
    expect(block).toContain("background: var(--surface-elevated)");
    expect(block).not.toContain("--menu-item-surface-hover");
  });

  // AC: focus rings on controls consume the --focus-ring semantic token. The scope-pill
  // ink uses --text-on-accent (a pure --ink-inverse alias), NEVER --accent-solid-ink
  // (which carries its own Light override → would diverge in Light; harness-proven trap).
  it("routes control focus rings through --focus-ring and keeps scope-pill ink value-preserving", () => {
    const focus = cssRule(".dlg-btn:focus-visible");
    expect(focus).toContain("solid var(--focus-ring)");
    const pill = cssBlock("\n.scope-pill {");
    expect(pill).toContain("color: var(--text-on-accent)");
    expect(pill).not.toContain("--accent-solid-ink");
  });

  it("does not leave undefined --focus references in reusable-control focus states", () => {
    expect(css).not.toContain("var(--focus)");

    const jsonButtonFocus = cssBlock(".figma-view-json-btn:focus-visible,");
    expect(jsonButtonFocus).toContain("outline: var(--focus-width, 2px) solid var(--focus-ring)");

    const previewDragFocus = cssBlock(".figma-view-preview-drag-surface:focus-visible");
    expect(previewDragFocus).toContain("outline: var(--focus-width, 2px) solid var(--focus-ring)");

    const errorNoticeCloseFocus = cssBlock(".ui-error-notice-close:focus-visible");
    expect(errorNoticeCloseFocus).toContain("border-color: var(--focus-ring)");
    expect(errorNoticeCloseFocus).toContain(
      "box-shadow: 0 0 0 2px color-mix(in oklch, var(--focus-ring) 24%, transparent)",
    );
  });

  // AC (ds-040) — completeness gate for #1294's scope: scope-wide component drift guard.
  // Parses EVERY CSS rule and, for those whose selector matches a reusable-control class
  // PREFIX (the controlLead classifier below — a semantic prefix set, NOT a hardcoded
  // per-selector allowlist, which is the form the #1293 review mutation-proved tautological),
  // asserts none still carries a raw aliased primitive. Same prefix-classifier shape as the
  // enumerator that drove the migration (worklist == guard). It is mutation-robust for every
  // reusable-control rule it covers (reverting one migrated declaration yields exactly one
  // offender). It does NOT police rules outside the reusable-control scope — route/layout/
  // window chrome (e.g. .memoria-window, .lkd-* panels, .rv-* run-viewer) still carry raw
  // primitives by design; those belong to later epic children, not #1294.
  it("leaves no raw aliased primitives in any reusable-control rule (ds-040, scope-wide)", () => {
    const forbidden = [
      "--card",
      "--card-2",
      "--inset",
      "--fg",
      "--fg-muted",
      "--fg-dim",
      "--fg-faint",
      "--line",
      "--line-soft",
      "--line-strong",
      "--shadow-card",
      "--shadow-pop",
      "--ink-inverse",
      "--surface",
      "--bg",
      "--accent-text",
      "--danger",
      "--warn",
      "--info",
      "--ok",
    ];
    // Escape every regex metacharacter (incl. backslash) before interpolating the token
    // into the pattern — addresses CodeQL "incomplete string escaping" (the prior
    // `replace(/-/g, "\\-")` escaped only the hyphen).
    const escapeRegExp = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bodyForbidden = (body: string): readonly string[] =>
      forbidden.filter((tok) => new RegExp(`var\\(\\s*${escapeRegExp(tok)}\\s*[),]`).test(body));
    const shellLead =
      /^\.(header|hd-|footer|ft-|stage|workspace|ws-|rail|win|window|tb-|conn-|install-banner|empty-workspace)/;
    // semantic prefixes of reusable controls / component primitives (NOT route layout)
    const controlLead = new RegExp(
      "(^|[ >+~])\\.(" +
        [
          "dlg-btn",
          "dlg-primary",
          "dlg-ghost",
          "dlg-danger",
          "bw-btn",
          "qi-btn",
          "lk-btn",
          "lkd-btn",
          "tm-action",
          "arun-btn",
          "scope-connect-btn",
          "grounded-cancel-btn",
          "grounded-[a-z-]*btn",
          "run-summary-card-action",
          "figma-snapshot-[a-z-]*btn",
          "figma-view-json-btn",
          "cmp-send",
          "cmp-icon",
          "cmp-add",
          "tr-caret-btn",
          "ed-icon-action",
          "rb-edge-badge-btn",
          "sm-code-copy",
          "chat-msg-copy",
          "attach-chip-remove",
          "code-copy",
          "number-control",
          "dlg-input",
          "dlg-textarea",
          "dlg-sel",
          "qi-input",
          "qi-textarea",
          "qi-select",
          "bw-input",
          "gw-input",
          "gw-textarea",
          "mc-dialog-input",
          "mc-dialog-textarea",
          "mc-dialog-select",
          "figma-snapshot-input",
          "cmp-input",
          "files-root-input",
          "rv-runid-input",
          "chat-history-search",
          "chat-title-input",
          "cmdk-input",
          "wf-dialog-input",
          "connector-picker-select",
          "scope-grounding-select",
          "ksel-",
          "cmp-model",
          "modesw-",
          "auto-toggle",
          "perm-sw",
          "brg-tg",
          "perm-toggle",
          "perm-opt",
          "figma-snapshot-consent",
          "ed-tab",
          "ed-tabs",
          "ed-empty",
          "edm-",
          "chip",
          "qi-badge",
          "mc-badge",
          "lk-badge",
          "cmp-budget-badge",
          "qi-sev",
          "qi-quality",
          "qi-cov-",
          "scope-pill",
          "dot",
          "tag",
          "attach-rejection-alert",
          "source-limit-alert",
          "lk-alert",
          "cmp-err",
          "files-error",
          "files-warning",
          "fpv-banner",
          "qi-degraded-notice",
          "scope-connect-error",
          "dlg-agent-warning",
          "wf-dialog-error",
          "mc-dialog-error",
          "dlg-error",
          "dir-error",
          "pal-card",
          "pal-main",
          "pal-name",
          "pal-desc",
          "run-summary-card",
          "cmp-box",
          "attach-chip",
          "dlg",
          "mc-dialog",
          "wf-dialog",
          "cmdk",
          "tr-row",
          "tr-caret",
          "tr-folder",
          "tr-file",
          "tr-dir-enter",
          "cmdk-list",
          "cmdk-row",
          "cmdk-ico",
          "cmdk-label",
          "cmdk-group",
          "cmdk-empty",
          "cmp-",
          "attach-",
          "scope-grounding",
          // PR #1400 review follow-up — reusable-control selectors whose prefixes were
          // missing from the classifier (their rules carried raw primitives and were
          // migrated as part of the same follow-up). Kept byte-identical to the mirror
          // enumerator's CONTROL list.
          "ed-tile",
          "tr-dir-line",
          "perm-legacy",
          "perm-note",
          "pal-ico",
          "ed-pane-actions",
          "ui-error-notice",
          "rb-edge-badge",
          "qi-source-kind",
          "qi-export-action",
          "plg-row",
        ].join("|") +
        ")",
    );
    // #1295-owned Light shadow/scrim rows + hand-built popover drop-shadows (new-no-token)
    const scrim = /(overlay|backdrop|scrim)/i;
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    let controlRulesChecked = 0;
    const offenders: string[] = [];
    while ((match = ruleRe.exec(source)) !== null) {
      const selector = (match[1] ?? "").trim().replace(/\s+/g, " ");
      const body = match[2] ?? "";
      if (selector === "" || /^(@|:root|html|body|\*|#)/.test(selector)) continue;
      if (selector.includes('[data-theme="light"]')) continue; // approved deviations
      const parts = selector
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length === 0) continue;
      const pureShell = parts.every((p) => {
        const lead = p.replace(/^[>+~\s]+/, "");
        return shellLead.test(lead) && !lead.startsWith(".connector");
      });
      if (pureShell) continue; // #1293 territory
      if (!parts.some((p) => controlLead.test(p))) continue; // not a reusable control
      if (scrim.test(selector)) continue; // #1295 Light shadow/scrim, new-no-token
      controlRulesChecked++;
      for (const tok of bodyForbidden(body)) {
        offenders.push(`${selector} { … var(${tok}) … }`);
      }
    }
    // the parser must find a substantial body of control rules (it cannot silently
    // match zero — the proven failure mode of a broken classifier).
    expect(controlRulesChecked).toBeGreaterThan(120);
    expect(
      offenders,
      `reusable-control rules still carry raw aliased primitives (migrate to the semantic token):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// ─── Issue #1295 — high-traffic product-surface token migration ────────────────
//
// #1295 is the product-CONTENT consumer migration after #1293 (shell) and #1294
// (reusable controls). It routes the raw neutral Tier-1 primitives in the chat,
// grounded-answer, workflow-handoff, Quality-Intelligence, MemoriaViva, Relationships,
// Local-Knowledge, Figma and file-preview surfaces through the Tier-3 semantic tokens —
// every target is a pure :root alias of the source primitive, so the migration is
// value-preserving in every mode (proven byte-identical by the 2324-probe, 7-mode
// computed-value harness in docs/design-system/evidence/1295/). Category C is a
// deliberate Light-Mode fix: the dark-biased shadow inks adapt via --shadow-ink-rgb
// (dark-preserving) and the dialog scrim is centralised via a light --overlay-scrim
// redefinition. Each positive pin is paired with a negative so reverting an alias re-fails.
describe("Issue #1295 — high-traffic product-surface token migration", () => {
  it("routes chat message bubbles through the semantic surface/border/text tokens", () => {
    const block = cssBlock("\n.chat-msg-bubble {");
    expect(block).toContain("background: var(--surface-primary)");
    expect(block).toContain("var(--border-subtle)");
    expect(block).toContain("color: var(--text-primary)");
    expect(block).not.toMatch(/var\(--card\)|var\(--line-soft\)|var\(--fg\)/u);
  });

  it("routes Quality-Intelligence candidate cards through --surface-primary / --border-default", () => {
    const block = cssBlock("\n.qi-cand-card {");
    expect(block).toContain("background: var(--surface-primary)");
    expect(block).toContain("var(--border-default)");
    expect(block).not.toMatch(/var\(--card\)|var\(--line\)/u);
  });

  it("routes the QI weak-test flag (danger-tinted card) through the feedback + surface tokens", () => {
    const block = cssBlock("\n.qi-weak-flag {");
    expect(block).toContain("var(--feedback-danger)");
    expect(block).toContain("var(--surface-primary)");
    expect(block).not.toMatch(/var\(--danger\)|var\(--card\)/u);
  });

  it("routes MemoriaViva rows through the semantic tokens", () => {
    const block = cssBlock("\n.mc-row {");
    expect(block).toContain("background: var(--surface-primary)");
    expect(block).toContain("var(--border-subtle)");
    expect(block).toContain("color: var(--text-primary)");
    expect(block).not.toMatch(/var\(--card\)|var\(--line-soft\)|var\(--fg\)/u);
  });

  it("routes Local-Knowledge metric cards through the semantic tokens", () => {
    const block = cssBlock("\n.lkd-metric-card {");
    expect(block).toContain("var(--surface-primary)");
    expect(block).toContain("var(--border-subtle)");
    expect(block).not.toMatch(/var\(--card\)|var\(--line-soft\)/u);
  });

  it("routes connector-graph nodes through the text token", () => {
    const block = cssBlock("\n.connector-node {");
    expect(block).toContain("color: var(--text-primary)");
    expect(block).not.toContain("var(--fg)");
  });

  it("routes the Figma JSON window through the text token", () => {
    const block = cssBlock("\n.figma-json-window {");
    expect(block).toContain("color: var(--text-primary)");
    expect(block).not.toContain("var(--fg)");
  });

  it("routes Figma snapshot error chrome through --feedback-danger / --text-primary", () => {
    const card = cssBlock("\n.figma-snapshot-error-card {");
    expect(card).toContain("var(--feedback-danger)");
    expect(card).not.toContain("var(--danger)");
  });

  // Category B — the file-preview syntax palette now consumes the editor tokens.
  it("routes the file-preview highlighter through the --ed-syn-* tokens", () => {
    expect(cssBlock("\n.hl-key {")).toContain("color: var(--ed-syn-keyword)");
    expect(cssBlock("\n.hl-str {")).toContain("color: var(--ed-syn-string)");
    expect(cssBlock("\n.fpv-src {")).toContain("color: var(--ed-fg)");
    expect(cssBlock("\n.hl-com {")).toContain("color: var(--text-tertiary)");
  });

  // Category C — mode-aware shadow ink (dark-preserving, light-adaptive).
  it("defines the mode-aware shadow-ink primitive (dark 0 0 0, light 20 30 25)", () => {
    expect(css).toContain("--shadow-ink-rgb: 0 0 0;");
    expect(css).toContain("--shadow-ink-rgb: 20 30 25;");
  });

  it("routes the Table-A required shadow inks through rgb(var(--shadow-ink-rgb) / α), no hardcoded black", () => {
    for (const sel of [
      "\n.ksel-menu {",
      "\n.hd-tool-cta {",
      "\n.ws-zoom {",
      "\n.cmp-model-menu {",
      "\n.ws-fab {",
    ]) {
      const block = cssBlock(sel);
      expect(block, `${sel} must use the mode-aware shadow ink`).toContain(
        "rgb(var(--shadow-ink-rgb)",
      );
      expect(block, `${sel} must not keep a hardcoded black shadow`).not.toContain("rgba(0, 0, 0,");
    }
    const brand = cssBlock("\n.chat-msg-brand img {");
    expect(brand).toContain("rgb(var(--shadow-ink-rgb)");
    expect(brand).not.toContain("rgba(0, 0, 0,");
  });

  it("centralises the dialog scrim via a light --overlay-scrim redefinition", () => {
    expect(css).toContain("--overlay-scrim: oklch(0.3 0.01 160 / 0.34);");
    expect(cssBlock("\n.mc-dialog-backdrop {")).toContain("background: var(--overlay-scrim)");
  });

  it("fixes the undefined var(--focus) focus rings (WCAG 2.4.7)", () => {
    const figma = cssRule(".figma-view-json-btn:focus-visible");
    expect(figma).toContain("var(--focus-ring)");
    const notice = cssBlock("\n.ui-error-notice-close:focus-visible {");
    expect(notice).toContain("var(--focus-ring)");
    // no live var(--focus) declaration survives (the remaining matches are explanatory comments)
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(noComments).not.toMatch(/var\(--focus\)/u);
  });

  // Completeness gate — scope-wide product-surface drift guard. Parses EVERY rule and, for
  // those whose selector matches a #1295 product-surface class prefix (productLead — a
  // semantic prefix set, NOT a per-selector allowlist, which the #1293 review mutation-proved
  // tautological), asserts none still carries a raw aliased neutral primitive. It mirrors the
  // migration's own in-scope predicate (worklist == guard): skip @-rules, the approved
  // [data-theme="light"] deviations, the #1294-owned reusable-control classes (controlExclude),
  // and the Category-C scrim/shadow rows. Mutation-robust: reverting one migrated declaration
  // yields exactly one offender.
  it("leaves no raw aliased neutral primitive in any #1295 product-surface rule (scope-wide)", () => {
    const forbidden = [
      "--bg",
      "--surface",
      "--card-2",
      "--card",
      "--inset",
      "--fg-muted",
      "--fg-dim",
      "--fg-faint",
      "--fg",
      "--ink-inverse",
      "--line-soft",
      "--line-strong",
      "--line",
      "--danger",
      "--warn",
      "--info",
      "--ok",
      "--accent-text",
    ];
    const escapeRegExp = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bodyForbidden = (body: string): readonly string[] =>
      forbidden.filter((tok) => new RegExp(`var\\(\\s*${escapeRegExp(tok)}\\s*[),]`).test(body));
    // #1295 product-surface class prefixes (the migration's productLead set).
    const productLead =
      /\.(chat-|chatw-|grounded-|wf-|qi-|mc-|memoria-|rel-|rb-|lk-|lkd-|connector-|figma-|json-token-|fpv-|hl-)/;
    // #1294-owned reusable controls kept out of #1295 (the migration's CONTROL_EXCLUDE list).
    const controlExclude = [
      ".qi-btn",
      ".qi-input",
      ".qi-textarea",
      ".qi-select",
      ".qi-badge",
      ".qi-sev",
      ".qi-cov",
      ".qi-quality",
      ".qi-source-kind",
      ".qi-export-action",
      ".wf-dialog",
      ".mc-dialog",
      ".mc-badge",
      ".lk-btn",
      ".lk-badge",
      ".lk-alert",
      ".rb-edge-badge",
      ".figma-snapshot-input",
      ".figma-snapshot-consent",
      ".figma-view-json-btn",
      ".figma-snapshot-rename",
      ".figma-snapshot-refresh",
    ];
    const scrim = /(overlay|backdrop|scrim|shadow-ink)/iu;
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    let productRulesChecked = 0;
    const offenders: string[] = [];
    while ((match = ruleRe.exec(source)) !== null) {
      const selector = (match[1] ?? "").trim().replace(/\s+/g, " ");
      const body = match[2] ?? "";
      if (selector === "" || selector.startsWith("@")) continue;
      if (selector.includes('[data-theme="light"]')) continue; // approved deviations
      if (controlExclude.some((ex) => selector.includes(ex))) continue; // #1294 controls
      if (scrim.test(selector)) continue; // Category-C scrim/shadow rows
      if (!productLead.test(selector)) continue; // not a #1295 product surface
      productRulesChecked++;
      for (const tok of bodyForbidden(body)) {
        offenders.push(`${selector} { … var(${tok}) … }`);
      }
    }
    // the parser must match a substantial body of product rules (never silently zero).
    expect(productRulesChecked).toBeGreaterThan(60);
    expect(
      offenders,
      `#1295 product-surface rules still carry raw aliased primitives (migrate to the semantic token):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("Issue #1296 — AI/agent component set (Design System 0.4.0)", () => {
  // ── 1. Value-preservation: every --ai-* component token aliases the exact primitive the
  //       bespoke product surfaces already used, so routing a surface onto the token cannot
  //       change its resolved value in any mode (mirrors the #1292 drift-gate idea).
  it("defines the --ai-* component tokens as pure aliases over the existing primitives", () => {
    for (const decl of [
      "--ai-response-surface: var(--surface)",
      "--ai-response-border: var(--line-soft)",
      "--ai-thinking-indicator: var(--accent-text)",
      "--ai-streaming-cursor: var(--accent)",
      "--ai-source-border: var(--accent-line)",
      "--ai-source-surface: var(--accent-dim)",
      "--ai-tool-surface: var(--inset)",
      "--ai-tool-border: var(--line)",
      "--ai-confidence-high: var(--ok)",
      "--ai-confidence-medium: var(--warn)",
      "--ai-confidence-low: var(--danger)",
      "--ai-permission-surface: var(--feedback-warning-surface)",
      "--ai-permission-border: color-mix(in oklch, var(--warn) 40%, transparent)",
    ]) {
      expect(css, `token def "${decl}" missing or drifted`).toContain(decl);
    }
  });

  it("surfaces editor-agent tokens as pure runtime aliases over the editor and AI palette", () => {
    for (const decl of [
      "--ed-agent-line: color-mix(in oklch, var(--accent) 12%, transparent)",
      "--ed-agent-gutter: var(--accent-text)",
      "--ed-agent-ghost: var(--ed-ghost)",
      "--ed-agent-accept: var(--ed-diff-ins-gutter)",
      "--ed-agent-reject: var(--danger)",
      "--ed-agent-chip-bg: var(--accent-dim)",
      "--ed-agent-chip-line: var(--accent-line)",
    ]) {
      expect(css, `editor-agent token def "${decl}" missing or drifted`).toContain(decl);
    }
  });

  // ── 2. The canonical .ai-* component primitives consume the --ai-* tokens exactly.
  it("ships the canonical .ai-* primitives consuming the --ai-* component tokens", () => {
    const response = cssBlock("\n.ai-response {");
    expect(response).toContain("var(--ai-response-surface)");
    expect(response).toContain("var(--ai-response-border)");
    expect(cssBlock("\n.ai-thinking {")).toContain("var(--ai-thinking-indicator)");
    expect(cssBlock("\n.ai-stream-cursor {")).toContain("var(--ai-streaming-cursor)");
    const tool = cssBlock("\n.ai-tool {");
    expect(tool).toContain("var(--ai-tool-border)");
    expect(tool).toContain("var(--ai-tool-surface)");
    const cite = cssBlock("\n.ai-cite {");
    expect(cite).toContain("var(--ai-source-surface)");
    expect(cite).toContain("var(--ai-source-border)");
    expect(cssBlock('\n.ai-conf[data-level="high"] .lbl {')).toContain("var(--ai-confidence-high)");
    expect(cssBlock('\n.ai-conf[data-level="medium"] .lbl {')).toContain(
      "var(--ai-confidence-medium)",
    );
    expect(cssBlock('\n.ai-conf[data-level="low"] .lbl {')).toContain("var(--ai-confidence-low)");
    const permit = cssBlock("\n.ai-permit {");
    expect(permit).toContain("var(--ai-permission-surface)");
    expect(permit).toContain("var(--ai-permission-border)");
    // stop / sensitive-action are danger-weighted, never accent.
    expect(cssBlock("\n.ai-stop {")).toContain("var(--feedback-danger)");
    expect(cssBlock("\n.ai-danger {")).toContain("var(--feedback-danger)");
  });

  // ── 3. Completeness: every --ai-* token defined in :root now has at least one real consumer
  //       (the audit's headline gap was that all 13 were defined but consumed 0 times).
  it("gives every --ai-* component token at least one consumer", () => {
    const tokens = [
      "--ai-response-surface",
      "--ai-response-border",
      "--ai-thinking-indicator",
      "--ai-streaming-cursor",
      "--ai-source-border",
      "--ai-source-surface",
      "--ai-tool-surface",
      "--ai-tool-border",
      "--ai-confidence-high",
      "--ai-confidence-medium",
      "--ai-confidence-low",
      "--ai-permission-surface",
      "--ai-permission-border",
    ];
    const unconsumed = tokens.filter((t) => !css.includes(`var(${t})`));
    expect(unconsumed, `--ai-* tokens with no consumer: ${unconsumed.join(", ")}`).toEqual([]);
  });

  // ── 4. Reduced-motion (WCAG 2.3.3): the AI animations are OFF by default and enabled only
  //       inside a prefers-reduced-motion: no-preference block (the canonical animation-off-by-default
  //       pattern; the no-preference wrapping itself is pinned per-selector in the "Fix 2" suite).
  it("defines the AI keyframes and keeps the base rules animation: none", () => {
    expect(css).toContain("@keyframes ai-blink");
    expect(css).toContain("@keyframes ai-caret");
    expect(css).toContain("@keyframes ai-spin");
    for (const sel of [
      "\n.ai-thinking .dots i {",
      "\n.ai-stream-cursor {",
      "\n.ai-tool-head .st.run::before {",
    ]) {
      expect(cssBlock(sel), `${sel} base must be animation: none`).toContain("animation: none");
    }
  });

  it("gives the AI stop / permission / sensitive-action controls a keyboard focus ring (WCAG 2.4.7)", () => {
    const focus = cssBlock("\n.ai-stop:focus-visible,");
    expect(focus).toContain("var(--focus-ring)");
    expect(css).toContain(".ai-permit-act button:focus-visible");
    expect(css).toContain(".ai-danger-act button:focus-visible");
  });

  // ── 5. Migrated bespoke surfaces consume the --ai-* tokens (positive) and drop the raw
  //       primitive they replaced (negative) → reverting any one alias re-fails (mutation-robust).
  it("routes grounded citations through the --ai-source-* tokens", () => {
    const chip = cssBlock("\n.grounded-citation {");
    expect(chip).toContain("var(--ai-source-border)");
    expect(chip).toContain("var(--ai-source-surface)");
    expect(chip).not.toMatch(/var\(--accent-line\)|var\(--accent-dim\)/u);
    expect(cssBlock("\n.grounded-citation-doc-badge {")).toContain("var(--ai-source-border)");
  });

  it("routes the chat thinking indicator through --ai-thinking-indicator", () => {
    const dots = cssBlock("\n.chat-typing i {");
    expect(dots).toContain("var(--ai-thinking-indicator)");
    expect(dots).not.toContain("var(--text-faint)");
  });

  it("routes the agent-run tool/result/input/summary cards through --ai-tool-surface", () => {
    for (const sel of [
      "\n.arun-meter {",
      "\n.arun-summary {",
      "\n.arun-result-card {",
      "\n.arun-input {",
    ]) {
      const block = cssBlock(sel);
      expect(block, `${sel} must consume --ai-tool-surface`).toContain("var(--ai-tool-surface)");
      expect(block, `${sel} must not keep the raw --inset primitive`).not.toContain("var(--inset)");
    }
  });

  it("routes the agent-run live indicators through --ai-streaming-cursor", () => {
    const spin = cssBlock("\n.arun-spin {");
    expect(spin).toContain("var(--ai-streaming-cursor)");
    expect(spin).not.toContain("color: var(--accent)");
    expect(cssBlock('\n.arun .dot[data-live="true"] {')).toContain("var(--ai-streaming-cursor)");
  });

  it("routes the agent-run grounded/applied accents through the --ai-source-* tokens", () => {
    const perm = cssBlock('\n.arun-perm[data-on="true"] {');
    expect(perm).toContain("var(--ai-source-border)");
    expect(perm).toContain("var(--ai-source-surface)");
    const applied = cssBlock("\n.arun-applied {");
    expect(applied).toContain("var(--ai-source-border)");
    expect(applied).toContain("var(--ai-source-surface)");
    expect(applied).not.toMatch(/var\(--accent-line\)|var\(--accent-dim\)/u);
  });

  // ── 6. Purity gate for the ported canonical layer: parse every .ai-* rule and assert none
  //       reintroduces a raw aliased primitive (it must read the --ai-*/semantic tier only).
  it("keeps the canonical .ai-* layer free of raw aliased primitives (scope-wide)", () => {
    const forbidden = [
      "--bg",
      "--surface",
      "--card-2",
      "--card",
      "--inset",
      "--fg-muted",
      "--fg-dim",
      "--fg-faint",
      "--fg",
      "--line-soft",
      "--line-strong",
      "--line",
      "--danger",
      "--warn",
      "--ok",
      "--accent-text",
      "--accent-line",
      "--accent-dim",
      "--accent",
    ];
    const escapeRegExp = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bodyForbidden = (body: string): readonly string[] =>
      forbidden.filter((tok) => new RegExp(`var\\(\\s*${escapeRegExp(tok)}\\s*[),]`).test(body));
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    let aiRulesChecked = 0;
    const offenders: string[] = [];
    while ((match = ruleRe.exec(source)) !== null) {
      const selector = (match[1] ?? "").trim().replace(/\s+/g, " ");
      const body = match[2] ?? "";
      if (selector === "" || selector.startsWith("@")) continue;
      if (!/(^|[\s,>])\.ai-[a-z]/u.test(selector)) continue; // canonical AI primitives only
      aiRulesChecked++;
      for (const tok of bodyForbidden(body)) {
        offenders.push(`${selector} { … var(${tok}) … }`);
      }
    }
    expect(aiRulesChecked).toBeGreaterThan(25);
    expect(
      offenders,
      `canonical .ai-* rules must read the --ai-*/semantic tier, not raw primitives:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("Issue #1297 — table / data grid + dataviz foundation (Design System 0.4.0)", () => {
  // ── 1. Value-preservation: every --table-* component token aliases the exact primitive the
  //       product table surfaces already used, so routing a surface onto the token cannot change
  //       its resolved value in any mode. The --viz-* palette is pinned to its governed values.
  it("defines the --table-* component tokens as pure aliases over the existing primitives", () => {
    for (const decl of [
      "--table-header-text: var(--fg-faint)",
      "--table-header-surface: var(--card-2)",
      "--table-row-border: var(--line-soft)",
      "--table-row-surface-hover: var(--card)",
      "--table-row-surface-selected: var(--accent-dim)",
      "--table-foot-surface: var(--card-2)",
      "--table-sort-indicator: var(--accent-text)",
      "--table-num-text: var(--fg)",
    ]) {
      expect(css, `table token def "${decl}" missing or drifted`).toContain(decl);
    }
  });

  it("defines the --viz-* categorical + sequential palette, mode-aware across dark and light", () => {
    // structural tokens alias the semantic tier; the lead categorical hue is the orca accent.
    for (const decl of [
      "--viz-1: var(--accent)",
      "--viz-grid: var(--border-subtle)",
      "--viz-axis: var(--text-faint)",
    ]) {
      expect(css, `viz token def "${decl}" missing or drifted`).toContain(decl);
    }
    // dark palette values (in :root) and their light-mode overrides both present → mode-aware.
    expect(css, "dark --viz-2 missing").toContain("--viz-2: oklch(0.7 0.12 240)");
    expect(css, "light --viz-2 override missing").toContain("--viz-2: oklch(0.5 0.14 240)");
    expect(css, "dark sequential ramp start missing").toContain("--viz-seq-1: oklch(0.3 0.05 160)");
    expect(css, "light sequential ramp start missing").toContain(
      "--viz-seq-1: oklch(0.9 0.04 160)",
    );
  });

  // ── 2. The canonical .c-table* / .viz* primitives consume the tokens exactly.
  it("ships the canonical .c-table* primitives consuming the --table-* component tokens", () => {
    const wrap = cssBlock("\n.c-tablewrap {");
    expect(wrap).toContain("var(--card-surface)");
    expect(wrap).toContain("var(--card-border)");
    const head = cssBlock("\n.c-table thead th {");
    expect(head).toContain("var(--table-header-text)");
    expect(head).toContain("var(--table-header-surface)");
    expect(cssBlock('\n.c-table th[aria-sort="ascending"] .so {')).toContain(
      "var(--table-sort-indicator)",
    );
    expect(cssBlock("\n.c-table tbody td {")).toContain("var(--table-row-border)");
    expect(cssBlock("\n.c-table tbody td.num {")).toContain("var(--table-num-text)");
    expect(cssBlock("\n.c-table tbody tr:hover {")).toContain("var(--table-row-surface-hover)");
    expect(cssBlock('\n.c-table tbody tr[aria-selected="true"] {')).toContain(
      "var(--table-row-surface-selected)",
    );
    expect(cssBlock("\n.c-table-foot {")).toContain("var(--table-foot-surface)");
  });

  // The sticky header and empty state are distinct data-grid states (AC: "sticky … states are
  // visibly and accessibly distinct" / "Component tests cover … empty"); pin them so a single-line
  // removal of the sticky positioning or the empty-state token wiring re-fails (mutation-robust).
  it("pins the sticky header positioning and the empty-state token wiring", () => {
    const head = cssBlock("\n.c-table thead th {");
    expect(head).toContain("position: sticky");
    expect(head).toContain("top: 0");
    expect(head).toContain("z-index: 1");
    expect(cssBlock("\n.c-table-empty .ic {")).toContain("var(--surface-inset)");
    expect(cssBlock("\n.c-table-empty .ic {")).toContain("var(--border-subtle)");
    expect(cssBlock("\n.c-table-empty .tt {")).toContain("var(--text-primary)");
    expect(cssBlock("\n.c-table-empty .ts {")).toContain("var(--text-secondary)");
  });

  it("ships the canonical .viz* primitives consuming the --viz-* palette + chart-chrome tokens", () => {
    expect(cssBlock("\n.viz-bar {")).toContain("var(--viz-1)");
    expect(cssBlock("\n.viz-bar.s2 {")).toContain("var(--viz-2)");
    expect(cssBlock("\n.viz-bar.s4 {")).toContain("var(--viz-4)");
    expect(cssBlock("\n.viz-gridlines i {")).toContain("var(--viz-grid)");
    expect(cssBlock("\n.viz-yaxis span {")).toContain("var(--viz-axis)");
    expect(cssBlock("\n.viz-seq i:nth-child(1) {")).toContain("var(--viz-seq-1)");
    const tip = cssBlock("\n.viz-tip {");
    expect(tip).toContain("var(--tooltip-surface)");
    expect(tip).toContain("var(--tooltip-text)");
  });

  // ── 3. Completeness: every --table-* and --viz-* token now has at least one consumer (the
  //       audit's headline gap was that the 8 --table-* tokens were defined but consumed 0 times).
  it("gives every --table-* and --viz-* token at least one consumer", () => {
    const tokens = [
      "--table-header-text",
      "--table-header-surface",
      "--table-row-border",
      "--table-row-surface-hover",
      "--table-row-surface-selected",
      "--table-foot-surface",
      "--table-sort-indicator",
      "--table-num-text",
      "--viz-1",
      "--viz-2",
      "--viz-3",
      "--viz-4",
      "--viz-5",
      "--viz-6",
      "--viz-seq-1",
      "--viz-seq-2",
      "--viz-seq-3",
      "--viz-seq-4",
      "--viz-seq-5",
      "--viz-grid",
      "--viz-axis",
    ];
    const unconsumed = tokens.filter((t) => !css.includes(`var(${t})`));
    expect(unconsumed, `data-display tokens with no consumer: ${unconsumed.join(", ")}`).toEqual(
      [],
    );
  });

  // ── 4. Reduced-motion (WCAG 2.3.3): the loading skeleton shimmers by default but is switched
  //       OFF inside prefers-reduced-motion: reduce.
  it("defines the skeleton shimmer keyframe and disables it under prefers-reduced-motion", () => {
    expect(css).toContain("@keyframes c-shimmer");
    // the reduce media query nulls the skeleton animation.
    const reduceIdx = css.indexOf(
      "@media (prefers-reduced-motion: reduce) {\n  .c-table.is-loading",
    );
    expect(reduceIdx, "reduced-motion guard for the table skeleton missing").toBeGreaterThan(-1);
    const guard = css.slice(reduceIdx, css.indexOf("}", css.indexOf("animation: none", reduceIdx)));
    expect(guard).toContain(".c-table.is-loading tbody td::after");
    expect(guard).toContain("animation: none");
  });

  // ── 5. Keyboard focus rings (WCAG 2.4.7): sortable headers and explicitly
  //       focusable data-grid rows are interactive.
  it("gives sortable column headers and focusable rows keyboard focus rings", () => {
    expect(cssBlock("\n.c-table th.sortable:focus-visible {")).toContain("var(--focus-ring)");
    const row = cssBlock("\n.c-table tbody tr[tabindex]:focus-visible {");
    expect(row).toContain("var(--focus-width, 2px) solid var(--focus-ring)");
    expect(row).toContain("outline-offset: -2px");
  });

  it("keeps browser evidence for row focus, sort announcements, and bounded rows", () => {
    expect(evidenceHarness1297).toContain('id="focus-row"');
    expect(evidenceHarness1297).toContain('tabindex="0"');
    expect(evidenceHarness1297).toContain('id="sort-status"');
    expect(evidenceHarness1297).toContain('role="status"');
    expect(evidenceHarness1297).toContain('aria-live="polite"');
    expect(evidenceHarness1297).toContain('aria-atomic="true"');
    expect(evidenceHarness1297).toContain("PERF_ROWS = Array.from({ length: 250 }");
    expect(evidenceHarness1297).toContain("stickyHeaderDeltaPx");
  });

  // ── 6. Product adopters consume the tokens (positive) and drop the raw primitive they replaced
  //       (negative) → reverting any one alias re-fails (mutation-robust).
  it("routes the markdown .sm-table onto the --table-* tokens value-preservingly", () => {
    const wrapper = cssBlock("\n.sm-table-wrapper {");
    expect(wrapper).toContain("var(--card-border)");
    expect(wrapper).not.toMatch(/border:\s*1px solid var\(--line\)/u);
    const cell = cssBlock("\n.sm-table th,");
    expect(cell).toContain("var(--table-row-border)");
    // cell text uses the general-purpose --text-primary (= var(--fg)), not the numeric-column token,
    // so the value is preserved while the semantics stay correct for non-numeric markdown cells.
    expect(cell).toContain("var(--text-primary)");
    expect(cell).not.toMatch(/var\(--line-soft\)/u);
    expect(cell).not.toMatch(/color:\s*var\(--fg\)/u);
    expect(cell).not.toMatch(/var\(--table-num-text\)/u);
    expect(cssBlock("\n.sm-table th {")).toContain("var(--table-header-surface)");
    const even = cssBlock("\n.sm-table tr:nth-child(even) td {");
    expect(even).toContain("var(--surface-inset)");
    expect(even).not.toContain("var(--inset)");
  });

  it("adopts the .c-table component on the prompt-enhancer scorecards + DS winner-row emphasis", () => {
    const winner = cssBlock("\n.pe-scorecards tbody tr.pe-winner {");
    expect(winner).toContain("var(--table-row-surface-selected)");
    const rowHead = cssBlock('\n.pe-scorecards tbody th[scope="row"] {');
    expect(rowHead).toContain("var(--table-row-border)");
    expect(rowHead).toContain("var(--text-primary)");
  });

  // ── 7. Purity gate for the ported canonical layer: parse every .c-table*/.viz* rule and assert
  //       none reintroduces a raw aliased primitive — it must read the --table-*/--viz-*/semantic
  //       tier only. The predicate is the same in-scope prefix the migration used (NOT an allowlist).
  it("keeps the canonical .c-table* / .viz* layer free of raw aliased primitives (scope-wide)", () => {
    const forbidden = [
      "--bg",
      "--surface",
      "--card-2",
      "--card",
      "--inset",
      "--fg-muted",
      "--fg-dim",
      "--fg-faint",
      "--fg",
      "--line-soft",
      "--line-strong",
      "--line",
      "--danger",
      "--warn",
      "--ok",
      "--accent-text",
      "--accent-line",
      "--accent-dim",
      "--accent",
    ];
    const escapeRegExp = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bodyForbidden = (body: string): readonly string[] =>
      forbidden.filter((tok) => new RegExp(`var\\(\\s*${escapeRegExp(tok)}\\s*[),]`).test(body));
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    let dataRulesChecked = 0;
    const offenders: string[] = [];
    while ((match = ruleRe.exec(source)) !== null) {
      const selector = (match[1] ?? "").trim().replace(/\s+/g, " ");
      const body = match[2] ?? "";
      if (selector === "" || selector.startsWith("@")) continue;
      // canonical data-display primitives only: .c-table*, .c-tablewrap/scroll, .viz*.
      if (!/(^|[\s,>])\.(c-table|c-tablewrap|c-tablescroll|viz)[a-z0-9-]*/u.test(selector))
        continue;
      dataRulesChecked++;
      for (const tok of bodyForbidden(body)) {
        offenders.push(`${selector} { … var(${tok}) … }`);
      }
    }
    expect(dataRulesChecked).toBeGreaterThan(40);
    expect(
      offenders,
      `canonical .c-table*/.viz* rules must read the --table-*/--viz-*/semantic tier, not raw primitives:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// ─── Issue #1298 — input family + navigation + breakpoint + density coverage ───
describe("Issue #1298 — input + navigation components (Design System 0.4.0)", () => {
  // ── 1. Value-preservation: every input/nav Tier-3 component token is a pure alias over an
  //       existing primitive (added additively in #1292), so a consumer reading the token cannot
  //       change its resolved value in any mode. Pin a representative span across the families so a
  //       drift in the alias re-fails (mutation-robust).
  it("defines the input/nav component tokens as pure aliases over the existing primitives", () => {
    for (const decl of [
      "--checkbox-surface: var(--inset)",
      "--checkbox-border: var(--line)",
      "--checkbox-surface-selected: var(--accent-solid)",
      "--checkbox-mark: var(--accent-solid-ink)",
      "--radio-border-selected: var(--accent)",
      "--slider-track: var(--inset)",
      "--slider-fill: var(--accent-solid)",
      "--stepper-button-text: var(--fg-muted)",
      "--combobox-list-surface: var(--surface)",
      "--tag-surface: var(--accent-dim)",
      "--file-progress: var(--accent)",
      "--date-segment-text-active: var(--accent-text)",
      "--breadcrumb-text: var(--fg-muted)",
      "--pagination-surface-current: var(--accent-dim)",
      "--tab-underline-indicator: var(--accent-text)",
      "--context-item-text-danger: var(--danger)",
      "--step-dot-surface-done: var(--accent-solid)",
      "--step-line-done: var(--accent)",
    ]) {
      expect(css, `input/nav token def "${decl}" missing or drifted`).toContain(decl);
    }
  });

  // ── 2. The canonical .c-* input primitives consume their component tokens exactly.
  it("ships the canonical .c-* input primitives consuming the input component tokens", () => {
    const box = cssBlock("\n.c-check .bx {");
    expect(box).toContain("var(--checkbox-border)");
    expect(box).toContain("var(--checkbox-surface)");
    expect(box).toContain("var(--checkbox-mark)");
    expect(cssBlock("\n.c-check input:checked + .bx {")).toContain(
      "var(--checkbox-surface-selected)",
    );
    const rb = cssBlock("\n.c-radio .rb {");
    expect(rb).toContain("var(--radio-border)");
    expect(rb).toContain("var(--radio-surface)");
    expect(cssBlock("\n.c-radio input:checked + .rb {")).toContain("var(--radio-border-selected)");
    expect(cssBlock('\n.c-slider input[type="range"] {')).toContain("var(--slider-track)");
    expect(cssBlock('\n.c-slider input[type="range"]::-moz-range-progress {')).toContain(
      "var(--slider-fill)",
    );
    const stepper = cssBlock("\n.c-stepper {");
    expect(stepper).toContain("var(--stepper-border)");
    expect(stepper).toContain("var(--stepper-surface)");
    const combo = cssBlock("\n.c-combo-input {");
    expect(combo).toContain("var(--combobox-border)");
    expect(combo).toContain("var(--combobox-surface)");
    const list = cssBlock("\n.c-combo-list {");
    expect(list).toContain("var(--combobox-list-surface)");
    expect(list).toContain("var(--popover-shadow)");
    expect(list).toContain("var(--z-dropdown)");
    const tag = cssBlock("\n.c-tag {");
    expect(tag).toContain("var(--tag-surface)");
    expect(tag).toContain("var(--tag-border)");
    expect(tag).toContain("var(--tag-text)");
    const drop = cssBlock("\n.c-drop {");
    expect(drop).toContain("var(--file-dropzone-border)");
    expect(drop).toContain("var(--file-dropzone-surface)");
    expect(cssBlock("\n.c-fileitem .bar i {")).toContain("var(--file-progress)");
    const date = cssBlock("\n.c-datefield {");
    expect(date).toContain("var(--date-border)");
    expect(date).toContain("var(--date-surface)");
  });

  // ── 3. The canonical .c-* navigation primitives consume their component tokens exactly.
  it("ships the canonical .c-* navigation primitives consuming the nav component tokens", () => {
    expect(cssBlock("\n.c-crumbs a,")).toContain("var(--breadcrumb-text)");
    expect(cssBlock("\n.c-crumbs a:hover {")).toContain("var(--breadcrumb-surface-hover)");
    expect(cssBlock('\n.c-utab[aria-selected="true"]::after {')).toContain(
      "var(--tab-underline-indicator)",
    );
    expect(cssBlock("\n.c-pager button {")).toContain("var(--pagination-text)");
    expect(cssBlock('\n.c-pager button[aria-current="page"] {')).toContain(
      "var(--pagination-surface-current)",
    );
    const ctx = cssBlock("\n.c-ctx {");
    expect(ctx).toContain("var(--popover-surface)");
    expect(ctx).toContain("var(--popover-border)");
    expect(cssBlock("\n.c-ctx-item {")).toContain("var(--context-item-text)");
    expect(cssBlock("\n.c-ctx-item.danger {")).toContain("var(--context-item-text-danger)");
    const dot = cssBlock("\n.c-step .dot {");
    expect(dot).toContain("var(--step-dot-border)");
    expect(dot).toContain("var(--step-dot-surface)");
    expect(cssBlock("\n.c-step.done .dot {")).toContain("var(--step-dot-surface-done)");
  });

  // ── 4. Completeness: every input/nav component token now has at least one consumer (the audit's
  //       headline gap was that these 13 token families were defined but consumed 0 times).
  it("gives every input/nav component token at least one consumer", () => {
    const tokens = [
      "--checkbox-surface",
      "--checkbox-border",
      "--checkbox-surface-selected",
      "--checkbox-mark",
      "--radio-surface",
      "--radio-border",
      "--radio-border-selected",
      "--radio-dot",
      "--slider-track",
      "--slider-fill",
      "--slider-thumb",
      "--slider-thumb-ring",
      "--slider-thumb-border",
      "--stepper-surface",
      "--stepper-border",
      "--stepper-button-text",
      "--stepper-button-surface-hover",
      "--stepper-input-surface",
      "--combobox-surface",
      "--combobox-border",
      "--combobox-list-surface",
      "--combobox-list-border",
      "--combobox-option-surface-hover",
      "--combobox-option-selected-mark",
      "--tag-surface",
      "--tag-border",
      "--tag-text",
      "--file-dropzone-surface",
      "--file-dropzone-border",
      "--file-dropzone-border-active",
      "--file-progress",
      "--file-item-surface",
      "--date-surface",
      "--date-border",
      "--date-segment-surface-active",
      "--date-segment-text-active",
      "--breadcrumb-text",
      "--breadcrumb-text-current",
      "--breadcrumb-surface-hover",
      "--pagination-text",
      "--pagination-surface-hover",
      "--pagination-surface-current",
      "--pagination-text-current",
      "--pagination-border-current",
      "--tab-underline-indicator",
      "--context-item-text",
      "--context-item-surface-hover",
      "--context-item-text-danger",
      "--step-dot-surface",
      "--step-dot-border",
      "--step-dot-surface-done",
      "--step-dot-text-done",
      "--step-dot-border-active",
      "--step-line",
      "--step-line-done",
    ];
    const unconsumed = tokens.filter((t) => !css.includes(`var(${t})`));
    expect(unconsumed, `input/nav tokens with no consumer: ${unconsumed.join(", ")}`).toEqual([]);
  });

  // ── 5. Keyboard focus ring (WCAG 2.4.7): every interactive primitive carries a focus-visible ring.
  it("gives every interactive input/nav primitive a :focus-visible ring", () => {
    expect(cssBlock("\n.c-check input:focus-visible + .bx {")).toContain("var(--focus-ring)");
    expect(cssBlock("\n.c-radio input:focus-visible + .rb {")).toContain("var(--focus-ring)");
    expect(cssBlock('\n.c-slider input[type="range"]:focus-visible {')).toContain(
      "var(--focus-ring)",
    );
    expect(cssBlock("\n.c-stepper button:focus-visible {")).toContain("var(--focus-ring)");
    expect(cssBlock("\n.c-crumbs a:focus-visible {")).toContain("var(--focus-ring)");
    expect(cssBlock("\n.c-back:focus-visible {")).toContain("var(--focus-ring)");
    expect(cssBlock("\n.c-utab:focus-visible {")).toContain("var(--focus-ring)");
    expect(cssBlock("\n.c-pager button:focus-visible {")).toContain("var(--focus-ring)");
    expect(cssBlock("\n.c-ctx-item:focus-visible {")).toContain("var(--focus-ring)");
  });

  // ── 5b. Per-consumer fidelity pins for the tokens the completeness gate (test 4) only checks for
  //        ">= 1 consumer". Several tokens have two consumers (e.g. the slider thumb's -webkit- and
  //        -moz- pseudo-elements), so a value-swap on ONE escapes both the completeness gate (the
  //        other consumer keeps the token present) and the purity guard (the swapped-in token may be
  //        an allowed semantic one like --text-primary). Pin each completeness-only consumer to its
  //        exact token so a single-line fidelity revert re-fails (mutation-robust).
  it("pins every completeness-only input/nav token to its specific consumer", () => {
    // slider thumb — two pseudo-element consumers, both must read the thumb tokens.
    const thumbW = cssBlock('\n.c-slider input[type="range"]::-webkit-slider-thumb {');
    expect(thumbW).toContain("var(--slider-thumb)");
    expect(thumbW).toContain("var(--slider-thumb-border)");
    expect(thumbW).toContain("var(--slider-thumb-ring)");
    const thumbM = cssBlock('\n.c-slider input[type="range"]::-moz-range-thumb {');
    expect(thumbM).toContain("var(--slider-thumb)");
    expect(thumbM).toContain("var(--slider-thumb-border)");
    expect(thumbM).toContain("var(--slider-thumb-ring)");
    // radio dot, stepper internals.
    expect(cssBlock("\n.c-radio .rb::after {")).toContain("var(--radio-dot)");
    expect(cssBlock("\n.c-stepper button {")).toContain("var(--stepper-button-text)");
    expect(cssBlock("\n.c-stepper button:hover {")).toContain(
      "var(--stepper-button-surface-hover)",
    );
    expect(cssBlock("\n.c-stepper input {")).toContain("var(--stepper-input-surface)");
    // combobox list border + option states.
    expect(cssBlock("\n.c-combo-list {")).toContain("var(--combobox-list-border)");
    expect(cssBlock("\n.c-combo-opt:hover,")).toContain("var(--combobox-option-surface-hover)");
    expect(cssBlock("\n.c-combo-opt .ck {")).toContain("var(--combobox-option-selected-mark)");
    // file dropzone-active + item, date segment active.
    expect(cssBlock("\n.c-drop:hover,")).toContain("var(--file-dropzone-border-active)");
    expect(cssBlock("\n.c-fileitem {")).toContain("var(--file-item-surface)");
    const seg = cssBlock("\n.c-datefield .seg:focus {");
    expect(seg).toContain("var(--date-segment-surface-active)");
    expect(seg).toContain("var(--date-segment-text-active)");
    // breadcrumb current, pagination hover/current text+border.
    expect(cssBlock('\n.c-crumbs [aria-current="page"] {')).toContain(
      "var(--breadcrumb-text-current)",
    );
    expect(cssBlock("\n.c-pager button:hover:not(:disabled) {")).toContain(
      "var(--pagination-surface-hover)",
    );
    const cur = cssBlock('\n.c-pager button[aria-current="page"] {');
    expect(cur).toContain("var(--pagination-text-current)");
    expect(cur).toContain("var(--pagination-border-current)");
    // context hover, step done/active/line.
    expect(cssBlock("\n.c-ctx-item:hover,")).toContain("var(--context-item-surface-hover)");
    expect(cssBlock("\n.c-step.done .dot {")).toContain("var(--step-dot-text-done)");
    expect(cssBlock("\n.c-step.active .dot {")).toContain("var(--step-dot-border-active)");
    expect(cssBlock("\n.c-step-line {")).toContain("var(--step-line)");
    expect(cssBlock("\n.c-step.done + .c-step-line {")).toContain("var(--step-line-done)");
  });

  // ── 6. Reduced motion (WCAG 2.3.3): the simple input/nav state transitions are switched OFF inside
  //       prefers-reduced-motion: reduce (mutation-robust — removing the guard or the .c-check entry
  //       re-fails).
  it("disables the input/nav state transitions under prefers-reduced-motion", () => {
    const reduceIdx = css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .c-check .bx,");
    expect(reduceIdx, "reduced-motion guard for the .c-* layer missing").toBeGreaterThan(-1);
    const guard = css.slice(
      reduceIdx,
      css.indexOf("}", css.indexOf("transition: none", reduceIdx)),
    );
    // Line-anchored, comma-terminated selectors so removing the standalone `.c-radio .rb,` entry is
    // caught — a bare `.contains(".c-radio .rb")` would be satisfied by the `.c-radio .rb::after`
    // substring even after the `.rb` border-color transition stopped being disabled.
    expect(guard).toContain("\n  .c-check .bx,");
    expect(guard).toContain("\n  .c-radio .rb,");
    expect(guard).toContain("\n  .c-radio .rb::after,");
    expect(guard).toContain("transition: none");
  });

  // ── 7. Breakpoint + density: responsiveness must use the named --bp-* scale (no one-off
  //       breakpoint), and the input controls must track the compact-density control sizing.
  it("uses the named --bp-sm breakpoint for the form-grid collapse (no one-off)", () => {
    expect(css, "--bp-sm scale token missing").toContain("--bp-sm: 640px");
    // the governed form-grid collapse is marked with the --bp-sm provenance comment; assert it
    // collapses .c-form-grid to one column and that its enclosing @media is exactly the --bp-sm
    // (640px) scale step — not a one-off breakpoint.
    const bpIdx = css.indexOf("/* --bp-sm */");
    expect(bpIdx, "governed form-grid breakpoint marker missing").toBeGreaterThan(-1);
    const block = css.slice(bpIdx, css.indexOf("}", css.indexOf("grid-template-columns", bpIdx)));
    expect(block).toContain(".c-form-grid");
    expect(block).toContain("grid-template-columns: 1fr");
    const mediaIdx = css.lastIndexOf("@media", bpIdx);
    expect(mediaIdx, "form-grid collapse not inside a media query").toBeGreaterThan(-1);
    const mediaHeader = css.slice(mediaIdx, css.indexOf("{", mediaIdx));
    expect(mediaHeader).toContain("max-width: 640px");
  });

  it("drives input control sizing through the compact-density control tokens", () => {
    // compact density tightens the control height (must stay above the accessible target floor).
    const compact = cssBlock('[data-density="compact"]');
    expect(compact).toContain("--control-height: 30px");
    // the input controls read --control-height, so compact density tightens them automatically.
    expect(cssBlock("\n.c-stepper input {")).toContain("height: var(--control-height)");
    expect(cssBlock("\n.c-datefield {")).toContain("height: var(--control-height)");
    expect(cssBlock("\n.c-combo-input {")).toContain("min-height: var(--control-height)");
  });

  it("keeps tag remove buttons at the WCAG 2.2 target-size floor", () => {
    const button = cssBlock("\n.c-tag button {");
    expect(button).toContain("width: 24px");
    expect(button).toContain("height: 24px");
    expect(button).toContain("line-height: 1");
  });

  it("keeps the file dropzone keyboard-focusable as a real button primitive", () => {
    const drop = cssBlock("\n.c-drop {");
    expect(drop).toContain("appearance: none");
    expect(drop).toContain("font: inherit");
    expect(drop).toContain("width: 100%");
    expect(designSystemInputsHtml).toContain(
      '<button class="c-drop" id="drop" type="button" aria-describedby="drop-help">',
    );
  });

  it("pins the reference input demo name/role/value repairs", () => {
    expect(designSystemInputsHtml).toContain('aria-labelledby="temperature-label"');
    expect(designSystemInputsHtml).toContain('aria-labelledby="max-tokens-label"');
    expect(designSystemInputsHtml).toContain('aria-labelledby="parallel-runs-label"');
    expect(designSystemInputsHtml).toContain('aria-labelledby="reviewers-label"');
    expect(designSystemInputsHtml).toContain('aria-label="Remove @maya"');
    expect(designSystemInputsHtml).toContain('"Remove " + v');
    expect(designSystemInputsHtml).toContain(
      'role="spinbutton" aria-label="Day" aria-valuemin="1" aria-valuemax="31" aria-valuenow="21"',
    );
    expect(designSystemInputsHtml).toContain(
      'role="spinbutton" aria-label="Month" aria-valuemin="1" aria-valuemax="12" aria-valuenow="6"',
    );
    expect(designSystemInputsHtml).toContain(
      'role="spinbutton" aria-label="Year" aria-valuemin="2026" aria-valuemax="2030" aria-valuenow="2026"',
    );
  });

  it("pins context-menu keyboard entry in the navigation reference demo", () => {
    expect(designSystemNavHtml).toContain('role="menu" aria-label="Row actions"');
    expect(designSystemNavHtml).toContain('aria-orientation="vertical"');
    expect(designSystemNavHtml).toContain('role="menuitem" tabindex="0"');
  });

  it("makes the #1298 evidence harness prove focus and responsive viewport coverage", () => {
    expect(evidenceHarness1298).toContain("const FOCUS_TARGETS = [");
    expect(evidenceHarness1298).toContain("collectFocusProof");
    expect(evidenceHarness1298).toContain('contrast: "no-preference"');
    expect(evidenceHarness1298).toContain('forcedColors: "none"');
    expect(evidenceHarness1298).toContain('reducedMotion: "no-preference"');
    expect(evidenceHarness1298).toContain('"10-tablet.png"');
    expect(evidenceHarness1298).toContain('"11-ultrawide.png"');
    expect(evidenceHarness1298).toContain('"12-focus-visible.png"');
    expect(evidenceHarness1298).toContain("Keyboard Tab proof");
  });

  it("pins the regenerated #1298 proof manifest for focus and viewport evidence", () => {
    const focusTargetIds = [
      "checkbox",
      "radio",
      "slider",
      "stepper",
      "combobox",
      "tag-remove",
      "dropzone",
      "date-calendar",
      "breadcrumb",
      "back",
      "tab",
      "pagination",
      "context-menu",
    ];
    expect(computedProof1298.keyboardFocus.targetCount).toBe(focusTargetIds.length);
    for (const id of focusTargetIds) {
      expect(computedProof1298.keyboardFocus.targets[id]?.ok, `${id} focus proof`).toBe(true);
    }
    expect(computedProof1298.screenshots.compactDensity).toBe("08-compact-density.png");
    expect(computedProof1298.screenshots.focusVisible).toBe("12-focus-visible.png");
    expect(computedProof1298.screenshots.responsiveViewports).toEqual([
      { fileName: "09-responsive.png", width: 560, height: 1700, label: "mobile responsive" },
      { fileName: "10-tablet.png", width: 900, height: 1700, label: "tablet" },
      { fileName: "11-ultrawide.png", width: 1920, height: 1700, label: "ultrawide" },
    ]);
  });

  // ── 8. Purity gate for the ported canonical layer: parse every .c-* input/nav rule and assert
  //       none reintroduces a raw aliased primitive. The reference reads the component tokens + the
  //       semantic tier only; the sole legitimate raw reads are the brand --accent and the semantic
  //       --feedback-danger inside color-mix() hover tints, which are NOT in the forbidden set.
  it("keeps the canonical .c-* input/nav layer free of raw aliased primitives (scope-wide)", () => {
    const forbidden = [
      "--bg",
      "--surface",
      "--card-2",
      "--card",
      "--inset",
      "--fg-muted",
      "--fg-dim",
      "--fg-faint",
      "--fg",
      "--line-soft",
      "--line-strong",
      "--line",
      "--danger",
      "--warn",
      "--ok",
      "--accent-text",
      "--accent-line",
      "--accent-dim",
      "--accent-solid-ink",
      "--accent-solid",
      "--accent-bright",
      "--accent-on-tint",
    ];
    const escapeRegExp = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bodyForbidden = (body: string): readonly string[] =>
      forbidden.filter((tok) => new RegExp(`var\\(\\s*${escapeRegExp(tok)}\\s*[),]`).test(body));
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    let inputNavRulesChecked = 0;
    const offenders: string[] = [];
    const scope =
      /(^|[\s,>+])\.(c-check|c-radio|c-slider|c-stepper|c-combo|c-tag|c-tagfield|c-drop|c-fileitem|c-datefield|c-form|c-crumbs|c-back|c-utab|c-pager|c-ctx|c-step)[a-z0-9-]*/u;
    while ((match = ruleRe.exec(source)) !== null) {
      const selector = (match[1] ?? "").trim().replace(/\s+/g, " ");
      const body = match[2] ?? "";
      if (selector === "" || selector.startsWith("@")) continue;
      if (!scope.test(selector)) continue;
      inputNavRulesChecked++;
      for (const tok of bodyForbidden(body)) {
        offenders.push(`${selector} { … var(${tok}) … }`);
      }
    }
    expect(inputNavRulesChecked).toBeGreaterThan(60);
    expect(
      offenders,
      `canonical .c-* input/nav rules must read the component/semantic tier, not raw primitives:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// ─── Issue #1299 — component state matrix drift gate ──────────────────────────
//
// Pins the docs/design-system/state-matrix.md applicability matrix cell-for-cell against the
// canonical ROWS array in design-system/states.html. A single flipped cell in either source
// causes the "cell for cell" test to fail on the exact row, naming the component.
//
// Parser: the ROWS array is extracted from the slice of states.html between 'var ROWS =' and
// its closing '];' using an anchored regex — any mutation to a component name or bitstring
// lands outside the pattern and fails the exact-row assertion below.
//
// The state-matrix.md table parser mirrors the harness in
// docs/design-system/evidence/1299/equivalence-harness.mjs so the two gates stay in sync.

describe("Issue #1299 — component state matrix", () => {
  const statesHtmlPath = resolve(here, "../../../../design-system/states.html");
  const stateMatrixPath = resolve(here, "../../../../docs/design-system/state-matrix.md");
  const statesHtml = readFileSync(statesHtmlPath, "utf8");
  const stateMatrixMd = readFileSync(stateMatrixPath, "utf8");

  // ── Parse ROWS out of states.html ────────────────────────────────────────────
  // Slice from 'var ROWS =' to the closing '];' to anchor the regex so it cannot
  // match rows that appear elsewhere in the file.
  function parseRows(): Array<readonly [string, string]> {
    const start = statesHtml.indexOf("var ROWS =");
    const end = statesHtml.indexOf("];", start);
    expect(start, "var ROWS = not found in states.html").toBeGreaterThan(-1);
    expect(end, "closing ]; for ROWS not found in states.html").toBeGreaterThan(-1);
    const slice = statesHtml.slice(start, end + 2);
    const rowRe = /\[\s*"([^"]+)"\s*,\s*"([01]{11})"\s*\]/g;
    const rows: Array<readonly [string, string]> = [];
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(slice)) !== null) {
      const name = m[1];
      const bits = m[2];
      if (name !== undefined && bits !== undefined) rows.push([name, bits]);
    }
    return rows;
  }

  // ── Parse applicability table out of state-matrix.md ─────────────────────────
  // The header row has 12 cells (Component + 11 state columns). The separator row
  // has cells matching /^[-:\s]+$/. Data rows: cell[0] is the component name,
  // cells[1..11] are "1" if the trimmed cell contains "✓", else "0".
  function parseMatrixMd(): Array<readonly [string, string]> {
    const lines = stateMatrixMd.split("\n");
    const rows: Array<readonly [string, string]> = [];
    for (const line of lines) {
      if (!line.startsWith("|")) continue;
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length !== 12) continue;
      const first = cells[0];
      if (first === undefined) continue;
      if (first === "Component") continue;
      const second = cells[1];
      if (second !== undefined && /^[-:\s]+$/.test(second)) continue;
      const bits = cells
        .slice(1)
        .map((c) => (c.includes("✓") ? "1" : "0"))
        .join("");
      rows.push([first, bits]);
    }
    return rows;
  }

  function parseStateMeta(): Array<{
    readonly key: string;
    readonly label: string;
    readonly group: string;
    readonly icon: string;
  }> {
    const match = statesHtml.match(/var STATE_META\s*=\s*\[([\s\S]*?)\];/);
    expect(match, "var STATE_META block not found in states.html").toBeTruthy();
    const slice = match![1]!;
    const rowRe =
      /\{\s*key:\s*"([a-z])"\s*,\s*label:\s*"([^"]+)"\s*,\s*group:\s*"([^"]+)"\s*,\s*icon:\s*"([^"]*)"\s*\}/g;
    const rows: Array<{
      readonly key: string;
      readonly label: string;
      readonly group: string;
      readonly icon: string;
    }> = [];
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(slice)) !== null) {
      const [, key, label, group, icon] = m;
      if (key !== undefined && label !== undefined && group !== undefined && icon !== undefined) {
        rows.push({ key, label, group, icon });
      }
    }
    return rows;
  }

  // ── 1. Canonical state keys in order ─────────────────────────────────────────
  // Mutation-robust: inverting or reordering any key in the STATES array re-fails.
  it("states.html declares the 11 canonical state keys in order", () => {
    // The STATES line in states.html must contain the exact keys in the exact order.
    const statesLineMatch = statesHtml.match(/var STATES\s*=\s*(\[[^\]]+\])/);
    expect(statesLineMatch, "var STATES line not found in states.html").toBeTruthy();
    const statesLine = statesLineMatch![0]!;
    const expected = ["d", "h", "f", "a", "s", "x", "l", "e", "m", "y", "c"];
    // Extract quoted single-char keys in order from the array literal.
    const found = [...statesLine.matchAll(/"([a-z])"/g)].map((m) => m[1]);
    expect(found).toEqual(expected);
  });

  // ── 2. Cell-for-cell equivalence between states.html ROWS and state-matrix.md ─
  // The test fails on the exact failing row, naming the component — a single flipped
  // "1"→"0" or "0"→"1" in either source is caught with a per-row failure message.
  it("documented matrix matches the live states.html ROWS, cell for cell", () => {
    const rows = parseRows();
    expect(rows, "expected exactly 11 ROWS in states.html").toHaveLength(11);

    const docRows = parseMatrixMd();
    expect(docRows, "expected exactly 11 rows in state-matrix.md table").toHaveLength(11);

    // Build a name→bits lookup from the markdown table so name order doesn't matter.
    const docMap = new Map(docRows);

    // Reverse direction: every documented component must be a real states.html ROWS family.
    // A renamed/phantom markdown row that keeps the count at 11 is caught here (not just by length).
    const htmlNames = new Set(rows.map(([name]) => name));
    for (const [name] of docRows) {
      expect(
        htmlNames.has(name),
        `state-matrix.md documents component "${name}" which is not a states.html ROWS family`,
      ).toBe(true);
    }

    for (const [name, bits] of rows) {
      const docBits = docMap.get(name);
      expect(
        docBits,
        `state-matrix.md is missing a row for component "${name}" (found in states.html ROWS)`,
      ).toBeDefined();
      expect(
        docBits,
        `component "${name}": states.html ROWS bitstring is "${bits}" but state-matrix.md has "${docBits ?? "undefined"}" — a cell is out of sync`,
      ).toBe(bits);
    }
  });

  // ── 3. Every component family defines the Default state (column 0) ────────────
  // Mutation-robust: zeroing any Default bit re-fails on that component row.
  it("every component family defines the Default state", () => {
    const rows = parseRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const [name, bits] of rows) {
      expect(
        bits[0],
        `component "${name}" must define the Default state (column 0 must be "1")`,
      ).toBe("1");
    }
  });

  // ── 4. The four data-state token rules are documented ─────────────────────────
  // Removing or misspelling any of the four token/keyword references in state-matrix.md
  // re-fails on that specific assertion — purely additive checks on the doc text.
  it("the four data-state token rules are documented", () => {
    expect(
      stateMatrixMd,
      "state-matrix.md must document the --feedback-danger token (Error state rule)",
    ).toContain("--feedback-danger");
    expect(
      stateMatrixMd,
      "state-matrix.md must document the --feedback-info token (Syncing state rule)",
    ).toContain("--feedback-info");
    expect(
      stateMatrixMd,
      "state-matrix.md must document the --feedback-warning token (Conflict state rule)",
    ).toContain("--feedback-warning");
    expect(
      stateMatrixMd,
      "state-matrix.md must document the skeleton token rule (Loading state)",
    ).toContain("skeleton");
  });

  // ── 5. The live proof generator exposes state markers and non-colour metadata ─
  // The Playwright harness renders these markers and fails if any checked matrix cell
  // lacks a proof element. This static gate prevents accidental removal of the
  // marker attributes or the data/sync glyph metadata the harness depends on.
  it("states.html generates live proof markers for every applicable state", () => {
    expect(statesHtml).toContain('id="state-proof"');
    expect(statesHtml).toContain('data-family="');
    expect(statesHtml).toContain('data-state="');
    expect(statesHtml).toContain("data-state-icon");
    expect(statesHtml).toContain("data-state-label");
    expect(statesHtml).toContain('data-noncolor="true"');
    expect(statesHtml).toContain("ROWS.map(function (r)");
    expect(statesHtml).toContain("stateChip(r[0], STATES[index])");

    const expectedKeys = ["d", "h", "f", "a", "s", "x", "l", "e", "m", "y", "c"];
    const dataSyncKeys = new Set(["l", "e", "m", "y", "c"]);
    const meta = parseStateMeta();
    expect(meta.map((row) => row.key)).toEqual(expectedKeys);

    const rows = parseRows();
    const checkedCellCount = rows.reduce(
      (sum, [, bits]) => sum + [...bits].filter((bit) => bit === "1").length,
      0,
    );
    expect(checkedCellCount, "expected the matrix to contain checked state cells").toBeGreaterThan(
      0,
    );

    for (const row of meta) {
      if (dataSyncKeys.has(row.key)) {
        expect(row.group, `state ${row.label} must be classified as data-sync`).toBe("data-sync");
        expect(row.icon.trim(), `state ${row.label} must define a non-colour glyph`).not.toBe("");
      }
    }
  });
});

// ─── Issue #1300 — consolidated visual-regression + designer-acceptance gate ─────
//
// Epic #1290 closure capstone. The browser harnesses under docs/design-system/evidence/1300 are the
// live re-runnable proofs; this block is the CI-enforced contract that pins their committed verdicts,
// the variance register, and the migrated-surface inventory against the product globals.css so the
// epic acceptance evidence cannot silently drift. A single revert (a dropped surface, a flipped
// verdict, a deleted variance disposition, a missing child-evidence link) re-fails a named assertion.

interface Issue1300ConsolidatedProof {
  readonly verdict: string;
  readonly postCssSha256: string;
  readonly referenceFiles: readonly string[];
  readonly groupR: { readonly totalProbes: number; readonly gatedDiffCount: number };
  readonly accentDerived: { readonly byMode: Record<string, unknown> };
  readonly accessibilityProof: {
    readonly focusProof: { readonly activeIsBack: boolean; readonly hasFocusRing: boolean };
    readonly nameRoleValue: { readonly comboRole: string; readonly gridSort: string };
  };
  readonly boundedRowSmoke: {
    readonly ok: boolean;
    readonly rowCount: number;
    readonly durationMs: number;
    readonly afterScrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
    readonly stickyHeaderDeltaPx: number;
  };
  readonly missingSelectorCount: number;
  readonly missingSelectors: readonly string[];
}
interface Issue1300EditorProof {
  readonly verdict: string;
  readonly postCssSha256: string;
  readonly tokenFidelity: { readonly totalProbes: number; readonly gatedDiffCount: number };
  readonly accentDerived: { readonly tokens: readonly string[] };
  readonly referenceOnly: {
    readonly tokens: readonly string[];
    readonly ownerEpics: readonly string[];
  };
  readonly referenceCaptureSummary: {
    readonly expectedCount: number;
    readonly actualCount: number;
    readonly errorCount: number;
  };
  readonly missingReferenceTokenCount: number;
}
interface Issue1300A11yProof {
  readonly verdict: string;
  readonly postCssSha256: string;
  readonly seriousCriticalTotal: number;
  readonly unresolvedIncomplete: readonly unknown[];
  readonly deterministicChecksByMode: Record<
    string,
    {
      readonly mediaProbe: {
        readonly reducedMotion: boolean;
        readonly forcedColors: boolean;
        readonly prefersContrast: boolean;
      };
      readonly noPositiveTabIndex: boolean;
      readonly namedControlCount: number;
      readonly unnamedControls: readonly unknown[];
      readonly allFocusTargetsVisible: boolean;
      readonly reducedMotionDurations: readonly {
        readonly transitionDuration: string;
        readonly animationDuration: string;
      }[];
      readonly forcedColorProbe: {
        readonly borderTopColor: string;
      };
    }
  >;
  readonly byMode: Record<
    string,
    {
      readonly seriousCriticalCount: number;
      readonly incompleteCount: number;
      readonly passRules: readonly unknown[];
      readonly incomplete: readonly unknown[];
    }
  >;
}
interface Issue1300BrowserManifest {
  readonly shotCount: number;
  readonly modes: readonly string[];
  readonly viewports: readonly string[];
  readonly scenarios: readonly {
    readonly id: string;
    readonly requiredSelectors: readonly string[];
  }[];
  readonly manifest: readonly {
    readonly file: string;
    readonly scenario: string;
    readonly viewport: string;
    readonly mode: string;
    readonly requiredSelectors: readonly string[];
    readonly hasShell: boolean;
    readonly windowCount: number;
    readonly missingRequiredSelectors: readonly string[];
    readonly pageErrors: readonly string[];
  }[];
}

function cssDurationSeconds(value: string): number {
  const trimmed = value.trim();
  if (trimmed.endsWith("ms")) return Number.parseFloat(trimmed) / 1000;
  if (trimmed.endsWith("s")) return Number.parseFloat(trimmed);
  return Number(trimmed);
}

function maxCssDurationSeconds(
  durations: readonly { readonly transitionDuration: string; readonly animationDuration: string }[],
): number {
  return Math.max(
    0,
    ...durations.flatMap((entry) =>
      [entry.transitionDuration, entry.animationDuration].flatMap((value) =>
        value
          .split(",")
          .map(cssDurationSeconds)
          .filter((duration) => Number.isFinite(duration)),
      ),
    ),
  );
}

describe("Issue #1300 — consolidated visual-regression + designer-acceptance gate", () => {
  const evidenceDir = resolve(here, "../../../..", "docs/design-system/evidence/1300");
  const consolidatedProof = JSON.parse(
    readFileSync(resolve(evidenceDir, "consolidated-fidelity-proof.json"), "utf8"),
  ) as unknown as Issue1300ConsolidatedProof;
  const editorProof = JSON.parse(
    readFileSync(resolve(evidenceDir, "editor/editor-fidelity-proof.json"), "utf8"),
  ) as unknown as Issue1300EditorProof;
  const a11yProof = JSON.parse(
    readFileSync(resolve(evidenceDir, "a11y/a11y-proof.json"), "utf8"),
  ) as unknown as Issue1300A11yProof;
  const browserManifest = JSON.parse(
    readFileSync(resolve(evidenceDir, "browser/manifest.json"), "utf8"),
  ) as unknown as Issue1300BrowserManifest;
  const visualRegressionMd = readFileSync(
    resolve(here, "../../../..", "docs/design-system/visual-regression.md"),
    "utf8",
  );
  const adr0051 = readFileSync(
    resolve(
      here,
      "../../../..",
      "docs/adr/ADR-0051-design-system-visual-regression-and-acceptance-gate.md",
    ),
    "utf8",
  );

  // ── 1. Component reference fidelity gate is green and broad ───────────────────
  it("the consolidated component fidelity proof passes with zero gated diffs", () => {
    expect(consolidatedProof.verdict, "consolidated harness must record PASS").toBe("PASS");
    expect(
      consolidatedProof.postCssSha256,
      "committed consolidated proof must be generated from the current globals.css",
    ).toBe(currentCssSha256);
    expect(
      consolidatedProof.groupR.gatedDiffCount,
      "every neutral migrated surface must resolve identically to the DS reference (dark+light)",
    ).toBe(0);
    expect(consolidatedProof.missingSelectorCount, "missing selectors must fail the proof").toBe(0);
    expect(consolidatedProof.missingSelectors).toEqual([]);
    expect(
      consolidatedProof.groupR.totalProbes,
      "the consolidated gate must cover the full migrated-surface union, not a token sample",
    ).toBeGreaterThanOrEqual(400);
    // No probe selector may be silently absent — a renamed/dropped migrated surface must surface here.
    expect(
      consolidatedProof.missingSelectors,
      "every probed surface must exist in both product and reference (no silently-dropped probes)",
    ).toEqual([]);
  });

  it("the consolidated proof concatenates every migrated 0.4.0 component layer", () => {
    for (const file of [
      "keiko-tokens.css",
      "keiko-semantic-tokens.css",
      "keiko-ai.css",
      "keiko-data.css",
      "keiko-dataviz.css",
      "keiko-inputs.css",
      "keiko-nav.css",
    ]) {
      expect(
        consolidatedProof.referenceFiles,
        `reference chain must include ${file} so its surfaces are gated`,
      ).toContain(file);
    }
  });

  // ── 2. Accessibility + performance smokes are green ───────────────────────────
  it("the accessibility proof records zero serious/critical violations in every mode", () => {
    expect(a11yProof.verdict).toBe("PASS");
    expect(a11yProof.postCssSha256, "committed a11y proof must pin current globals.css").toBe(
      currentCssSha256,
    );
    expect(a11yProof.seriousCriticalTotal).toBe(0);
    expect(a11yProof.unresolvedIncomplete).toEqual([]);
    const modes = Object.keys(a11yProof.byMode);
    expect(modes.length, "axe must run across the full 7-mode matrix").toBe(7);
    for (const [mode, r] of Object.entries(a11yProof.byMode)) {
      expect(
        r.seriousCriticalCount,
        `mode ${mode} must have no serious/critical a11y violation`,
      ).toBe(0);
      expect(
        r.passRules.length,
        `mode ${mode} must serialize rule-level pass evidence`,
      ).toBeGreaterThan(20);
    }
    for (const [mode, checks] of Object.entries(a11yProof.deterministicChecksByMode)) {
      const expectedReducedMotion = mode === "07-reduced-motion";
      const expectedForcedColors = mode === "06-forced-colors";
      const expectedPrefersContrast = mode === "05-prefers-contrast";
      expect(
        checks.mediaProbe.reducedMotion,
        `mode ${mode} must explicitly set/reset prefers-reduced-motion`,
      ).toBe(expectedReducedMotion);
      expect(
        checks.mediaProbe.forcedColors,
        `mode ${mode} must explicitly set/reset forced-colors`,
      ).toBe(expectedForcedColors);
      expect(
        checks.mediaProbe.prefersContrast,
        `mode ${mode} must explicitly set/reset prefers-contrast`,
      ).toBe(expectedPrefersContrast);
      expect(checks.noPositiveTabIndex, `mode ${mode} must not contain positive tabindex`).toBe(
        true,
      );
      expect(
        checks.namedControlCount,
        `mode ${mode} must expose named controls`,
      ).toBeGreaterThanOrEqual(10);
      expect(checks.unnamedControls, `mode ${mode} must not expose unnamed controls`).toEqual([]);
      expect(
        checks.allFocusTargetsVisible,
        `mode ${mode} must keep visible focus indicators on representative controls`,
      ).toBe(true);
      if (expectedReducedMotion) {
        expect(
          maxCssDurationSeconds(checks.reducedMotionDurations),
          `mode ${mode} must prove representative transitions/animations are reduced`,
        ).toBeLessThanOrEqual(0.01);
      }
      if (expectedForcedColors) {
        expect(
          checks.forcedColorProbe.borderTopColor,
          `mode ${mode} must activate forced-colors styling`,
        ).not.toBe("rgba(0, 0, 0, 0)");
      } else {
        expect(
          checks.forcedColorProbe.borderTopColor,
          `mode ${mode} must reset forced-colors styling`,
        ).toBe("rgba(0, 0, 0, 0)");
      }
    }
  });

  it("the consolidated proof carries the a11y + performance smokes", () => {
    expect(consolidatedProof.accessibilityProof.focusProof.activeIsBack).toBe(true);
    expect(consolidatedProof.accessibilityProof.focusProof.hasFocusRing).toBe(true);
    expect(consolidatedProof.accessibilityProof.nameRoleValue.comboRole).toBe("combobox");
    expect(consolidatedProof.accessibilityProof.nameRoleValue.gridSort).toBe("descending");
    expect(consolidatedProof.boundedRowSmoke.ok).toBe(true);
    expect(consolidatedProof.boundedRowSmoke.rowCount).toBe(250);
    expect(consolidatedProof.boundedRowSmoke.durationMs).toBeLessThanOrEqual(250);
    expect(consolidatedProof.boundedRowSmoke.afterScrollTop).toBeGreaterThan(0);
    expect(consolidatedProof.boundedRowSmoke.scrollHeight).toBeGreaterThan(
      consolidatedProof.boundedRowSmoke.clientHeight,
    );
    expect(consolidatedProof.boundedRowSmoke.stickyHeaderDeltaPx).toBeLessThanOrEqual(4);
  });

  it("the running-app browser bundle covers shell plus seeded high-traffic workspace windows", () => {
    expect(browserManifest.modes).toEqual([
      "dark",
      "light",
      "dark-hc",
      "light-hc",
      "reduced-motion",
      "forced-colors",
    ]);
    expect(browserManifest.viewports).toEqual(["desktop", "tablet", "mobile"]);
    const expectedScenarios = [
      "git-window-constrained",
      "git-window-desktop",
      "shell",
      "workspace-chat-quality",
      "workspace-files-editor",
      "workspace-memory-relationships",
    ];
    expect(browserManifest.scenarios.map((scenario) => scenario.id).sort()).toEqual(
      expectedScenarios,
    );
    // 3 viewports x 6 modes x 6 scenarios. Issue #1574 (EV3) added the git-window-desktop and
    // git-window-constrained scenarios, lifting the matrix from 72 to 108 captured cells.
    expect(browserManifest.shotCount).toBe(108);
    expect(browserManifest.manifest.length).toBe(108);
    const expectedCells = new Set(
      browserManifest.viewports.flatMap((viewport) =>
        browserManifest.modes.flatMap((mode) =>
          browserManifest.scenarios.map((scenario) => `${viewport}/${mode}/${scenario.id}`),
        ),
      ),
    );
    const seenCells = new Set<string>();
    for (const shot of browserManifest.manifest) {
      const cell = `${shot.viewport}/${shot.mode}/${shot.scenario}`;
      expect(expectedCells.has(cell), `${cell} must be a declared viewport/mode/scenario`).toBe(
        true,
      );
      expect(seenCells.has(cell), `${cell} must be unique in the screenshot manifest`).toBe(false);
      seenCells.add(cell);
      expect(shot.file, `${cell} must use the deterministic screenshot filename`).toBe(
        `${shot.viewport}__${shot.scenario}__${shot.mode}.png`,
      );
      const screenshotPath = resolve(evidenceDir, "browser", shot.file);
      expect(existsSync(screenshotPath), `${shot.file} must be committed with the manifest`).toBe(
        true,
      );
      expect(readFileSync(screenshotPath).length, `${shot.file} must not be empty`).toBeGreaterThan(
        0,
      );
      expect(
        shot.hasShell,
        `${shot.viewport}/${shot.mode}/${shot.scenario} must render shell`,
      ).toBe(true);
      expect(
        shot.pageErrors,
        `${shot.viewport}/${shot.mode}/${shot.scenario} must have no page errors`,
      ).toEqual([]);
      expect(
        shot.missingRequiredSelectors,
        `${shot.viewport}/${shot.mode}/${shot.scenario} must render every required selector`,
      ).toEqual([]);
      if (shot.scenario !== "shell") {
        // Every seeded window must mount. Count the distinct window-frame selectors the scenario
        // declares (a bare `[data-window-id="…"]` with no descendant combinator) rather than all
        // required selectors, so scenarios that additionally assert in-window IA (e.g. the Git client
        // shell's toolbar/tablist/changed-files structure) are not mistaken for extra seeded windows.
        const seededWindowSelectors = new Set(
          shot.requiredSelectors.filter((selector) =>
            /^\[data-window-id="[^"]+"\]$/u.test(selector.trim()),
          ),
        );
        expect(
          shot.windowCount,
          `${shot.viewport}/${shot.mode}/${shot.scenario} high-traffic shot must render seeded windows`,
        ).toBeGreaterThanOrEqual(seededWindowSelectors.size);
      }
    }
    expect([...seenCells].sort()).toEqual([...expectedCells].sort());
  });

  // ── 3. Editor matrix gate + carried-forward variance ──────────────────────────
  it("the editor token-fidelity proof passes with zero gated diffs", () => {
    expect(editorProof.verdict, "editor harness must record PASS").toBe("PASS");
    expect(editorProof.postCssSha256, "committed editor proof must pin current globals.css").toBe(
      currentCssSha256,
    );
    expect(
      editorProof.tokenFidelity.gatedDiffCount,
      "every product-defined editor token must resolve identically to the DS editor reference",
    ).toBe(0);
    expect(editorProof.missingReferenceTokenCount).toBe(0);
    expect(editorProof.referenceCaptureSummary.expectedCount).toBe(14);
    expect(editorProof.referenceCaptureSummary.actualCount).toBe(14);
    expect(editorProof.referenceCaptureSummary.errorCount).toBe(0);
    expect(editorProof.tokenFidelity.totalProbes).toBeGreaterThanOrEqual(150);
  });

  it("the editor reference-only variance is exactly the three unadopted tokens owned by #1373/#1390", () => {
    expect([...editorProof.referenceOnly.tokens].sort()).toEqual([
      "--ed-blame-fg",
      "--ed-fold-placeholder",
      "--ed-inlay-fg",
    ]);
    expect(editorProof.referenceOnly.ownerEpics).toContain("#1373");
    expect(editorProof.referenceOnly.ownerEpics).toContain("#1390");
    // These tokens must remain unadopted in the product (otherwise the variance is resolved, not carried).
    for (const t of editorProof.referenceOnly.tokens) {
      expect(css.includes(`${t}:`), `${t} is reference-only; product must not declare it yet`).toBe(
        false,
      );
    }
  });

  it("the editor accent-derived bucket records the four accent tokens (not gated)", () => {
    for (const t of ["--ed-statusbar-accent", "--ed-selection", "--ed-agent-line", "--ed-focus"]) {
      expect(editorProof.accentDerived.tokens, `${t} must be recorded as accent-derived`).toContain(
        t,
      );
    }
  });

  // ── 4. Variance register + tolerance + retention are documented ───────────────
  it("visual-regression.md records the tolerance, the approved accent delta, and Light Mode", () => {
    expect(visualRegressionMd).toContain("≤ 1 LSB");
    expect(
      visualRegressionMd,
      "the pre-existing ~1.5% accent delta must be the approved deviation",
    ).toContain("1.5%");
    expect(visualRegressionMd).toContain("#4eba87");
    expect(visualRegressionMd, "Light Mode must be a mandatory acceptance surface").toContain(
      "Light Mode",
    );
    expect(visualRegressionMd).toContain("Human Review Required");
  });

  it("the final evidence links back to every child issue affected by the 0.4.0 update", () => {
    for (const child of ["1292", "1293", "1294", "1295", "1296", "1297", "1298", "1299"]) {
      expect(visualRegressionMd, `final evidence must link child #${child}`).toContain(
        `evidence/${child}/`,
      );
    }
  });

  it("the variance register dispositions the carried-forward editor tokens to #1373/#1390", () => {
    expect(visualRegressionMd).toContain("--ed-inlay-fg");
    expect(visualRegressionMd).toContain("#1373");
    expect(visualRegressionMd).toContain("#1390");
  });

  it("ADR-0051 records the gate as additive and never weakening prior gates", () => {
    expect(adr0051).toContain("never weaken");
    expect(adr0051).toContain("ADR-0049");
    expect(adr0051).toContain("ADR-0050");
  });

  // ── 5. Migrated surfaces still exist in the product (drift guard) ──────────────
  it("every surface the consolidated proof covers is still defined in the product CSS", () => {
    for (const selector of [
      ".ai-tool {",
      ".ai-response {",
      ".c-table {",
      ".viz-bar {",
      ".c-check {",
      ".c-combo-input {",
      ".c-crumbs {",
      ".c-steps {",
    ]) {
      expect(
        css.includes(selector),
        `migrated surface "${selector}" must remain in globals.css`,
      ).toBe(true);
    }
    expect(
      css.includes("--ed-syn-keyword:"),
      "editor syntax token must remain in globals.css",
    ).toBe(true);
    expect(css.includes("--accent:"), "brand accent primitive must remain in globals.css").toBe(
      true,
    );
  });
});

// ADR-0057 D2 — drift gate pinning the ContextStatusPanel into the shared grounded-evidence
// disclosure chrome. Context and Evidence must read as one coherent audit stack instead of two
// unrelated panels.
describe("PR6 context status panel — shared evidence disclosure styling pin (ADR-0057 D2)", () => {
  it("defines the .ctx-status container and shared grounded-evidence disclosure selectors", () => {
    for (const selector of [
      ".ctx-status {",
      ".ctx-status-dl {",
      ".grounded-evidence-disclosure {",
      ".grounded-evidence-summary {",
      ".grounded-evidence-summary-title {",
      ".grounded-evidence-summary-meta {",
      ".grounded-evidence-body {",
    ]) {
      expect(css.includes(selector), `${selector} must remain in globals.css`).toBe(true);
    }
    expect(
      css.includes(".grounded-evidence-summary:hover {"),
      "the shared quiet summary must brighten on hover",
    ).toBe(true);
  });

  it("styles the shared Context/Evidence disclosure with existing semantic tokens", () => {
    const block = css.slice(
      css.indexOf(".grounded-evidence-disclosure {"),
      css.indexOf(".grounded-citations-wrap {"),
    );
    expect(block.length).toBeGreaterThan(0);
    for (const token of [
      "var(--border-subtle)",
      "var(--surface-primary)",
      "var(--text-secondary)",
      "var(--text-primary)",
      "var(--font-mono)",
    ]) {
      expect(block.includes(token), `.ctx-* block must use ${token}`).toBe(true);
    }
  });
});
