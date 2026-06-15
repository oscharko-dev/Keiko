# ADR-0041: Design-to-Code Form Landmarks — Adapter-Level form Wrapping

## Status

Proposed

## Context

The HTML/CSS adapter (`htmlCssAdapter.ts`) emits `<input />` elements without any enclosing
`<form>` landmark and without associated `<label>` elements. Consequences:

1. **WCAG 1.3.1 (Info and Relationships)**: input fields not inside a `<form>` are structurally
   disconnected from their semantic context. Screen readers cannot identify field groups.
2. **WCAG 1.3.5 (Identify Input Purpose)**: without `<form>` context, autofill browsers cannot
   infer field purpose.
3. **WCAG 3.3.2 (Labels or Instructions)**: inputs carry only a generic `aria-label` derived from
   the node's structural display name (e.g. `aria-label="TextField"`), which is not a programmatic
   label association.

The full label-association fix — `<label for="id">` tied to the actual visible label text — requires
upstream IR support: the field label text lives INSIDE the Figma `<TextField>` component subtree
(a flattened composite node), not as a preceding sibling text node. The audit empirically confirmed
this: **0 of 20 sampled input nodes** on the production board have a preceding sibling TEXT node
whose text plausibly functions as a label. The label is only recoverable with either:

(a) an upstream IR change in Issue #752 to extract `fieldLabel` as a dedicated IR field from the
    `<TextField>` subtree during normalization, or
(b) a model call to infer label text from surrounding context (violates the model-free invariant).

Neither is in scope for this ADR. This ADR defines the safe, adapter-only interim step.

### Interim scope

The structural fact determinable without IR or model changes: any `container`-role element that
contains one or more `input`-role descendants is a form-bearing region in the design. Wrapping
it in a `<form>` landmark is:

- Correct: HTML `<form>` is the appropriate landmark for an input-bearing region.
- Safe: `<form>` has no action attribute by default; the generated skeleton is not submitted.
- Deterministic: the presence of an `input`-role descendant is a pure structural predicate over
  the existing `EmissionElement` tree; no IR change, no model, no new fields.
- Bounded: the wrapping applies only to the **nearest ancestor container that has at least one
  `input`-role descendant** — not to every container in the tree (which would nest `<form>`
  elements, illegal in HTML).

### The sibling-text-to-label heuristic is not viable

One commonly proposed alternative is to walk backward over preceding sibling nodes and, if the
immediately preceding sibling is a `text`-role element, use its text content as a `<label>`.
The audit falsified this on the production board: 0/20 inputs have a text-role preceding sibling.
The label lives inside the `<TextField>` component, not outside it. The heuristic would produce
zero label associations on the actual board and would produce false-positive label associations
on boards where a preceding text node is a decorative caption, not a label. It is explicitly
rejected here so it is not re-proposed.

## Decision

We will detect form-bearing container subtrees in `htmlCssAdapter.ts` and emit a `<form>` wrapper
in place of the default `<section>` for those containers — with no change to `IrNode`,
`EmissionElement`, or `emissionPlan.ts`.

### Module changes

**`htmlCssAdapter.ts` only**

1. **`hasInputDescendant(element: EmissionElement): boolean`** — pure recursive predicate, O(n)
   in the subtree size, called once per container-role element during `renderElement()`. Returns
   `true` if the element has any descendant (at any depth) with `role === "input"`.

2. **`nearestFormAncestorIds` set** — threaded through `renderElement()` as a `Set<string>`.
   Before recursing into a `container`-role element, if `hasInputDescendant(element)` is true
   AND no ancestor of the current element is already in the set (to prevent `<form>` nesting),
   the element's id is added to the set and `<form>` is emitted instead of `<section>`.

3. **`tagForContainer(element: EmissionElement, inForm: boolean): string`** — returns `"form"`
   when the element is the chosen form ancestor, otherwise `"section"`.

4. **`aria-label` on `<form>`** — the form element emits
   `aria-label="${escapeHtml(element.displayName)}"` to give the landmark a descriptive name
   accessible to screen readers (WCAG 2.4.6).

5. **`<input>` elements** retain their existing `aria-label` attribute. No `<label for="">` is
   emitted in this ADR (deferred to the full label-association fix; see below).

6. **No change to `collectStyles()`**. The CSS class scheme is unchanged; a container that
   becomes a `<form>` continues to use its `n-<id>` class.

### Full label association — deferred path

