# Connected-folder chat retrieval delivery plan — #3881

This is an implementation plan, not closeout evidence. It was revalidated against `dev` at
`3d46ff9aca669c349bf0528a2a356ba95991099a` on 2026-10-09. Issue line references from
`b6bbe5a95` must be resolved again before each child is implemented. No acceptance criterion,
local gate, required GitHub check, or customer reproduction is claimed complete here.

## Accepted decisions and delivery boundaries

The owner accepted one bounded server-owned follow-up pass for #3889 with the normal-installation
default **on**, recorded in the [owner decision](https://github.com/oscharko-dev/Keiko/issues/3889#issuecomment-6076008027).
Only admitted, unread, in-scope declarations may trigger the pass; the original authority and
remaining search, byte, token, elapsed, and spend budgets still apply. Cancellation propagates and
there is never a third pass. Citation repair and follow-up answer generation share a maximum of
two application-level model-call slots per turn, including the initial answer; consuming the second
slot for one leaves no slot for the other. Models do not receive workspace tools.

All children meet on one integration branch through child-branch merges. One non-draft pull
request targets `dev`, with native auto-merge **off**; the owner integrates it. Agents commit and
push their assigned branches regularly, at least every ten minutes where work has changed. Before
each push, run the applicable local gates and `npm run gates:sonar`; report unavailable gates
truthfully. Review conversations receive a fix reference or evidenced refutation before resolution.
Never push to `dev`, force-push, weaken a gate, widen authority, or publish private support artifacts.

## Current-code corrections

- The proposed fixture has **five** `validation.ts` files: three factories, the addressed feature,
  and another-feature decoy. Basename discovery must preserve all five eligible matches.
- The lexical gate exercises workspace search, whereas explicit admission, continuity and excerpt
  packing are composed by the server. Cases that assert these outcomes need the existing grounded
  orchestration harness alongside the lexical cases. A script must call the production continuity
  entry point; it must not copy its algorithm or assert a server outcome from lexical search alone.
- Keep existing semantic and scope-context vocabularies. Current semantic disposition values
  include `used`, `unavailable` and `rejected`; scope-context states include `applied`, `overflow`,
  `gate-refused` and `incomplete-traversal`. UI prose maps canonical values to localized language
  instead of introducing a competing runtime glossary.
- `usage.filesRead` counts assembled files. Only the prompt fitter can report `filesInPrompt`.
  Existing evidence-manifest file entries describe assembled reads; a table must state that
  precisely unless prompt membership is supplied by the owning producer.
- The existing `fetchEvidenceManifest` helper already serves the file inspection panel through the
  loopback host/origin-restricted evidence read endpoint. Its manifest exposes permitted
  scope-relative metadata, while the answer summary remains path-free. Prose links default to
  unread until trusted evidence establishes their read state.

## Sequence and exclusive ownership

Lane C opens with #3882. Lane A follows the epic's dependency order: #3883 → #3886 → #3885 →
#3887 → #3884 → #3888 → #3889 → #3892. Lane B implements #3890 → #3891 after the failing-first
fixture baseline is integrated. Lane C closes with #3893, then #3894.

| Owner lane               | Exclusive write scope and coordination                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: runtime               | One child at a time owns `grounded-orchestrator.ts`, planner/ranking changes, admission, prompt assembly, contracts, server diagnostic projection and runtime tests.        |
| B: UI                    | One child at a time owns scope/evidence UI, associated tests, i18n catalogs and updater evidence. Shared diagnostics and contract changes are agreed with A before editing. |
| C: gates and analyzer    | Owns retrieval fixtures first, then analyzer/scenario/operator documentation after runtime integration.                                                                     |
| Integration and delivery | Owns merges, PR body and review settlement, board/issue state, final complete local matrix and exact-head required checks.                                                  |

The UI uses isolated child branches and merges complete code/test/doc packages into the integration
branch. No two agents edit a shared file simultaneously. Catalog generation has one assigned owner
after registrations are integrated; generated files are never hand-edited. Heavy coverage, browser
evidence and Sonar runs are coordinated so they do not share build trees, fixed ports or writers.

## Acceptance and verification map

The issue acceptance criteria remain authoritative. This map identifies their production owner and
the proof needed before a checkbox can be updated. Regression assertions must fail against the
pre-fix producer and pass after the change; budgets and existing incident pins stay intact.

| Child | Acceptance boundary and failing-first proof                                                                                                                                                                                                                                                                  | Additional verification                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #3882 | Synthetic trace, explicit path, basename collision, assistant referent, orientation follow-up and floor-outlier cases; language twins; ignore control; production history seam; injected basename regression; complete Activity Log scenario. Record actual red results without expected-failure skips.      | Retrieval and grounded retrieval gates; unchanged budgets; baseline document; Activity Log gate.                                                                  |
| #3883 | One admission path protects explicit files through both floors, includes hinted lines and all five basename matches. Hostile, missing, ignored, generated, binary, oversized and unsupported inputs fail closed without reads or path-bearing logs.                                                          | Admission/excerpt/floor tests; retrieval case (a); scenario projection; unchanged latency gates; ADR-0022 amendment.                                              |
| #3886 | Trace frames, paired source and assertion line win; external frames cannot consume user anchors; mixed-case pairing; genuine metadata/route lookups remain valid; German/English follow-up intent does not become overview.                                                                                  | Planner, intent, pairing and orchestration negatives; retrieval cases (c)/(e); complete closed intent vocabulary.                                                 |
| #3885 | Exact path and segment affinity beat shallow basename-only candidates; addressed collisions retain order; deterministic tie-break; exact-path bucket is implemented or removed with evidence.                                                                                                                | Producer-derived weight invariant; filter and dedup regression pins; case (b); unchanged retrieval latency gates.                                                 |
| #3887 | Derived absolute floor and robust relative reference preserve genuine hits; low-confidence fallback is visible; reranking precedes the cut and failure cannot claim application.                                                                                                                             | Outlier/depth/reranker controls; case (f); prompt/wire caveat; non-tautology probes; ADR-0022 and latency evidence.                                               |
| #3884 | Last-assistant paths/declarations resolve the next follow-up, bounded and scoped. Different explicit targets and unrelated questions ignore referents; previous-user behavior stays green.                                                                                                                   | German/English case (d); cross-chat/stale/read referent negatives; count-only continuity evidence.                                                                |
| #3888 | Answer/refusal/clarification/insufficiency classification; validated declarations; one bounded marker-only citation repair; separate memory warning; consistent single/multi/hybrid assembly.                                                                                                                | Faithfulness cases and injected regression; prose-changing repair rejection; existing pins; capability observation and Activity Log projection.                   |
| #3889 | Owner decision and indexed ADR precede code. One remaining-budget pass answers admissible declarations, refuses elapsed/spend/budget/denied inputs, buffers first-pass output and propagates abort.                                                                                                          | Scripted-model call-count pin; never a third pass; distinct follow-up latency scenario; scenario timeline.                                                        |
| #3890 | Root/directory/files fixtures render agreeing pill, edge and boundary. Canonical acknowledged scope wins over pending Files config; file previews announce changes, and keep-folder preserves the folder. Help is visible; validated missing-file action updates scope and prefills/focuses without sending. | Localized labels; live-region/focus/axe tests; preview/pin smoke journey; UI plus server read proof; editor and updater evidence; registered client scope notice. |
| #3891 | Prompt-reaching, ranking and eligibility counters derive from one contracts grouping helper. Read/omission tables use the existing loopback host/origin-restricted endpoint; fetch failure, three prose-link states, four degradation states, one citation warning and distinct memory/capability copy.      | Counter/manifest/link/accessibility controls; typed additive wire tests; inspection and prose activation evidence; UI coverage; regenerated updater evidence.     |
| #3892 | Observed bounded Git status gives admitted edited files recency; non-Git scopes spawn no process. Stale semantic files retain lexical candidates; optional refresh respects the remaining budget; runner failure is diagnostic and retrieval survives.                                                       | Git runner/non-Git/ignore/fingerprint/budget tests; measured status-call latency; Activity Log proof.                                                             |
| #3893 | Validated analyzer projection emits closed retrieval-miss reasons for recorded pre-fix replay and none for post-fix/healthy controls. The full scenario reaches a complete report; operator troubleshooting and contract descriptions converge.                                                              | Analyzer/scenario tests; complete Activity Log gate; targeted Markdown links; AGENTS.md/CONTRIBUTING.md parity.                                                   |
| #3894 | Full matrix on the integrated head; lab trace → follow-up → explicit path → basename flow with a model emitting no markers; healthy control; ADR/docs/release-impact convergence.                                                                                                                            | Required GitHub checks on current head; final body-free closeout only after the integration branch is green.                                                      |

## Reuse and UI contract handoff

Explicit admission extends selected-file injection and the existing scope/realpath/deny/ignore
checks. Continuity extends `grounded-conversation-continuity.ts`. Diagnostics reuse
`parseFailureEvidence` and test-source pairing. Ranking extends the current scoring/signals/filter
and workspace policy. Prompt and citation changes extend shared faithfulness and the existing
Knowledge Pod repair pattern. No second reader, parser, conversation store, scorer, evidence store,
retrieval spine or logging system is introduced.

Scope UI extends `ConnectedScopePill`, `connectionUtils`, `ConnectionsLayer`, `filesVisibleScope`
and AppShell's canonical acknowledged rebind flow. Preserve the existing fingerprint ownership,
alias, stale-acknowledgement and ambiguous restoration tests. A keep-folder preference belongs to
the existing browser workspace state under [ADR-0027](../adr/ADR-0027-workspace-state-ownership.md);
it cannot create server authority or select a broader root implicitly.

Evidence UI extends `GroundedAnswer`, `SafeMarkdown` and `repositoryReferences`. The existing
repository reference component already handles governed root choice, focus, activation correlation
and closed outcomes; prose links supply that same activation metadata. Extract small components
instead of growing suppressed functions, prune resolved suppressions, and use component CSS.
`globals.css` remains behind its existing visual-proof boundary.

The runtime-to-UI handoff provides additive typed fields for `answerKind`, validated in-scope
insufficiency declarations, `citationBehaviour`, `selectionConfidence`, canonical semantic/reranker/
scope-context dispositions and exact `filesInPrompt`. One pure contracts helper groups
`low-relevance`, `budget-exhausted` and `near-duplicate` as ranking omissions and all other existing
reasons as eligibility omissions. The analyzer shares that helper. Raw paths are carried only on
already-authorized declaration/manifest surfaces, never in the path-free summary or Activity Log.

New client scope notices and evidence inspections use `reportClientDiagnostic` with closed reasons,
counts and correlation. Runtime owns typed diagnostic wire validation and registered server
projection. Fetch failures carry closed `errorKind` and structured frames. The generated catalog
and a complete support-analyze scenario prove retention and projection.

## Gate and evidence prerequisites

Every change runs the applicable [AGENTS.md minimum loop](../../AGENTS.md) and
`npm run gates:sonar`. Runtime logging changes additionally regenerate the catalog and run
`npm run check:activity-log`, which proves the complete registered inventory. Package export changes
require the assembled surface gate; run it last because it prunes live dependencies.

UI packages run their own typecheck/lint, `test:coverage:ui`, `check:ui-i18n` and
`check:editor-release-evidence`. The scope smoke spec uses the existing Chromium smoke lane and must
pass `check:e2e-suite-wiring` after packages are built. Preserve focus when controls disappear,
announce only genuine scope changes, coalesce navigation bursts, and qualify English/German and
compact layouts with zero axe violations. Visible-state screenshots establish the scope notice,
inspection tables and link distinctions without customer data.

Both i18n catalogs are updater-evidence inputs. After their final changes, one owner runs
`KEIKO_WRITE_TRACKED_EVIDENCE=1 npm run test:e2e:update-ui-1696`, then
`npm run check:update-ui-evidence`, and updates the actual provenance in the
[existing evidence README](../design-system/evidence/3405/README.md). The suite owns its configured
port and build tree; do not run competing browser producers. UI changes do not require D12 timing
regeneration unless the measurement toolchain changes.

The final matrix and lab reproduction are defined by #3894. Local evidence records actual commands,
head/tree identity and platform limitations. Required CI is the full final arbiter. Do not write
`connected-chat-retrieval-closeout.md` or publish closeout evidence while the integration branch is
red. Child issues remain open until the owner merges, review findings settle and closure evidence
exists. Record any proven gaps in multi-source reranking, hybrid insufficiency or Knowledge Pod
parity as explicit follow-ups; never disguise them as completed acceptance.
