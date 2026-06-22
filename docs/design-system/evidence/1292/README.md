# Issue #1292 — runtime token consolidation: browser evidence

Parent Epic: [#1290](https://github.com/oscharko-dev/Keiko/issues/1290) · Issue:
[#1292](https://github.com/oscharko-dev/Keiko/issues/1292) · Blueprint:
[#1291](https://github.com/oscharko-dev/Keiko/issues/1291).

This folder is the browser evidence for the Light Mode / Dark / High-Contrast /
forced-colors foundations after the Tier-2/3/4 token consolidation landed in the
single live stylesheet (`packages/keiko-ui/src/app/globals.css`).

The corrective #1292 audit fixed two production gaps after the original closure:

- the product high-contrast token branches now copy the full primitive palettes
  from `design-system/keiko-tokens.css`, and the stylesheet drift gate exact-matches
  those declaration values for all four high-contrast branches;
- product `:focus-visible` rules now consume `--focus-width`, so the 2px baseline
  ring steps to 3px in both in-app and OS high-contrast modes.

The harness below loads the unmodified product `globals.css` into Chromium and
renders a foundation swatch board for each mode. The board includes visible focus,
text hierarchy, a selected-text sample, and success/warning/danger status samples.

## Screenshots (Chromium, deviceScaleFactor 2)

| Mode                                         | File                                               |
| -------------------------------------------- | -------------------------------------------------- |
| Dark (default)                               | [01-dark.png](01-dark.png)                         |
| Light                                        | [02-light.png](02-light.png)                       |
| Dark + in-app high-contrast (`data-hc`)      | [03-dark-hc.png](03-dark-hc.png)                   |
| Light + in-app high-contrast                 | [04-light-hc.png](04-light-hc.png)                 |
| Dark + OS `prefers-contrast: more`           | [05-prefers-contrast.png](05-prefers-contrast.png) |
| Forced-colors active (Windows High Contrast) | [06-forced-colors.png](06-forced-colors.png)       |
| Reduced motion                               | [07-reduced-motion.png](07-reduced-motion.png)     |

Each board renders the consolidated semantic + component tokens directly
(`surface-*`, `text-*`, `border-*`, `feedback-*`, `button-primary-*`,
`focus-ring` / `focus-w`) and uses a real product `.dlg-btn:focus-visible` rule
for the focused action. All seven render cleanly.

## Computed-value proof (read via `getComputedStyle` in the browser)

Every probed Tier-1/2/3/4 token resolved to a non-empty value in all seven modes
(0 empty resolutions). The computed focus values came from
`getComputedStyle(document.querySelector(".focus-sample"))` after focusing a real
product button:

| Mode                       | --focus-w | Focus outline                              | --bg                   | --line                 | --fg                   |
| -------------------------- | --------- | ------------------------------------------ | ---------------------- | ---------------------- | ---------------------- |
| Dark                       | 2px       | 2px solid rgb(78, 186, 135)                | oklch(0.17 0.004 160)  | oklch(0.3 0.004 160)   | oklch(0.97 0.003 160)  |
| Light                      | 2px       | 2px solid oklch(0.48 0.13 160)             | oklch(0.955 0.004 160) | oklch(0.88 0.006 160)  | oklch(0.26 0.012 160)  |
| Dark + `data-hc="more"`    | 3px       | 3px solid oklch(0.86 0.16 160)             | oklch(0.11 0.004 160)  | oklch(0.62 0.006 160)  | oklch(1 0 0)           |
| Light + `data-hc="more"`   | 3px       | 3px solid oklch(0.42 0.14 160)             | oklch(1 0 0)           | oklch(0.45 0.008 160)  | oklch(0.13 0.01 160)   |
| Dark + `prefers-contrast`  | 3px       | 3px solid oklch(0.86 0.16 160)             | oklch(0.11 0.004 160)  | oklch(0.62 0.006 160)  | oklch(1 0 0)           |
| Forced-colors active       | 2px       | 2px solid rgba(5, 0, 73, 0.8)              | oklch(0.955 0.004 160) | oklch(0.88 0.006 160)  | oklch(0.26 0.012 160)  |
| Reduced motion             | 2px       | 2px solid rgb(78, 186, 135)                | oklch(0.17 0.004 160)  | oklch(0.3 0.004 160)   | oklch(0.97 0.003 160)  |

Notes:

- `--focus-width` resolved to the same value as `--focus-w` in every mode. The
  focused product button proves normal focus rings now consume the primitive
  rather than hard-coded widths.
- `data-hc="more"` and OS `prefers-contrast: more` both load the full dark/light
  high-contrast primitive palettes from `design-system/keiko-tokens.css`.
- The forced-colors screenshot proves the fallback path still renders usable
  system-colored text, selection, borders, and focus in Chromium's forced-colors
  emulation.
- Scale tokens (`--space-*`, `--z-*`, `--dur-*`, type sizes) are mode-independent
  by design and resolve identically everywhere.

## Reproduction

The stylesheet contract test is the committed gate
(`packages/keiko-ui/src/app/globals.css.test.ts`, the `Issue #1292` describe
blocks + drift gate). It exact-compares high-contrast declaration values against
`design-system/keiko-tokens.css` and rejects normal `:focus-visible` rings that
hard-code pixel widths.

These screenshots were generated with a one-off Playwright harness (not committed
as a CI project — permanent visual regression is scoped to #1300) that inlines the
real `globals.css`:

```bash
# from the repo root, with dependencies installed (npm ci):
KEIKO_REPO="$PWD" node <harness>.mjs   # launches chromium, screenshots 7 modes,
                                       # asserts every probed token resolves
```

The harness sets `data-theme` / `data-hc` on the document and explicitly resets
or emulates `prefers-contrast`, `forced-colors`, and `reduced-motion` via
Playwright `page.emulateMedia`, then reads `getComputedStyle` for the root token
probe set and the focused product button.
