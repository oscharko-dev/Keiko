# Deliverable 3 — Token / Component Reuse Map and Implementation Sequence

Parent Epic: [#1290](https://github.com/oscharko-dev/Keiko/issues/1290). Issue: [#1291](https://github.com/oscharko-dev/Keiko/issues/1291).
Companion: [README.md](README.md) · [fidelity-matrix.md](fidelity-matrix.md) · [light-mode-deviation-register.md](light-mode-deviation-register.md) · [visual-qa-matrix.md](visual-qa-matrix.md).

This document records the reuse decision for every styling asset, the dependency-ordered token implementation
sequence, and the **exact files each child issue will edit** (acceptance criterion C). It enforces the epic's
reuse / no-duplication gate.

## 1. Two divergent token systems (the reuse-gate concern)

There are two styling sources, and they have **diverged**:

1. [design-system/](../../design-system/) — a standalone reference site (11 HTML spec pages + 6 CSS files). It is
   **not imported anywhere** in the app (grep for a `design-system` import/`@import`/`href` across `packages/`
   returns zero live consumers). [keiko-tokens.css](../../design-system/keiko-tokens.css) self-describes as
   "lifted 1:1 from packages/keiko-ui globals.css". It implements the clean four-layer token architecture.
2. [packages/keiko-ui/src/app/globals.css](../../packages/keiko-ui/src/app/globals.css) — the **sole live
   stylesheet** (16,191 lines), imported once at `app/layout.tsx:3`. It has the Tier-1 primitives and editor
   tier but **zero** Tier-2/3/4 tokens.

**Provenance is bidirectional**: primitives went product → reference (the "lifted 1:1" note); the editor tier
went reference → product (`globals.css:646-654`). The new scale/semantic/component tiers
([keiko-semantic-tokens.css](../../design-system/keiko-semantic-tokens.css), 160 tokens) have **not** been
propagated back into the product.

### Reuse gate posture (mandatory)

- The product already runs **one** theme engine — CSS custom properties + global classes switched by
  `data-theme` / `data-hc` / `data-input-modality` and `@media (prefers-contrast|forced-colors|reduced-motion)`.
  There are **no** CSS Modules (`0` `*.module.css`), no Tailwind, no styled-components/emotion/stitches/
  vanilla-extract, and no Storybook in `keiko-ui/package.json`. **Migration must introduce none of these.**
- Consolidation = make `globals.css` the single emitted source and **layer the semantic/component aliases on
  top of the existing primitives**. Adding a second `:root` token block alongside the existing primitives would
  create the duplicate-namespace / parallel-token-source the gate forbids — **do not** keep `design-system/*.css`
  as a second live copy.
- The editor tier is the precedent: `keiko-editor-tokens.css` "EXTENDS the base palette … it does not fork it".
  Every tier consolidates the same way.

## 2. Quantified token gap

The product is missing the entire mid/top of the architecture (verified by full-file grep returning zero
matches for each family):

| Tier           | Families                                                                                                                                                                                                        | Tokens missing |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------: |
| 2 — Scales     | `--space-*` (13), `--radius-{pill,control,surface,floating}` (4), `--weight-*` (4), `--leading-*` (4), `--text-<role>` size (9), `--opacity-*` (5), `--blur-*` (3), `--dur-*` (5), `--ease-*` (4), `--z-*` (12) |         **63** |
| 3 — Semantic   | `--background-*` (2), `--surface-*` (5), `--text-*` (8), `--border-*` (3), `--action-*` (5), `--feedback-*` (8), focus/selection (3), overlay (2), skeleton (2)                                                 |         **38** |
| 4 — Component  | `--button-*` (12), `--input-*` (8), `--card-*` (4), `--modal-*` (4), popover/tooltip/menu (6), `--toast-*` (3), `--ai-*` (13), `--table-*` (4), `--nav-*` (5)                                                   |         **59** |
| Primitive gaps | `--focus-w`, `--grid-dot`                                                                                                                                                                                       |          **2** |
| Mode gaps      | `@media (forced-colors: active)` block; in-app neutral `[data-hc]` override (today editor-only)                                                                                                                 |     (2 blocks) |

Total mid/top tokens absent: **160**.

### Raw-value debt (no scale exists) — measured

| Category   | Measured in `globals.css`                                                                                                                                                                                                                                                               | Class        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| z-index    | 38 raw values, 0 tokenised; collisions at 9000/9999/10000/99999                                                                                                                                                                                                                         | **blocking** |
| spacing    | 425 `padding` + 448 `gap` + 139 `margin` raw px, 0 `var()`                                                                                                                                                                                                                              | required     |
| font-size  | 582 declarations, 559 raw px, 0 `var()`, 21 distinct sizes (incl. fractional 9.5–15.5px)                                                                                                                                                                                                | required     |
| motion     | 97 transition/animation declarations, 0 duration/easing tokens (easings duplicated by value)                                                                                                                                                                                            | required     |
| radius     | 392 declarations: 133 `var(--radius*)` + **202 raw-px bypass** (12 off-scale values) + ~57 legit pill/circle                                                                                                                                                                            | required     |
| box-shadow | 91 declarations, 18 fully hardcoded + several token+raw-ambient mixes                                                                                                                                                                                                                   | required     |
| color      | `.hl-*`/`.fpv-*` syntax hex (the `--ed-syn-*` tokens exist at lines 660–829 but are consumed by **0** `var(--ed-syn`), raw `oklch` scrims repeated by value, raw brand-green glow (`rgba(126,224,171,…)`), `#fff` on-accent ink where `--ink-inverse` exists, `EditorMenu.tsx` tile hex | required     |

Legitimate raw values (NOT to migrate): the `WorkspaceShader.tsx` WebGL `vec3` constants, `layout.tsx:31`
`themeColor:"#4EBA87"` (PWA manifest), `EmptyWorkspaceBlob.tsx` SVG `<mask>` `#fff`/`#000`, `color-mix(… #000/#fff)`
math endpoints, and documentation comments / issue refs.

## 3. Implementation sequence (dependency-ordered)

`#1292` is the foundation gate. Tier order is strict because each tier resolves to the one below it.

1. **#1292 — token consolidation foundation.** Land in `globals.css` in this order: (a) add missing Tier-1
   primitives `--focus-w`, `--grid-dot`; (b) Tier-2 scales (`--space-*`, `--z-*` first — `--z-*` closes the
   blocking z-index gap — then `--dur-*`/`--ease-*`, `--opacity-*`, `--blur-*`, `--text-<role>`, `--weight-*`,
   `--leading-*`, radius aliases); (c) Tier-3 semantic aliases; (d) Tier-4 component aliases; (e) add the
   `@media (forced-colors: active)` block and an in-app neutral `[data-hc]` override mirroring the design-system.
   All aliases resolve to existing primitives, so the live product is byte-identical until components are
   migrated. Extend `globals.css.test.ts` to assert each new tier exists.
2. **#1293 / #1294** — migrate shell/chrome and reusable controls to consume the new tokens (find-and-replace
   raw primitives → semantic/component tokens; no visual change expected). **Both shipped** (value-preserving;
   see the per-section status notes and [evidence/1293](evidence/1293/) / [evidence/1294](evidence/1294/)).
