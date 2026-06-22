# ADR-0040: Design-to-Code Heading Hierarchy — Additive headingLevel IR Field

## Status

Proposed

## Context

Every TEXT node in the generated HTML/CSS output is rendered as `<p>`, regardless of its semantic
role in the design. The generated screens are therefore heading-less, violating WCAG 1.3.1 (Info
and Relationships) and WCAG 2.4.6 (Headings and Labels). Screen-reader users cannot navigate by
heading. Automated accessibility checkers flag the absence.

`irTypes.ts` defines `InteractionHint = "button" | "input" | "link" | "text" | "image" |
"container"` — there is no `"heading"` role. `htmlCssAdapter.ts` maps `text → <p>` via
`TAG_BY_ROLE`. The fix requires either a new role or an additive field on existing TEXT nodes.

### Audit finding: both naive heuristics are empirically unsound

The adversarial audit for Issue #755 tested the two most commonly proposed heuristics on the
actual production board (153 screens):

**Heuristic A — font-size tier ranking**: rank all `IrTypography.fontSize` values into tiers and
assign `<h1>`–`<h3>` to the top tiers.

- **Refuted**: heading nodes are continuum-sized (no discrete gap between heading and body
  sizes). Body text at 14–18px overlaps heading text at 20px. Size rank produces false positives
  on large-text decorative elements and false negatives on small headings. The ranking would
  change across boards, making it board-specific rather than generic.

**Heuristic B — name-pattern matching**: match node names against patterns like `"heading"`,
`"title"`, `"H1"`, etc.

- **Refuted**: on the production board, 79 nodes are named `"Typography"` — including nodes
  that are structural headings. A name-pattern heuristic would silently produce the wrong
  result for the majority of heading nodes on this board. The `normalize.ts` header explicitly
  states that name heuristics are acceptable only for `button`/`input` because "these words
  appear in design-system role vocabulary" — there is no equivalent universal convention for
  heading naming.

### Reliable signal: explicit sibling marker in the "(headlines)" wrapper

The audit identified one reliable, board-agnostic signal: on ~28 of the 153 production screens,
heading TEXT nodes appear as siblings inside a FRAME or GROUP whose name matches the pattern
`"(headlines)"` (case-insensitive, parentheses-delimited). Within that wrapper, sibling children
are named `"H1"`, `"H2"`, `"H3"`, etc. (exact match of the heading level, case-insensitive).
This is not a Keiko-specific convention — it is the Figma community's standard way to annotate
a component's semantic heading level when the component library does not encode it structurally.
Its presence is a reliable signal; its absence means "no heading level determinable" (graceful
degradation to `<p>`).

Detection algorithm (purely structural, no model):

1. During `normalize.ts` (or a new sibling pass), walk the pruned node tree. When a FRAME/GROUP
   node's name matches `/^\(headlines?\)$/iu`, examine its kept children.
2. For each kept child TEXT node whose name (trimmed, uppercased) matches `"H1"` through `"H6"`,
   record `headingLevel = 1..6` on the corresponding `IrNode`.
3. The detection is local to the sibling list of the marker frame — it does not propagate
   upward or downward.

On screens without the `"(headlines)"` marker frame, `headingLevel` is absent on all nodes, and
all TEXT nodes continue to render as `<p>`. Output is byte-identical to the current state on
those screens.

### Relationship to "generic by construction"

`emissionPlan.ts` header: "the only structural signal read is `interactionHint`." After this ADR,
`emissionPlan.ts` also threads `headingLevel` verbatim — but it does not interpret it any more
than it interprets `typography`. The adapter decides the tag; the plan carries the signal. The
detection logic in `normalize.ts` reads only the structural tree shape and node names — it does
not encode any board-specific vocabulary beyond the Figma community convention
`"(headlines)"` / `"H1"–"H6"`.

## Decision

We will add an additive, optional `headingLevel: 1 | 2 | 3 | 4 | 5 | 6` field to `IrNode`,
thread it through `EmissionElement`, and use it in `htmlCssAdapter.ts` to emit `<h1>`–`<h6>` for
TEXT-role elements that carry it.

### Module changes

**1. `irTypes.ts` — additive optional field on `IrNode`**

```typescript
/**
 * Heading level (1–6) derived from the "(headlines)" sibling-marker convention in the Figma
 * source tree. Present only on TEXT nodes that are siblings of an "H1"–"H6" marker node inside
 * a "(headlines)" wrapper frame. Absent on all other nodes (no inference, no heuristic).
 *
 * Hash-neutral: excluded from canonicalHashSha256Hex (same treatment as layout, typography).
 * Codegen metadata, not structural drift identity.
 */
readonly headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
```

