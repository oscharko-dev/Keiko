# Design System 0.4.0 — Visual Regression & Designer Acceptance (Issue #1300)

Status: Accepted (Issue #1300, Epic #1290, 2026-06-22)
Version: 0.2.0
Owner: `verifier` (coordinator) · Human Review Required: **Yes**

This is the **final evidence gate** for epic #1290 (pixel-perfect Keiko Design System). Children #1291–#1299
each migrated one product surface onto Design System 0.4.0 tokens and shipped a per-surface 0-diff proof.
This document consolidates that work into a single, **re-runnable** visual-regression suite, a cross-theme
/ cross-viewport screenshot bundle, a dedicated **editor matrix**, an accessibility proof, a performance
smoke, the **final variance register**, and the **designer-acceptance** record so Engineering and Design can
close the epic on evidence rather than subjective claims (per [ADR-0050](../adr/ADR-0050-component-state-and-governance-contract.md)
Gate 8: visual inspection of the running UI is primary; automated checks are supporting).

All artifacts live under [`evidence/1300/`](evidence/1300/) and are reproduced by three commands plus the
CI-enforced vitest block (see [Re-runnable verification](#re-runnable-verification)).

---

## 1. Agreed surface matrix

The 0.4.0 reference/product matrix covered by the consolidated suite. Every row is proven by computed-value
fidelity probes (product `globals.css` vs the governed DS reference CSS) **and** rendered screenshots.

| Surface family        | Product selectors                                                                      | DS 0.4.0 reference          | Reference page        | Migrated by | Modes |
| --------------------- | -------------------------------------------------------------------------------------- | --------------------------- | --------------------- | ----------- | ----- |
| AI / agent            | `.ai-response/.ai-tool/.ai-source/.ai-permit/.ai-conf/.ai-cite/.ai-avatar/.ai-danger`  | `keiko-ai.css`              | `ai-components.html`  | #1296       | 7     |
| Data grid             | `.c-table/.c-tablewrap/.c-table-foot/.c-table-empty`                                   | `keiko-data.css`            | `data-grid.html`      | #1297       | 7     |
| Data viz              | `.viz/.viz-bar/.viz-gridlines/.viz-yaxis/.viz-tip/.viz-legend/.viz-seq`                | `keiko-dataviz.css`         | `dataviz.html`        | #1297       | 7     |
| Inputs                | `.c-check/.c-radio/.c-slider/.c-stepper/.c-combo/.c-tagfield/.c-datefield/.c-fileitem` | `keiko-inputs.css`          | `inputs.html`         | #1298       | 7     |
| Navigation            | `.c-crumbs/.c-back/.c-utabs/.c-pager/.c-ctx/.c-steps`                                  | `keiko-nav.css`             | `nav-components.html` | #1298       | 7     |
| Component states      | 11-state applicability matrix (data-state)                                             | `keiko-semantic-tokens.css` | `states.html`         | #1299       | 7     |
| App shell / chrome    | `.header/.hd/.workspace/.ws/.rail/.stage/.footer/.ws-fab/.ws-zoom`                     | shell tier                  | running app `/`       | #1293       | 6     |
| High-traffic surfaces | chat / QI / grounded / Local Knowledge / memoria / relationships / files / editor      | semantic tier               | seeded app workspaces | #1294/#1295 | 6     |
| Editor token tier     | `--ed-*` (chrome, gutter, 12-colour syntax, selection/find, diff, agent, focus)        | `keiko-editor-tokens.css`   | `editor-*.html` (7)   | editor tier | 4     |

Token tiers (`keiko-tokens.css` Tier-1, `keiko-semantic-tokens.css` Tier-2/3/4) are pinned independently by
the existing `Issue #1292` drift gate and are the resolution base for every surface above.

---

## 2. Selected visual-diff tolerance & artifact retention

**Tolerance.** The authoritative gate is **computed-value fidelity** (not raw pixel diffing), because the
product and the DS reference author the same colour two ways (the product uses hex `#4eba87` for the brand
`--accent`; the reference uses `oklch(0.72 0.124 160)`). Every probed colour is normalised to rendered sRGB
pixels through an in-page `<canvas>` and compared with a tolerance of **≤ 1 LSB per channel** (`oklch()→sRGB`
and `hex→sRGB` rounding can differ by one least-significant bit). The gate is **0-diff in Dark and Light** for
every neutral/semantic surface; High Contrast, forced-colors, reduced-motion and accent-derived surfaces are
**recorded, not gated** (rationale in the [variance register](#5-final-variance-register)). This is consistent
with, and supersedes for the consolidated gate, the pixel-ratio note in
[visual-qa-matrix.md §5](visual-qa-matrix.md) (`maxDiffPixelRatio ≤ 0.001` for raw screenshot diffing).

**Determinism** (Stop Condition: no flaky baselines). All harnesses are deterministic: `page.setContent`
/ `file://` (no server timing for the fidelity gates), fixed viewport + `deviceScaleFactor`, fixed seed data,
canvas-normalised colour, and emulated `prefers-reduced-motion` so animation never enters a capture.

**Retention.** Artifacts are retained **in-repo** under `docs/design-system/evidence/1300/` (PNG + JSON), so
the baseline travels with the source it proves and any future contributor reruns the harness to regenerate and
diff. The CI-enforced `Issue #1300` vitest block pins the proof JSON + this register against the product CSS so
drift fails `ci`/`ui` without needing the browser.

---

## 3. Re-runnable verification

From the repo root, after `npm ci` + `npx playwright install chromium`:

| Command                                                                                                         | Proves                                                                  | Gate                                                                    | Artifacts                                               |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `node docs/design-system/evidence/1300/equivalence-harness.mjs`                                                 | component reference fidelity + a11y smoke + perf smoke                  | exit ≠ 0 on any gated diff / missing selector / a11y / perf failure     | `consolidated-fidelity-proof.json`, `01..11-*.png`      |
| `npm run build --workspace @oscharko-dev/keiko-ui && node docs/design-system/evidence/1300/browser/capture.mjs` | running-app shell + seeded high-traffic workspaces across the matrix    | exit ≠ 0 on page error, missing shell, or missing required selector     | `browser/*.png`, `browser/manifest.json`                |
| `node docs/design-system/evidence/1300/editor/capture.mjs`                                                      | editor token tier fidelity + reference-page captures                    | exit ≠ 0 on any gated editor-token diff or missing/erroring ref capture | `editor/editor-fidelity-proof.json`, `editor/ref-*.png` |
| `node docs/design-system/evidence/1300/a11y/axe-proof.mjs`                                                      | axe-core WCAG 2.1 A/AA across 7 modes                                   | exit ≠ 0 on serious/critical violation or unresolved incomplete finding | `a11y/a11y-proof.json`                                  |
| `npm run test:coverage:ui` (CI `ui` + `ci`)                                                                     | the `Issue #1300` drift gate pins this register + proofs                | vitest red on drift                                                     | —                                                       |
| `npm run test:e2e:editor-fidelity-1295` / `-1296`                                                               | running Monaco / tabs / diagnostics / find / ghost-text / agent prompts | playwright red on regression                                            | `evidence/1295/editor/`, `evidence/1296/editor/`        |

### Results (this run)

- **Component reference fidelity:** 427 probes, **0 gated diffs** (Dark + Light); 0 recorded diffs in HC /
  forced-colors / prefers-contrast / reduced-motion. `verdict: PASS`.
- **Editor token fidelity:** 160 gated probes, **0 gated diffs** (Dark + Light); 10 accent-derived recorded;
  3 reference-only tokens recorded (carried-forward). `verdict: PASS`.
- **Accessibility:** axe-core 4.12.0, **0 serious/critical violations** in every one of the 7 modes
  (40 passing checks per mode); unresolved incomplete findings are 0 after the checked-in `color-contrast`
  disposition. `verdict: PASS`.
- **Performance smoke:** bounded 250-row sticky table — 250 rows scrolled in **0.1 ms**, sticky-header delta
  **0 px**, scroll engaged (`afterScrollTop > 0`). `verdict: PASS`.
- **Running-app bundle:** 72 captures (**4 scenarios × 6 modes × 3 viewports**) with the shell present,
  required selectors present, and **0 page errors**. Scenarios cover the empty shell, chat / Quality
  Intelligence / Local Knowledge, MemoriaViva / Relationships, and Files / Editor.

---

## 4. Designer acceptance — agent visual-inspection notes

Per ADR-0050 Gate 8, pixel/token/contrast automation is supporting evidence only; the surfaces below were
**inspected as rendered images** (not measured) for polish, readability and usability. `Human Review Required`
remains **Yes** — these notes are the autonomous agent-assisted acceptance pass; final human designer sign-off
is the governance step recorded on the epic.

| Surface                                                | Reference compared    | Inspection note                                                                                                                                                                                | Variance                               | Disposition                   |
| ------------------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------- |
| AI components (Light/Dark)                             | `ai-components.html`  | Response/tool cards, citations, confidence meters (high/med/low), permission + danger prompts read cleanly; hierarchy and spacing match the reference; running-spinner + status pills legible. | none                                   | ✅ accept                     |
| Data grid (Light/Dark)                                 | `data-grid.html`      | Header, selected row (accent tint), zebra body, footer count, empty state all polished; numeric column right-aligned; sticky header holds on scroll.                                           | accent tint (~1.5%)                    | ✅ accept                     |
| Data viz (Light/Dark)                                  | `dataviz.html`        | Categorical bars, sequential ramp, gridlines, y-axis, tooltip render with the governed palette; legible at small sizes.                                                                        | accent/palette (~1.5%)                 | ✅ accept                     |
| Inputs (Light/Dark)                                    | `inputs.html`         | Checkbox/radio (default + checked), slider, stepper, combobox (open listbox), tag field, date field, file item with progress — all crisp; focus targets clear.                                 | accent fills (~1.5%)                   | ✅ accept                     |
| Navigation (Light/Dark)                                | `nav-components.html` | Breadcrumbs, back, underline tabs, pager (current page accent), context menu popover, stepper wizard render correctly.                                                                         | accent (~1.5%)                         | ✅ accept                     |
| App shell `/` (Light/Dark)                             | running app           | Header brand + window controls, left rail icons, dot-grid workspace, "Empty workspace" empty-state, zoom/FAB, footer — production-clean in both themes.                                        | none                                   | ✅ accept                     |
| Seeded high-traffic workspaces                         | running app           | Deterministic `keiko.workspace.v4` captures cover chat / Quality Intelligence / Local Knowledge, MemoriaViva / Relationships, and Files / Editor windows across all viewports and modes.       | none                                   | ✅ accept                     |
| App shell `/` (forced-colors)                          | running app           | System borders correctly added to controls + workspace; everything legible under Windows High Contrast emulation.                                                                              | forced-colors borders (by design)      | ✅ accept                     |
| Editor chrome                                          | `editor-chrome.html`  | Tabs, source with 12-colour syntax highlighting, editor groups/splits, structural navigation, status line, minimap, chrome token map all render faithfully.                                    | none                                   | ✅ accept                     |
| Editor agent                                           | `editor-agent.html`   | Ghost text, reviewable add/remove diff, multi-file agent run, ask-at-caret, agent-surface tokens render faithfully.                                                                            | inlay/blame/fold tokens reference-only | ⏭ carry-forward (#1373/#1390) |
| Editor theme / gutter / navigation / panels / markdown | `editor-*.html`       | Theme swatches, gutter diagnostics, breadcrumbs/minimap/outline, problems/references/search panels, split markdown preview render faithfully across Dark + Light.                              | none                                   | ✅ accept                     |

No visual defect, contrast failure, illegible state, or unapproved deviation was observed. All themes include
**Light Mode** (Stop Condition satisfied).

---

## 5. Final variance register

Only the deviations below exist between the product and the DS 0.4.0 reference. All are **approved** or
**carried-forward with an owner** — none is an unresolved regression.

| #   | Variance                                                                                                                                         | Where                                                                                                                                   | Magnitude                                                           | Classification                                                                                              | Disposition                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| V1  | Brand `--accent` authored as hex `#4eba87` (product) vs `oklch(0.72 0.124 160)` (reference)                                                      | every accent-derived surface (viz bars, selected row, checked inputs, current page, editor selection/focus/statusbar-accent/agent-line) | ~1.5% sub-perceptual sRGB delta (e.g. `78,186,135` vs `82,188,138`) | **Approved deviation** — pre-existing primitive, identical token _chain_, outside the 0.4.0 migration scope | Recorded in every proof's accent bucket; not gated. No action.                                        |
| V2  | 0.4.0 editor tokens `--ed-inlay-fg`, `--ed-blame-fg`, `--ed-fold-placeholder` declared in reference, not yet in product (fall back to `--ed-fg`) | inlay hints, git blame, fold placeholder                                                                                                | full-colour (unadopted)                                             | **Carried-forward** — editor surfaces owned by editor epics **#1373 / #1390**, outside DS epic #1290        | Recorded in `editor-fidelity-proof.json` → `referenceOnly`; tracked for adoption by the editor epics. |
| V3  | High-contrast / forced-colors layering                                                                                                           | product layers `[data-hc]` + `@media (forced-colors)` palettes the bare reference page does not                                         | mode-specific                                                       | **Approved** — product adds accessibility hardening on top of the reference                                 | Recorded (not gated) in HC/forced-colors modes; verified by axe (0 serious/critical).                 |
| V4  | Light Mode one-off `[data-theme="light"]` overrides                                                                                              | enumerated in [light-mode-deviation-register.md](light-mode-deviation-register.md)                                                      | per-surface                                                         | **Approved deviations** (register must shrink, not grow — ADR-0050 Gate 6)                                  | Governed debt ledger; unchanged by #1300.                                                             |

---

## 6. Child-issue evidence index (epic #1290)

Final evidence links back to **every** child affected by the 0.4.0 update (required by the issue):

- #1291 — fidelity blueprint + ADR-0049: [fidelity-matrix.md](fidelity-matrix.md), [visual-qa-matrix.md](visual-qa-matrix.md), [light-mode-deviation-register.md](light-mode-deviation-register.md), [token-component-reuse-map.md](token-component-reuse-map.md)
- #1292 — token consolidation: [evidence/1292/](evidence/1292/)
- #1293 — shell/chrome migration: [evidence/1293/](evidence/1293/)
- #1294 — controls/primitives migration: [evidence/1294/](evidence/1294/)
- #1295 — product-surface migration + editor fidelity: [evidence/1295/](evidence/1295/), [evidence/1295/editor/](evidence/1295/editor/)
- #1296 — AI component set + editor-agent: [evidence/1296/](evidence/1296/), [evidence/1296/editor/](evidence/1296/editor/), [ai-components.md](ai-components.md)
- #1297 — data-grid + dataviz: [evidence/1297/](evidence/1297/), [data-display-migration.md](data-display-migration.md)
- #1298 — inputs + navigation: [evidence/1298/](evidence/1298/), [input-nav-migration.md](input-nav-migration.md)
- #1299 — component states + governance: [evidence/1299/](evidence/1299/), [state-matrix.md](state-matrix.md), [governance.md](governance.md), [editor-governance.md](editor-governance.md)
- #1300 — this consolidated gate: [evidence/1300/](evidence/1300/)

---

## 7. Epic closure readiness

With component fidelity (427/427), editor token fidelity (160/160), accessibility (0 serious/critical × 7
modes), performance smoke, the cross-theme/cross-viewport shell and seeded high-traffic screenshot bundle, the
editor matrix, and this variance register all green and re-runnable, epic #1290 has measurable, reproducible
evidence for closure. The only open carry-forward (V2) is explicitly owned by the editor epics #1373/#1390 and
is not a #1290 deliverable. Final human designer sign-off (`Human Review Required: Yes`) is the remaining
governance step, recorded on the epic closure comment.
