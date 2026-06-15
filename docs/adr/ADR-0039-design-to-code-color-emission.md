# ADR-0039: Design-to-Code Color Emission — Foreground Text and Screen-Root Background

## Status

Proposed

## Context

The HTML/CSS adapter (`htmlCssAdapter.ts`) emits zero color declarations. Every generated screen
renders black text on a white background regardless of the design. The Screen-IR already carries
per-node color data — `IrNode.textColor` (TEXT nodes only, normalized `#RRGGBB[AA]`) and
`IrNode.backgroundColor` (non-TEXT nodes, same format) — populated by `normalize.ts` via
`readTextColor` / `readBackgroundColor` and preserved in the snapshot evidence record (Issue #812,
used for a11y contrast). Both fields are **hash-neutral** by existing decision (ADR-0037 §4,
`irTypes.ts` lines 81–91): they are excluded from `canonicalHashSha256Hex` and survive re-fetches
of an unchanged design.

The color data is deliberately absent from `EmissionElement` today: `emissionPlan.ts` threads
`layout`, `sizing`, `cornerRadius`, and `typography` from `IrNode` but does not thread
`textColor` / `backgroundColor`, so `htmlCssAdapter.ts` never receives them.

The reason for that omission is not documented in any ADR. The audit for Issue #973 (layout
fidelity) confirmed it is a gap, not a deliberate permanent choice. The risk that motivates caution
is the **stacked opaque background problem**: if every `container`-role element emits its
`background-color`, nested containers cover each other with opaque fills, producing an illegible or
visually incorrect skeleton.

### Forces

- **Fidelity gap**: generated screens are monochromatically useless for design review.
- **Determinism**: `textColor` / `backgroundColor` are already deterministic, model-free, and
  hash-neutral. Threading them through the emission pipeline introduces no non-determinism and no
  model dependency.
- **Integrity hash**: both fields are explicitly excluded from `canonicalHashSha256Hex` today
  (ADR-0037 §4). Adding them to the emission path does not change that exclusion.
- **Stacking risk**: indiscriminate emission of `background-color` on every container produces
  opaque boxes that obscure child content or misrepresent visual layering.
- **Relationship to Issue #812 a11y**: `textColor` / `backgroundColor` are the primary inputs to
  the contrast-ratio pass. If the adapter emits them, the generated CSS and the a11y test items
  share the same source — single source of truth, no divergence.
- **Relationship to Issue #973 (layout fidelity)**: the layout-fidelity track established the
  threading pattern (IrNode → EmissionElement → adapter). Color emission is a direct extension of
  that pattern and depends on its precedent.

## Decision

We will thread `textColor` and `backgroundColor` through the emission pipeline with a **bounded
emission rule** that eliminates the stacking problem:

1. **`IrNode` is unchanged.** `textColor` and `backgroundColor` already exist on `IrNode` in
   `irTypes.ts`. No IR schema change, no snapshot migration.

2. **`EmissionElement` gains two optional fields** (additive; backward-compatible for all existing
   adapters and tests that do not read the new fields):

   ```typescript
   /** Foreground color for TEXT-role nodes, threaded verbatim from IrNode.textColor. */
   readonly textColor?: string;
   /**
    * Background fill color, threaded verbatim from IrNode.backgroundColor.
    * Present on any non-TEXT node that carries a solid fill. The adapter is responsible
    * for applying the bounded emission rule (see ADR-0039) to avoid stacked opaque fills.
    */
   readonly backgroundColor?: string;
   ```

3. **`emissionPlan.ts` `toElement()` threads both fields verbatim** using the same optional spread
   pattern already applied to `layout`, `sizing`, `cornerRadius`, and `typography`. No
   interpretation, no guard at this layer — every node that carries the field passes it through.
   `emissionPlan.ts` remains "generic by construction" (header comment): it does not decide when
   to emit color; that decision lives exclusively in the adapter.

4. **`htmlCssAdapter.ts` applies the bounded emission rule**:

   - `color: <textColor>;` (or `color: var(--color-N);` when the value matches the deduped token
     table) is emitted in the per-node CSS class for every element whose `textColor` is present
     and passes the existing `isSafeColor()` hex-validation guard. All TEXT-role nodes that carry
     a text fill benefit immediately.
   - `background-color: <backgroundColor>;` is emitted only for elements at **nesting depth 0
     within the screen** (the screen root `<section>`) and their **immediate CSS children**
     (depth 1). Elements nested more deeply do not receive a `background-color` declaration and
     inherit or default to transparent. This matches the common visual intent: board background
     and first-level panels (navigation bars, sidebars, cards) carry their fill; inner
     sub-elements use CSS inheritance or transparency.
   - Both declarations prefer `var(--color-N)` via the existing `TokenLookups.colorVar` map;
     inline hex is the fallback for values absent from the deduped token set.
   - The depth limit is tracked by threading a `colorDepth` counter into `collectStyles()`,
     incrementing as it recurses. The counter is independent of the existing style-declaration
     logic and does not change the per-node class scheme.

