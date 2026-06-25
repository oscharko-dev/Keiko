# Issue #1293 — global shell + workspace chrome token migration: browser evidence

Parent Epic: [#1290](https://github.com/oscharko-dev/Keiko/issues/1290) · Issue:
[#1293](https://github.com/oscharko-dev/Keiko/issues/1293) · Foundation:
[#1292](https://github.com/oscharko-dev/Keiko/issues/1292) · Blueprint:
[#1291](https://github.com/oscharko-dev/Keiko/issues/1291).

This folder is the browser evidence for migrating the always-on global shell — header, footer, left/right
rails, workspace canvas, window-frame chassis, traffic controls, connection chrome, and the PWA install
banner — to consume the semantic (Tier-3) and component (Tier-4) tokens that #1292 added to the single live
stylesheet (`packages/keiko-ui/src/app/globals.css`).

## What changed

The migration is a **value-preserving consumer migration**: every shell rule that hard-coded a raw primitive
(`var(--card)`, `var(--line)`, `var(--fg)`, `var(--shadow-card)` …) or a raw scale literal (`z-index: 0`,
`8px`, `9px`, `0.12s`, `blur(12px)` …) now consumes the matching semantic/component/scale token instead. Each
token #1292 added is an alias over an existing primitive (`--surface-primary: var(--card)`,
`--card-shadow: var(--shadow-card)`, `--space-4: 8px`, `--z-base: 0`, `--focus-ring: var(--accent-text)` …),
so the resolved value is **byte-identical in every mode** — Dark stays Dark, Light stays Light, High Contrast
stays High Contrast. Highlights: the window chassis now reads through the `--card-*` component tokens (AC3),
shell surfaces route through `--surface-*`/`--background-*`/`--nav-*` (AC2), and shell focus rings consume
`--focus-ring` (AC3 focus treatment).

### Deliberately out of scope (documented variance — AC4)

- **Light-Mode shadow/scrim corrections.** Three shell rules keep a dark-biased drop shadow in Light
  (`.hd-tool-cta`, `.ws-zoom`, `.ws-fab` — the C415 canonical example). These are the `required` Table A rows
  in [light-mode-deviation-register.md](../../light-mode-deviation-register.md) and are explicitly owned by
  **#1295** ("resolve the Light Mode `required` rows by tokenising shadows/scrims"), not #1293. #1293 is a
  no-visual-change migration; tokenising those shadows is a Light-Mode _visual change_, so it is left to #1295.
- **The eight `[data-theme="light"]` shell-override rules** (`.ws-fab` colour _and_ the separate C415
  `.ws-fab` shadow, `.ft-you`, `.install-banner-btn-dismiss/-desc`, `.win-close:hover`,
  `.conn-path`, `.conn-dot`/`.conn-particle`, `.win-port`) are genuine per-mode WCAG corrections (1.4.3 text /
  1.4.11 non-text) — approved deviations. Per ADR-0049 gate 4 approved deviations are never removed; they are
  kept verbatim. (The C415 `.ws-fab` shadow row is also the deferred-to-#1295 shadow correction above — one
  selector, two distinct light-override declarations.)
- **TSX inline values.** The 13 shell components are styled entirely through `globals.css` class names. The only
  inline values are: WebGL shader colour uniforms (`WorkspaceShader.tsx` — a canvas cannot read CSS custom
  properties), SVG `<mask>` alpha endpoints (`EmptyWorkspaceBlob.tsx`), per-window-type `accent: boolean`
  metadata (`WindowsRegistry.ts`), and already-tokenised conditional `var(--accent)`/`var(--fg-muted)` tints
  (`Footer.tsx`, `WindowFrame.tsx`). None is a raw visual value; all are documented exceptions per ADR-0049
  gate 3.
- **Accent-family primitives with no neutral alias** are intentionally kept raw: `var(--accent)` /
  `var(--accent-line)` / `var(--accent-dim)` / `var(--accent-glow)` / `var(--accent-bright)` (e.g. the rail
  active-indicator bar, the `.rail-new` / `.rail-avatar` chip border/fill, connection-edge strokes, the FAB
  gradient, focus-glow rings). These are brand-accent design tokens, not raw literals, and the design-system
  defines no neutral semantic alias for them, so they stay as-is. Where an accent value is used as _text/icon
  colour_ (`var(--accent-text)`) it IS migrated to the `--text-accent` semantic alias (or `--focus-ring` for
  focus outlines).
- **Raw values with no equal token** are kept and remain documented exceptions: one-off radii (`7px`, `8px`,
  `10px`), one-off type sizes (`13.5px`, `11.5px`), `font-weight: 560`/`700`,
  `color-mix`/gradient maths and `white`/`rgba` endpoints, and the `oklch(1 0 0 / 0.0x)` top-bevel insets
  (approved deviation A9). The former raw rail `z-index: 12000` exception was retired by #1426; rails now
  consume the named `--z-rail` layer and footer/palette chrome consumes the governed sticky/popover/tooltip
  layers.

## Computed-value proof — no visual change (`computed-value-proof.json`)

The committed Playwright harness ([`equivalence-harness.mjs`](equivalence-harness.mjs)) renders representative
shell markup with the **pre-migration** and **post-migration** `globals.css`, then reads `getComputedStyle` for
the migrated properties
(`background-color`, `color`, all four `border-*-color`, `border-radius`, `box-shadow`, `z-index`, `padding`,
`gap`, `font-size`, `font-weight`, `background-image`, `backdrop-filter`) on every shell element, across seven
modes.

| Mode                                    | Probes  | Differing computed values |
| --------------------------------------- | ------- | ------------------------- |
| Dark (default)                          | 120     | **0**                     |
| Light                                   | 120     | **0**                     |
| Dark + in-app high-contrast (`data-hc`) | 120     | **0**                     |
| Light + in-app high-contrast            | 120     | **0**                     |
| OS `prefers-contrast: more`             | 120     | **0**                     |
| Forced colors (Windows High Contrast)   | 120     | **0**                     |
| Reduced motion                          | 120     | **0**                     |
| **Total**                               | **840** | **0**                     |

**840 computed-value probes, 0 differences** between the pre- and post-migration stylesheet across all seven
modes. This is the objective proof that the migration preserves Dark, Light, and High-Contrast behaviour
(Deliverable 3) and introduces no visual change (the #1293 / reuse-map mandate). Light Mode is byte-identical
because #1293 makes no Light-Mode correction; the shell already routed surfaces through the adaptive primitives
that Light overrides to the warm off-white / neutral hierarchy, and the migration now names them semantically
(`--surface-*` / `--background-*`), which the screenshots below confirm.

## Screenshots (Chromium, deviceScaleFactor 2)

Rendered against the **post-migration** stylesheet on the representative shell board.

| Mode                                    | File                                               |
| --------------------------------------- | -------------------------------------------------- |
| Dark (default)                          | [01-dark.png](01-dark.png)                         |
| Light                                   | [02-light.png](02-light.png)                       |
| Dark + in-app high-contrast (`data-hc`) | [03-dark-hc.png](03-dark-hc.png)                   |
| Light + in-app high-contrast            | [04-light-hc.png](04-light-hc.png)                 |
| OS `prefers-contrast: more`             | [05-prefers-contrast.png](05-prefers-contrast.png) |
| Forced colors active                    | [06-forced-colors.png](06-forced-colors.png)       |
| Reduced motion                          | [07-reduced-motion.png](07-reduced-motion.png)     |

The Light screenshot shows the shell on the Design-System warm off-white / neutral hierarchy (canvas, rails,
window card surface) with the accent green reserved for the active nav indicator and the FAB — the AC2 target.

## Committed gate

The committed regression gate is `packages/keiko-ui/src/app/globals.css.test.ts` (the `Issue #1293` describe
block: window-chassis card tokens, shell surface tokens, focus-ring adoption, named z/space/radius scales, and
a scope-wide mutation-robust drift guard that parses every pure-shell rule and forbids raw aliased primitives) plus the
extended `WorkspaceShell.a11y.test.tsx` (full-shell `axe` pass in both Dark and Light). The behaviour-preserving
contract is anchored by the existing `*.test.tsx` component suites.

## Reproduction

The screenshots, `computed-value-proof.json`, and the headline 840-probe/0-diff result are regenerated by the
committed harness [`equivalence-harness.mjs`](equivalence-harness.mjs) (a developer/evidence script, not a CI
project — permanent pixel visual-regression is scoped to #1300):

```bash
# from the repo root, with dependencies installed (npm ci):
node docs/design-system/evidence/1293/equivalence-harness.mjs
```

The harness derives the comparison stylesheet from `BASE_REF` (default `origin/release/0.2.0`; use the PR base
SHA for an immutable pre-migration replay) and the **post-migration** stylesheet from the working tree, sets
`data-theme` / `data-hc` on the document, emulates
`prefers-contrast`, `forced-colors`, and `prefers-reduced-motion` via Playwright `page.emulateMedia`, then reads
`getComputedStyle` for each shell element under both stylesheets, writes the proof JSON + the seven screenshots
next to itself, and exits non-zero if any computed value differs. (Set `BASE_REF` to compare against a different
base after this work merges.)
