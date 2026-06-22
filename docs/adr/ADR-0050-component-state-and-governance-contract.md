# ADR-0050: Component state, documentation, and governance contract

Issue [#1299](https://github.com/oscharko-dev/Keiko/issues/1299) · Epic [#1290](https://github.com/oscharko-dev/Keiko/issues/1290) · Design System 0.4.0.

## Status

Accepted (Issue #1299, Epic #1290, 2026-06-22)

## Version

0.2.0

## Context

Issues #1292–#1298 landed the full Design System token tiers, shell/chrome migration, product-surface
migration, AI/agent components, table/data-grid foundation, and the input/navigation component set
into `packages/keiko-ui/src/app/globals.css`. Each child was accepted against the runtime gates in
ADR-0049; what was absent was a single acceptance contract governing how component states are named
and proven, how per-component documentation is structured, how status is tracked, and what rules
govern future contributions and deprecations.

That gap means:

- Component families that shipped (buttons, inputs, tabs, tables, AI surfaces, etc.) have no shared
  vocabulary for the interaction and data states they must define, and no enforced proof that each
  applicable state is implemented and screenshotted.
- There is no enforceable template for per-component documentation; coverage of states, tokens, and
  accessibility expectations varies per doc.
- There is no authoritative register that maps components to their status and owner, and no rule
  aligning that status with the Keiko Product Delivery board labels.
- Contribution and deprecation rules are informal, creating risk that new visual values are introduced
  without a token-proposal step, or that one-off `[data-theme="light"]` overrides accumulate.
- Editor fidelity governance, structural ownership, and agent-action authority are documented in
  separate tracks (#1373, #1390) with no cross-reference to the design-system acceptance layer.

The binding content is established by two reference pages: `design-system/states.html` defines the
eleven canonical interaction and data states plus the `ROWS` applicability matrix that declares which
states each component family must implement. `design-system/governance.html` defines the component
register (status: Draft / Ready / Deprecated; owning area; version), the ten-section per-component
documentation template, and the contribution and deprecation rules. Evidence and sibling documents
live in `docs/design-system/`.

Issue #1299 is the governing issue for this contract; it closes the #1292–#1298 acceptance work.
The implementation baseline is Design System 0.4.0, PR #1398.

## Decision

The following gates are additive to, and never weaken, the existing architecture, security,
accessibility, evidence, and CI gates established by ADR-0049 and the upstream architecture ADRs.

1. **Eleven-state vocabulary is canonical.** The eleven component states — Default, Hover, Focus,
   Active, Selected, Disabled, Loading, Error, Empty, Syncing, Conflict — as named in
   `design-system/states.html` are the only authorised state names. No synonyms, no local aliases.
   The applicability matrix in `design-system/states.html` (`ROWS` array) is the authoritative
   contract for which states each component family must define; [state-matrix.md](../design-system/state-matrix.md)
   is its Markdown transcription. Drift between the two is blocked by the `Issue #1299` gate in
   `packages/keiko-ui/src/app/globals.css.test.ts`, which pins `state-matrix.md` cell-for-cell
   against `states.html` so neither can diverge silently.

2. **Every implemented component family documents applicable and non-applicable states.** For each
   family, both the `✓` (must implement) and the `·` (not applicable, by design) sets from the
   applicability matrix must be recorded explicitly in [state-matrix.md](../design-system/state-matrix.md),
   together with the component token source and the accessibility expectation governing its interaction
   states. Screenshot evidence across Dark, Light, and High Contrast (seven canonical modes) is
   required for every state marked `✓`; the evidence path is recorded in the per-family mapping table.
   A missing `·` row is a documentation error, not a silent omission: a future contributor must know
   that a state was deliberately excluded, not forgotten.

3. **Per-component documentation follows the ten-section template.** The template defined in
   `design-system/governance.html` (sections: Overview, When (not) to use, Anatomy, Variants & sizes,
   States, Accessibility, Tokens, Do / Don't, Status & owner, Changelog) is the required structure for
   every component page. Status cannot move to Ready in the component register until the full template
   — including States (proven in three modes) and Accessibility (roles, focus order, keyboard,
   contrast) — is shipped. The canonical template document is [component-template.md](../design-system/component-template.md).

4. **Status and ownership are governed by the component register.** Every component family has a
   declared status (Draft / Ready / Deprecated) and an owning area in the register maintained at
   [governance.md](../design-system/governance.md), mirroring `design-system/governance.html`. The
   register status must agree with the component's label on the Keiko Product Delivery board; a
   component labelled `status:done` on the board must be Ready in the register, and a component
   labelled `status:in-progress` must be Draft. Conflicting labels between the register and the board
   are a governance error that the area owner is responsible for resolving.

5. **Contributions resolve to existing tokens; new visual values require a token proposal.** A pull
   request that introduces a new colour, hue, shadow value, or any other one-off visual value without
   a prior token proposal is rejected at review. The rule from `design-system/governance.html` is
   binding: "Resolve to existing tokens. A change that needs a new colour, hue or one-off value is a
   token proposal first." Raw unreviewed visual values in `packages/keiko-ui/src/app/globals.css` are
   caught by the scope-wide drift guards in `globals.css.test.ts` and by review against this ADR.

6. **No new one-off `[data-theme="light"]` overrides.** Light Mode mismatches must be resolved through
   tokens (routing through `--shadow-*`, `--overlay-scrim`, or a new semantic alias in the token
   tiers), not by adding a component-scoped `[data-theme="light"]` patch. The existing approved
   deviations are the sign-off list in [light-mode-deviation-register.md](../design-system/light-mode-deviation-register.md);
   that list must shrink over time, not grow. Any new entry requires an explicit documented exception
   with a classification (`required` / `approved deviation`) and a reproduction path.

7. **Editor fidelity evidence requirements are governed by `editor-governance.md`.** The design-system
   acceptance requirements specific to the Keiko Editor (fidelity evidence, mode coverage, token
   coverage) are recorded in [editor-governance.md](../design-system/editor-governance.md). Editor
   structural and runtime package ownership remains governed by ADR-0042 and Issue #1373; agent-action
   authority and audit boundaries remain governed by Issue #1390. This ADR does not override those
   constraints; it adds the fidelity evidence layer on top of them.

8. **Primary acceptance is autonomous visual inspection of the running UI.** The primary acceptance
   evidence for any component migration or addition is visual inspection of the running application
   across Dark, Light, and High Contrast (and reduced-motion, compact, and responsive breakpoints where
   the component has applicable states in those modes). Automated token-resolution checks, contrast
   checks, and pixel-diff comparisons in `globals.css.test.ts` and the Playwright visual harness are
   supporting evidence; they prove the mechanism, but do not substitute for human or autonomous
   App-Browser inspection of the rendered component. A component that passes all automated gates but
   fails visual inspection is not accepted.

## Consequences

- Component families shipped under #1292–#1298 have an objective, retrospective acceptance checklist:
  every family's applicable states are enumerated, documented in `state-matrix.md`, and backed by
  seven-mode screenshot evidence.
- Future contributors have a single place to look up what states apply to a component, what the
  documentation structure must be, and what the contribution rules are. Ambiguity about whether a
  missing state is intentional is eliminated by the explicit `·` (non-applicable) column.
- The ten-section documentation requirement adds measurable overhead before a component moves to
  Ready, which is an honest cost of durable governance.
- The token-proposal gate prevents silent visual proliferation in `globals.css`, but it adds a step
  for contributors who need a new visual value and must open a token proposal before their change can
  land.
- Aligning register status with Keiko Product Delivery board labels requires an ongoing owner
  responsibility; it is not automated. Label drift between the two systems is possible and must be
  caught at review.
- The Light Mode deviation register becomes a governed debt ledger; it grows only with explicit
  sign-off, which makes the cost of Light Mode technical debt visible.

## References

- Issue [#1299](https://github.com/oscharko-dev/Keiko/issues/1299), Epic [#1290](https://github.com/oscharko-dev/Keiko/issues/1290).
- `design-system/states.html` (eleven states, `ROWS` applicability matrix, live three-mode proof).
- `design-system/governance.html` (component register, ten-section template, contribution and
  deprecation rules, version history).
- [state-matrix.md](../design-system/state-matrix.md) (Markdown transcription of the applicability
  matrix; pinned against `states.html` by the `Issue #1299` drift gate).
- [governance.md](../design-system/governance.md), [component-template.md](../design-system/component-template.md),
  [editor-governance.md](../design-system/editor-governance.md) (wave-authored sibling documents;
  this ADR is the acceptance contract they implement).
- [fidelity-matrix.md](../design-system/fidelity-matrix.md), [light-mode-deviation-register.md](../design-system/light-mode-deviation-register.md),
  [token-component-reuse-map.md](../design-system/token-component-reuse-map.md),
  [visual-qa-matrix.md](../design-system/visual-qa-matrix.md) (blueprint documents shipped under
  Issue #1291; referred to by the gates above).
- [ai-components.md](../design-system/ai-components.md), [data-display-migration.md](../design-system/data-display-migration.md),
  [input-nav-migration.md](../design-system/input-nav-migration.md) (component migration docs for
  the #1292–#1298 wave).
- ADR-0049 (design-system runtime fidelity gates; this ADR adds state, documentation, and governance
  gates on top — scope distinction: ADR-0049 governs the runtime token architecture and visual
  acceptance gates; this ADR governs component-state vocabulary, documentation completeness, and
  contribution governance).
- ADR-0039, ADR-0040, ADR-0041 (design-to-code emission pipeline — color, heading hierarchy, form
  landmarks; those govern the Figma→code pipeline, not runtime governance).
- ADR-0042 (Keiko Editor package boundary; this ADR adds fidelity evidence requirements via
  `editor-governance.md` without superseding the package-boundary or egress rules).
