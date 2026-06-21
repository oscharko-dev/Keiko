# Issue #1294 — Reusable controls & component primitives → semantic tokens (evidence)

Epic #1290. Predecessors: #1291 (blueprint), #1292 (token layer), #1293 (shell/chrome).
This issue is the **component-primitive** consumer migration: route the reusable controls
(buttons, icon buttons, fields, selects, toggles, steppers, tabs, menus, badges, chips,
pills, toasts, alerts, composer controls, cards, dialogs, popovers, tooltips, tree/command
rows) in the single `packages/keiko-ui/src/app/globals.css` through the 0.4.0
tier-2/3/4 semantic/component tokens, instead of raw primitives.

## What changed

- **363 component-primitive CSS rules / ~550 declarations** (346 in the initial pass + 17 reusable-control rules added in the PR #1400 review follow-up) migrated from raw primitives
  (`var(--card)`, `var(--fg)`, `var(--line)`, `var(--danger)`, `var(--accent-text)`, …) to
  the 0.4.0 semantic/component tokens (`--button-*`, `--input-*`, `--text-*`, `--surface-*`,
  `--border-*`, `--feedback-*`, `--card-*`, `--popover-*`, `--combobox-*`, `--focus-ring`, …).
- **Value-preserving by construction.** Every target token is a `:root` alias over the exact
  primitive it replaced (e.g. `--button-primary-surface: var(--accent)`,
  `--input-surface: var(--inset)`, `--feedback-danger: var(--danger)`), so `var(--target)`
  resolves byte-identically to the prior `var(--primitive)` in every mode. The Light-Mode
  fidelity win the issue asks for ("no longer a generic inversion") was already delivered by
  #1292's mode-aware primitives; this migration makes the controls **consume** that chain.
- **Diff is 100% token swaps** — 575 added and 575 removed lines, every one containing a
  `var(--…)` token (no structural, layout, spacing, radius, or value change).

## Kept verbatim (deliberate non-migrations, documented per Deliverable D4)

- **Accent-family brand primitives** — `--accent`, `--accent-line`, `--accent-dim`,
  `--accent-glow`, `--accent-bright` — no neutral semantic alias exists; they are brand tokens
  (`var(--accent)` standalone count unchanged: 185 → 185).
- **Raw literals with no token** — `#fff` (Light avatar/toggle ink), `oklch` amber badge inks,
  green-tinted Light scrims, bespoke `color-mix` percentages, disabled opacities
  `0.45 / 0.55 / 0.6` (the `--opacity-disabled` token is `0.42`, a different value, so KEPT raw).
- **Approved `[data-theme="light"]` deviations** — per-mode WCAG corrections (e.g.
  `.modesw-av`/`.cmp-budget-badge-low`, amber badge inks, the blanket Light focus-ring rule)
  kept verbatim (mirrors #1293; ADR-0049 gate 4 forbids removal).
- **#1295-owned Light shadow/scrim rows** (`.dlg-overlay`, `.cmdk-overlay`, `.mc-dialog-backdrop`,
  `.wf-dialog-overlay`, `.gw-setup-backdrop`, `.ws-fab` C415) — not tokenised here.

## Out-of-scope follow-ups discovered

- Duplicate `[data-theme="light"] .mc-dialog-backdrop` (lines 15242 & 15791) — dead duplicate,
  separate cleanup.
- `var(--focus)` is undefined (figma-view-json focus rings) — pre-existing bug, left verbatim.
- A shared Light `--dialog-scrim` token **definition** would belong to #1295 (token-layer change),
  out of #1294's pure-consumer scope.

## Computed-value equivalence proof (the "no visual change" gate)

`equivalence-harness.mjs` renders representative markup for every migrated component family with
the PRE (`origin/release/0.2.0`) and POST (this branch) `globals.css`, reads `getComputedStyle`
for the migrated properties on each primitive across **7 modes** (dark, light, dark-HC, light-HC,
prefers-contrast, forced-colors, reduced-motion), and asserts the resolved values are identical.

**Result: 1106 computed-value probes × 7 modes = 0 differences** (`computed-value-proof.json`).
Screenshots `01-dark.png` … `07-reduced-motion.png` are the rendered POST evidence per mode.

A wrong-token-by-value trap was caught and fixed by this harness during development: the
`.scope-pill` ink was first routed to `--accent-solid-ink` (which carries its own Light override
→ diverges in Light); it was corrected to `--text-on-accent` (a pure `var(--ink-inverse)` alias),
restoring the 0-diff result.

### Reproduce

```bash
npm ci && npx playwright install chromium
BASE_REF=origin/release/0.2.0 node docs/design-system/evidence/1294/equivalence-harness.mjs
# exits 0 with "DIFFERENCES (pre vs post): 0"
```

## Committed regression gate

`packages/keiko-ui/src/app/globals.css.test.ts` carries the **Issue #1294** describe block:
per-component routing pins (positive + negative, mutation-robust) plus a **scope-wide component
drift guard** that classifies rules by reusable-control class prefix (a semantic prefix set,
not a hardcoded per-selector allowlist — the form the #1293 review mutation-proved tautological)
and fails if any matched rule still carries a raw aliased primitive. It is the completeness gate
**for #1294's reusable-control scope** and is mutation-robust for every rule it covers; route /
layout / window chrome outside that scope still carries raw primitives by design and belongs to
later epic children.
