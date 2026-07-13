# Follow-up Epic Proposal — Cognitive Complexity Hotspots

Source: SonarCloud Blocker/Critical review (`typescript:S3776` / `javascript:S3776`, see
[`sonarcloud-blocker-critical-triage.md`](sonarcloud-blocker-critical-triage.md) for the sibling
triage of the false-positive findings from the same review pass).

## Why these two files are out of scope for the current fix round

Of 136 total Cognitive Complexity findings, 120 were addressed directly (PR 4, scoped batch) because
they are isolated, well-tested, low/medium-risk functions. The remaining **20 findings concentrate
in two files** that are both core-feature, high-blast-radius code:

| File                                                                                 | Findings | Max complexity | Total complexity | Role                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | -------- | -------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/keiko-ui/src/app/components/desktop/widgets/cards/EditorRuntimeWidget.tsx` | 3        | 177 (limit 15) | 233              | The editor's main runtime widget — 5,102 lines, ~40+ state variables, 15+ effects, manages file save/recovery, agent interaction, git gutter, diagnostics, completions, test generation, and diff review in one component. |
| `packages/keiko-workspace/src/codeIntelligence.ts`                                   | 17       | 83 (limit 15)  | 486              | Polyglot route-endpoint extraction — one `forEach` loop with 15+ if/else branches per line, detecting route patterns across C#/.NET, Java/Spring, NestJS, Express, Python/Flask/Django in a single function.               |

Refactoring either responsibly requires behavior-preserving extraction across dozens of call sites
plus new/expanded test coverage to catch regressions in save/load/recovery flows (editor) or
route-detection accuracy across 6+ languages (code intelligence) — this is architecture-level work,
not a drive-by fix alongside ~240 other Sonar findings. Bundling it into the same change set as
PR 1–4 would violate this repo's own engineering bar (`AGENTS.md` §7: "prove the failure first",
bounded iterations, no half-finished implementations) and risks destabilizing the editor, the
product's flagship surface.

## Recommended refactor strategy (for the follow-up epic, not executed now)

### `codeIntelligence.ts` — Handler-registry dispatch (risk: LOW once extracted)

Replace the single `forEach`-over-lines loop with:

1. A `classifyLine(line, scan): LineType` step (or, since multiple _independent_ patterns can match
   the same line across different languages, a `detectPatterns(line, scan): PatternMatch[]` step).
2. One handler function per language/framework (`detectDotNetRoute`, `detectSpringRoute`,
   `detectExpressRoute`, `detectPythonRoute`, ...), each returning the endpoint(s) it found without
   depending on the others' state.
3. A per-language state object (`dotNetState`, `springState`, ...) instead of ~15 loose `let`
   variables shared across the loop body.

This is the lowest-risk of the two, because each language's detection is already largely
independent — the complexity comes from co-locating 15 unrelated concerns in one function, not from
inherent coupling between them. Regression tests should snapshot endpoint-detection output against
a corpus of real multi-language fixture files (one per supported framework) before touching the
function, so any refactor that changes detected endpoints for any fixture fails immediately.

### `EditorRuntimeWidget.tsx` — Sub-component and hook extraction (risk: MEDIUM-HIGH)

1. Extract cohesive concerns into custom hooks: `useEditorFileState`, `useEditorRecovery`,
   `useEditorAgentReview`, `useEditorDiagnostics` — each owning its own state/effects, exposing a
   narrow return interface to the parent component.
2. Extract rendering sub-trees into components once state ownership is clarified: `EditorTabs`,
   `EditorDiffReviewPanel`, `EditorAgentPanel`.
3. Do this incrementally, one hook/component at a time, with the full existing
   `EditorRuntimeWidget` test suite (plus any e2e editor smoke tests) run after each extraction step
   — never as one large rewrite.
4. Add missing test coverage for save/recovery edge cases _before_ extracting that logic, per
   `AGENTS.md` §7 ("prove the failure first").

## Suggested epic scope

- A dedicated ADR is likely warranted for the `EditorRuntimeWidget.tsx` decomposition specifically
  (it changes the internal structure of the product's flagship editor surface) — evaluate against
  the existing editor ADRs (`docs/adr/`) for whether this counts as an architectural decision needing
  its own record, or is an internal refactor covered by an existing one.
- Recommend splitting into at minimum two tracked issues (one per file) given their independent
  risk profiles and refactor strategies above.
- `codeIntelligence.ts` can likely proceed first and faster (lower risk, clearer test story via
  fixture snapshots).
- `EditorRuntimeWidget.tsx` should be scoped as a multi-PR effort (one hook/component extraction per
  PR) with e2e coverage gated before each step, not a single large PR.

## Non-goals for this document

This is a proposal for scoping a future epic, not an implementation plan — no code changes were
made against either file as part of this review.
