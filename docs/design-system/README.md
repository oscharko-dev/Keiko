# Keiko Design System Fidelity Audit and Implementation Blueprint

Parent Epic: [#1290](https://github.com/oscharko-dev/Keiko/issues/1290) — Pixel-perfect Keiko Design System implementation.
Issue: [#1291](https://github.com/oscharko-dev/Keiko/issues/1291) — Design system fidelity audit and implementation blueprint.

Status: Audit-only deliverable. This document set records the authoritative blueprint for adopting the
Keiko Design System across the product. It introduces **no production UI change**; it is the review
checklist and implementation contract for child issues [#1292](https://github.com/oscharko-dev/Keiko/issues/1292)–[#1300](https://github.com/oscharko-dev/Keiko/issues/1300).

Audit date: 2026-06-21. Reference snapshot: `design-system/` v0.3.0. Product snapshot: `packages/keiko-ui`
at `release/0.2.0`.

## Purpose

Map the current product UI against the design-system reference, identify Light Mode deviations, define the
screen/component inventory, assign write ownership by surface, and convert the Design team's expectations into
measurable gates — exactly the scope set by issue #1291.

The blueprint is governed by [ADR-0049](../adr/ADR-0049-design-system-fidelity-gates.md), which records the
measurable fidelity gates the epic's child issues are accepted against.

## Deliverables in this set

| #   | Deliverable (issue #1291)                                                                              | Document                                                             |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 1   | Design System fidelity matrix covering all product surfaces                                            | [fidelity-matrix.md](fidelity-matrix.md)                             |
| 2   | Light Mode deviation register (classified, with reproduction steps)                                    | [light-mode-deviation-register.md](light-mode-deviation-register.md) |
| 3   | Token/component reuse map and implementation sequence                                                  | [token-component-reuse-map.md](token-component-reuse-map.md)         |
| 4   | Visual QA matrix (Light/Dark/High-Contrast/reduced-motion × desktop/tablet/mobile) + designer sign-off | [visual-qa-matrix.md](visual-qa-matrix.md)                           |

## How designers use this set (review checklist entry point)

1. Read this overview for the verdict, the central gap, and the migration sequence.
2. Use [fidelity-matrix.md](fidelity-matrix.md) to confirm every visible product surface has an owner child
   issue or a documented deferral (acceptance criterion A).
3. Use [light-mode-deviation-register.md](light-mode-deviation-register.md) as the Light Mode sign-off list:
   every mismatch is classified `blocking` / `required` / `approved deviation` with a reproduction path
   (acceptance criterion B).
4. Use [token-component-reuse-map.md](token-component-reuse-map.md) to see exactly which files each child
   issue will edit (acceptance criterion C).
5. Use the sign-off table in [visual-qa-matrix.md](visual-qa-matrix.md) to record designer acceptance per
   surface × theme × viewport during the child-issue work (acceptance criterion D).

## Executive summary

The design-system reference (`design-system/`) is a self-contained, Apple-grade reference site with an
overall self-audit score of **4.1 / 5** (see [audit.html](../../design-system/audit.html)). Its foundations,
the three colour modes, and accessibility already score 5/5. The gap it names is **architecture and breadth**,
not taste: the product carried its system logic in **primitive tokens alone**, with no semantic/component
token layer, and a core component set that has not yet grown to cover the full product.

The product UI (`packages/keiko-ui`) is a **single-route governed desktop**: one real interactive route (`/`)
renders `KeikoDesktop → AppShell`, and the apparent "pages" are 31 tool-window types rendered on the
`Workspace` canvas. The entire visual language lives in **one 16,191-line `globals.css`** with global class
names — there is no CSS-Modules, Tailwind, styled-components, or Storybook layer. See
[fidelity-matrix.md](fidelity-matrix.md) for the full surface inventory.

### The central gap — tokens stop at the primitive tier

The design-system defines a four-layer token architecture; the product implements only the first layer
(plus the editor extension):

| Tier                                                       | Design-system reference                                                    | Tokens | In product `globals.css`?       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- | -----: | ------------------------------- |
| 1 — Primitives                                             | [keiko-tokens.css](../../design-system/keiko-tokens.css)                   |     32 | **Yes** (`:root` lines 19–80)   |
| 2 — Scales (space/motion/z/opacity/blur/type/radius-alias) | [keiko-semantic-tokens.css](../../design-system/keiko-semantic-tokens.css) |     63 | **No — 0 present**              |
| 3 — Semantic (background/text/action/feedback/focus…)      | keiko-semantic-tokens.css                                                  |     38 | **No — 0 present**              |
| 4 — Component (button/input/card/ai/table/nav…)            | keiko-semantic-tokens.css                                                  |     59 | **No — 0 present**              |
| Editor (extends Tier 1)                                    | [keiko-editor-tokens.css](../../design-system/keiko-editor-tokens.css)     |     58 | **Yes** (lifted, lines 656–831) |

**160 mid/top-tier tokens are absent from the product.** Components wire directly to raw Tier-1 primitives
(`var(--card)`, `var(--fg-muted)`), and large categories have **no scale at all**: 38 raw `z-index` values
(with collisions), 1,012 raw spacing declarations, 559 raw `font-size` declarations, 97 raw motion durations.
Two Tier-1 primitives (`--focus-w`, `--grid-dot`) and the `@media (forced-colors: active)` mode block are also
missing. Full evidence: [token-component-reuse-map.md](token-component-reuse-map.md).

### Light Mode verdict

Light Mode is architecturally **sound and mature** — the product uses a token-override model
(`[data-theme="light"]` redefines the same token names) with WCAG-measured contrast corrections, and the
design-system rates Light Mode 5/5. The defect is the **one-off override layer the epic forbids**: 49
component-scoped `[data-theme="light"] .selector` rules patch components that hardcoded dark-biased values
(raw `rgba(0,0,0,…)` shadows, white insets) instead of routing through tokens, and several components with the
same defect were never patched, so they leak dark shadows into Light Mode. Full classified register:
[light-mode-deviation-register.md](light-mode-deviation-register.md).

### Migration sequence (child issues)

The audit's prioritised to-dos map cleanly onto the epic's required implementation order. #1292 is the
foundation gate; nothing else should land before it.

| Order | Child                                                      | Scope                                                                                                                                        | Foundation dependency  |
| ----- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1     | [#1292](https://github.com/oscharko-dev/Keiko/issues/1292) | Consolidate runtime tokens + Light Mode foundations (port Tiers 2–4, add `--focus-w`/`--grid-dot`, add forced-colors + in-app high-contrast) | — (gate for all below) |
| 2     | [#1293](https://github.com/oscharko-dev/Keiko/issues/1293) | Migrate global shell + workspace chrome to semantic/component tokens                                                                         | #1292                  |
| 3     | [#1294](https://github.com/oscharko-dev/Keiko/issues/1294) | Migrate reusable controls + component primitives                                                                                             | #1292                  |
| 4     | [#1295](https://github.com/oscharko-dev/Keiko/issues/1295) | Migrate high-traffic product surfaces                                                                                                        | #1292–#1294            |
| 5     | [#1296](https://github.com/oscharko-dev/Keiko/issues/1296) | Specify + implement the AI/agent component set                                                                                               | #1292, #1294           |
| 6     | [#1297](https://github.com/oscharko-dev/Keiko/issues/1297) | Build the data-display (table/data-grid) foundation                                                                                          | #1292, #1294           |
| 7     | [#1298](https://github.com/oscharko-dev/Keiko/issues/1298) | Complete input, navigation, breakpoint + density coverage                                                                                    | #1292, #1294           |
| 8     | [#1299](https://github.com/oscharko-dev/Keiko/issues/1299) | Standardise component states, documentation, governance                                                                                      | all above              |
| 9     | [#1300](https://github.com/oscharko-dev/Keiko/issues/1300) | Visual-regression automation + designer acceptance evidence                                                                                  | all above              |

## Reuse and no-duplication posture (epic gate)

The design-system tokens were **lifted 1:1 from the product `globals.css`** (the primitive provenance runs
product → reference), and the editor tier was lifted back into the product. Consolidation must therefore
**extend `globals.css` as the single token source** — layer the semantic/component aliases on top of the
existing primitives — and must **not** introduce a second `:root` token block, a parallel theme engine, a
CSS-Modules/Tailwind/styled-components layer, or a duplicate token namespace. The standalone
`design-system/*.css` files stay the reference and visual-regression ground truth; they are not shipped as a
second live stylesheet. Per-asset reuse decisions are in
[token-component-reuse-map.md](token-component-reuse-map.md).

## Method and provenance

This blueprint was produced read-only against the `release/0.2.0` snapshot. The required input
[audit.html](../../design-system/audit.html) was used as the system scorecard, but the conclusions here are
**product-specific** (the design-system audit page is not treated as closure evidence for production UI
fidelity, per the issue's Engineering Notes). Findings cite exact `path:line` evidence. No production UI files
were modified.
