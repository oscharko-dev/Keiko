# Editor fidelity governance — token source, surfaces, and coordination

Issue [#1299](https://github.com/oscharko-dev/Keiko/issues/1299) · Epic [#1290](https://github.com/oscharko-dev/Keiko/issues/1290) · Design System 0.4.0.

Reference: the editor reference pages `design-system/editor-theme.html`, `design-system/editor-chrome.html`,
`design-system/editor-gutter.html`, `design-system/editor-navigation.html`, `design-system/editor-panels.html`,
`design-system/editor-markdown.html`, and `design-system/editor-agent.html`; the editor token set
`design-system/keiko-editor-tokens.css` (the `--ed-*` families) layered on `design-system/keiko-tokens.css`;
and the editor view styles `design-system/keiko-editor-views.css` (the `.ev-*` selector groups). The eleven-state
vocabulary is defined once in [state-matrix.md](state-matrix.md); the editor-agent token table is documented in
[ai-components.md](ai-components.md) and is **not** restated here.

This is the **editor-fidelity governance entry** required by the issue's "Editor Governance Priority". Its purpose is
to make editor fidelity explicit so that no future agent treats Monaco built-in defaults, file-icon fallbacks, or
bespoke editor-only CSS as acceptable substitutes for the 0.4.0 references. Every editor surface must be driven by the
`--ed-*` families (or the named base / MIT-icon source) and must be proven by visual inspection of the running app
across Dark, Light, and High Contrast — not asserted from token values alone.

## Token source rule

Editor surfaces are driven exclusively by `design-system/keiko-editor-tokens.css` (the `--ed-*` families) and
`design-system/keiko-editor-views.css` (the `.ev-*` selector groups). The `--ed-*` set **extends** the base palette in
`design-system/keiko-tokens.css` — it reuses `--bg` / `--fg` / `--danger` / `--warn` / `--info` wherever the app surface
already answers the need, and never forks the base palette. Only the syntax palette (`--ed-syn-*`), the editor chrome,
the diff / ghost-text, and the editor-only gutter and agent surfaces are net-new.

The Monaco theme is registered **purely from `--ed-*` tokens** — no colour literals appear anywhere in editor code:

- **Syntax types** (`--ed-syn-comment`, `--ed-syn-string`, `--ed-syn-keyword`, …) map to Monaco `tokenColors` /
  TextMate scopes.
- **Chrome** (`--ed-bg`, `--ed-fg`, `--ed-line-active`, `--ed-selection`, tab / statusbar / minimap families) maps to
  the Monaco `colors` dictionary.
- **Agent ranges** (`--ed-agent-*`) map to editor decorations, not to base colours.

`packages/keiko-editor/src/monaco/theme.ts` is the single mapping site. It is the surface documented in
[ai-components.md](ai-components.md) for `--ed-agent-ghost` (Monaco `editorGhostText.foreground` resolves through
`--ed-agent-ghost`, which aliases `--ed-ghost`, so rendered ghost text cannot drift). Any new editor colour must be
added as an `--ed-*` token and mapped here — never inlined.

## Editor surface register

One row per editor surface. "Applicable states" names the subset of the eleven states (see
[state-matrix.md](state-matrix.md)) that the surface must define and screenshot; states not listed are non-applicable by
design. "Risk class" records why the surface is at risk of silently regressing to a non-0.4.0 substitute — the three
risks this governance exists to prevent are Monaco built-in defaults, file-icon fallbacks, and bespoke editor-only CSS.

| Surface                                                                                                         | Owning reference page                                                                                           | Token family                                                                                                                                                                                                                         | Applicable states                                                                                                                                                                                  | Required evidence                                                                                                                                                                                                 | Risk class                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monaco theme (syntax + code well)                                                                               | `editor-theme.html`                                                                                             | `--ed-syn-*` + `--ed-bg` / `--ed-fg` / `--ed-line-active` / `--ed-selection`                                                                                                                                                         | Default, Selected, Active (plus Error / Warn via squiggles)                                                                                                                                        | Browser/Playwright of a real file in running Monaco across Dark/Light/HC; computed colours equal `--ed-syn-*`                                                                                                     | Monaco-default-prone (highest risk)                                                                                                                                         |
| Editor chrome (titlebar / tabs / breadcrumbs / status bar / minimap)                                            | `editor-chrome.html`                                                                                            | `--ed-tab-*` / `--ed-statusbar-*` / `--ed-minimap-*`                                                                                                                                                                                 | Default, Hover, Focus, Active, Selected, plus Modified-dirty + Error/Warn tab states; Loading/Empty/Conflict where applicable                                                                      | Browser/Playwright of the multi-tab strip, split groups, breadcrumbs, status line in Dark/Light/HC + compact/responsive overflow + Empty group                                                                    | editor-only CSS (behaviour co-owned by [#1373](https://github.com/oscharko-dev/Keiko/issues/1373))                                                                          |
| Gutter (line numbers / run-debug / breakpoints / change bars / folding / inlay / blame)                         | `editor-gutter.html`                                                                                            | `--ed-gutter-*` / `--ed-run-glyph` / `--ed-breakpoint*` / `--ed-vcs-*` / `--ed-fold-*` / `--ed-inlay-*` / `--ed-blame-*`                                                                                                             | Default vs Active line; breakpoint sub-states (verified / conditional / logpoint / Disabled / hit); VCS added / modified / removed / staged; folding                                               | Browser/Playwright of breakpoints + VCS-dirty bars + folded placeholder + inlay values in Dark/Light/HC                                                                                                           | Monaco-default-prone (secondary)                                                                                                                                            |
| Navigation &amp; search (omni-search / fuzzy jump / find-replace / completion / hover-signature / context menu) | `editor-navigation.html`                                                                                        | base popup / accent tokens + `--ed-suggest-*` / `--ed-find-match*`                                                                                                                                                                   | Default, Hover, Focus, Active/selected result, Disabled item, Loading (async), Empty (no results), Error (invalid regex)                                                                           | Browser/Playwright of palette / find / completion / hover / menu in Default + selected-row + Empty + focus-ring across Dark/Light/HC incl. keyboard traversal                                                     | editor-only CSS (find-match-in-well is Monaco-mapped)                                                                                                                       |
| Panels / tool windows (stripes / file tree / run console / problems / terminal / VCS)                           | `editor-panels.html`                                                                                            | base `--surface` / `--card` + consoles borrow `--ed-bg` / `--ed-fg` + tree reuses `--ed-vcs-*`                                                                                                                                       | Default, Hover, Active/open panel, Selected tree row, VCS row colour, Loading (streaming), Empty (empty tree / problems), Error (severity), Syncing/Conflict (git)                                 | Browser/Playwright of file tree (selected + VCS rows) + run console + problems + git panel in Dark/Light/HC + Empty state + responsive narrow layout                                                              | editor-only CSS (behaviour co-owned by [#1373](https://github.com/oscharko-dev/Keiko/issues/1373); icons are file-icon-fallback-prone)                                      |
| Markdown views (source / split / rendered preview)                                                              | `editor-markdown.html`                                                                                          | source reuses `--ed-syn-*` on `--ed-bg`; preview uses base prose / typography tokens                                                                                                                                                 | Default + view-mode variants; Loading (preview render), Empty (empty doc)                                                                                                                          | Browser/Playwright of one `.md` in all three view modes across Dark/Light/HC, asserting source uses `--ed-syn-*` and preview uses prose tokens (not a default markdown stylesheet)                                | split: source-pane Monaco-default-prone, rendered preview editor-only CSS                                                                                                   |
| File icons (file &amp; folder glyphs in tree / tabs / breadcrumbs / menus)                                      | `editor-panels.html` (file-tree section, backed by `keiko-editor-views.css` `.ev-ft*` and `[data-licon]` rules) | real Material Icon Theme / Atom Material Icons (MIT) SVG assets under `design-system/assets/file-icons/*.svg`, extension-keyed, `document.svg` default + `folder-base.svg`; glyphs carry their own colour (outside `--ed-*` theming) | Default + extension identity + default fallback                                                                                                                                                    | Browser/Playwright of the real tree showing recognised extensions resolving to their Material SVGs AND a deliberate unknown extension resolving to `document.svg` (not a broken/blank glyph)                      | file-icon-fallback-prone (the surface explicitly named in [#1299](https://github.com/oscharko-dev/Keiko/issues/1299))                                                       |
| Agent-in-editor (banner / agent ranges / ghost text / hunk accept-reject / inline chat / provenance)            | `editor-agent.html`                                                                                             | `--ed-agent-*` (accent-only, applied as editor decorations)                                                                                                                                                                          | Default proposal, Active/focused hunk, Accept/Reject affordances, Loading (streaming), Syncing (multi-file apply), Conflict (edit vs dirty buffer), Error (governed/blocked), Empty (no proposals) | Browser/Playwright of a live proposal: ghost text + diff hunk with accept/reject + multi-file run review + inline chat + provenance hover in Dark/Light/HC, asserting brand-green-only + every range attributable | agent authority/audit co-owned by [#1390](https://github.com/oscharko-dev/Keiko/issues/1390); visual contract is [#1299](https://github.com/oscharko-dev/Keiko/issues/1299) |

The agent-in-editor `--ed-agent-*` token table is documented once in [ai-components.md](ai-components.md) — see the
**Editor-agent tokens** section there for the full alias map; it is cross-linked rather than duplicated here.

## Do not substitute

The following are **not** acceptable substitutes for the 0.4.0 references and must never be shipped in place of them:

- **Monaco built-in themes** (`vs-dark`, `vs`, `hc-black`, or any stock theme). The Monaco theme must be registered
  purely from `--ed-*` tokens through `packages/keiko-editor/src/monaco/theme.ts`. Falling back to a built-in theme,
  even temporarily, breaks the syntax-palette and chrome contract proven in `editor-theme.html`.
- **File-icon blank / default-document fallbacks where a typed Material icon exists.** When an extension maps to a real
  MIT icon (`.ts` → `typescript.svg`, `.tsx` → `react_ts.svg`, `.md` → `markdown.svg`, and the rest of the `.ev-ft*`
  map), that icon must render. `document.svg` is the fallback **only** for genuinely unknown extensions — never a stand-in
  for a recognised type, and never a broken or blank glyph.
- **Bespoke editor-only CSS** invented to approximate a reference instead of consuming the `--ed-*` families and `.ev-*`
  groups. Editor surfaces draw from `keiko-editor-tokens.css` and `keiko-editor-views.css`; new editor colour is added as
  an `--ed-*` token and mapped at the theme site, not hand-rolled per component.

In short: the Monaco theme is registered purely from `--ed-*` tokens, and the real MIT icon set is used — not bespoke
marks.

## Coordination boundaries (#1373 / #1390)

[#1299](https://github.com/oscharko-dev/Keiko/issues/1299) owns the **visual / token fidelity** contract for all eight
surfaces above: every surface driven by `--ed-*` (or the named base / MIT-icon source) across Dark, Light, and High
Contrast; the eleven states documented as applicable or non-applicable per surface; and App Browser/Playwright visual
inspection as the **primary** acceptance evidence. It does not own editor behaviour or agent authority.

- Epic [#1373](https://github.com/oscharko-dev/Keiko/issues/1373) (Editor Core Workspace Resilience) owns the
  **behavioural** baseline — tabs / split / resize, dirty buffers, hot-exit / recovery, folder-open, large-repo — and the
  editor browser-regression / a11y / perf gate. #1299's chrome, panels, and navigation evidence **references** #1373's
  gate for behaviour; it does not re-prove behaviour.
- Epic [#1390](https://github.com/oscharko-dev/Keiko/issues/1390) (Agent-Native Editor API and Workspace Governance)
  owns the **agent-in-editor authority / audit** semantics — sessions, selection, diagnostics, version / hash-preconditioned
  safe writes, patch apply, and provenance / policy / evidence. #1299's agent-in-editor visual states **cross-link** to
  #1390's audit / evidence contracts.

Stop condition: #1299 must **not** promise agent behaviour that #1390 has not implemented. Documentation must not
promise components or states the implementation does not support; the agent-in-editor row above is a visual contract for
states #1390 already backs, not a forward commitment.

See also: [state-matrix.md](state-matrix.md), [governance.md](governance.md), [component-template.md](component-template.md),
[ai-components.md](ai-components.md), [ADR-0050](../adr/ADR-0050-component-state-and-governance-contract.md).
