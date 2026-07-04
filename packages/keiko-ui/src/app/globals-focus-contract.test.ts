/**
 * globals.css keyboard focus-ring contract — W10 a11y remediation (test-plan #21/#59)
 *
 * These tests parse the raw CSS text to assert that the additive keyboard-modality
 * :focus-visible rings introduced by the css-focus-rings remediation are present, so
 * keyboard users get a visible focus indicator on the shared KeikoSelect trigger, the
 * task-workspace switcher, the Twin tabs, and the QI candidate accordion (WCAG 2.4.7).
 *
 * Each assertion is crafted so that reverting the specific rule causes the test to fail.
 * Unlike globals.css.test.ts these do NOT depend on the SHA-pinned #1300 proof, so they
 * stay green independently of proof regeneration.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "globals.css"), "utf8").replace(/\r\n?/g, "\n");
// Whitespace-normalised copy so multi-line selector lists (e.g. the :is() group)
// match regardless of how the formatter wraps them.
const cssCompact = css.replace(/\s+/g, " ");

describe("globals.css keyboard focus-ring contract", () => {
  it("gives the shared .ksel-trigger a base keyboard focus-visible ring (GEN-UI-A11Y-007)", () => {
    expect(cssCompact).toContain('[data-input-modality="keyboard"] .ksel-trigger:focus-visible');
  });

  it("gives the task-workspace switcher trigger and row actions a focus ring (GEN-UI-FOCUS-017)", () => {
    expect(css).toContain(".tw-switcher-trigger:focus-visible");
    expect(css).toContain(".tw-switcher-action:focus-visible");
  });

  it("covers .twin-tab with a keyboard-modality :focus-visible rule (GEN-UI-FOCUS-008)", () => {
    // Match the :is(...) group defensively: keyboard modality + .twin-tab + :focus-visible
    // must all appear inside the same rule, regardless of line wrapping.
    const isGroup = cssCompact.match(
      /\[data-input-modality="keyboard"\][^{]*:is\(([^)]*)\):focus-visible/g,
    );
    expect(isGroup).not.toBeNull();
    expect(isGroup?.some((rule) => rule.includes(".twin-tab"))).toBe(true);
  });

  it("gives the QI candidate accordion summary a focus ring (GEN-UI-VISUAL-005)", () => {
    expect(css).toContain(".qi-cand-accordion-summary:focus-visible");
  });

  it("declares exactly one .gpref-slider:focus-visible block (GEN-UI-VISUAL-006 dedupe)", () => {
    const matches = css.match(/\.gpref-slider:focus-visible/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
