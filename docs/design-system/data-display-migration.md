# Data-display migration note (Issue #1297)

The Design System 0.4.0 data-display foundation — the `.c-table*` table / data-grid component and the
`.viz*` data-visualisation layer — now lives in the single product `packages/keiko-ui/src/app/globals.css`,
ported verbatim from `design-system/keiko-data.css` and `design-system/keiko-dataviz.css`. This note
records what adopts it today and which surfaces should adopt it later, with the reuse analysis that
keeps the foundation from being forced onto patterns it does not fit (issue Stop Condition 1).

## The foundation

| Layer              | Classes                                                                                                                                                                                       | Tokens consumed                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Table / data grid  | `.c-tablewrap`, `.c-tablescroll`, `.c-table` (+ `thead th`, `.sortable`, `.num`, `.so`, `tbody tr[aria-selected]`, `.zebra`, `.is-loading`, `.c-table-empty`, `.c-table-foot`, `.responsive`) | `--table-header-text/-surface`, `--table-row-border`, `--table-row-surface-hover/-selected`, `--table-foot-surface`, `--table-sort-indicator`, `--table-num-text`, `--card-surface/-border`, density `--row-pad-x/-y` (via `[data-density]`), `--skeleton-base/-highlight`, `--focus-ring` |
| Data visualisation | `.viz`, `.viz-plot`, `.viz-bars`, `.viz-bar` (`.s2`…`.s6`, `.uncertain`), `.viz-yaxis`, `.viz-gridlines`, `.viz-legend`, `.viz-tip`, `.viz-seq`, `.viz-uncert-note`, `.viz-donut`             | `--viz-1..6` (categorical), `--viz-seq-1..5` (sequential), `--viz-grid`, `--viz-axis`, `--tooltip-surface/-text`, `--popover-shadow`                                                                                                                                                       |

States covered by the component: header, row, cell, **sort** (`aria-sort` + `.so` indicator), **row
selection** (`aria-selected`), **hover**, **sticky header**, **loading skeleton** (shimmer, off under
`prefers-reduced-motion`), **empty**, **density** (`[data-density="compact"]`), **zebra**, and
**responsive card collapse** (`.responsive`, ≤640px). The dataviz layer covers categorical +
sequential palettes, axis/gridline/legend/tooltip rules, multi-series (grouped/stacked via `.s*`),
and an **uncertainty** encoding that is hatched, never colour-alone.

Usage and live behaviour are documented in `design-system/data-grid.html` and
`design-system/dataviz.html`; computed-value + screenshot evidence is in
[`evidence/1297/`](./evidence/1297/README.md).

## Adopted now

- **`.sm-table`** (`SafeMarkdown.tsx`, markdown tables in chat / grounded answers) — routed onto the
  `--table-*` tokens **value-preservingly**: every token aliases the exact primitive the surface
  already used, so no resolved colour changed in any mode (proven 0-diff in `evidence/1297`).
- **`.pe-scorecards`** (`PromptEnhancerPanel.tsx`, candidate comparison) — adopts the full `.c-table`
  component with right-aligned numeric columns (`.num`) and the DS selected-row emphasis on the
  winning candidate. It was previously UA-default-unstyled; this is a deliberate, rationale-backed
  appearance change, not a value-preserving swap.

## Deferred adopters (reuse analysis)

The five product areas the issue names — Local Knowledge, MemoriaViva, Relationships, Quality
Intelligence, and file/capsule lists — were inspected. **None renders a real `<table>` / `role=grid`.**
They are flex / `<ul><li>` **card-and-row lists**, already migrated to the Tier-3 semantic tokens by
#1295, and they each already carry hover / focus / selected / skeleton / empty behaviour:

| Surface                                                                          | Pattern                       | Why not migrated to `.c-table`                                                                                                                                   |
| -------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.mc-row*` (MemoriaViva memory list / review queue)                              | Flex card list                | Single-column cards, no `thead`/columns; `--surface-primary` / `--border-subtle` / `--surface-secondary` hover are the correct semantics, not the table aliases. |
| `.rel-row` (Relationships)                                                       | Flex row buttons              | Already has full hover / `:focus-visible` / `[aria-pressed]` selected states on semantic tokens.                                                                 |
| `.qi-run-item` / `.qi-finding-list` / `.qi-cand-list` (Quality Intelligence)     | Kanban columns + `<ul>` lists | List/column model, not tabular; `.qi-skeleton-row` already provides loading.                                                                                     |
| `.lkd-diag-row` / `.lkd-source-row` / `.lkd-picker-row` (Local Knowledge detail) | `<ul>` flex rows              | The diagnostics rows are the most column-like, but remain a labelled flex list; no row/column selection model.                                                   |
| `.lk-capsule-row` (capsule / file lists)                                         | `<article>` flex cards        | Card layout with `--shadow-card`; not a grid.                                                                                                                    |

Forcing `.c-table` onto these would be neither value-preserving (their per-row card border and hover
deliberately differ from the table token aliases) nor a structural fit. They are reused **as-is**.

Two other real `<table>`s are intentionally left for a follow-up:

- **`ResourceLimitDecisionsTable.tsx`** — a genuine `<table>`, but built entirely from Tailwind
  utilities and the raw Tailwind palette (`bg-red-950/40`, `text-ink-muted`). The `--table-*` oklch
  tokens do not map to those classes, so there is no value-preserving swap; adopting `.c-table` here
  is a self-contained follow-up once the surface moves off Tailwind utilities.

## Adoption checklist for new data tables

1. Wrap in `.c-tablewrap > .c-tablescroll`; add `.c-table` to the `<table>` (add `.responsive` to opt
   into the ≤640px card collapse, with `data-label` on each `<td>`).
2. Use `role="grid"` / `role="row"` / `role="gridcell"` only when wiring real grid interaction;
   otherwise keep native table semantics.
3. Numeric columns: add `.num` to the `<th>` and `<td>` (right-aligned tabular mono).
4. Sortable headers: `class="sortable" tabindex="0"` + `aria-sort="ascending|descending|none"`; the
   `.so` indicator and focus ring come for free.
5. Selection: set `aria-selected="true"` on the `<tr>`.
6. Loading: add `.is-loading` to the `<table>` (skeleton respects reduced-motion). Empty: render a
   `.c-table-empty` block instead of `<tbody>` rows.
7. Density: set `[data-density="compact"]` on an ancestor.
8. Never introduce a raw colour — read a `--table-*` / `--viz-*` / semantic token. New chart series
   use `--viz-1..6` (categorical) or `--viz-seq-1..5` (magnitude); back any colour-coded distinction
   with a non-colour signal (pattern, label, divider).
