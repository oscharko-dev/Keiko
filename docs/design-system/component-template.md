# Per-component documentation template — the ten-section spine

Issue [#1299](https://github.com/oscharko-dev/Keiko/issues/1299) · Epic [#1290](https://github.com/oscharko-dev/Keiko/issues/1290) · Design System 0.4.0.

Reference: `design-system/governance.html` (section "02 — DOC TEMPLATE", the authoritative spine
definition and the component register). State data is quoted from [state-matrix.md](state-matrix.md),
which transcribes the `ROWS` applicability array in `design-system/states.html` cell-for-cell. The
register status and owners are mirrored in [governance.md](governance.md).

Every component page follows the same spine, so a reader always knows where to look: the same ten
sections, in the same order, on every page. We apply it to the existing high-priority components
first — the ones already shipped and depended on — and then to each new component as it lands. A page
is not a description; it is the contract for the component, and the spine is what makes the contract
auditable. For new component promotions after #1299, documentation-spine coverage is a Ready gate.
For component families already shipped as Ready by #1292-#1298, implementation readiness remains as
shipped while documentation-spine coverage is tracked explicitly below as full, partial, or worked
example.

## The ten-section spine

Each numbered section below carries its **verbatim one-line purpose** from `governance.html`, followed
by the **evidence** the section must show. The evidence column is the difference between a page that
reads well and a page that can be verified: every section resolves to something a reviewer can open —
a token, a screenshot, a matrix row, a register entry.

1. **Overview** — _what it is, in one line._ One sentence naming the component and its job. No
   marketing. Evidence: the canonical class (e.g. `.c-table`) and the product source file.
2. **When (not) to use** — _the decision, and the nearest alternative._ The single decision a reader
   makes, plus the one component they would reach for instead. Evidence: a named alternative that also
   exists in the register.
3. **Anatomy** — _named parts on a labelled example._ Each structural part named once, against a
   labelled instance. Evidence: the part-to-class map and a screenshot or reference scene.
4. **Variants & sizes** — _every supported shape._ Every variant and size that ships — no more, no
   aspirational shapes. Evidence: the variant-to-modifier-class map.
5. **States** — _from the eleven-state matrix ([state-matrix.md](state-matrix.md)), proven in 3
   modes._ The applicable (`✓`) states for this family from the matrix, each proven in **Dark**,
   **Light**, and **High Contrast**. Non-applicable (`·`) states are named explicitly as deliberate
   scope, not omissions. Evidence: the matrix row plus the committed 7-mode screenshot set.
6. **Accessibility** — _roles, focus order, keyboard, contrast._ ARIA roles, tab/focus order, the
   keyboard model, and the contrast guarantee. Evidence: the role/keyboard contract and the jest-axe
   suite that pins it.
7. **Tokens** — _the component tokens it consumes._ The component token family the component reads, and
   what each aliases. Evidence: the token names in `design-system/keiko-semantic-tokens.css` and the
   `globals.css.test.ts` drift block that pins them.
8. **Do / Don't** — _the two mistakes people actually make._ The two real, observed misuses — not a
   generic list. Evidence: a concrete wrong/right pair.
9. **Status & owner** — _from the register ([governance.md](governance.md))._ Status (Draft / Ready /
   Deprecated), owning area, and the version it shipped in. Evidence: the matching register row.
10. **Changelog** — _what changed, per version._ Newest first, one line per version, naming the
    shipping issue. Evidence: the epic child (`#1294`, `#1297`, …) that landed the change.

## Adoption status

Adoption of the spine is a **documentation gate for future Ready promotions**. A new component cannot
move to Ready until its page carries all ten sections, states and accessibility included (contribution
rule 2 — _"Ship the full template before future Ready promotions"_). Existing #1292-#1298 families may
remain implementation Ready because their product migrations already shipped and were accepted, but
their documentation coverage is recorded separately:

| High-priority family    | Implementation status | Documentation                                          | Spine coverage                                                        |
| ----------------------- | --------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| AI & Agent surfaces     | Ready                 | [ai-components.md](ai-components.md)                   | Partial — tokens, states, accessibility (migration note)              |
| Table & Data Grid       | Ready                 | [data-display-migration.md](data-display-migration.md) | Partial migration note + full spine in the Table worked example below |
| Inputs / Navigation     | Ready                 | [input-nav-migration.md](input-nav-migration.md)       | Partial — states, breakpoints, adopters (migration note)              |
| Core control primitives | Ready                 | Button / Input / field / Table worked examples below   | Full spine (worked examples)                                          |

The migration notes above document a **subset** of the spine — typically tokens, states, and
accessibility — rather than all ten sections; they are accurate for their migration purpose but are
not yet the spine-complete component page. The Button, Input / field, and Table **worked examples
below** are the spine-complete instances and are the model a full component page follows.

The three worked examples below — Button, Input / field, and Table — fill the ten-section spine end to
end. They are written against the **shipped product**, not an aspiration: every state, token, and role
is the one in `packages/keiko-ui/src/app/globals.css` today, and every state a component does **not**
have is listed as non-applicable rather than invented.

## Worked example — Button

**01 — Overview.** The primary action control: a focusable `<button>` that triggers one action.
Canonical reference class `.c-btn` (with `.c-btn--primary` / `.c-btn--accent` / `.c-btn--ghost` /
`.c-btn--danger` / `.c-btn--sm` modifiers) in `design-system/components.css`; the product's button
surfaces (`.dlg-btn`, `.rail-btn`, `.qi-btn`, …) consume the `--button-*` token family in
`packages/keiko-ui/src/app/globals.css`.

**02 — When (not) to use.** Use a Button when activating the control _does_ something — submits,
runs, opens, confirms. If the control _navigates_ to another place, use a link; if it toggles a
binary on/off state that persists, use the Toggle (`role="switch"`) instead.

**03 — Anatomy.** `.c-btn` is the focusable hit target and surface; its label text is the accessible
name; an optional leading icon is `aria-hidden` and decorative. There is no separate sub-part — the
button is a single labelled control. A labelled reference instance lives in
`design-system/components.html` (§01 Buttons).

**04 — Variants & sizes.** Variants: `primary` (neutral solid), `accent` (brand solid), `ghost`
(transparent / low-emphasis), `danger` (destructive). Sizes follow `--control-height`, tightened by
`[data-density="compact"]` from 34px to 30px. No other variants ship.

**05 — States.** From the [state-matrix.md](state-matrix.md) Button row, the applicable states are
**Default**, **Hover**, **Focus**, **Active**, and **Disabled** — each proven in Dark, Light, and
High Contrast. Disabled is `aria-disabled` and non-interactive, never colour-only. **Non-applicable
(by design):** Selected, Loading, Error, Empty, Syncing, Conflict — a button does not hold selection
or data state; a control that needs them is a Toggle (Selected) or a status surface. Evidence:
[`evidence/1294/`](evidence/1294/README.md).

**06 — Accessibility.** Role: native `<button>` (or `role="button"` only when a native element is
impossible). Focus: inherits the global `:focus-visible` ring at `--focus-ring` / `--focus-w`;
participates in normal tab order. Keyboard: Enter and Space activate. Contrast: label and surface
meet WCAG 2.2 AA in all three modes; disabled state still reads by shape and `aria-disabled`, not by
colour alone.

**07 — Tokens.** Maps each variant to its token: `primary` → `--button-primary-*`, `ghost` →
`--button-ghost-surface-hover`, `danger` → `--button-danger-*` (all in the `--button-*` family). The
`accent` variant (`.c-btn--accent`) draws its brand fill from `--surface-accent-subtle` /
`--border-accent` rather than a dedicated button-tier token; `--button-secondary-*` backs
neutral/secondary product buttons. All defined in `design-system/keiko-semantic-tokens.css` and pinned
by the `globals.css.test.ts` drift block. Focus resolves from `--focus-ring`.

**08 — Do / Don't.** Don't use a Button to navigate (it breaks open-in-new-tab and screen-reader
landmark expectations) — use a link. Don't encode the disabled state by lowering opacity alone
without `aria-disabled` and removing interactivity — assistive tech will still announce it as
actionable.

**09 — Status & owner.** Ready · `@core-ui` · since v0.1 (register row "Button · Field · Toggle ·
Tabs").

**10 — Changelog.**

- **v0.4.0** ([#1294](https://github.com/oscharko-dev/Keiko/issues/1294)) — migrated to the
  `--button-*` component-token family; interaction states verified in all three modes.
- **v0.1** — initial Ready release.

## Worked example — Input / field

**01 — Overview.** A single-value text entry control with an associated label and the field chrome
around it. Canonical classes `.c-form-row`, `.c-form-grid`, and the input family in
`packages/keiko-ui/src/app/globals.css`.

**02 — When (not) to use.** Use an Input / field for free-form or constrained single-value entry. If
the value is one of a known closed set, use a Select / combobox; if it is binary, use a
Checkbox / Toggle; if it is one of a few mutually exclusive options, use a radio group.

**03 — Anatomy.** A field row (`.c-form-row`) pairs a `<label>` with its control; the control is the
focusable `<input>`; optional help / error text sits below and is associated via
`aria-describedby` / `aria-errormessage`. Fields lay out in a `.c-form-grid` that collapses to one
column at `--bp-sm` (640px). Labelled reference: `design-system/inputs.html`.

**04 — Variants & sizes.** Variants follow input type (text, date via `.c-datefield`, stepper via
`.c-stepper`, tag entry via `.c-tagfield`). Size from `--control-height`, tightened to 30px under
`[data-density="compact"]`, never below the accessible target floor.

**05 — States.** From the [state-matrix.md](state-matrix.md) Input / field row, the applicable states
are **Default**, **Hover**, **Focus**, **Active**, **Selected**, **Disabled**, and **Loading** — each
proven in Dark, Light, and High Contrast. Invalid input is surfaced via `aria-invalid` plus text, and
Disabled is never colour-only. **Non-applicable (by design):** Error, Empty, Syncing, Conflict — a
single field carries no list-level empty/sync state and no async-conflict state (those belong to the
Select/combobox, Table, or sync-item families). Evidence:
[`evidence/1298/`](evidence/1298/README.md).

**06 — Accessibility.** Role: native `<input>` with a programmatically associated `<label>` (`for` /
`id`). Focus: the global `:focus-visible` ring; Loading does not steal focus. Keyboard: standard text
editing; the field is reachable and operable by keyboard alone. Contrast: label, value, placeholder,
and the focus ring meet WCAG 2.2 AA in all three modes; the invalid state reads by `aria-invalid` and
message text, not colour alone.

**07 — Tokens.** Consumes the `--input-*` family (with `--checkbox-*`, `--radio-*`, `--stepper-*`,
`--date-*`, `--tag-*` for the typed variants) from `design-system/keiko-semantic-tokens.css`, plus
`--control-height`, `--bp-sm`, and `--focus-ring`. Pinned by the `globals.css.test.ts` Issue #1298
block.

**08 — Do / Don't.** Don't use placeholder text as the label — it disappears on input and fails the
label-association contract; always pair a visible `<label>`. Don't signal an invalid field with a red
border alone — pair it with `aria-invalid` and a text message so it survives High Contrast and
colour-blind viewing.

**09 — Status & owner.** Ready · `@core-ui` · since v0.1 (register row "Button · Field · Toggle ·
Tabs"; the extended input family is Ready since v0.4).

**10 — Changelog.**

- **v0.4.0** ([#1298](https://github.com/oscharko-dev/Keiko/issues/1298)) — extended input family and
  the `--bp-sm` form-grid collapse + compact-density sizing landed; the Field row migrated to the
  `--input-*` family in [#1294](https://github.com/oscharko-dev/Keiko/issues/1294).
- **v0.1** — initial Ready release.

## Worked example — Table

**01 — Overview.** A row/column data grid for structured, scannable records. Canonical class
`.c-table` (with `.c-tablewrap` / `.c-tablescroll`) in `packages/keiko-ui/src/app/globals.css`.

**02 — When (not) to use.** Use a Table when the data is genuinely tabular — multiple records sharing
the same columns, scanned and compared down a column. If each item is a self-contained object the
reader acts on individually, use a card list; if there is one column, use a List / tree row.

**03 — Anatomy.** `.c-table` wraps a `thead` of `th` headers (sortable headers carry `aria-sort` and
the `.so` indicator), a `tbody` of rows (`tr[aria-selected]` for selection, `.zebra` striping),
right-aligned numeric cells (`.num`), an optional `.c-table-foot`, and an `.c-table-empty` row for
the empty state. The scroll container keeps the header sticky. Labelled reference:
`design-system/data-grid.html`.

**04 — Variants & sizes.** Density via `[data-density="compact"]` (`--row-pad-x` / `--row-pad-y`),
optional `.zebra` striping, sticky header, and the `.responsive` card-collapse at ≤640px. Numeric
columns use `.num`; sortable columns use `.sortable` + `.so`.

**05 — States.** From the [state-matrix.md](state-matrix.md) Table row, the applicable states are
**Default**, **Selected**, **Loading**, **Error**, **Empty**, and **Syncing** — each proven in Dark,
Light, and High Contrast. Loading is a skeleton shimmer (off under `prefers-reduced-motion`); Empty
and Loading carry text. **Non-applicable (by design):** Hover, Focus, Active, Disabled, Conflict — the
table surface itself is not a focusable control and holds no row-level conflict state (interaction
states live on the cells/controls inside it; conflict belongs to the sync-item and card/window
families). Evidence: [`evidence/1297/`](evidence/1297/README.md).

**06 — Accessibility.** Role: native `<table>` semantics with `scope` on headers; sortable columns
expose sort direction through `aria-sort`. Focus: the table is not itself focusable — interactive
cells/controls inside it are, in document order. Keyboard: controls within cells are operable by
keyboard; sort toggles are real buttons. Contrast: header, body, selected-row emphasis, and the sort
indicator meet WCAG 2.2 AA in all three modes; Empty / Loading / Error / Syncing always pair a glyph
with a word, never colour alone.

**07 — Tokens.** Consumes the `--table-*` family — `--table-header-text` / `--table-header-surface`,
`--table-row-border`, `--table-row-surface-hover` / `--table-row-surface-selected`,
`--table-foot-surface`, `--table-sort-indicator`, `--table-num-text` — plus `--skeleton-base` /
`--skeleton-highlight` for Loading and `--feedback-danger` / `--feedback-info` for Error / Syncing,
from `design-system/keiko-semantic-tokens.css`. Pinned by the `globals.css.test.ts` Issue #1297 block.

**08 — Do / Don't.** Don't force a card-list pattern into a Table just to get borders — the five
product card areas (Local Knowledge, MemoriaViva, Relationships, Quality Intelligence, capsule lists)
are deliberately _not_ tables (see [data-display-migration.md](data-display-migration.md)). Don't show
a blank region for the empty or loading state — use the `.c-table-empty` row and the skeleton so the
state reads as intentional with text.

**09 — Status & owner.** Ready · `@data-ui` · since v0.4 (register row "Table & Data Grid").

**10 — Changelog.**

- **v0.4.0** ([#1297](https://github.com/oscharko-dev/Keiko/issues/1297)) — `.c-table` data-grid
  foundation shipped on the `--table-*` family; `.sm-table` (markdown) migrated value-preservingly and
  `.pe-scorecards` adopted the full component.

See also: [state-matrix.md](state-matrix.md), [governance.md](governance.md),
[editor-governance.md](editor-governance.md),
[ADR-0050](../adr/ADR-0050-component-state-and-governance-contract.md).