5. **`screenIrTestBaseline.ts` `parseOptionalNodeFields()`** already parses `textColor` and
   `backgroundColor` as typed `isString` checks (lines 151–152 of the current file). No change
   required.

6. **Hash neutrality is preserved.** Neither field enters `canonicalHashSha256Hex`. The ADR-0037
   §4 exclusion list is unchanged. Adding these fields to the emission path is additive; it does
   not redefine what constitutes a "changed design" for drift detection.

### What "generic by construction" means after this decision

`emissionPlan.ts` passes color fields verbatim without interpreting them — exactly the same
treatment as `typography`. The bounded emission rule (background-color only at depth ≤ 1) is a
CSS layout convention: opaque fills belong near the document root to avoid stacking artifacts.
It is structural and board-agnostic, not tuned to any specific board's vocabulary.

## Consequences

### Positive

- Generated screens carry brand colors; text renders in the correct foreground color.
- Single source of truth: the a11y contrast pass (Issue #812) and the generated CSS share the
  same `textColor` / `backgroundColor` fields — no divergence between the a11y evidence and the
  code skeleton.
- No model dependency introduced; no non-determinism; no integrity-hash change.
- Fully backward-compatible: existing adapters that do not read the new fields are unaffected at
  compile time.
- Reversible: removing the new fields from `EmissionElement` is a compile-time refactor with no
  stored data impact.

### Negative

- The depth-1 cutoff for `background-color` is a structural approximation. Transparent first-level
  panels receive a (possibly incorrect) background; deep containers with meaningful fills (e.g.
  modals, overlays) receive none. The skeletal output remains approximate.
- Background-color at depth 1 on every direct child of the screen root will produce colored bands
  when the design uses transparent card children in an auto-layout row.
- New optional fields increase the `EmissionElement` interface surface.

### Neutral

- CSS specificity: declarations are emitted in per-node `<style>` blocks using the existing
  `n-<nodeId>` class scheme. Specificity behavior is unchanged.
- Future adapters (MUI, component library) inherit the fields but make their own emission choices;
  the depth rule is adapter-local, not encoded in the plan.

## Alternatives Considered

### Alternative 1: Emit background-color on ALL containers

- **Pros**: simplest implementation; no depth tracking.
- **Cons**: stacked opaque backgrounds make nested sections invisible or visually wrong; the audit
  brief explicitly flags this risk.
- **Why rejected**: produces actively misleading output for any non-trivial layout.

### Alternative 2: Emit background-color only at the screen root (depth 0)

- **Pros**: simplest; zero stacking risk.
- **Cons**: first-level panels (nav bars, sidebars, cards) lose their background colors, which are
  often the most prominent design decision on a screen.
- **Why rejected**: too conservative; the incremental improvement over monochrome blank output is
  minimal.

### Alternative 3: Derive per-element CSS layering from bounding-box overlap

- **Pros**: could reproduce accurate visual layering.
- **Cons**: requires spatial reasoning across the element tree; non-trivial; incorrect on
  absolute-positioned designs not captured in the IR; out of scope for a structural code skeleton
  whose stated goal is design review, not pixel-perfect reproduction.
- **Why rejected**: premature complexity for the current maturity of the pipeline.

### Alternative 4: Let a model decide which elements to color

- **Pros**: could make smarter per-element choices.
- **Cons**: violates the "model-free" and "deterministic" invariants (ADR-0037 §5,
  `emissionPlan.ts` header comment); produces non-reproducible output; breaks the
  model-independence contract that the entire Epic #750–#764 audit track validated.
- **Why rejected**: the invariant is not negotiable; the structural color data is available without
  model assistance.

## Related

- ADR-0037: Figma Snapshot Boundary — establishes hash-neutrality of `textColor`/`backgroundColor`
  and the model-free determinism invariant for the emission pipeline.
- ADR-0040: Heading Hierarchy — second design-to-code fidelity improvement; same threading pattern.
- ADR-0041: Form Landmarks — third design-to-code fidelity improvement; no IR change required.
- Issue #755: design-to-code first slice (htmlCssAdapter introduction).
- Issue #973: layout fidelity track (established the threading pattern this ADR extends).
- Issue #812: a11y baseline (source of the `textColor` / `backgroundColor` IR fields).
- Issue #279: dedup — color token deduplication is already handled by `DesignTokens.colors`; this
  ADR reuses that dedup via `TokenLookups.colorVar` and does not duplicate it.

## Date

2026-06-15