The complete label-association fix is explicitly deferred. When Issue #752 adds a `fieldLabel?:
string` field to `IrNode` (the visible label text extracted from the `<TextField>` subtree), the
adapter can emit:

```html
<label for="input-<nodeId>"><escaped fieldLabel></label>
<input id="input-<nodeId>" aria-label="<displayName>" ... />
```

That requires an `EmissionElement.fieldLabel?: string` additive field (same threading pattern as
`headingLevel` and `textColor`) and a corresponding `irTypes.ts` change. That work is scoped to
Issue #752 and is tracked separately. This ADR does not block it.

### What stays the same

- `IrNode`, `irTypes.ts`, `emissionPlan.ts`, `screenIrTestBaseline.ts` — unchanged.
- The `EmissionElement` interface — unchanged.
- Hash neutrality — unchanged (no new IR fields).
- The model-free and determinism invariants — unchanged.
- All existing adapters — unaffected (the change is entirely within `htmlCssAdapter.ts`).

## Consequences

### Positive

- Every input-bearing screen region acquires a `<form>` landmark; screen readers can navigate
  to it directly.
- WCAG 1.3.1 (landmark structure) is partially satisfied for input-bearing regions.
- Zero IR change; zero snapshot migration; zero integrity-hash impact.
- Fully reversible: removing the `hasInputDescendant` guard and the `<form>` tag path is a
  small, contained change to `htmlCssAdapter.ts`.
- Implementation effort is the smallest of the three fidelity ADRs — adapter-only, no new IR
  fields, no pipeline threading.

### Negative

- `<input>` elements still lack programmatic `<label for="">` association; screen readers fall
  back to `aria-label` on the input itself (the structural display name). WCAG 3.3.2 is only
  partially addressed.
- WCAG 1.3.5 (Identify Input Purpose) still requires correct `autocomplete` attributes, which
  are not determinable structurally; deferred.
- The `hasInputDescendant` predicate adds a per-container traversal pass during rendering.
  For deep trees this is O(n) per container node, yielding O(n²) in the worst case. In
  practice, input nodes are rare (a typical form screen has 3–10 inputs in a shallow subtree),
  so the actual cost is negligible. If profiling shows a real cost, the pass can be collapsed
  into the existing `collectStyles()` walk.

### Neutral

- `<form>` without `action` is a valid HTML5 landmark; browsers do not submit it; the default
  behavior is a no-op for review artifacts.
- Nesting prevention (the `nearestFormAncestorIds` set) means that if a design has a
  sub-form inside a parent form, only the nearest form-bearing ancestor gets `<form>`. This
  matches HTML semantics (nested `<form>` is invalid).

## Alternatives Considered

### Alternative 1: Sibling-text-to-label heuristic (walk backward for a preceding text sibling)

- **Pros**: would emit `<label for="">` if a label text node is a preceding sibling.
- **Cons**: empirically refuted — 0 of 20 inputs on the production board have a preceding TEXT
  sibling. The label lives inside the `<TextField>` component subtree. The heuristic produces
  zero associations on the actual board and would produce false positives on boards where a
  preceding text node is decorative.
- **Why rejected**: non-viable on the production board; would silently mislead on other boards.

### Alternative 2: Add fieldLabel to IrNode now (full label association in this ADR)

- **Pros**: closes WCAG 3.3.2 fully.
- **Cons**: requires Issue #752 to be reopened or extended; the label extraction logic in
  `normalize.ts` must identify label text inside the `<TextField>` subtree, which varies by
  design system. This is a larger, riskier change and belongs to a separate issue.
- **Why rejected**: out of scope for the minimal-risk adapter-only fix; correctly scoped to
  Issue #752.

### Alternative 3: Use ARIA role="form" without a form element

- **Pros**: adds the form landmark without the HTML `<form>` element.
- **Cons**: `role="form"` on a `<div>` or `<section>` is only exposed to screen readers when it
  has an accessible name (ARIA requirement). It is harder to style and does not enable native
  browser form behaviors (autofill, Enter-to-submit) even in a review skeleton. Using the
  native `<form>` element is simpler and semantically clearer.
- **Why rejected**: `<form>` is the correct semantic element; ARIA role is a fallback for
  contexts where `<form>` is genuinely unavailable.

### Alternative 4: Emit one form per screen unconditionally

- **Pros**: simplest; ensures every screen has a form landmark.
- **Cons**: screens with no inputs would have an empty `<form>` wrapper, which is incorrect
  and misleading. Screen readers would announce an empty form.
- **Why rejected**: incorrect markup for screens without any input-role elements.

## Related

- ADR-0037: Figma Snapshot Boundary — model-free/determinism invariant; hash-neutrality baseline.
- ADR-0039: Color Emission — threading pattern for IR field additions.
- ADR-0040: Heading Hierarchy — additive IR field pattern; same sequencing track.
- Issue #752: Screen-IR definition — the deferred full `fieldLabel` fix belongs here.
- Issue #755: design-to-code first slice; introduces htmlCssAdapter.
- Issue #973: layout fidelity track (threading precedent).
- WCAG 1.3.1: Info and Relationships.
- WCAG 1.3.5: Identify Input Purpose.
- WCAG 2.4.6: Headings and Labels.
- WCAG 3.3.2: Labels or Instructions.

## Date

2026-06-15
