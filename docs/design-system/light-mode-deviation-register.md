# Deliverable 2 — Light Mode Deviation Register

Parent Epic: [#1290](https://github.com/oscharko-dev/Keiko/issues/1290). Issue: [#1291](https://github.com/oscharko-dev/Keiko/issues/1291).
Companion: [README.md](README.md) · [fidelity-matrix.md](fidelity-matrix.md) · [token-component-reuse-map.md](token-component-reuse-map.md).

Every known Light Mode mismatch is enumerated here with exact `path:line` evidence, a reproduction path, and a
classification of **blocking** / **required** / **approved deviation** (acceptance criterion B). Target file:
[packages/keiko-ui/src/app/globals.css](../../packages/keiko-ui/src/app/globals.css) (16,191 lines).

## Architecture (sound) and the defect pattern

Light Mode uses a **token-override model**: `:root` (lines 19–80) holds the dark token set; `[data-theme="light"]`
(lines 582–622) re-declares the **same** custom-property names with light values, including light-tuned shadow
tokens (`--shadow-card`/`--shadow-pop` use `rgba(20,30,25,…)` ink instead of black at lines 620–621) and
AA-darkened text/status tones carrying inline WCAG-ratio comments (lines 594–618). The editor tier mirrors the
pattern (dark lines 656–724, light 725–751). This is mature and correct — the design-system rates Light Mode 5/5.

The **defect** is the one-off override layer the epic forbids: **49 component-scoped `[data-theme="light"] .selector`
rules** patch individual components that hardcoded dark-biased literals (raw `rgba(0,0,0,…)` shadows,
`oklch(1 0 0/…)` white insets) instead of routing through tokens. Where a component has the same raw-shadow
defect but was **never** given a patch, it leaks a dark shadow into Light Mode. The canonical example is `.ws-fab`:
a code comment at `globals.css:15904` ("C415 — `.ws-fab` keeps a hardcoded 50%-black drop shadow in light theme")
documents that the fix for a raw `rgba(0,0,0,0.55)` shadow was a per-component light override rather than tokenising
the shadow. The correct fix is to route every shadow/overlay through a token (`--shadow-card`/`--shadow-pop` or a
new `--overlay-scrim`/`--shadow-*`) so light values flow automatically. This work is owned by
[#1292](https://github.com/oscharko-dev/Keiko/issues/1292) (token foundations) and
[#1293](https://github.com/oscharko-dev/Keiko/issues/1293)/[#1295](https://github.com/oscharko-dev/Keiko/issues/1295) (surface migration).

## Classification scheme

- **blocking** — breaks mode-correctness or token governance for an interactive/overlay surface; must be fixed
  before the epic can claim Light Mode fidelity.
- **required** — a real Light Mode mismatch or a forbidden one-off override that must be migrated to a token.
- **approved deviation** — a legitimate, intentional per-mode token correction (WCAG ink flip, editor syntax
  palette, accent-text-on-white) that is correct today; it should be migrated to the semantic/component token
  layer opportunistically but is not a defect.

## Reproduction harness

Theme is published on `<html data-theme>` by [hooks/useTheme.ts](../../packages/keiko-ui/src/app/components/desktop/hooks/useTheme.ts)
(storage key **`keiko.theme`**, default `dark`) and bootstrapped pre-paint in `app/layout.tsx:40`. To reproduce any
row: set `localStorage["keiko.theme"] = "light"` and reload (the bootstrap applies `data-theme=light` before first
paint), **or** toggle the sun/moon control in the left rail (`LeftRail.tsx:151-163`), **or** in devtools run
`document.documentElement.dataset.theme = "light"`. Then navigate to the named surface. (Note: the design-system
reference pages use a different key, `keiko-ds-theme`; the product key is `keiko.theme`.)

## Table A — visible Light Mode defects (hardcoded dark-biased values)

These components hardcode a dark-biased shadow/inset/glow and have **no** correct light treatment.

| #   | Surface                                                          | Location                                    | Defect                                                                                                                                     | Class              | Reproduction                                                                                                                       |
| --- | ---------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Select/tooltip popover `.ksel-menu`                              | `globals.css:317-321`                       | `box-shadow … rgba(0,0,0,0.85)` + `color-mix(--surface 98%, black)` bg; no light override → heavy black shadow + muddy gray on off-white   | required           | theme=light; open any KeikoSelect dropdown (model picker, source-kind selectors)                                                   |
| A2  | Header tool CTA `.hd-tool-cta`                                   | `globals.css:1064-1074`                     | `box-shadow … rgba(0,0,0,0.75)` + white inset bevel `oklch(1 0 0/0.04)`; bypasses light `--shadow-card`; shadow too heavy, bevel invisible | required           | theme=light; header tool CTA in top bar                                                                                            |
| A3  | Workspace zoom control `.ws-zoom`                                | `globals.css:1454-1464`                     | `box-shadow … rgba(0,0,0,0.9)` (heaviest in file) + white inset; near-black ambient on off-white                                           | required           | theme=light; workspace zoom % control                                                                                              |
| A4  | Composer model menu `.cmp-model-menu`                            | `globals.css:2333-2337`                     | `box-shadow … rgba(0,0,0,0.8)`; no light override                                                                                          | required           | theme=light; open model selector in chat composer                                                                                  |
| A5  | QI source-kind tooltip `.qi-source-kind-option[data-tip]::after` | `globals.css:10895-10904`                   | `box-shadow … rgba(0,0,0,0.85)` + `color-mix(--surface 96%, black)`; heavy shadow + gray tint                                              | required           | theme=light; hover a QI source-kind option with a tooltip                                                                          |
| A6  | Chat brand logo `.chat-msg-brand img`                            | `globals.css:5915-5938`                     | `filter: drop-shadow(… rgba(0,0,0,0.72))` (static + keyframes); dark smudge halo on off-white                                              | required           | theme=light; open a chat thread; brand avatar (animated when `data-pulsing=true`)                                                  |
| A7  | Workspace FAB base `.ws-fab`                                     | `globals.css:4945-4956`                     | base shadow `rgba(0,0,0,0.55)`; the C415 defect — fixed by a one-off override at 15904 instead of tokenising (architectural deviation)     | required           | theme=light; inspect both `.ws-fab` rules in devtools (override masks the visual defect)                                           |
| A8  | Generation-pref slider thumb `.gpref-slider` thumb               | `globals.css:4015-4027`                     | `box-shadow … rgba(0,0,0,0.35)` on `::-webkit/::-moz` thumbs; mild over-darkening, low impact                                              | approved deviation | theme=light; open generation preferences slider                                                                                    |
| A9  | Window frame inset highlight `.win` frame                        | `globals.css:1503-1510`                     | inset `oklch(1 0 0/0.025)` top-bevel assumes dark surface; invisible (dead style) in light                                                 | approved deviation | theme=light; inspect a workspace window frame top edge                                                                             |
| A10 | Workflow log wells + Figma image preview                         | `globals.css:12845,12901,12983,12998,13006` | `color-mix()` over `--bg`/`--card` (88-92%) darkened with black is theme-blind → flat light-gray well in light                             | approved deviation | theme=light; open a workflow run log well / Figma image window                                                                     |
| A11 | Strong danger fill `color-mix(--danger 75%, black)`              | `globals.css:10980-10981`                   | black-mix darken on `--danger`; stays legible (dark on light); direction happens to be correct                                             | approved deviation | theme=light; trigger strong/active danger button state                                                                             |
| A12 | Product chrome — forced-colors / Windows HCM                     | `globals.css` (entire file)                 | **zero** `@media (forced-colors: active)` blocks; only the Monaco editor adapts via JS (`useEditorThemeVariant.ts:36,59`)                  | required           | enable OS forced-colors (Windows HC or devtools Rendering → forced-colors: active); product chrome has no app-controlled treatment |

## Table B — the one-off `[data-theme="light"]` override layer (49 component-scoped rules)

The full enumeration of every component-scoped `[data-theme="light"] .selector` rule, classified. (The **five**
token/architecture `[data-theme="light"]` blocks at lines **582**, **637**, **725**, **774**, and **814** are the
legitimate per-mode token redefinition, not a deviation — 637 and 774 sit inside `@media (prefers-contrast: more)`
and 814 is `[data-hc="more"][data-theme="light"]`; lines 13782 and 14503 are comments, not rules.)

| Group                         | Selectors (line)                                                                                                                                                                                                                                                                                                                                             | Purpose                                                                                      | Class                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Overlay scrims                | `.dlg-overlay` (832), `.wf-dialog-overlay` (13085), `.cmdk-overlay` (13357), `.gw-setup-backdrop` (13360), `.mc-dialog-backdrop` (14507 **and** 15056 — duplicated)                                                                                                                                                                                          | Per-component light scrim re-stated by value; should be one `--overlay-scrim` token          | **required** (tokenise; dedupe the duplicate)                                                                                |
| FAB / primary shadow          | `.ws-fab` (835 and 15904), `.dlg-primary` (836), `.cmp-send[data-on]` (837)                                                                                                                                                                                                                                                                                  | C415 shadow/fill patches that paper over hardcoded dark shadows                              | **required** (route through `--shadow-*`)                                                                                    |
| Editor syntax palette (light) | `.fpv-code` (4167), `.fpv-src` (4170), `.hl-key` (4173), `.hl-str` (4176), `.hl-num`/`.hl-lit` (4182–4183), `.hl-fn`/`.hl-key2` (4186–4187), `.hl-type` (4190), `.hl-punct` (4193), `.fpv-num`/`.ed-num`/`.hl-com` (13503–13505)                                                                                                                             | Documented light syntax palette for the FilePreview highlighter                              | approved deviation (migrate to `--ed-syn-*` tokens — see [token-component-reuse-map.md](token-component-reuse-map.md) D-row) |
| Status-badge ink flips        | `.qi-badge-succeeded`/`-running`/`-cancelled` (841–843), `.qi-cand-risk` (11358), `.run-summary-card-status[succeeded/completed]` (13284–13285), `.mc-badge-proposed` (13581), `.cmp-budget-badge-low` (13784), `.lk-badge[indexing]` (15042)                                                                                                                | WCAG ink-inverse / darkened-tone corrections so badge text clears contrast on light tints    | approved deviation (legitimate; fold into `--feedback-*` semantic tokens)                                                    |
| Link + focus + control ink    | `.sm-link` (9760), `.sm-link:hover` (9763), `.sm-link:focus-visible` (9766), `:focus-visible` (13454), `.rv-truncated a:focus-visible` (13458), `.win-close:hover` (13493), `.arun-btn.danger:hover` (13497), `.modesw-av`/`.ft-you` (13718–13719), `.qi-btn-approve` (15395), `.qi-btn-reject` (15399), `.install-banner-btn-dismiss`/`-desc` (10381–10382) | Accent-text / danger-ink / focus-ring corrections for ≥4.5:1 (text) or ≥3:1 (focus) on white | approved deviation (legitimate WCAG corrections; fold into `--text-accent`/`--feedback-*`/`--focus-ring`)                    |
| Connection-edge colours       | `.conn-path` (15735), `.conn-dot`/`.conn-particle` (15738–15739), `.win-port` (15742)                                                                                                                                                                                                                                                                        | Accent-text edge colour so connectors clear 3:1 on white (WCAG 1.4.11 non-text)              | approved deviation (legitimate; fold into `--ai-source-*`/semantic accent tokens)                                            |

Count: 5 token/architecture blocks (582, 637, 725, 774, 814) + 49 component-scoped override selectors + 2 comment
false-positives = 56 `[data-theme="light"]` occurrences. Of the 49 overrides, **10 are `required`** (overlay scrim
group = 6, FAB/primary shadow group = 4) and **39 are approved deviations** (legitimate per-mode corrections to
migrate into the semantic/component token tier).

## Related blocking item (token governance, affects overlay mode-correctness)

`z-index` has **no token scale**: 38 raw values with collisions at 9000/9999/10000/99999 across portalled
dialogs, command palette, overlays, and the install banner (`globals.css:313,473,…,14723`). This is classified
**blocking** in the [token-component-reuse-map.md](token-component-reuse-map.md) systemic-gaps table; it affects
the stacking correctness of the same overlay surfaces listed in Table B and must be resolved by a named layer
scale under #1292.

## Acceptance criterion B — coverage statement

Every known Light Mode mismatch is classified: Table A (12 visible defects: 8 required incl. forced-colors,
4 approved deviations) and Table B (all 49 component-scoped `[data-theme="light"]` overrides: 10 required,
39 approved deviations), plus the related blocking `z-index` governance item. No `[data-theme="light"]` rule and
no hardcoded-dark-shadow surface is left unclassified. Reproduction steps are provided for every row in Table A;
Table B rows reproduce via the same theme-toggle harness and the cited selector.
