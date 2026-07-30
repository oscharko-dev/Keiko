/**
 * The coverage contract of the real-browser axe smoke (`tests/e2e/a11y.smoke.spec.ts`).
 *
 * GEN-TEST-E2E-004 wired the first real-browser axe gate, but it scanned exactly two surfaces — the
 * desktop shell and a seeded chat window — in the default theme with no dialog open. That left the
 * 0.3.0 release with NO real-browser contrast or a11y proof for the light theme, for the in-app
 * high-contrast step, for forced colours, or for any modal — including the destructive confirms,
 * whose danger styling is the one place in the product where the palette is deliberately pushed.
 * jsdom cannot answer any of it: `jest-axe` in jsdom has no layout and no computed colours, so
 * `color-contrast` is skipped there entirely.
 *
 * The contract lives in its own module (no Playwright import, so a vitest gate can read it) for two
 * reasons: the spec derives its cases from it, so a surface cannot be dropped from the matrix
 * without the generated tests disappearing with it, and `a11y-smoke-coverage.static.test.ts` pins
 * the matrix itself so the lane cannot quietly shrink back to "two surfaces, one theme".
 */

/** Both product themes. `keiko.theme` defaults to `dark`, which is why light had no proof at all. */
export const A11Y_THEMES = ["dark", "light"] as const;
export type A11yTheme = (typeof A11Y_THEMES)[number];

/**
 * The contrast conditions the shell claims to support.
 *
 * - `baseline` — no contrast preference asserted.
 * - `high-contrast` — `prefers-contrast: more` plus the in-app `[data-hc="more"]` token step, which
 *   `globals.css` keys on independently of the media query.
 * - `forced-colors` — `forced-colors: active`. This IS drivable here: Playwright's
 *   `page.emulateMedia({ forcedColors: "active" })` is supported by the chromium project this lane
 *   runs, and the #1300/#2253 evidence specs already use it. What it does NOT do is prove authored
 *   contrast: under forced colours the UA replaces the palette with system colours, so a scan in
 *   this mode proves the surface stays operable and structurally sound, not that Keiko's own tokens
 *   pass. The authored ratios are what `baseline` and `high-contrast` measure.
 */
export const A11Y_CONTRAST_MODES = ["baseline", "high-contrast", "forced-colors"] as const;
export type A11yContrastMode = (typeof A11Y_CONTRAST_MODES)[number];

export interface A11ySurfaceContract {
  /** Stable id; also the discriminator the spec's opener table is keyed by. */
  readonly id: string;
  /** Human-readable surface name, used verbatim in the generated test titles. */
  readonly label: string;
  /** True when the scanned root is an open `aria-modal` dialog. */
  readonly modal: boolean;
  /** True when that dialog gates an irreversible action (danger palette + confirm wording). */
  readonly destructive: boolean;
}

/**
 * Every surface the axe smoke scans, in both themes. These are the surfaces a local human actually
 * operates: the launcher they land on, the palette they drive the shell from, and the three bound
 * work surfaces (Coding Workbench, Editor, Git) — plus one open destructive confirm, because a
 * modal that is never opened is a modal that is never measured.
 */
export const A11Y_SURFACES: readonly A11ySurfaceContract[] = [
  { id: "launcher", label: "desktop launcher shell", modal: false, destructive: false },
  { id: "chat-window", label: "seeded chat window", modal: false, destructive: false },
  { id: "command-palette", label: "command palette", modal: true, destructive: false },
  { id: "coding-workbench", label: "bound Coding Workbench", modal: false, destructive: false },
  { id: "editor", label: "Editor window", modal: false, destructive: false },
  { id: "git-window", label: "Git window", modal: false, destructive: false },
  { id: "delete-confirm", label: "destructive delete confirm", modal: true, destructive: true },
];