3. **#1295** — migrate high-traffic product surfaces; resolve the Light Mode `required` rows (Table A/B) by
   tokenising shadows/scrims.
4. **#1296 / #1297 / #1298** — net-new component families (AI/agent set, data grid, input/nav/breakpoints)
   consuming the Tier-4 tokens.
5. **#1299 / #1300** — state matrix + governance + visual-regression automation and designer evidence.

## 4. Reuse decisions by asset

| Asset                                                                             | Decision              | Child         | Rationale                                                                                                                                                         |
| --------------------------------------------------------------------------------- | --------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design-system/keiko-tokens.css` (Tier-1 primitives)                              | generalize            | #1292         | Same-named superset of `globals.css` primitives ("lifted 1:1"). Make it the single primitive source; do not keep a detached copy.                                 |
| `design-system/keiko-semantic-tokens.css` (Tiers 2–4)                             | extend                | #1292         | 160 net-new aliases layered on top of the existing primitives in `globals.css`; never a second `:root`.                                                           |
| `design-system/keiko-editor-tokens.css`                                           | extend                | #1292         | Already lifted into `globals.css` (656–831). Keep extend model; wire via `useEditorThemeVariant.ts`.                                                              |
| `design-system/components.css` (canonical component recipes)                      | generalize            | #1294         | The `.c-*` recipes are the spec the product control classes must be generalised to match.                                                                         |
| `design-system/ds.css` (site chrome)                                              | untouched             | —             | Documentation-site chrome; reference only, not app code.                                                                                                          |
| `design-system/*.html` reference pages                                            | reuse                 | #1300         | Fidelity ground truth + designer evidence; visual-regression comparison target. Do not modify.                                                                    |
| `packages/keiko-ui/src/app/globals.css`                                           | extend                | #1292         | Sole live stylesheet + single theme engine. Absorbs the 3-tier tokens as the single source.                                                                       |
| App shell / workspace chrome                                                      | extend                | #1293         | Live components styled by `globals.css`; bring to fidelity; anchored by `WorkspaceShell.a11y.test.tsx`.                                                           |
| Reusable controls (`KeikoSelect`, `ModeSwitch`, `NumberControlStepper`, `Toggle`) | extend                | #1294         | Generalise styling to component recipes + new tokens without behaviour change.                                                                                    |
| High-traffic surfaces (`ChatWindow`, `GroundedAnswer`, `Header`, `Footer`, rails) | extend                | #1295         | Migrate inline-style / hardcoded-hex drift to tokens; extend existing tests.                                                                                      |
| AI/agent components                                                               | extend → new specs    | #1296         | Exist only as improvised patterns; specify as first-class components consuming `--ai-*` tokens.                                                                   |
| Table / data grid                                                                 | new                   | #1297         | No tabular component exists; build on Tier-4 `--table-*` tokens.                                                                                                  |
| Input / nav / breakpoint / density                                                | extend → new          | #1298         | Complete the input + navigation families; formalise a breakpoint + density system.                                                                                |
| `globals.css.test.ts` (CSS/WCAG contract)                                         | extend                | #1292 / #1299 | Keep green; extend the required-token set (asserted at `:1205`) to cover the new tiers.                                                                           |
| `*.a11y.test.tsx` (axe) + `axe-core`/`jest-axe`                                   | reuse                 | #1299         | Reuse as the a11y gate for migrated components; add coverage where missing.                                                                                       |
| Playwright e2e (`tests/e2e/config/playwright.config.ts`, 5 specs, chromium)       | extend                | #1300         | No pixel-diff exists (`0` `toHaveScreenshot`/`toMatchSnapshot`); add a visual-regression project on the existing chromium config — do not add a second framework. |
| Route shells (`launch`, `local-knowledge`, `memoriaviva`) + modals                | untouched / via owner | #1295         | Routes are thin (launch = 1-line re-export); styling lives in shared components/`globals.css`. Modals migrate with their owning surface.                          |

## 5. Exact files each child issue will edit (acceptance criterion C)

No child issue body lists files; this section is the authoritative edit map. All paths under
`packages/keiko-ui/src/app/` unless noted.

### #1292 — Consolidate runtime tokens + Light Mode foundations

- `globals.css` — primitives `:root` (19–80); Light block `[data-theme="light"]` (582–622); high-contrast
  (629–644, 752–831); editor tier (656–831). Insert Tiers 2–4 after the primitive `:root`; add `--focus-w`,
  `--grid-dot`; add `@media (forced-colors: active)` and in-app neutral `[data-hc]` override.
- `components/desktop/hooks/useTheme.ts` — extend if an in-app High-Contrast selector is introduced (today
  `Theme = "light" | "dark"` only).
- `app/layout.tsx:40` — theme bootstrap (only if the contrast axis becomes user-selectable).
- `globals.css.test.ts` — extend the required-token contract to cover Tiers 2–4 + new mode blocks.

### #1293 — Global shell + workspace chrome

`components/desktop/AppShell.tsx`, `KeikoDesktop.tsx`, `Header.tsx`, `LeftRail.tsx`, `RightRail.tsx`,
`Footer.tsx`, `Workspace.tsx`, `WorkspaceShader.tsx`, `EmptyWorkspaceBlob.tsx`, `windows/WindowFrame.tsx`,
`windows/WindowsRegistry.ts`, `windows/ConnectionsLayer.tsx`, `install/InstallBanner.tsx`; plus the shell class
blocks in `globals.css`. Anchored by `WorkspaceShell.a11y.test.tsx`.

> **Status: shipped.** The shell class blocks in `globals.css` were migrated to the semantic/component tokens
> (value-preserving — the TSX files carry only documented exceptions: WebGL shader uniforms, SVG mask endpoints,
> window-type metadata). Gated by the `Issue #1293` describe block in `globals.css.test.ts` (window-card tokens,
> surface tokens, `--focus-ring`, named z/space/radius scales, raw-primitive drift guard) + the extended
> Dark/Light `WorkspaceShell.a11y.test.tsx`. Browser evidence: [evidence/1293](evidence/1293/) — 840
> computed-value probes, 0 differences across 7 modes. The three `required` Light-Mode shell shadow rows
> (Table A: `.hd-tool-cta`, `.ws-zoom`, `.ws-fab`/C415) stay with **#1295** (shadow/scrim tokenisation is a
> Light visual change, out of scope for this no-visual-change migration); the eight `[data-theme="light"]` shell
> overrides are kept verbatim as approved deviations (ADR-0049 gate 4).

### #1294 — Reusable controls + component primitives

`components/desktop/KeikoSelect.tsx`, `NumberControlStepper.tsx`, `ModeSwitch.tsx`, `EditorMenu.tsx`
(also fix the inline hex tiles at `EditorMenu.tsx:64,66,79,82`), `widgets/shared/Toggle.tsx`,
`AttachmentStrip.tsx`, `ConnectedScopePill.tsx`, `ConnectorScopePill.tsx`, `ScopeConnectButton.tsx`,
`SafeMarkdown.tsx`, `ErrorNotice.tsx`; modals `components/desktop/modals/*.tsx`; their `globals.css` class blocks.

> **Status: shipped.** 363 reusable-control rules / ~550 declarations in `globals.css` were migrated to the
> Tier-3/4 semantic/component tokens (`--button-*`, `--input-*`, `--text-*`, `--surface-*`, `--border-*`,
> `--feedback-*`, `--card-*`, `--popover-*`, `--combobox-*`, `--focus-ring`) — value-preserving, since every
> target token is a `:root` alias over the primitive it replaced (the EditorMenu inline hex tiles also migrated).
> Kept verbatim as documented non-migrations: the accent-family brand primitives (`--accent`, …), the raw
> literals with no token (`#fff`, `oklch` amber inks, green Light scrims, disabled opacities `0.45 / 0.55 / 0.6`),
> the approved `[data-theme="light"]` deviations, and the #1295-owned Light shadow/scrim rows (`.dlg-overlay`,
> `.cmdk-overlay`, `.mc-dialog-backdrop`, `.wf-dialog-overlay`, `.gw-setup-backdrop`, `.ws-fab`/C415). Gated by
> the `Issue #1294` describe block in `globals.css.test.ts` (per-component routing pins + a scope-wide component
> drift guard, 0 offenders). Browser evidence: [evidence/1294](evidence/1294/) — 1106 computed-value probes,
> 0 differences across 7 modes.

### #1295 — High-traffic product surfaces

`components/desktop/ChatWindow.tsx`, `GroundedAnswer.tsx`,
`WorkflowHandoff.tsx`, `ContextStatusPanel.tsx`;
QI `widgets/quality-intelligence/*.tsx`; `widgets/panels/PromptEnhancerPanel.tsx`;
MemoriaViva `memoriaviva/components/*.tsx`; Relationships `relationships/RelationshipsView.tsx` +
`widgets/panels/Relationship*.tsx`; Local Knowledge `local-knowledge/connector-graph.tsx` +
`local-knowledge/[capsuleId]/capsule-detail.tsx` + `capsule-actions.tsx` + `capsule-rename.tsx`;
Figma `widgets/figma/*.tsx`. Resolve Light Mode Table A `required` rows here (tokenise shadows/scrims) and the
inline `borderRadius`/spacing literals in `MemoryConsolidation.tsx`, `RelationshipCreateDialog.tsx`,
`RelationshipInspectorPanel.tsx`, `RelationshipListPanel.tsx`, `RelationshipImpactCard.tsx`.

> **Status: shipped.** The #1295 product-surface migration routed ~330 rules / ~466+30 declarations from raw neutral
> Tier-1 primitives to the Tier-3 semantic tokens across the high-traffic content surfaces (chat-, chatw-,
> grounded-, wf-, qi-\*, mc-/memoria-, rel-/rb-, lk-/lkd-/connector-, figma-, fpv-/hl- prefixes) — value-preserving
> for Categories A/B (dark/HC/forced-colors 0-diff proven by 2324-probe equivalence harness in
> [evidence/1295](evidence/1295/)), with deliberate Category-C light adaptations (new `--shadow-ink-rgb` making
> Table A required shadow rows light-adaptive, centralised `--overlay-scrim` via `.mc-dialog-backdrop`). Deferred to
> later issues: AI/agent patterns (#1296), data-grid/lists (#1297), systematic spacing/typography/density/breakpoint
> (#1298), deeper running-Monaco editor visual-regression (#1300).

### #1296 — AI / agent component set

Current improvised patterns (to formalise as components consuming `--ai-*` tokens):
`components/desktop/GroundedAnswer.tsx` (citations / uncertainty / coverage — 110 markers), `WorkflowHandoff.tsx`
(launch + run summary + dialogs), `ChatWindow.tsx` (typing/streaming bubbles, stop/cancel),
`ContextStatusPanel.tsx` (grounded context status), `widgets/cards/AgentRunWidget.tsx` + `AgentGateCard.tsx` (run status, permission/gate,
stop/regenerate), `widgets/cards/EditorRuntimeWidget.tsx`. Target tokens: `--ai-thinking-indicator`,
`--ai-streaming-cursor`, `--ai-source-*`, `--ai-tool-*`, `--ai-confidence-*`, `--ai-permission-*`.

### #1297 — Data display foundation (Table / Data Grid)

No table component exists. Consolidate the ad-hoc list surfaces into a tokenised data grid:
`memoriaviva/components/MemoryList.tsx` + `ReviewQueue.tsx`, `widgets/panels/RelationshipListPanel.tsx`,
`widgets/panels/ChatHistoryPanel.tsx`, `widgets/quality-intelligence/CandidatesPane.tsx` + `QiHubPanel.tsx`
run-list, `local-knowledge/connector-graph.tsx`. Target tokens: `--table-header-text`, `--table-row-border`,
`--table-row-surface-hover`, `--table-row-surface-selected`.

### #1298 — Input, navigation, breakpoint + density

Input/nav components (Select formalised on `KeikoSelect.tsx`, plus Combobox/Date-Time/Slider/Stepper/File-upload/
Tag-input/Checkbox/Radio/Breadcrumbs/Tabs/Pagination/Context-menu/Command-palette). Breakpoint + density system
in `globals.css`: replace the 11 unsystematic `max-width` queries (420/560/620/640/680/700/760/900/1000/1100/1180px)
with a named scale; address the tablet 768–1024px overflow note (~`globals.css:14060`, WCAG 1.4.10); formalise the
`WindowFrame.selectBody` density branching (full/mini/tiny) and composer `compact` variants. Icon-system
reconciliation (Deferral D5): `components/desktop/Icons.tsx` + the 7 inline-`<svg>` files vs the design-system
Lift grammar.

### #1299 — States, documentation, governance

Per-component state matrix (default→hover→focus→active→selected→disabled→loading→error→empty→syncing→conflict)
across all migrated components; standardise the placeholder panels (Deferral D4); content/voice + messages
governance (Deferral D6: map `ErrorNotice.tsx`, `.install-banner-*`, status badges, field validation to the
design-system four-level severity + microcopy). Extend `globals.css.test.ts` and the `*.a11y.test.tsx` suite.

### #1300 — Visual-regression automation + designer evidence

`tests/e2e/config/playwright.config.ts` + a new visual-regression spec under `tests/e2e/` using `toHaveScreenshot` against the
`design-system/*.html` reference pages and the live `/` route across the theme/viewport matrix; reuse `axe-core`/
`jest-axe`. See [visual-qa-matrix.md](visual-qa-matrix.md).

## 6. Existing test infrastructure to reuse / extend

| Asset                                                                                                                                                                                                                           | Use                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/keiko-ui/src/app/globals.css.test.ts` (1,320-line CSS/WCAG string contract)                                                                                                                                           | Primary token/contrast gate; extend for the new tiers (#1292/#1299). |
| 9× `*.a11y.test.tsx` (`GroundedAnswer`, `WorkflowHandoff`, `WorkspaceShell`, `PromptEnhancerPanel`, `QiRunCard`, `RunLauncher`, `CandidatesPane`, `KeikoCodeEditor`, `KeikoDiffEditor`) + `axe-core` 4.12.1 / `jest-axe` 10.0.0 | a11y regression for migrated surfaces (#1299).                       |
| Near-1:1 component `*.test.tsx` (vitest + RTL, jsdom)                                                                                                                                                                           | Behavioural regression anchor for each migration.                    |
| `tests/e2e/config/playwright.config.ts` + 5 specs (chromium, screenshots as evidence only — no pixel diff)                                                                                                                      | Extend into the visual-regression harness (#1300).                   |

## Acceptance criterion C — coverage statement

Every child issue #1292–#1300 has an explicit exact-file edit list above, and every styling asset has a reuse
decision (reuse/extend/generalize/untouched/new) with rationale. The token gap is converted into a
dependency-ordered sequence with #1292 as the foundation gate. The reuse gate (single theme engine, no parallel
token namespace, no new styling framework) is stated as a binding constraint.