The field is marked hash-neutral consistent with all other additive optional IR fields added since
Issue #752 (ADR-0037 §4). Its presence or absence does not change the drift-detection hash; re-
normalizing a board after this field ships does not invalidate existing snapshots.

**2. `normalize.ts` — detection pass**

Add a `readHeadingLevel(node: FigmaSourceNode, siblings: readonly PrunedNode[]): 1|2|3|4|5|6 |
undefined` function. The function is called inside `buildNodeAt()` for TEXT nodes only and only
when the parent frame has the marker name. Implementation sketch:

```typescript
const HEADLINES_WRAPPER = /^\(headlines?\)$/iu;
const HEADING_TAG = /^H([1-6])$/iu;

// Called once per TEXT node with the kept siblings of its parent frame.
function readHeadingLevel(
  node: FigmaSourceNode,
  parentName: string,
  siblingNames: readonly string[],
): 1 | 2 | 3 | 4 | 5 | 6 | undefined {
  if (!HEADLINES_WRAPPER.test(parentName)) return undefined;
  // Find the first sibling whose name matches H1..H6 (the marker).
  // The TEXT node itself may BE the H1..H6-named node.
  const ownName = nodeName(node).trim();
  const match = HEADING_TAG.exec(ownName);
  if (match === null) return undefined;
  const level = Number(match[1]);
  return level >= 1 && level <= 6 ? (level as 1 | 2 | 3 | 4 | 5 | 6) : undefined;
}
```

`buildNodeAt()` must receive the parent frame's name and kept-sibling name list. This requires a
small change to the call signature (parent context threaded down one level), or alternatively a
two-pass approach where a sibling-marker scan runs before `normalizeScreenRoot` and produces a
`Set<string>` of node ids that carry heading levels.

The implementor should choose the two-pass approach (pre-scan the pruned tree, build a
`Map<nodeId, 1|2|3|4|5|6>`, then read from the map in `buildNodeAt`) to avoid widening the
`buildNodeAt` signature across the recursion stack.

**3. `emissionPlan.ts` — thread verbatim**

`toElement()` adds:

```typescript
...(node.headingLevel !== undefined ? { headingLevel: node.headingLevel } : {}),
```

`EmissionElement` gains:

```typescript
/**
 * Heading level (1–6), present only when the IR node carries the "(headlines)" marker signal.
 * Absent for all other TEXT-role nodes; undefined for non-TEXT roles.
 */
readonly headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
```

**4. `htmlCssAdapter.ts` — emit `<h1>`–`<h6>` for TEXT nodes with headingLevel**

`TAG_BY_ROLE` remains unchanged (the default tag for `text` is still `<p>`). The element
rendering path adds a special case:

```typescript
function tagForElement(element: EmissionElement): string {
  if (element.role === "text" && element.headingLevel !== undefined) {
    return `h${String(element.headingLevel)}`;
  }
  return TAG_BY_ROLE[element.role];
}
```

`renderElement()` calls `tagForElement(element)` instead of `TAG_BY_ROLE[element.role]`.

**5. `screenIrTestBaseline.ts` — `parseOptionalNodeFields()`**

Add `headingLevel` parsing:

```typescript
const hl = value.headingLevel;
const headingLevel =
  typeof hl === "number" && Number.isInteger(hl) && hl >= 1 && hl <= 6
    ? (hl as 1 | 2 | 3 | 4 | 5 | 6)
    : undefined;
// ...
...(headingLevel !== undefined ? { headingLevel } : {}),
```

This ensures the field round-trips through the persisted `irJson` correctly.

### Hash neutrality

`headingLevel` is excluded from `canonicalHashSha256Hex`. It is codegen metadata — the same
category as `layout`, `sizing`, `typography`, `textColor`, `backgroundColor`. A board whose
heading TEXT nodes gain `headingLevel` after this field ships does not produce a new drift hash;
only structural node additions/removals (id, type, interactionHint, children) change the hash.

### Integrity of the "generic by construction" invariant

The detection rule reads only two things: (a) whether a FRAME/GROUP node's name matches the
Figma community convention `"(headlines)"` and (b) whether the TEXT node itself is named
`"H1"–"H6"`. These are structural reads of node shape and explicit annotation, not font metrics,
not content, not model output. `emissionPlan.ts` threads the result verbatim. The invariant
holds: no board-specific name, style, or copy is special-cased.

## Consequences

### Positive

