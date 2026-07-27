# Knowledge M2 wave activation and HS-6 coordination

This note operationalizes [ADR-0152](../adr/ADR-0152-substrate-ownership-and-unified-retrieval-spine.md)
for Knowledge M2 (Epic #2556, program Epic #2554). It is a checklist, not a second architecture
decision. ADR-0152 is authoritative when wording differs.

## Status: wave closed

The Knowledge M2 wave has shipped. M2.2 through M2.8 are integrated on this branch, and the HS-6
single-writer window closed at merge commit `f90fa2f3`.

**The single-writer freeze below is no longer binding.** A concurrent Editor or OpenCode branch may
edit the HS-6 files under the repository's normal review rules; it does not need an ordering
assignment from the M2.6 writer. The checked boxes are the historical settlement record of the
window, kept because `check:knowledge-m2-closeout` reads this file as the wave's bookkeeping proof —
an unchecked required box keeps that gate red.

## Activation record

- [x] Maintainer early-activation decision recorded: 2026-07-18.
- [x] Deviation class recorded: Delivery-Constitution scheduling deviation only.
- [x] Authority unchanged: the accepted issue scope, selected mode, Authority Envelope, deployment
      ceiling, required checks, redaction rules, and trust boundaries remain controlling.
- [x] Phase A entry gate assigned to M2.1 / Issue #2565.
- [x] M2.2, M2.3, M2.4, and M2.5 may start only after M2.1 integrates.
- [x] Phase B starts after the relevant Phase A outputs settle.
- [x] M2.6 owns the shared contract batch and the single D12 regeneration.
- [x] M2.7 owns repository-pod consumption.
- [x] M2.8 owns wave closeout evidence.

## Phase ownership

| Phase  | Child | Exclusive outcome                                                                |
| ------ | ----- | -------------------------------------------------------------------------------- |
| A gate | M2.1  | ADR-0152, ADR index row, and this operational record                             |
| A      | M2.2  | Shared vector port activation and native vector runtime qualification            |
| A      | M2.3  | One server reranker facade and the empty-result regression correction            |
| A      | M2.4  | One physical evaluation fold and the verbatim rule-3l amendment                  |
| A      | M2.5  | Repository pod production on existing Local Knowledge substrate                  |
| B      | M2.6  | Neutral retrieval contracts, shared eval types, HS-6 edits, one D12 regeneration |
| B      | M2.7  | Existing repository semantic-provider consumption swap                           |
| B      | M2.8  | Full unchanged-gate, byte-identity, and wave-settlement proof                    |

No child may pre-implement another row. A discovered implementation need is recorded against its
named owner rather than added opportunistically.

## HS-6 single-writer files

From M2.1 integration through M2.6 integration, only the designated M2.6 writer could edit these
files for the retrieval-context generalization. That window is closed (see the status section):

- [x] `packages/keiko-contracts/src/coding-context.ts`
- [x] `packages/keiko-contracts/src/index.ts` — coding-context export block only
- [x] `packages/keiko-contracts/src/harness.ts`
- [x] `packages/keiko-server/src/editor/codingContext.ts`
- [x] `packages/keiko-server/src/editor/codingContextProviders.ts`
- [x] `packages/keiko-server/src/editor/codingContextEvidence.ts`
- [x] `packages/keiko-server/src/editor/localKnowledgeRetrieval.ts`
- [x] `packages/keiko-server/src/editor/contextRoutes.ts`
- [x] `packages/keiko-server/src/editor/testGenerationEvidence.ts`
- [x] `packages/keiko-harness/src/tasks/renderRetrievedContext.ts`
- [x] `packages/keiko-workspace/src/contextPack.ts`

The checkboxes are coordination state. They were checked by the M2.6 owner as each file settled;
all eleven are settled and the window closed at merge commit `f90fa2f3`. They never authorized a
second writer while the window was open.

Explicitly outside the freeze: `packages/keiko-server/src/coding-context/*`. That connected-context
intake shares a name but not the coding-context contract family.

## Coordinate-only seams

These seams must be inspected for byte and type compatibility. They are not additional migration
sites unless the M2.6 owner schedules the change:

- [ ] Completion provenance vocabulary:
      `packages/keiko-contracts/src/editor-completion.ts`
- [ ] Completion source mapper:
      `packages/keiko-server/src/editor/completionRoutes.ts`
- [ ] Inline reuse of completion provenance:
      `packages/keiko-contracts/src/editor-inline-completion.ts`
- [ ] Inline source mapper:
      `packages/keiko-server/src/editor/inlineCompletionRoutes.ts`
- [ ] Test-generation mapper:
      `packages/keiko-server/src/editor/testGenerationRoutes.ts`
- [ ] Editor source-kind mirror:
      `packages/keiko-editor/src/types.ts`
- [ ] UI wire-to-editor mapping:
      `packages/keiko-ui/src/lib/editor-test-generation.ts`
- [ ] Git-context eligibility ceiling:
      the collector/provider seam in `codingContext.ts` and `codingContextProviders.ts`

While the window was open, an active Editor or OpenCode branch needing any single-writer file had to
stop and ask the maintainer to assign ordering, rather than merge overlapping edits and call the
result coordinated. The window is now closed and that ordering requirement has lapsed.

## Compatibility checklist

- [ ] Existing coding purpose literals remain closed and byte-identical.
- [ ] Existing coding source-kind and tier literals remain byte-identical.
- [ ] Existing `schemaVersion: "1"` values remain unchanged.
- [ ] Existing pack ordering and byte-budget tie breaking remain unchanged.
- [ ] Existing run-id material and prompt hashes remain unchanged.
- [ ] `CODING_CONTEXT_SOURCE_TIER_BY_KIND` remains total.
- [ ] Harness `SOURCE_LABEL` remains total.
- [ ] `EditorContextSourceKind` remains a synchronized coding mirror.
- [ ] Neutral graph/entailment kinds do not enter coding flows.
- [ ] Existing coding-context, route, completion, inline-completion, test-generation, evidence, and
      render suites pass unmodified.
- [ ] New wire fixtures prove alias-based serialization is byte-identical.

## Evaluation assets that must not move semantically

- [ ] Required aggregate name remains `ci`.
- [ ] Gate names remain `check:retrieval-quality`, `check:grounded-retrieval-quality`, and
      `check:grounded-faithfulness`.
- [ ] `PASS_THRESHOLDS` remains byte-identical.
- [ ] `DEFAULT_GROUNDED_RETRIEVAL_BUDGET` remains `0.8 / 0.9 / 0.85 / 0.8`.
- [ ] `DEFAULT_GROUNDED_FAITHFULNESS_BUDGET` remains all `1.0`.
- [ ] All sixteen registered Local Knowledge non-tautology probe ids remain present.
- [ ] `reranker-reversed` and `embedding-flat` remain negative controls.
- [ ] `reranker-off` remains the positive fallback control.
- [ ] Sealed-pod mutation proof remains behavioral.
- [ ] Hallucinated path, line-window, connector-page, and connector-issue fixtures remain negative
      faithfulness proofs.
- [ ] All 29 Local Knowledge fixtures remain present.
- [ ] All twelve current faithfulness fixtures remain present: six original repository fixtures and
      six connector fixtures.
- [ ] Deterministic seeds, ordering, report meaning, and redacted evidence shape remain unchanged.

## D12 ownership

- M2.1 is documentation-only and does not invalidate editor performance evidence under ADR-0139
  D2.
- M2.5 changes no D12 measured surface.
- M2.6 batches the measured contract changes and owns exactly one Linux-authoritative D12
  regeneration for the wave.
- No sibling performs a speculative or competing regeneration.
- A measurement-toolchain change still triggers the repository's toolchain-specific regeneration
  rule; this note creates no skip.

## Child-to-decision review table

| Child | ADR-0152 citation required at review |
| ----- | ------------------------------------ |
| M2.2  | D1, D2, D3                           |
| M2.3  | D4                                   |
| M2.4  | D5                                   |
| M2.5  | D8                                   |
| M2.6  | D1, D6, D7, D10                      |
| M2.7  | D3, D9                               |
| M2.8  | D5, D6, D10                          |

## Stop conditions

Stop the wave and ask the maintainer when:

- ADR-0152 is taken or the next free number collides with a reserved in-flight record;
- a proposed change would weaken a gate, redaction requirement, fail-closed branch, rule 3l, or
  rule 6a;
- a current-tree fact changes an ADR-0152 ownership or security decision rather than merely moving
  a line number;
- an active Editor/OpenCode branch conflicts with HS-6; or
- a child requires an implementation owned by another row in the phase table.

## M2.1 verification record

The M2.1 author records actual results in the delivery report; this checklist names the required
commands without pre-claiming success. It listed `npm run agent:pre-pr` when it was written; ADR-0145
has since retired that aggregate wrapper by owner decision, so the individual minimum-loop commands
it used to chain are named directly, per AGENTS.md section 3:

- [ ] `npm run check:adr-index`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm test`
- [ ] `npm run arch:check`
- [ ] `npm run arch:check:negative`
- [ ] `npm run check:knowledge-m2-closeout`
- [ ] `npm run check:retrieval-quality`
- [ ] `npm run check:grounded-retrieval-quality`
- [ ] `npm run check:grounded-faithfulness`

`check:package-surface` is not applicable to M2.1 because it changes no package export. No
`perf:evidence:regen` is required because the M2.1 diff is documentation-only.
