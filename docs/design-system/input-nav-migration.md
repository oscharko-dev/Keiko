# Input + Navigation component migration (Issue #1298)

Part of the Design System 0.4.0 fidelity epic (#1290). This note records what the input / navigation /
breakpoint / density coverage work landed, which product surfaces adopt the canonical layer, and which
bespoke surfaces are deliberately left as-is.

## What landed

The complete input family (`design-system/keiko-inputs.css`) and navigation set
(`design-system/keiko-nav.css`) were ported verbatim into the single `globals.css` as reusable system
primitives:

| Family     | Primitives                                                                                                                                           | Tier-3 tokens (added in #1292, now consumed)                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Inputs     | `.c-check` `.c-radio` `.c-slider` `.c-stepper` `.c-combo` `.c-tagfield`/`.c-tag` `.c-drop`/`.c-fileitem` `.c-datefield` `.c-form-row`/`.c-form-grid` | `--checkbox-*` `--radio-*` `--slider-*` `--stepper-*` `--combobox-*` `--tag-*` `--file-*` `--date-*` |
| Navigation | `.c-crumbs` `.c-back` `.c-utabs`/`.c-utab` `.c-pager` `.c-ctx`/`.c-ctx-item` `.c-steps`/`.c-step`                                                    | `--breadcrumb-*` `--pagination-*` `--tab-underline-indicator` `--context-*` `--step-*`               |

Each primitive reads its component token (which aliases a primitive) plus the semantic tier, so it
tracks Dark / Light / High Contrast automatically. The headline audit gap — these 13 token families
defined but **consumed 0 times** — is closed: `globals.css.test.ts` pins that every one now has a
consumer. Reference fidelity is proved 0-diff in `docs/design-system/evidence/1298`.

## Breakpoint and density

- **Breakpoints.** The named `--bp-*` scale (`--bp-xs … --bp-2xl`, landed in #1292) is the single
  source of truth. CSS media queries cannot read a custom property, so responsiveness is achieved two
  ways: the input/nav primitives are **intrinsically fluid** (flex-wrap on `.c-crumbs` / `.c-tagfield`,
  `flex: 1` / `min-width` on inputs — no breakpoint needed), and the one governed media query collapses
  `.c-form-grid` to a single column at `max-width: 640px`, which is exactly the `--bp-sm` value. There
  are no one-off breakpoints. (AC: "Responsive behavior is predictable and does not depend on one-off
  breakpoints.")
- **Density.** The input controls (`.c-stepper`, `.c-combo-input`, `.c-datefield`) size from
  `--control-height`, which `[data-density="compact"]` tightens from 34px to 30px (still above the
  accessible target floor). The compact screenshot evidences the tightened layout. (AC: "Density rules
  are explicit and do not collapse text or controls below accessible limits.")

## Product adopters

- **Workflow-handoff "Expected checks"** (`WorkflowHandoff.tsx`) adopts `.c-check`. The migration is
  presentation-only: the native `<input type="checkbox">` stays the control (role, checked state,
  `onChange` and the accessible name from the trailing text span are unchanged); the added `.bx` span
  is a decorative, `aria-hidden` check glyph driven by the input's `:checked` state. Proved by
  `WorkflowHandoff.a11y.test.tsx` and the existing `WorkflowHandoff.test.tsx` role/name queries.

## Deliberately not migrated (bespoke surfaces)

These product surfaces use a different, pre-existing token chain or a feature set the canonical
primitive does not expose. Migrating them would change resolved colours or drop behaviour, so they are
kept as-is (issue Stop Condition: "Stop if a component requires domain behavior not defined by the
Design System"):

| Surface                                    | Why kept bespoke                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `.gpref-slider` (Settings sliders)         | Custom gradient-fill track + custom thumb; `.c-slider` is a solid track/fill — not value-preserving.         |
| `.ed-tab` / `.tb-tab` (editor/header tabs) | Filled-background active tab with rounded top; `.c-utab` is an underline indicator — different visual model. |
| `KeikoSelect`                              | Feature-rich combobox (sections, descriptions, badges, fixed-position menu) beyond `.c-combo`.               |
| `NumberControlStepper`                     | Buttons-only arrow control with no input field; `.c-stepper` is a full +/− input control.                    |
| `.attach-drop-zone`                        | Bare drop target; `.c-drop` expects icon/title/subtitle child markup.                                        |

The canonical `.c-*` primitives are available for any **new** input/navigation surfaces, which should
adopt them rather than re-styling from raw tokens.

## Editor navigation / density

The editor find/replace, tabs, context menus and breadcrumb/file navigation called out in the issue's
editor-fidelity priority are not yet wired to the `.c-*` navigation primitives in the running product
(the editor surfaces use their own `.ed-*` chrome). The keyboard-driven running-editor evidence for
those surfaces is tracked by #1300 (visual-regression + editor running-evidence); this issue lands the
governed primitives they will adopt.
