# ADR-0049: Design System fidelity measurable gates

## Status

Accepted (Issue #1291, Epic #1290, 2026-06-21)

## Version

0.2.0

## Context

Epic #1290 adopts the Keiko Design System pixel-perfectly across the product, with Light Mode treated as a
first-class acceptance surface. Issue #1291 audited the product UI against the `design-system/` reference and
must "turn the Design team's expectations into measurable gates" so that child issues #1292–#1300 are accepted
against objective criteria rather than subjective review.

The audit established the ground truth (full evidence in `docs/design-system/`):

- The product UI is a single-route governed desktop. The entire visual language lives in one 16,191-line
  `packages/keiko-ui/src/app/globals.css` of global class names. There is one theme engine (CSS custom
  properties switched by `data-theme` / `data-hc` / `data-input-modality` and `@media` queries) and no
  CSS-Modules, Tailwind, styled-components, or Storybook layer.
- The design-system defines a four-layer token architecture (primitive → scale → semantic → component). The
  product implements only Tier 1 (primitives) plus the editor extension; **160 Tier-2/3/4 tokens are absent**,
  two Tier-1 primitives (`--focus-w`, `--grid-dot`) are missing, and the `@media (forced-colors: active)` mode
  block and an in-app neutral high-contrast override are absent.
- Large style categories have no scale: 38 raw `z-index` values (with collisions), 1,012 raw spacing
  declarations, 559 raw `font-size` declarations, 97 raw motion durations, 202 raw `border-radius` bypasses.
- Light Mode is architecturally sound (token-override model with WCAG-measured corrections) but carries a
  forbidden one-off override layer: 49 component-scoped `[data-theme="light"]` rules patch components that
  hardcoded dark-biased values instead of routing through tokens.

The design-system primitives were "lifted 1:1" from the product `globals.css`, and the editor tier was lifted
back into the product, so the two sources share names and must be **consolidated, not forked**.

## Decision

Child issues under Epic #1290 are accepted against the following measurable gates. These gates are additive to,
and never weaken, the existing architecture, security, accessibility, evidence, and CI gates.

1. **Single token source, no duplication.** Token consolidation extends `globals.css` as the single emitted
   token source; the semantic/component tiers are layered on top of the existing primitives. No second `:root`
   token block, no parallel token namespace, no parallel theme engine, and no new styling framework
   (CSS-Modules / Tailwind / styled-components / Storybook) may be introduced. Enforced by review against this
   ADR and by extending `globals.css.test.ts`.

2. **Token-tier completeness.** After #1292, `globals.css` defines the design-system Tier-2 scales, Tier-3
   semantic, and Tier-4 component tokens, the `--focus-w` and `--grid-dot` primitives, an
   `@media (forced-colors: active)` block, and an in-app neutral high-contrast override. Each tier is asserted
   in `globals.css.test.ts`.

3. **No unapproved raw values in migrated scopes.** Within a migrated component's CSS/TSX, colour, shadow,
   radius, spacing, motion, z-index, and type values consume semantic or component tokens. Remaining raw values
   require a documented exception (e.g. WebGL shader constants, the PWA manifest brand colour, SVG mask
   endpoints, `color-mix` math endpoints). The `z-index` layer scale is a blocking prerequisite.

4. **Light Mode is a first-class acceptance surface.** Every Light Mode mismatch is classified
   `blocking` / `required` / `approved deviation` with a reproduction path; `required` items are migrated to
   tokens (shadows/scrims routed through `--shadow-*` / `--overlay-scrim`), and the one-off
   `[data-theme="light"] .selector` override layer is reduced, not extended. Reference:
   `docs/design-system/light-mode-deviation-register.md`.

5. **Mode-driven, never duplicated.** Light, Dark, High Contrast (OS `prefers-contrast` and the in-app
   override), reduced motion, and forced colors remain token-driven; no per-component, per-mode one-off layer.

6. **Behaviour-preserving migration.** Component migrations preserve existing behaviour, keyboard support, ARIA
   semantics, persistence, and data contracts, anchored by the existing component `*.test.tsx` and
   `*.a11y.test.tsx` suites.

7. **Accessibility floor.** Migrated components clear WCAG 2.2 AA (text ≥ 4.5:1, large/border/focus ≥ 3:1),
   AAA ≥ 7:1 in High Contrast, ≥ 24×24px targets, visible focus, keyboard operability, and state conveyed by
   icon + text + shape (never colour alone). Enforced by `globals.css.test.ts` + `axe-core`/`jest-axe`.

8. **Visual evidence.** Visual changes carry deterministic visual evidence across Light, Dark, and High Contrast.
   The visual-regression harness is built as a net-new Playwright project on the existing chromium config
   (`toHaveScreenshot`), since no pixel-diff harness exists today; baselines are committed and designer-approved,
   with a pixel-variance policy and recorded variance notes. Reference:
   `docs/design-system/visual-qa-matrix.md`.

9. **Surface ownership.** Every visible product surface has an owner child issue or a documented deferral, and
   each child issue's exact edit-file set is recorded. Reference: `docs/design-system/fidelity-matrix.md` and
   `docs/design-system/token-component-reuse-map.md`.

## Consequences

- Child issues have objective, testable acceptance criteria; designer review becomes a sign-off against the
  matrix in `docs/design-system/visual-qa-matrix.md` rather than subjective cleanup.
- #1292 is a hard foundation gate: it lands the token tiers with all aliases resolving to existing primitives,
  so the live product is byte-identical until components are migrated, bounding regression risk.
- The single-source / no-new-framework constraint prevents token-namespace drift and parallel theme engines.
- This ADR documents gates only; it ships no production UI change. It is authored under the audit-only Issue
  #1291 and is the contract its child issues are verified against.

## References

- Issue #1291, Epic #1290.
- `docs/design-system/README.md` (blueprint overview), `fidelity-matrix.md`, `light-mode-deviation-register.md`,
  `token-component-reuse-map.md`, `visual-qa-matrix.md`.
- `design-system/audit.html` (system scorecard 4.1/5), `keiko-tokens.css`, `keiko-semantic-tokens.css`,
  `accessibility.html`.
- Related design-to-code ADRs: ADR-0039 (color emission), ADR-0040 (heading hierarchy), ADR-0041 (form
  landmarks). Those govern the Figma→code emission pipeline; this ADR governs the runtime design-system.
