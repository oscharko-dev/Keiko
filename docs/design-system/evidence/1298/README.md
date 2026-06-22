# Issue #1298 — Input family + Navigation components: browser evidence

Computed-value proof and rendered screenshots for the Design System 0.4.0 input + navigation
component layer (`.c-*` from `design-system/keiko-inputs.css` and `design-system/keiko-nav.css`) and
its `--checkbox-*` … `--step-*` token consumers.

All artifacts are produced by [`equivalence-harness.mjs`](./equivalence-harness.mjs) — headless
Chromium rendering the **real product `globals.css`** via `page.setContent` (no file server,
CodeQL-safe) across all seven theme / contrast / motion modes.

## Reproduce

```bash
npm ci
npx playwright install chromium
BASE_REF=origin/release/0.2.0 node docs/design-system/evidence/1298/equivalence-harness.mjs
```

Exits non-zero if any Group-R reference-fidelity probe differs in dark or light, or if keyboard focus
does not expose the expected focus-visible/focus-within ring on a representative primitive. Writes
`computed-value-proof.json` + `01-dark.png … 12-focus-visible.png`.

## What is proved

### Group R — reference fidelity (0-diff gate in dark + light, recorded in HC/forced/reduced)

The new canonical `.c-*` input / navigation primitives are rendered with (a) the product POST
`globals.css` and (b) the governed DS 0.4.0 reference CSS (`keiko-tokens` + `keiko-semantic-tokens` +
`keiko-inputs` + `keiko-nav`), then compared as **rendered sRGB pixels** (each colour canonicalised
through a canvas so a hex-authored token and the perceptually-identical `oklch()` the reference uses
compare equal; ±1 LSB tolerance for rounding).

**Result: 203 probes, 0 differences. The 58 neutral/semantic dark + light probes are the gated 0-diff
result (the run fails on any difference); the same surfaces are also recorded — and likewise measure
0-diff this run — in the five HC / `prefers-contrast` / forced-colors / reduced-motion modes.** Every
neutral / semantic-tier input and navigation surface (checkbox / radio / stepper / combobox / date
borders and fills, breadcrumb / pagination / context text, underline-tab and step chrome, popover
surfaces) resolves pixel-identically to `inputs.html` / `nav-components.html`.

Recorded (not gated), with explanation, in `computed-value-proof.json → accentDerived`:

- **Accent-derived** surfaces — the selected checkbox (`--checkbox-surface-selected`), the selected
  radio border (`--radio-border-selected`), the tag (`--tag-surface` / `--tag-text`), the dropzone
  icon (`--surface-accent-subtle` / `--border-accent`), the current page (`--pagination-surface-current`)
  and the completed step (`--step-dot-surface-done`) — resolve through the brand `--accent`, which the
  product defines as hex `#4eba87` (rgb 78,186,135) while the reference uses `oklch(0.72 0.124 160)`
  (rgb 82,188,138): a ~1.5% delta in the shared base primitive that predates and is outside #1298. The
  token chain is identical in both.

### Product adopter (proved by component test, not this harness)

The workflow-handoff **Expected checks** list adopts the `.c-check` primitive (presentation-only — the
native `<input>` stays the control). This is a React change proved by
`WorkflowHandoff.a11y.test.tsx`: the checkbox keeps its role and accessible name, the decorative glyph
is `aria-hidden`, toggling by accessible name still flips the control, and the dialog stays axe-clean.
It is not reproducible in this CSS-only harness.

### Keyboard focus proof

The harness tabs through the rendered product markup and records representative checkbox, radio,
slider, stepper, combobox, tag remove, file upload, date calendar, breadcrumb, back, tab, pagination,
and context-menu targets. Each target must enter `:focus-visible` or `:focus-within` and expose a
visible ring in `computed-value-proof.json → keyboardFocus`. `12-focus-visible.png` captures the final
focused state from that keyboard pass.

## Screenshots (real product `globals.css`)

| File                      | Mode                                                             |
| ------------------------- | ---------------------------------------------------------------- |
| `01-dark.png`             | Dark                                                             |
| `02-light.png`            | Light                                                            |
| `03-dark-hc.png`          | Dark · High Contrast (`[data-hc="more"]`)                        |
| `04-light-hc.png`         | Light · High Contrast                                            |
| `05-prefers-contrast.png` | `prefers-contrast: more`                                         |
| `06-forced-colors.png`    | `forced-colors: active` (Windows High Contrast)                  |
| `07-reduced-motion.png`   | `prefers-reduced-motion: reduce` (state transitions off)         |
| `08-compact-density.png`  | `[data-density="compact"]` (tightened control heights)           |
| `09-responsive.png`       | 560px mobile viewport — intrinsic flex-wrap reflow + grid collapse |
| `10-tablet.png`           | 900px tablet viewport                                            |
| `11-ultrawide.png`        | 1920px ultrawide viewport                                        |
| `12-focus-visible.png`    | Keyboard focus proof screenshot                                  |

Each screenshot renders the canonical `inputs.html` markup (checkbox, radio, slider, stepper,
combobox with open list, tag input, file dropzone + file item, segmented date field) and
`nav-components.html` markup (breadcrumbs, back, underline tabs, pagination, context menu, wizard
steps), plus the responsive `.c-form-grid`, so they double as the side-by-side comparison against the
reference. Default, hover-equivalent, selected, disabled and completed/active states are present in
the theme/responsive captures; keyboard focus-ring evidence is proved separately by the harness and
shown in `12-focus-visible.png`.