- WCAG 1.3.1 and 2.4.6 are satisfied on screens that carry the `"(headlines)"` marker, with
  zero model involvement.
- Screen-reader navigation by heading works on annotated screens.
- Screens without the marker are unchanged — graceful degradation.
- Fully additive: no existing test, adapter, or snapshot is broken.
- Hash-neutral: no snapshot re-validation is required after the field ships.
- Reversible: removing `headingLevel` from `IrNode` and `EmissionElement` is a compile-time
  change with no stored data impact.

### Negative

- Only ~18% of screens (28/153) carry the `"(headlines)"` marker on the production board. The
  other ~82% remain heading-less until the design team adds the annotations or until a reliable
  non-heuristic signal is identified.
- The detection depends on the design team following the `"(headlines)"` / `"H1–H6"` convention.
  Boards that use a different convention (e.g. component-level semantic annotation) receive no
  benefit.
- The two-pass approach (pre-scan + map) adds a small traversal overhead per screen in
  `normalize.ts`.

### Neutral

- The `"(headlines)"` convention is implicit knowledge today; this ADR documents it as an
  explicitly supported signal in Keiko's pipeline.
- Future IR versions could add a richer `semanticRole` field; `headingLevel` is a narrower
  specific case that would compose with such a field without conflict.

## Alternatives Considered

### Alternative 1: Font-size tier ranking

- **Pros**: no Figma convention dependency; works on any board.
- **Cons**: empirically refuted on the production board. Heading nodes are continuum-sized;
  body text at 14–18px overlaps heading text at 20px. Any rank threshold is board-specific.
  The audit explicitly ruled this out.
- **Why rejected**: produces wrong output on the production board; violates "generic by
  construction" (would require board-specific threshold tuning).

### Alternative 2: Name-pattern matching (e.g. detect nodes named "heading", "title", "H1"...)

- **Pros**: no layout tree traversal; simple.
- **Cons**: empirically refuted. 79 nodes on the production board are named `"Typography"`;
  structural headings use that name rather than role-indicating names. A name-pattern heuristic
  produces wrong results for the majority of headings on this board. `normalize.ts` correctly
  limits name heuristics to `button`/`input`, where the vocabulary is stable across design
  systems. Heading naming has no equivalent stable vocabulary.
- **Why rejected**: unsound on the production board; would silently misclassify most headings.

### Alternative 3: Introduce a new "heading" InteractionHint role

- **Pros**: more explicit; adapter logic is simpler.
- **Cons**: `InteractionHint` is a `"button" | "input" | "link" | "text" | "image" | "container"`
  union used everywhere in the emission pipeline, test baseline derivation, and the purityGuard
  ADR-0023 D4 checks. Adding a new member is a breaking change to all `switch` exhaustiveness
  checks and TAG_BY_ROLE. It also conflates role (interactive/structural) with semantics
  (heading level) — a heading is still a `text` node with an additional semantic annotation.
- **Why rejected**: wider blast radius than the benefit warrants; heading level is an annotation
  on a text node, not a distinct interaction role.

### Alternative 4: Derive heading level from model output

- **Pros**: could handle boards without the `"(headlines)"` marker.
- **Cons**: violates the model-free invariant; produces non-reproducible output; requires a model
  call even for the structural code skeleton.
- **Why rejected**: same reason as ADR-0039 Alternative 4 — the invariant is not negotiable.

### Alternative 5: Thread ARIA role via a generic semanticRole field

- **Pros**: general-purpose; supports heading, landmark, and other ARIA roles from one field.
- **Cons**: no existing signal in the IR provides the full range of ARIA roles; designing a
  general `semanticRole` field is a larger scope change; the three usages required before
  extracting a general pattern (rule: three similar usages before extracting) are not present
  yet.
- **Why rejected**: premature generalization. `headingLevel` is the concrete signal; revisit when
  a second ARIA role annotation signal is confirmed.

## Related

- ADR-0037: Figma Snapshot Boundary — hash-neutrality baseline; model-free/determinism invariant.
- ADR-0039: Color Emission — same threading pattern (IrNode → EmissionElement → adapter).
- ADR-0041: Form Landmarks — third fidelity improvement; no IR change.
- Issue #752: Screen-IR definition (IrNode, InteractionHint).
- Issue #755: design-to-code first slice; introduces htmlCssAdapter.
- Issue #973: layout fidelity track (threading precedent for optional IR fields).
- WCAG 1.3.1: Info and Relationships — requires heading markup for structural headings.
- WCAG 2.4.6: Headings and Labels.

## Date

2026-06-15
