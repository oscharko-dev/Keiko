# Issue #1299 -- Component state matrix: browser evidence

Rendered-matrix proof for the Design System 0.4.0 component state governance
([#1299](https://github.com/oscharko-dev/Keiko/issues/1299),
epic [#1290](https://github.com/oscharko-dev/Keiko/issues/1290)).

All artefacts are produced by [`equivalence-harness.mjs`](./equivalence-harness.mjs) -- headless
Chromium navigating `design-system/states.html` via `file://` (no HTTP server, CodeQL-safe) across
all seven theme / contrast / motion modes.

## What is proved

The harness proves three things in a single run:

1. **Rendered matrix = documented matrix.** For every mode, the browser renders the `#mx tbody`
   table that `states.html` builds from its `ROWS` array. The harness reads each rendered cell
   (a `span.y svg` present = check, absent = dot), converts the 11-cell row to a bitstring, and
   asserts it equals the corresponding row in `docs/design-system/state-matrix.md` (parsed with
   the same 12-cell pipe-table parser used by the vitest drift gate). Any single flipped cell
   -- in either the HTML or the markdown -- causes the run to exit non-zero and names the
   component and column in `matrix-fidelity-proof.json`.

2. **Every checked state has a live proof element.** For every mode, the harness reads
   `#state-proof [data-family][data-state]` and asserts that every checked matrix cell has a
   rendered proof element. Data & sync states (Loading, Error, Empty, Syncing, Conflict) must
   additionally carry `data-noncolor="true"`, a visible state label, and a glyph marker so the
   state is not encoded by colour alone.

3. **Visual proof across all 7 modes.** Full-page screenshots capture the generated per-family
   state proof and the applicability matrix in every mode. Because the proof elements are driven
   by the Tier-2/3/4 tokens, the screenshots are the visual evidence for the matrix; the JSON
   assertions above are the machine-readable proof that no checked state is missing from the
   rendered page.

## Committed gate

`matrix-fidelity-proof.json` records **0 matrix diffs** and **0 proof diffs** across all 7 modes
(see `diffCount`, `proofDiffCount`, and `byMode` fields). The vitest block `"Issue #1299 --
component state matrix"` in
`packages/keiko-ui/src/app/globals.css.test.ts` independently pins
`docs/design-system/state-matrix.md` cell-for-cell against the `ROWS` array in
`design-system/states.html`, and statically guards the proof marker / non-colour metadata the
browser harness consumes.

## Screenshots

| File                      | Mode                                            |
| ------------------------- | ----------------------------------------------- |
| `01-dark.png`             | Dark                                            |
| `02-light.png`            | Light                                           |
| `03-dark-hc.png`          | Dark, High Contrast (`[data-hc="more"]`)        |
| `04-light-hc.png`         | Light, High Contrast                            |
| `05-prefers-contrast.png` | `prefers-contrast: more`                        |
| `06-forced-colors.png`    | `forced-colors: active` (Windows High Contrast) |
| `07-reduced-motion.png`   | `prefers-reduced-motion: reduce`                |

Each screenshot renders the full `states.html` proof page: the vocabulary section (eleven
badges), the generated per-family state proof for all checked cells, and the applicability matrix
rendered from `ROWS`.

## Reproduction

```bash
npm ci
npx playwright install chromium
node docs/design-system/evidence/1299/equivalence-harness.mjs
```

Exits non-zero if any rendered cell differs from `docs/design-system/state-matrix.md`, if any
checked state lacks a proof element, or if any data/sync state lacks non-colour label/glyph
evidence in any mode. Writes `matrix-fidelity-proof.json` and `01-dark.png` ...
`07-reduced-motion.png`.
