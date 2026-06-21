# Issue #1292 — runtime token consolidation: browser evidence

Parent Epic: [#1290](https://github.com/oscharko-dev/Keiko/issues/1290) · Issue:
[#1292](https://github.com/oscharko-dev/Keiko/issues/1292) · Blueprint:
[#1291](https://github.com/oscharko-dev/Keiko/issues/1291).

This folder is the browser evidence for the Light Mode / Dark / High-Contrast /
forced-colors foundations after the Tier-2/3/4 token consolidation landed in the
single live stylesheet (`packages/keiko-ui/src/app/globals.css`).

Because #1292 is an **additive token-availability** change — every new alias
resolves to a Tier-1 primitive that already existed, and no in-app control sets
`data-hc` yet — the rendered product is byte-identical until later issues migrate
components onto the new names. The meaningful browser proof is therefore that the
consolidated tokens **resolve to the correct, mode-aware computed values in a real
browser** and that the foundations stay legible in every mode. The harness below
loads the unmodified product `globals.css` into Chromium and renders a foundation
swatch board for each mode.

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
`focus-ring` / `focus-w`), so a broken alias would show as a missing swatch or an
unstyled element. All seven render cleanly.

## Computed-value proof (read via `getComputedStyle` in the browser)

Every probed Tier-1/2/3/4 token resolved to a non-empty value in all seven modes
(0 empty resolutions). The mode-aware tokens switch exactly as the cascade
intends — proving theme switching, the new `--focus-w` / `--grid-dot` primitives,
and the neutral `[data-hc]` step (previously editor-only):

| Token                    | Dark                   | Light                 | Dark+HC                | Light+HC              |
| ------------------------ | ---------------------- | --------------------- | ---------------------- | --------------------- |
| --focus-w                | 2px                    | 2px                   | 3px                    | 3px                   |
| --grid-dot               | oklch(0.34 0.005 160)  | oklch(0.78 0.012 160) | oklch(0.52 0.006 160)  | oklch(0.6 0.01 160)   |
| --surface-primary        | oklch(0.235 0.004 160) | oklch(1 0 0)          | oklch(0.235 0.004 160) | oklch(1 0 0)          |
| --text-primary           | oklch(0.97 0.003 160)  | oklch(0.26 0.012 160) | oklch(0.97 0.003 160)  | oklch(0.26 0.012 160) |
| --border-default         | oklch(0.3 0.004 160)   | oklch(0.88 0.006 160) | oklch(0.55 0.004 160)  | oklch(0.62 0.006 160) |
| --focus-ring             | #4eba87                | oklch(0.48 0.13 160)  | #4eba87                | oklch(0.48 0.13 160)  |
| --feedback-danger        | oklch(0.68 0.16 25)    | oklch(0.5 0.18 25)    | oklch(0.68 0.16 25)    | oklch(0.5 0.18 25)    |
| --button-primary-surface | #4eba87                | #4eba87               | #4eba87                | #4eba87               |
| --space-8                | 24px                   | 24px                  | 24px                   | 24px                  |
| --z-modal                | 300                    | 300                   | 300                    | 300                   |
| --dur-base               | 180ms                  | 180ms                 | 180ms                  | 180ms                 |
| --text-body              | 14px                   | 14px                  | 14px                   | 14px                  |

Notes:

- `--focus-w` thickens 2px → 3px under both in-app `[data-hc="more"]` and the OS
  `prefers-contrast: more`, satisfying the focus-visibility requirement (EV4).
- `--border-default` steps brighter in Light Mode (0.88) and brighter still under
  high contrast (0.55 dark / 0.62 light) — the neutral `[data-hc]` step this issue
  added is what produces the 0.55 value, confirming the hook is no longer
  editor-only.
- Scale tokens (`--space-*`, `--z-*`, `--dur-*`, type sizes) are mode-independent
  by design and resolve identically everywhere.
- Under `prefers-contrast`/`forced-colors`, the **declared** custom-property values
  are unchanged (the product's high-contrast step is intentionally limited to the
  neutral ramp it consumes); the user-agent applies the system palette at paint
  time, which the `05`/`06` screenshots capture (system borders survive on every
  surface via the new `@media (forced-colors: active)` block).

## Reproduction

The stylesheet contract test is the committed gate
(`packages/keiko-ui/src/app/globals.css.test.ts`, the `Issue #1292` describe
blocks + drift gate). These screenshots were generated with a one-off Playwright
harness (not committed as a CI project — permanent visual regression is scoped to
#1300) that inlines the real `globals.css`:

```bash
# from the repo root, with dependencies installed (npm ci):
KEIKO_REPO="$PWD" node <harness>.mjs   # launches chromium, screenshots 7 modes,
                                       # asserts every probed token resolves
```

The harness sets `data-theme` / `data-hc` on the document and emulates
`prefers-contrast`, `forced-colors`, and `reduced-motion` via Playwright
`page.emulateMedia`, then reads `getComputedStyle(document.documentElement)` for
the probe set above.
