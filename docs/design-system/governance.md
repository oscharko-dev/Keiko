# Design System governance — ownership, status, and the rules for change

Issue [#1299](https://github.com/oscharko-dev/Keiko/issues/1299) · Epic [#1290](https://github.com/oscharko-dev/Keiko/issues/1290) · Design System 0.4.0.

Reference: `design-system/governance.html` (the binding governance scaffold and visual-regression ground
truth). This document keeps the Design System accurate after the epic closes: it gives every component a
status, a named owner, and a single rule for changing it. A system stays trustworthy only when each part can
be located on the register, traced to the child PR that shipped it, and changed through a contribution path
that resolves to reviewed tokens and carries its own evidence. Governance is the scaffold that holds those
three facts — status, owner, change rule — in one place so the system does not drift back into one-off values
and unreviewed Light Mode patches.

## Design System 0.4.0 baseline

Design System 0.4.0 — shipped by [PR #1398](https://github.com/oscharko-dev/Keiko/pull/1398) — is the current
implementation baseline. Product implementation consumes the Tier-2/3/4 tokens layered onto
`packages/keiko-ui/src/app/globals.css` by [#1292](https://github.com/oscharko-dev/Keiko/issues/1292); it
never wires components directly to raw Tier-1 primitives. Every component family in the register below was
migrated onto those semantic/component tokens by its child issue, and the
[token-component-reuse-map.md](token-component-reuse-map.md) records the per-asset reuse decisions that keep a
single theme engine and a single token source.

**One stale label, reconciled.** The governance reference (`design-system/governance.html`) carries a single
internal inconsistency: its changelog prose for v0.4.0 says "Data-viz foundation in draft", while the same
page's component register lists **Data Visualisation = Ready (v0.4)**. The register is correct.
[#1297](https://github.com/oscharko-dev/Keiko/issues/1297) shipped the data-display foundation — the
`.c-table*` data grid **and** the `.viz*` data-visualisation layer — as **Ready**, ported verbatim into
`globals.css` and adopted by live surfaces (see [data-display-migration.md](data-display-migration.md)).

Resolution: **the register is authoritative for current status.** The "draft" changelog line predates the
data-viz Ready promotion and is superseded by it. The merged reference HTML is **not** edited to repair the
prose — it is the visual-regression ground truth under [ADR-0049](../adr/ADR-0049-design-system-fidelity-gates.md),
so changing it would invalidate the pixel baseline. The reconciliation is recorded here instead: where the
changelog prose and the register disagree, the register wins, and Data Visualisation is Ready as of v0.4.

## Component register

Every component carries a status and an owning area. **Ready** ships and is safe to depend on; **Deprecated**
has a named replacement and a migration path; **Draft** means in-progress and not yet safe to depend on. The
register maps each row to the epic child that shipped it and to its Keiko Product Delivery board state.

| Component                      | Status     | Owner     | Since                           | Shipped by  | Board status |
| ------------------------------ | ---------- | --------- | ------------------------------- | ----------- | ------------ |
| Button / Field / Toggle / Tabs | Ready      | @core-ui  | v0.1                            | #1293/#1294 | Done         |
| Messages & Feedback            | Ready      | @core-ui  | v0.2                            | #1294       | Done         |
| Table & Data Grid              | Ready      | @data-ui  | v0.4                            | #1297       | Done         |
| Inputs & Forms (extended)      | Ready      | @core-ui  | v0.4                            | #1298       | Done         |
| Navigation set                 | Ready      | @core-ui  | v0.4                            | #1298       | Done         |
| AI & Agent surfaces            | Ready      | @agent-ux | v0.4                            | #1296       | Done         |
| Data Visualisation             | Ready      | @data-ui  | v0.4                            | #1297       | Done         |
| Legacy 2-way theme toggle      | Deprecated | @core-ui  | migration target: theme-control | replaced    | Done         |

**Draft** is a defined status, but no current component uses it — every shipped family is Ready, and the one
retired family is Deprecated. Register status labels must agree with the **Keiko Product Delivery** board: a
component shown Ready here must not sit in a board state that contradicts shipped delivery, and vice versa.
This is a Stop Condition — status labels must not conflict with delivery-board states. When the two disagree,
reconcile before treating either as authoritative (the data-viz reconciliation above is the worked example).

## Per-component documentation template

The canonical ten-section template — Overview, When (not) to use, Anatomy, Variants & sizes, States,
Accessibility, Tokens, Do / Don't, Status & owner, Changelog — lives in
[component-template.md](component-template.md). A component's register status cannot move to **Ready** until
the full template is shipped for it, with the **States** section proven across the three colour modes and the
**Accessibility** section completed (roles, focus order, keyboard, contrast). An incomplete template is, by
definition, a Draft.

## Contribution rules

A change enters the system through three rules, each enforced by a real gate in this repository:

1. **Resolve to existing tokens.** A change that needs a new colour, hue, or one-off value is a **token
   proposal first**, not a component change. Enforcement: the scope-wide drift guards in
   `packages/keiko-ui/src/app/globals.css.test.ts` parse every in-scope rule and fail when a migrated surface
   carries a raw, unreviewed value instead of a `--*` token — a new literal cannot land silently.
2. **Ship the full template before Ready.** States and accessibility are included; status cannot move to Ready
   until the [component-template.md](component-template.md) spine is complete (see above). Enforcement: the
   per-component pins in `globals.css.test.ts` and the `*.a11y.test.tsx` (jest-axe) suites gate the States and
   Accessibility sections.
3. **An owner reviews; the changelog is part of the change.** The area owner named in the register reviews the
   contribution, and the changelog entry ships with it, not as an afterthought. Enforcement: PR review plus
   this governance document plus the formal acceptance contract in
   [ADR-0050](../adr/ADR-0050-component-state-and-governance-contract.md).

## Deprecation rules

A component leaves the system through three rules:

1. **Mark Deprecated with a named replacement and the version it lands in.** The register row must name the
   successor (the Legacy 2-way theme toggle names `theme-control`).
2. **Keep it working for one minor cycle.** Emit nothing breaking while consumers migrate — the deprecated
   component continues to render and behave as before for at least one minor version.
3. **Remove only after zero internal consumers.** Deletion is allowed only once the component's migration note
   shows no internal consumers remain.

## Migration and variance-note expectations

Every future component PR carries a **migration note** that classifies each change as one of two kinds:

- **value-preserving** — no resolved colour changes in any mode. This is proved the same way the shipped
  children proved it: an equivalence harness captures `getComputedStyle` across the mode matrix and reports
  **0 differences** (the established harnesses live under the evidence directories, e.g.
  [`evidence/1297/`](evidence/1297/README.md) and [`evidence/1298/`](evidence/1298/README.md)).
- **deliberate appearance change / DS 0.4.0 alignment** — an intentional visual change, named as such, with
  its rationale (for example `.pe-scorecards` adopting the full `.c-table` component in
  [data-display-migration.md](data-display-migration.md)).

Light Mode mismatches must be resolved **through tokens**, never through new one-off `[data-theme="light"]`
overrides — the one-off override layer is the defect the epic forbids. The
[light-mode-deviation-register.md](light-mode-deviation-register.md) is the Light Mode sign-off list: every
mismatch is classified **blocking** / **required** / **approved deviation** with a reproduction path, and a
new component must not add a row to it without that classification and sign-off. This is how governance
prevents both unreviewed raw visual values and Light Mode regressions from re-entering the system.

## Evidence requirements

Acceptance is a hierarchy, and the top of it is the running UI:

- **Primary acceptance** is autonomous **App Browser or Playwright visual inspection of the running UI**
  across Dark, Light, and High-Contrast (plus reduced-motion and compact/responsive where relevant). The
  7-mode screenshot set (`01-dark` … `07-reduced-motion`) under `docs/design-system/evidence/<issue>/` is the
  canonical capture — see [`evidence/1296/`](evidence/1296/README.md), [`evidence/1297/`](evidence/1297/README.md),
  and [`evidence/1298/`](evidence/1298/README.md).
- **Supporting evidence** is the automated token / contrast / pixel checks: the `globals.css.test.ts` drift
  gates, the axe / jest-axe a11y suites, and the equivalence harnesses. These confirm token discipline and
  guard against regression, but they are **not a substitute** for UI acceptance.

Future agents **must inspect the running UI visually** — Dark, Light, and High-Contrast — before closing any
pixel-fidelity work. A green test suite alone does not close a fidelity task.

## How governance connects to implementation and review

Each register row points to a real artifact triple: its implementing child PR, its evidence directory under
`docs/design-system/evidence/<issue>/`, and its `Issue #<n>` describe block in
`packages/keiko-ui/src/app/globals.css.test.ts`. The contribution and deprecation rules above gate real PRs —
a contribution that bypasses the token drift guard or the a11y suite does not merge — and
[ADR-0050](../adr/ADR-0050-component-state-and-governance-contract.md) is the formal acceptance contract that
binds the register, the template, and the evidence hierarchy together. Governance here is connected to actual
implementation and review evidence at every row; it is never process for its own sake (a Stop Condition).

## See also

[state-matrix.md](state-matrix.md) · [component-template.md](component-template.md) ·
[editor-governance.md](editor-governance.md) · [visual-qa-matrix.md](visual-qa-matrix.md) ·
[ADR-0050](../adr/ADR-0050-component-state-and-governance-contract.md).
