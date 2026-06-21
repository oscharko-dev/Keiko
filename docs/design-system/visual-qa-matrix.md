# Deliverable 4 — Visual QA Matrix, Studio Visual-Regression Plan, and Designer Sign-off

Parent Epic: [#1290](https://github.com/oscharko-dev/Keiko/issues/1290). Issue: [#1291](https://github.com/oscharko-dev/Keiko/issues/1291).
Companion: [README.md](README.md) · [fidelity-matrix.md](fidelity-matrix.md) · [token-component-reuse-map.md](token-component-reuse-map.md).

This document defines the cross-mode / cross-viewport visual QA matrix, the visual-regression automation plan
for the later child issues, and the designer sign-off checklist that makes this blueprint a usable review
artifact (acceptance criterion D).

## 1. Axes

### Theme / mode axis (4 resolved palettes + 2 environment modes)

| Mode                              | Mechanism                                                | In-product selectable?                                                                                                                          |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Dark (default)                    | `:root`, `data-theme=dark` (`globals.css:24`)            | Yes (left-rail toggle)                                                                                                                          |
| Light                             | `[data-theme="light"]` (`globals.css:582`)               | Yes (left-rail toggle)                                                                                                                          |
| High Contrast (dark+HC, light+HC) | OS `@media (prefers-contrast: more)` (`globals.css:629`) | **No in-product toggle** — OS-driven only; `[data-hc]` hook is editor-only and never set by runtime JS (#1292 adds the in-app neutral override) |
| Reduced motion                    | `@media (prefers-reduced-motion)` + JS rAF guards        | OS-driven                                                                                                                                       |
| Forced colors (Windows HCM)       | **absent** in `globals.css` (#1292 adds it)              | OS-driven                                                                                                                                       |

### Viewport / density axis

| Tier           | Width                                | Backing in product                                                                                                                         |
| -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop        | ≥ 1180px                             | Primary layout; reflow at 1180/1100/1000px                                                                                                 |
| Tablet         | 768–1024px                           | **No supported layout today** — only a documented overflow note at `globals.css:~14060` (WCAG 1.4.10 reflow failure). Formalised by #1298. |
| Mobile         | ≤ 560px (and ≤ 420px)                | Composer compact variants, container queries at 360/430px                                                                                  |
| Window density | full · mini (<430px) · tiny/TooSmall | `WindowFrame.selectBody` (107–175) — a per-window state, independent of viewport                                                           |

Note: a significant share of reflow is **container-query** driven (`container-type: inline-size` at
`globals.css:2186,8018,10537`), so QA by viewport width alone misses panel-width-triggered reflow — resize panels
as well as the viewport.

## 2. Visual QA matrix (surface × mode × viewport)

For each surface in [fidelity-matrix.md](fidelity-matrix.md), verify the cells below. Capture evidence for the
3 highest-traffic surfaces (App shell, Chat window, Grounded answer/workflow handoff) at minimum; extend per
child issue.

| Mode × Viewport      | What to verify                                                                                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dark × desktop       | Baseline. Confirm static HTML `data-theme=dark` (`layout.tsx:50`) matches first paint; `--shadow-*` token depth correct.                                                                                                                                                                |
| Light × desktop      | `[data-theme="light"]` token overrides render (darker `--accent-text` ≥ 4.5:1 on white, badge `--ink-inverse`); **none of the Light Mode Table A `required` defects visible** (no heavy black shadows on off-white).                                                                    |
| Dark+HC × desktop    | OS `prefers-contrast:more`: `--line*`/`--fg-faint`/`--fg-dim` step-up (`globals.css:629-636`), editor 752-773; all text ≥ 7:1, lines ≥ 3:1.                                                                                                                                             |
| Light+HC × desktop   | `globals.css:637-643` light-HC lift + editor 774-791; combine OS contrast with the light toggle.                                                                                                                                                                                        |
| Light/Dark × tablet  | Reflow at 900/760px without horizontal scrollbar; RightRail collapse preserves inspector state; container-query reflow at panel widths. Flag tablet 768–1024px as the known overflow gap.                                                                                               |
| Light/Dark × mobile  | Smallest tiers (420px, 700px/430px short viewport); composer `.cmp-*-compact`; footer `.ft-window-trigger` min-height 24px; container queries at 360/430px.                                                                                                                             |
| Reduced-motion × any | The 27 `no-preference`-gated animations all freeze; 3 explicit kill-switches active (`.empty-workspace-blob`, `.chat-msg-brand` pulse, `.qi-progress-spinner`); WebGL shader falls back to solid `--bg` (`WorkspaceShader.tsx:355-375`); connection flow swaps to a static dashed line. |
| Forced-colors × any  | (After #1292) focus ring → `Highlight`, card/window edges → `CanvasText`; verify icon-as-background, `color-mix` surfaces, and SVG fills survive the OS override. Today: **gap** (no handling).                                                                                         |
| Keyboard focus × any | `data-input-modality=keyboard` (`AppShell.tsx:604-625`): two-tone focus ring visible on every surface incl. the green primary button; light-mode focus ring (`globals.css:13454`).                                                                                                      |

## 3. Per-component accessibility checklist (from the design-system bar)

Every migrated component must clear ([accessibility.html](../../design-system/accessibility.html)):

- Text contrast ≥ 4.5:1 (3:1 large text / borders / focus ring) in **both** themes; **AAA ≥ 7:1** in High Contrast.
- Hit target ≥ 24×24px (WCAG 2.5.8) with non-colliding spacing (24 min · 28 window-ctl · 32 icon-btn · 34 button/send · 38 rail · 44 touch).
- Visible focus ring; fully keyboard-operable; skip-link first on Tab; DOM order = reading order; no positive `tabindex`; Esc closes overlays; arrows drive tablists/canvas.
- State conveyed by **icon + text + shape**, never colour alone (WCAG 1.4.1).
- Degrades gracefully under reduced motion.
- Carries a label / accessible name; live regions: `role=alert` (assertive) for blocking errors, `role=status`/`aria-live=polite` for info/success.
- Non-text contrast (WCAG 1.4.11) for the editor caret/focus/diff/squiggles ≥ 3:1.

These map to the existing gates: the 1,320-line `globals.css.test.ts` (contrast/focus/target/reduced-motion) and
the 9 `*.a11y.test.tsx` axe suites — see [token-component-reuse-map.md](token-component-reuse-map.md) §6.

## 4. Studio visual-regression plan (for child issue #1300)

**Reality check:** there is **no pixel visual-regression harness today** — grep for `toHaveScreenshot` /
`toMatchSnapshot` returns zero; the only `page.screenshot()` calls (`tests/e2e/release-smoke.spec.ts:367`,
`prompt-enhancer-smoke.spec.ts:38`) are `testInfo.attach` evidence artifacts, not diff assertions. There is no
Storybook / Chromatic / Percy / Loki / reg-suit anywhere. The "Studio" plan is therefore **net-new** and must be
built on the existing tooling, not a new framework.

Plan:

1. **Harness** — add a Playwright visual-regression project to the existing chromium config
   ([playwright.config.ts](../../playwright.config.ts), `workers:1`, builds packages + `scripts/dev-runner.mjs`).
   Use `expect(page).toHaveScreenshot()` with a committed baseline. Do **not** introduce a second framework.
2. **Targets** — (a) the live `/` route and each high-traffic surface from the fidelity matrix; (b) the
   `design-system/*.html` reference pages as the designer ground truth (foundations, components, accessibility,
   editor-theme, motion, patterns, messages, content, audit, icon system).
3. **Matrix coverage** — parameterise each baseline across the theme/viewport axes in §1: Light, Dark,
   Dark+HC, Light+HC (emulate `prefers-contrast`), reduced-motion (emulate `prefers-reduced-motion`),
   forced-colors (emulate `forced-colors: active`), at desktop / tablet / mobile widths, plus panel-width
   container-query states.
4. **a11y gate** — run `axe-core` (reuse `axe-core` 4.12.1 / `jest-axe` 10.0.0) on each captured state; no new
   serious/critical violations.
5. **Pixel variance policy** — see §5; baselines committed under version control; designer approves every new or
   changed baseline.
6. **Determinism** — disable animations during capture (`prefers-reduced-motion` emulation), pin fonts
   (JetBrains Mono is already a committed webfont), single worker, fixed device-scale-factor; mask the WebGL
   shader canvas region (non-deterministic) so it does not flake the diff.

## 5. Pixel variance policy

| Tier                                                           | Threshold                                                                                            | Disposition                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Token-level surfaces (colour, border, radius, shadow, spacing) | 0% intended change after a no-op token migration; `maxDiffPixelRatio ≤ 0.001` for AA-rendering noise | Any larger diff is a regression unless an explicit variance note is approved by Design. |
| Layout reflow (breakpoints, density)                           | structural change expected at named breakpoints                                                      | New baseline per breakpoint, designer-approved.                                         |
| Animated / WebGL regions                                       | non-deterministic                                                                                    | Masked out of the diff; verified behaviourally (reduced-motion freeze) instead.         |

Every approved deviation from the design-system reference is recorded with a variance note (surface, reason,
Design approver) so the epic ships "no remaining unapproved raw visual values".

## 6. Designer sign-off checklist (acceptance criterion D)

Manual-first (no pixel harness exists yet). Designers fill the approval cell per surface during the child-issue
work. Status legend: ☐ not started · ◐ in review · ✓ approved · ⚠ variance noted.

The four palette modes are expanded per viewport in §2; the reduced-motion and forced-colors columns below are
intentionally single sign-off cells (each is verified across all three viewports per §2 and §4, not viewport-specific
in outcome).

| Surface (owner)                              | Dark · desktop | Light · desktop | Dark+HC | Light+HC | Tablet | Mobile | Reduced-motion | Forced-colors | Designer approval |
| -------------------------------------------- | -------------- | --------------- | ------- | -------- | ------ | ------ | -------------- | ------------- | ----------------- |
| App shell — Header/Rails/Footer (#1293)      | ✓¹             | ✓¹              | ✓¹      | ✓¹       | ✓¹     | ✓¹     | ✓¹             | ✓¹            | ◐                 |
| Workspace canvas + window frame (#1293)      | ✓¹             | ✓¹              | ✓¹      | ✓¹       | ✓¹     | ✓¹     | ✓¹             | ✓¹            | ◐                 |
| Reusable controls / input atoms (#1294)      | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |
| Modals / dialogs (#1294)                     | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |
| Chat / conversation (#1295)                  | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |
| Grounded answer + workflow handoff (#1296)   | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |
| Agent run / gate cards (#1296)               | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |
| Quality Intelligence hub + run cards (#1295) | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |
| Prompt Enhancer (#1295)                      | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |
| Files + Editor + diff (#1295)                | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |
| Local Knowledge hub + capsule page (#1295)   | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |
| MemoriaViva (#1295)                          | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |
| Relationships (#1295)                        | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |
| Figma snapshot + source windows (#1295)      | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |
| Data grid / table (new, #1297)               | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |
| Input + navigation family (#1298)            | ☐              | ☐               | ☐       | ☐        | ☐      | ☐      | ☐              | ☐             | ☐                 |

Deferred surfaces (D1–D6 in [fidelity-matrix.md](fidelity-matrix.md)) are excluded from sign-off until their
disposition is resolved.

¹ #1293 shell/chrome migration: each mode cell is engineering-verified by the 7-mode computed-value-equivalence
proof and screenshots in [evidence/1293](evidence/1293/) — 826 `getComputedStyle` probes, **0** differing values
between the pre- and post-migration stylesheet (the migration is value-preserving, so it carries the #1292
designer-reviewed foundation forward unchanged across every viewport). The migration introduces no Light-Mode
visual change; the three `required` Light shadow rows (Table A: `.hd-tool-cta`, `.ws-zoom`, `.ws-fab`) remain
owned by #1295. Designer approval (◐) stays open pending human sign-off (Human Review Required: Yes).

## Acceptance criterion D — coverage statement

The QA matrix covers Light, Dark, High Contrast, reduced motion, forced colors, and desktop/tablet/mobile (with
the tablet gap and container-query caveat called out). The per-component a11y checklist, the net-new Studio
visual-regression plan (built on the existing Playwright chromium config, since no pixel harness exists today),
the pixel-variance policy, and a per-surface × mode × viewport designer sign-off table together make this
blueprint a check-offable designer review artifact.
