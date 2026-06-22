# Component state matrix — the eleven states and where they apply

Issue [#1299](https://github.com/oscharko-dev/Keiko/issues/1299) · Epic [#1290](https://github.com/oscharko-dev/Keiko/issues/1290) · Design System 0.4.0.

Reference: `design-system/states.html` (the live, three-mode proof and the authoritative `ROWS`
applicability data), `design-system/keiko-semantic-tokens.css` (the feedback + skeleton tokens the
states resolve from). Browser evidence (the matrix rendered and screenshotted across all 7 modes):
[`docs/design-system/evidence/1299/`](evidence/1299/README.md). Drift gate: the `Issue #1299` block
in `packages/keiko-ui/src/app/globals.css.test.ts` pins this matrix cell-for-cell against
`states.html` so the document cannot silently diverge from the reference.

This document is the **contract** that closes the design-system component work (Tiers 2–4 landed in
[#1292](https://github.com/oscharko-dev/Keiko/issues/1292)–[#1298](https://github.com/oscharko-dev/Keiko/issues/1298)):
it names every interaction and data state once, declares which states each implemented component
family must define, and maps each family to the token source, accessibility expectation, and shipped
screenshot evidence that proves it.

## The eleven states

One name per state, used everywhere. The first six are **interaction** states; the last five are
**data &amp; sync** states, which the agentic surfaces lean on. A component is not done until every
state the matrix marks for it is implemented and screenshotted in Dark, Light, and High Contrast.

| #   | State    | Group           | Resolves from                                     |
| --- | -------- | --------------- | ------------------------------------------------- |
| 1   | Default  | Interaction     | the component's base surface/text tokens          |
| 2   | Hover    | Interaction     | the component's `*-hover` surface tokens          |
| 3   | Focus    | Interaction     | `--focus-ring` at `--focus-w` (`:focus-visible`)  |
| 4   | Active   | Interaction     | the component's pressed/active treatment          |
| 5   | Selected | Interaction     | the accent family / component `*-selected` tokens |
| 6   | Disabled | Interaction     | the component disabled tokens (never colour-only) |
| 7   | Loading  | Data &amp; sync | the skeleton tokens                               |
| 8   | Error    | Data &amp; sync | `--feedback-danger`                               |
| 9   | Empty    | Data &amp; sync | base surface + guidance copy                      |
| 10  | Syncing  | Data &amp; sync | `--feedback-info`                                 |
| 11  | Conflict | Data &amp; sync | `--feedback-warning`                              |

**State-token rule (verbatim, from `states.html`):** _"Loading uses the skeleton tokens; error uses
`--feedback-danger`; syncing uses `--feedback-info`; conflict uses `--feedback-warning` — always
paired with an icon and a word."_ The data &amp; sync states (Loading, Error, Empty, Syncing,
Conflict) are never encoded by colour alone (WCAG 1.4.1 Use of Color): every one carries a glyph and a
label in addition to its tone, so it survives High Contrast, forced-colors, and colour-blind viewing.

## Applicability matrix

A check (`✓`) means the component family **must define and document** that state; a dot (`·`) means
the state does not apply. This table is transcribed cell-for-cell from the `ROWS` array in
`design-system/states.html` and is pinned against it by the drift gate — editing one without the
other fails CI.

| Component         | Default | Hover | Focus | Active | Selected | Disabled | Loading | Error | Empty | Syncing | Conflict |
| ----------------- | :-----: | :---: | :---: | :----: | :------: | :------: | :-----: | :---: | :---: | :-----: | :------: |
| Button            |    ✓    |   ✓   |   ✓   |   ✓    |    ·     |    ✓     |    ·    |   ·   |   ·   |    ·    |    ·     |
| Input / field     |    ✓    |   ✓   |   ✓   |   ✓    |    ✓     |    ✓     |    ✓    |   ·   |   ·   |    ·    |    ·     |
| Checkbox / radio  |    ✓    |   ✓   |   ✓   |   ✓    |    ✓     |    ✓     |    ·    |   ·   |   ·   |    ·    |    ·     |
| Select / combobox |    ✓    |   ✓   |   ✓   |   ✓    |    ✓     |    ✓     |    ✓    |   ✓   |   ·   |    ·    |    ·     |
| List / tree row   |    ✓    |   ✓   |   ✓   |   ·    |    ✓     |    ✓     |    ·    |   ·   |   ·   |    ·    |    ·     |
| Table             |    ✓    |   ·   |   ·   |   ·    |    ✓     |    ·     |    ✓    |   ✓   |   ✓   |    ✓    |    ·     |
| Tab               |    ✓    |   ✓   |   ✓   |   ✓    |    ✓     |    ✓     |    ·    |   ·   |   ·   |    ·    |    ·     |
| Toggle            |    ✓    |   ✓   |   ✓   |   ✓    |    ✓     |    ✓     |    ·    |   ·   |   ·   |    ·    |    ·     |
| Card / window     |    ✓    |   ·   |   ✓   |   ·    |    ·     |    ·     |    ✓    |   ·   |   ·   |    ✓    |    ✓     |
| AI response       |    ✓    |   ·   |   ·   |   ·    |    ·     |    ✓     |    ✓    |   ✓   |   ·   |    ✓    |    ✓     |
| File / sync item  |    ✓    |   ·   |   ·   |   ·    |    ·     |    ✓     |    ✓    |   ·   |   ✓   |    ✓    |    ✓     |

## Per-family mapping — token source, accessibility, evidence

Each family maps to the implemented product component (and the epic child that shipped it), the
component token source it consumes, the accessibility expectation that governs its interaction
states, and the committed 7-mode screenshot evidence. "Applicable states" is the `✓` set above;
"Non-applicable" is the `·` set, recorded explicitly so a future contributor knows a missing state is
a deliberate scope decision, not an omission.

| Family            | Shipped by                                                                                                              | Doc note                                               | Component token source                                      | Applicable states                                                 | Non-applicable (by design)                         | Accessibility expectation                                                                                                     | Evidence (7-mode)                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Button            | [#1293](https://github.com/oscharko-dev/Keiko/issues/1293) / [#1294](https://github.com/oscharko-dev/Keiko/issues/1294) | [fidelity-matrix.md](fidelity-matrix.md)               | `--button-*` (`primary` / `secondary` / `ghost` / `danger`) | Default, Hover, Focus, Active, Disabled                           | Selected, Loading, Error, Empty, Syncing, Conflict | `:focus-visible` ring; disabled is `aria-disabled` + non-interactive, never colour-only                                       | [`evidence/1294/`](evidence/1294/README.md) |
| Input / field     | [#1294](https://github.com/oscharko-dev/Keiko/issues/1294) / [#1298](https://github.com/oscharko-dev/Keiko/issues/1298) | [input-nav-migration.md](input-nav-migration.md)       | `--input-*`                                                 | Default, Hover, Focus, Active, Selected, Disabled, Loading        | Error, Empty, Syncing, Conflict                    | label association; focus ring; invalid via `aria-invalid` + text                                                              | [`evidence/1298/`](evidence/1298/README.md) |
| Checkbox / radio  | [#1298](https://github.com/oscharko-dev/Keiko/issues/1298)                                                              | [input-nav-migration.md](input-nav-migration.md)       | `--checkbox-*` / `--radio-*`                                | Default, Hover, Focus, Active, Selected, Disabled                 | Loading, Error, Empty, Syncing, Conflict           | native control semantics; checked exposed to AT; focus ring                                                                   | [`evidence/1298/`](evidence/1298/README.md) |
| Select / combobox | [#1298](https://github.com/oscharko-dev/Keiko/issues/1298)                                                              | [input-nav-migration.md](input-nav-migration.md)       | `--combobox-*`                                              | Default, Hover, Focus, Active, Selected, Disabled, Loading, Error | Empty, Syncing, Conflict                           | `role=combobox`/listbox; `aria-expanded`/`aria-activedescendant`; selected mark                                               | [`evidence/1298/`](evidence/1298/README.md) |
| List / tree row   | [#1293](https://github.com/oscharko-dev/Keiko/issues/1293) / [#1295](https://github.com/oscharko-dev/Keiko/issues/1295) | [fidelity-matrix.md](fidelity-matrix.md)               | `--nav-item-*` / `--surface-secondary`                      | Default, Hover, Focus, Selected, Disabled                         | Active, Loading, Error, Empty, Syncing, Conflict   | `aria-current`/`aria-selected`; roving tabindex; visible selection bar                                                        | [`evidence/1293/`](evidence/1293/README.md) |
| Table             | [#1297](https://github.com/oscharko-dev/Keiko/issues/1297)                                                              | [data-display-migration.md](data-display-migration.md) | `--table-*`                                                 | Default, Selected, Loading, Error, Empty, Syncing                 | Hover, Focus, Active, Disabled, Conflict           | header scope; sortable columns expose sort state; empty/loading have text                                                     | [`evidence/1297/`](evidence/1297/README.md) |
| Tab               | [#1294](https://github.com/oscharko-dev/Keiko/issues/1294) / [#1298](https://github.com/oscharko-dev/Keiko/issues/1298) | [input-nav-migration.md](input-nav-migration.md)       | `--tab-underline-indicator` / `--nav-item-*`                | Default, Hover, Focus, Active, Selected, Disabled                 | Loading, Error, Empty, Syncing, Conflict           | `role=tab`/`tablist`; `aria-selected`; Arrow/Home/End roving focus                                                            | [`evidence/1298/`](evidence/1298/README.md) |
| Toggle            | [#1294](https://github.com/oscharko-dev/Keiko/issues/1294)                                                              | [fidelity-matrix.md](fidelity-matrix.md)               | `--surface-accent-subtle` / `--surface-inset`               | Default, Hover, Focus, Active, Selected, Disabled                 | Loading, Error, Empty, Syncing, Conflict           | `role=switch`; `aria-checked`; state by knob position, not colour only                                                        | [`evidence/1294/`](evidence/1294/README.md) |
| Card / window     | [#1293](https://github.com/oscharko-dev/Keiko/issues/1293) / [#1294](https://github.com/oscharko-dev/Keiko/issues/1294) | [fidelity-matrix.md](fidelity-matrix.md)               | `--card-*` / `--surface-*`                                  | Default, Focus, Loading, Syncing, Conflict                        | Hover, Active, Selected, Disabled, Error, Empty    | titled region; loading/syncing/conflict carry icon + word; focusable when interactive                                         | [`evidence/1293/`](evidence/1293/README.md) |
| AI response       | [#1296](https://github.com/oscharko-dev/Keiko/issues/1296)                                                              | [ai-components.md](ai-components.md)                   | `--ai-*`                                                    | Default, Disabled, Loading, Error, Syncing, Conflict              | Hover, Focus, Active, Selected, Empty              | live region (`role=status`, polite) announces lifecycle; caret/dots decorative (`aria-hidden`); reduced-motion off by default | [`evidence/1296/`](evidence/1296/README.md) |
| File / sync item  | [#1295](https://github.com/oscharko-dev/Keiko/issues/1295)                                                              | [fidelity-matrix.md](fidelity-matrix.md)               | `--ed-vcs-*` / `--ai-source-*`                              | Default, Disabled, Loading, Empty, Syncing, Conflict              | Hover, Focus, Active, Selected, Error              | sync/conflict by icon + word; row label carries the change class, not the glyph                                               | [`evidence/1295/`](evidence/1295/README.md) |

### Reading the matrix in three modes

Every interaction and data state above is driven by the Tier-2/3/4 tokens, so it resolves correctly
in **Dark**, **Light**, and **High Contrast** from a single source. The screenshot evidence for each
family (linked above) captures the family in the seven canonical modes — `01-dark`, `02-light`,
`03-dark-hc`, `04-light-hc`, `05-prefers-contrast`, `06-forced-colors`, `07-reduced-motion` — and the
[#1299 evidence harness](evidence/1299/README.md) additionally renders the live `states.html` proof
(both the per-component state strips and this matrix) across all seven modes and asserts the rendered
matrix equals this document. All seven canonical modes are the required evidence for a family to be
accepted as Ready; fewer-than-seven-mode coverage keeps it Draft. Visual inspection of the running UI
is the primary acceptance evidence;
the token, contrast, and pixel checks are supporting, not a substitute — see
[governance.md](governance.md) and [ADR-0050](../adr/ADR-0050-component-state-and-governance-contract.md).

See also: [governance.md](governance.md), [component-template.md](component-template.md),
[editor-governance.md](editor-governance.md), [visual-qa-matrix.md](visual-qa-matrix.md),
[ADR-0050](../adr/ADR-0050-component-state-and-governance-contract.md).
