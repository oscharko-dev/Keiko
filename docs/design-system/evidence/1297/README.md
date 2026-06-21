# Issue #1297 — Table / Data Grid + Dataviz foundation: browser evidence

Computed-value proof and rendered screenshots for the Design System 0.4.0 data-display foundation
(`.c-table*` from `design-system/keiko-data.css`, `.viz*` from `design-system/keiko-dataviz.css`),
its `--table-*` / `--viz-*` token consumers, and the two product surfaces that adopt them.

All artifacts are produced by [`equivalence-harness.mjs`](./equivalence-harness.mjs) — headless
Chromium rendering the **real product `globals.css`** via `page.setContent` (no file server,
CodeQL-safe) across all seven theme / contrast / motion modes.

## Reproduce

```bash
npm ci
npx playwright install chromium
BASE_REF=origin/release/0.2.0 node docs/design-system/evidence/1297/equivalence-harness.mjs
```

Exits non-zero if any Group-A value-preservation probe differs, or if any Group-R reference-fidelity
probe differs in dark or light. Writes `computed-value-proof.json` + `01-dark.png … 09-responsive.png`.

## What is proved

### Group A — value-preserving migration (0-diff gate, all 7 modes)

The markdown table (`.sm-table*`, chat/grounded answers) was routed onto the `--table-*` component
tokens. Each token aliases the exact primitive the surface already used
(`--table-header-surface → --card-2`, `--table-row-border → --line-soft`, `--table-num-text → --fg`,
`--card-border → --line`, zebra `--inset → --surface-inset`), so the resolved colour is **identical
PRE (`origin/release/0.2.0`) vs POST (this branch)** in every mode.

**Result: 49 computed-value probes, 0 differences across all 7 modes.**

### Group R — reference fidelity (0-diff gate in dark + light, recorded in HC/forced/reduced)

The new canonical `.c-table*` / `.viz*` primitives are rendered with (a) the product POST
`globals.css` and (b) the governed DS 0.4.0 reference CSS (`keiko-tokens` + `keiko-semantic-tokens`

- `keiko-data` + `keiko-dataviz`), then compared as **rendered sRGB pixels** (each colour
  canonicalised through a canvas so a hex-authored token and the perceptually-identical `oklch()` the
  reference uses compare equal; ±1 LSB tolerance for rounding).

**Result: 112 probes, 0 differences in all 7 modes** — every neutral/semantic-tier data-display
surface (table header, row borders, numeric/body text, footer, empty-state inset, gridlines, axis,
tooltip, the `--viz-2` categorical hue) resolves pixel-identically to the reference.

Recorded (not gated), with explanation, in `computed-value-proof.json → additiveAndAccentDerived`:

- **Accent-derived** `.viz-bar` (`--viz-1`) and the selected row (`--table-row-surface-selected`)
  resolve through the brand `--accent`, which the product defines as hex `#4eba87` (rgb 78,186,135)
  while the reference uses `oklch(0.72 0.124 160)` (rgb 82,188,138) — a ~1.5% delta in the shared
  base primitive that predates and is outside #1297. The token chain is identical in both.
- **Product-additive** `.viz-bar.s4/.s5/.s6` and `.viz-seq i:nth-child()` helpers consume the
  extended categorical hues (`--viz-4..6`) and the sequential ramp (`--viz-seq-*`). The bare
  reference applies these via inline `style="background:var(--viz-N)"` per series, so it has no such
  rule; the helpers exist so no governed palette token ships defined-but-unconsumed.

### Group D — deliberate adoption (recorded)

`.pe-scorecards` (prompt-enhancer candidate comparison) was UA-default-unstyled PRE and adopts the
`.c-table` component POST, so its computed value is expected to differ. Recorded per mode.

## Screenshots (real product `globals.css`)

| File                      | Mode                                                                    |
| ------------------------- | ----------------------------------------------------------------------- |
| `01-dark.png`             | Dark                                                                    |
| `02-light.png`            | Light                                                                   |
| `03-dark-hc.png`          | Dark · High Contrast (`[data-hc="more"]`)                               |
| `04-light-hc.png`         | Light · High Contrast                                                   |
| `05-prefers-contrast.png` | `prefers-contrast: more`                                                |
| `06-forced-colors.png`    | `forced-colors: active` (Windows High Contrast)                         |
| `07-reduced-motion.png`   | `prefers-reduced-motion: reduce` (skeleton shimmer off)                 |
| `08-compact-density.png`  | `[data-density="compact"]`                                              |
| `09-responsive.png`       | 560px viewport — `.c-table.responsive` collapses rows to labelled cards |

Each screenshot renders the canonical `data-grid.html` (full grid: sortable sticky header, selected
row, numeric alignment, loading skeleton, empty state, footer) and `dataviz.html` markup (categorical

- sequential palettes, bar/line, legend, tooltip, hatched uncertainty), plus the migrated `.sm-table`
  and the adopted `.pe-scorecards`, so they double as the side-by-side comparison against the reference.
