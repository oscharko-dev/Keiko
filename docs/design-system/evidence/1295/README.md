# Issue #1295 — Product-surface tokens: shadow-ink, overlay-scrim, semantic swaps, hl-*/fpv-src HC (evidence)

Epic #1290. Predecessors: #1291 (blueprint), #1292 (token layer), #1293 (shell/chrome),
#1294 (component primitives).
This issue is the **product-surface** consumer migration: routes the chat, memory, QI, wf,
mc, rel/rb, lk/lkd, connector, figma-view, json-token, fpv, and hl-* surface classes in
the single `packages/keiko-ui/src/app/globals.css` through the 0.4.0 semantic tokens,
and introduces two Light-mode fixes (`--shadow-ink-rgb` warm ink, `--overlay-scrim` scrim).

## What changed

- **Product-surface semantic token swaps** — fg→`--text-primary`, fg-muted→`--text-secondary`,
  card→`--surface-primary`, line→`--border-default`, and equivalents across the
  chat-/chatw-/grounded-/wf-/qi-/mc-/memoria-/rel-/rb-/lk-/lkd-/connector-/figma-/json-token-
  families. Every swap is a pure alias over the same primitive.
- **`--shadow-ink-rgb` token** (Tier-3) introduced: `0 0 0` in Dark, `20 30 25` in Light.
  Shadow rows that previously hard-coded `rgba(0,0,0,α)` now use `rgba(var(--shadow-ink-rgb)/α)`,
  producing identical resolved values in Dark and warm-ink values in Light.
- **`--overlay-scrim` token** (Tier-3) introduced: `oklch(0 0 0 / 0.55)` in Dark,
  `oklch(0.3 0.01 160 / 0.34)` in Light. `.mc-dialog-backdrop` previously had a bespoke
  `[data-theme=light]` override with the same value — the token centralises it with no
  value change (both modes resolve identically PRE/POST).
- **`--ed-syn-*` / `--ed-fg` routing** for hl-* and fpv-src — replaces hardcoded hex
  literals with semantic editor tokens. In Dark/Light modes the resolved values are
  byte-identical to the prior hex. In High-Contrast modes the `--ed-syn-*` tokens carry
  HC overrides that improve contrast (intentional improvement, not a regression).
- **Diff is 100% token swaps** — no structural, layout, spacing, radius, or value change in
  Dark mode.

## Computed-value equivalence proof (the "no visual change" gate)

`equivalence-harness.mjs` renders representative markup for all migrated product-surface
families with the PRE (`origin/release/0.2.0`) and POST (working tree) `globals.css`,
reads `getComputedStyle` for every migrated property across **7 modes** (dark, light,
dark-HC, light-HC, prefers-contrast, forced-colors, reduced-motion), and asserts the
resolved values are identical.

**Category-A result: 2324 computed-value probes × 7 modes = 0 differences**
(`computed-value-proof.json`, `diffCount: 0`).

The hl-*/fpv-src selectors are excluded from the Category-A gate (see Category C4 below).

Screenshots `01-dark.png` … `07-reduced-motion.png` are the rendered POST evidence per mode.

## Category-C: deliberate adaptations (separate from the 0-diff gate)

These are asserted in the `categoryC` section of `computed-value-proof.json` and do not
contribute to the Category-A diff count.

### C1 — Shadow-ink warm adaptation in Light

Three representative shadow-ink rows (`.hd-tool-cta`, `.cmp-model-menu`, `.ksel-menu`):

| Selector | Dark | Light |
| -------- | ---- | ----- |
| `.hd-tool-cta` boxShadow | PRE=POST (identical) | `rgba(0,0,0,…)` → `rgba(20,30,25,…)` |
| `.cmp-model-menu` boxShadow | PRE=POST (identical) | `rgba(0,0,0,…)` → `rgba(20,30,25,…)` |
| `.ksel-menu` boxShadow | PRE=POST (identical) | `rgba(0,0,0,…)` → `rgba(20,30,25,…)` |

Dark is byte-identical. Light now uses warm ink (`rgb(20 30 25 / α)`) instead of pure
black — confirming the Light shadow-ink fix.

### C3 — Overlay-scrim centralisation (no value change)

`.mc-dialog-backdrop` backgroundColor:

- Dark: PRE = `oklch(0 0 0 / 0.55)` → POST = `oklch(0 0 0 / 0.55)` (identical)
- Light: PRE = `oklch(0.3 0.01 160 / 0.34)` → POST = `oklch(0.3 0.01 160 / 0.34)` (identical)

The `--overlay-scrim` token resolves to the same value as the former bespoke override in
both modes. This is a pure centralisation with zero visual change.

### C4 — hl-*/fpv-src High-Contrast improvement

8 selectors (`.fpv-src`, `.hl-str`, `.hl-num`, `.hl-key`, `.hl-type`, `.hl-fn`, `.hl-key2`,
`.hl-punct`):

- Dark mode: byte-identical PRE/POST (semantic tokens resolve to the same hex values).
- HC mode (`03-dark-hc`): resolved values differ — `--ed-syn-*` / `--ed-fg` carry HC
  overrides that improve contrast over the prior hardcoded hex literals. This is an
  intentional fidelity improvement.

## Reproduce

```bash
npm ci && npx playwright install chromium
BASE_REF=origin/release/0.2.0 node docs/design-system/evidence/1295/equivalence-harness.mjs
# exits 0 with "DIFFERENCES (pre vs post): 0"
```

## Committed regression gate

`packages/keiko-ui/src/app/globals.css.test.ts` carries the **Issue #1295** describe block:
token-routing pins for shadow-ink, overlay-scrim, ed-syn/ed-fg, and product-surface
semantic tokens (positive + negative, mutation-robust), plus a scope-wide product-surface
drift guard that classifies rules by product-surface class prefix and fails if any matched
rule still carries a raw aliased primitive in the token-eligible declaration set.
