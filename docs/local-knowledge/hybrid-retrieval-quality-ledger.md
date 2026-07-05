# Epic #1817 Hybrid Retrieval Quality Acceptance Ledger

Status: live coordination ledger for Epic
[#1817](https://github.com/oscharko-dev/Keiko/issues/1817) and child issues
[#1837](https://github.com/oscharko-dev/Keiko/issues/1837),
[#1838](https://github.com/oscharko-dev/Keiko/issues/1838),
[#1839](https://github.com/oscharko-dev/Keiko/issues/1839),
[#1840](https://github.com/oscharko-dev/Keiko/issues/1840),
[#1841](https://github.com/oscharko-dev/Keiko/issues/1841), and
[#1842](https://github.com/oscharko-dev/Keiko/issues/1842).

This file is the working acceptance ledger requested by the Goal Mode contract. It maps
implementation-relevant epic and child issue criteria to the evidence required before any GitHub
checkbox can be updated. It intentionally contains only synthetic, redacted, body-safe evidence:
counts, fixture ids, gate names, issue numbers, and source file names.

Fetched source-of-truth state on 2026-07-05:

- Epic #1817 was fetched from GitHub and is open.
- GitHub sub-issues and the epic body agree on this order: #1837, #1838, #1839, #1840, #1841,
  #1842.
- All six child issues were fetched from GitHub and are open.
- Existing implementation PR:
  [#1908](https://github.com/oscharko-dev/Keiko/pull/1908), targeting `dev`.
- Active PR branch: `codex/epic-1817-hybrid-retrieval`.

Ledger status vocabulary:

- `planned`: required and not implemented yet.
- `in progress`: actively being inspected or implemented.
- `implemented`: code or docs are present, but verification or GitHub evidence is incomplete.
- `verified`: tests, gates, or documented review prove the row.
- `checked`: GitHub issue checkbox or board field is updated with evidence.
- `not applicable`: explicitly outside this issue after evidence-backed review.
- `blocked`: cannot proceed without maintainer input or external state change.

## Epic #1817 Ledger

| Source | Section                                       | Exact criterion text                                                                                                                                                                                                | Classification          | Evidence required                                                                                  | Current evidence                                                                                                | Planned implementation or test                                                                             | Owner agent                 | Status      |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------- | ----------- |
| #1817  | Target Outcome                                | Lexical retrieval is stronger for exact terms, phrase-like queries, identifiers, ADR references, policy clauses, API names, and error strings.                                                                      | implementation/quality  | Exact technical fixtures, low-level lexical tests, and retrieval quality gate output.              | Existing Local Knowledge path already has SQLite FTS/BM25, exact-term fallback, and lexical normalization.      | Add exact technical fixtures and hostile-input lexical regression coverage in the existing retrieval path. | Codex                       | in progress |
| #1817  | Target Outcome                                | Vector retrieval remains effective for semantic, multilingual, and natural-language questions.                                                                                                                      | implementation/quality  | Semantic and multilingual fixtures with scorecards meeting thresholds.                             | Existing scripted eval harness supports deterministic vector-topic fixtures.                                    | Add semantic paraphrase and multilingual fixtures to the Local Knowledge eval suite.                       | Codex                       | planned     |
| #1817  | Target Outcome                                | Hybrid RRF behavior is calibrated through candidate budgets and retrieval modes such as broad, exact, and balanced strategies.                                                                                      | implementation/quality  | Strategy-specific fixtures/tests and budget rationale that preserves ADR-0036 RRF.                 | Existing profiles implement exact, broad, and balanced oversampling with RRF k=60.                              | Expose selected strategy in safe diagnostics and pin strategy behavior in tests/docs.                      | Codex                       | in progress |
| #1817  | Target Outcome                                | Retrieval diagnostics make it clear which retrieval legs contributed candidates and how evidence was selected.                                                                                                      | implementation/evidence | Diagnostics include strategy and per-leg/fused counts without raw content.                         | Diagnostics already report mode and candidate counts.                                                           | Add selected strategy to diagnostics; preserve count-only, body-free output.                               | Codex                       | in progress |
| #1817  | Target Outcome                                | Quality improvements are backed by deterministic fixtures and release evidence rather than subjective prompt tuning.                                                                                                | verification/evidence   | Retrieval quality gate executes Local Knowledge fixtures and release evidence records gate output. | Existing `runRetrievalEval` and report renderer are deterministic but not wired into `check:retrieval-quality`. | Wire Local Knowledge scorecards into the retrieval-quality gate and ledger evidence.                       | Codex                       | planned     |
| #1817  | Child Issues                                  | #1837 Task: Audit current hybrid retrieval behavior and quality gaps - acceptance criteria and expected verification checkboxes must be checked only after implementation evidence exists.                          | workflow/evidence       | #1837 deliverables, acceptance, verification, issue comment, and checkboxes updated.               | Live issue fetched; audit row map started here.                                                                 | Complete audit section and evidence-backed updates after gates.                                            | Codex                       | in progress |
| #1817  | Child Issues                                  | #1838 Task: Improve SQLite FTS/BM25 exact and phrase retrieval for Knowledge Pods - acceptance criteria and expected verification checkboxes must be checked only after implementation evidence exists.             | workflow/evidence       | #1838 exact lexical fixtures/tests and verification.                                               | Existing FTS/BM25 path inspected.                                                                               | Add exact-query fixtures and hostile-input regression.                                                     | Codex                       | planned     |
| #1817  | Child Issues                                  | #1839 Task: Calibrate hybrid retrieval candidate budgets and RRF diagnostics - acceptance criteria and expected verification checkboxes must be checked only after implementation evidence exists.                  | workflow/evidence       | #1839 budget diagnostics, fixture evidence, and ADR-0036 rationale.                                | Existing oversampling and RRF code inspected.                                                                   | Record safe diagnostics and budget rationale; run gates.                                                   | Codex                       | planned     |
| #1817  | Child Issues                                  | #1840 Task: Tune broad, exact, and balanced Knowledge Pod retrieval strategies - acceptance criteria and expected verification checkboxes must be checked only after implementation evidence exists.                | workflow/evidence       | #1840 strategy semantics, tests, and fixture evidence.                                             | Existing strategy resolver and profiles inspected.                                                              | Pass strategy through eval harness and expose selected strategy in diagnostics.                            | Codex                       | planned     |
| #1817  | Child Issues                                  | #1841 Task: Expand retrieval quality fixtures for exact, semantic, and multilingual workloads - acceptance criteria and expected verification checkboxes must be checked only after implementation evidence exists. | workflow/evidence       | #1841 fixture taxonomy and deterministic gate results.                                             | Existing fixtures inspected.                                                                                    | Add exact, semantic, multilingual, and mixed strategy fixtures.                                            | Codex                       | planned     |
| #1817  | Child Issues                                  | #1842 Task: Produce hybrid retrieval release evidence and operating guidance - acceptance criteria and expected verification checkboxes must be checked only after implementation evidence exists.                  | workflow/evidence       | #1842 evidence summary, gate matrix, known limitations, and guidance.                              | This ledger is initial evidence, not release evidence.                                                          | Add final evidence and operating guidance after verification.                                              | Codex                       | planned     |
| #1817  | Definition of Done                            | Hybrid retrieval quality improves against committed fixtures without reducing sealed/local policy guarantees.                                                                                                       | verification/security   | Scorecards pass; scoping/security tests pass; no hosted service or duplicate path.                 | Existing scoping tests cover capsule isolation.                                                                 | Expand fixtures and run local gates.                                                                       | Codex                       | planned     |
| #1817  | Definition of Done                            | Exact technical queries and semantic questions both have coverage in quality gates.                                                                                                                                 | verification            | `check:retrieval-quality` includes exact and semantic Local Knowledge scorecards.                  | Workspace retrieval gate exists; Local Knowledge scorecards are separate.                                       | Wire Local Knowledge scorecards into the gate.                                                             | Codex                       | planned     |
| #1817  | Definition of Done                            | Diagnostics can explain lexical, vector, and fused candidate participation without leaking private content.                                                                                                         | implementation/security | Diagnostics tests and security review show only enums/counts are emitted.                          | Diagnostics are count-only today.                                                                               | Add `strategy` enum and hostile-input leakage regression.                                                  | Codex                       | in progress |
| #1817  | Definition of Done                            | ADR-0036 behavior is preserved or intentionally updated through the ADR process.                                                                                                                                    | architecture            | Code keeps RRF k=60 and no direct raw score mixing; `arch:check` passes.                           | ADR-0036 read; no ADR conflict found.                                                                           | Preserve RRF and document alignment.                                                                       | Codex                       | in progress |
| #1817  | Definition of Done                            | The implementation remains scoped to the existing Local Knowledge retrieval path.                                                                                                                                   | architecture            | Reuse map, file diff, and architecture gates show no parallel subsystem.                           | Existing `runLocalKnowledgeRetrieval`, FTS/BM25, vector, and RRF path inspected.                                | Extend existing diagnostics, fixtures, and gate script only.                                               | Codex                       | in progress |
| #1817  | Definition of Done                            | Release evidence clearly states what improved, what remains limited, and how regressions are detected.                                                                                                              | evidence/docs           | Final evidence section with gate matrix, fixture taxonomy, limitations, and commands.              | Not written yet.                                                                                                | Update this document after final verification.                                                             | Codex                       | planned     |
| #1817  | Expected Verification                         | Expected verification includes `typecheck`, `lint`, `format:check`, `arch:check`, `arch:check:negative`, and `npm test` for touched packages.                                                                       | verification            | Commands run after latest changes with outcomes recorded.                                          | Targeted baseline tests passed before edits.                                                                    | Run the minimum loop after implementation.                                                                 | Codex                       | planned     |
| #1817  | Expected Verification                         | Retrieval work should also run retrieval quality gates, grounded retrieval quality, grounded faithfulness, and any release-evidence checks that validate retrieval behavior.                                        | verification            | Retrieval/RAG gates run after latest changes with outcomes recorded.                               | Not run for final diff yet.                                                                                     | Run `check:retrieval-quality`, `check:grounded-retrieval-quality`, and `check:grounded-faithfulness`.      | Codex                       | planned     |
| #1817  | Review Settlement and Formal Issue Completion | Closure should include the final quality scorecard and remaining known retrieval limitations.                                                                                                                       | human-owned/evidence    | PR, issue evidence comments, and maintainer review.                                                | No PR yet.                                                                                                      | Add release evidence and leave post-merge closure human-owned.                                             | Codex plus human maintainer | planned     |

## Shared Child-Issue Ledger

These exact checklist criteria appear in every child issue #1837-#1842 unless a row names a subset.

| Source      | Section                                       | Exact criterion text                                                                                                                                                                                                            | Classification                   | Evidence required                                                   | Current evidence                                                                                          | Planned implementation or test                                                        | Owner agent      | Status         |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------- | -------------- |
| #1837-#1842 | Existing Capability Review                    | Existing Keiko packages, UI surfaces, server routes, contracts, validation helpers, evidence models, memory/local-knowledge graph patterns, workflow state, and tool/workspace boundaries were inspected before implementation. | architecture                     | Read-first code map and reuse decision.                             | `keiko-local-knowledge`, evaluation harness, retrieval gates, ADR-0036, ADR-0034, and ADR-0022 inspected. | Record reuse map here and in PR.                                                      | Codex            | in progress    |
| #1837-#1842 | Existing Capability Review                    | The issue identifies what will be reused, extended, generalized, or left untouched.                                                                                                                                             | architecture                     | Reuse section in this ledger and PR.                                | Initial reuse map below.                                                                                  | Keep changes to existing retrieval, fixtures, and gates.                              | Codex            | in progress    |
| #1837-#1842 | Existing Capability Review                    | Any new implementation is justified as a real capability gap, not a parallel implementation of existing behavior.                                                                                                               | architecture                     | Gap rationale tied to exact files.                                  | Gaps are diagnostic strategy visibility, fixture taxonomy, and gate integration.                          | Do not add a search service, second pipeline, or provider SDK path.                   | Codex            | in progress    |
| #1837-#1842 | Existing Capability Review                    | Refactoring or consolidation was considered when existing functionality is close but not yet shaped for this issue.                                                                                                             | architecture                     | PR reuse/no-duplication evidence.                                   | Existing retrieval implementation is close; extension is preferred.                                       | Pass strategy through existing types and runner instead of creating a second harness. | Codex            | in progress    |
| #1837-#1842 | Epic And Board Placement                      | The parent epic remains `Classification: Epic`, `Status: Open Epics`, and positioned in the board's top-to-bottom implementation order.                                                                                         | project workflow                 | ProjectV2 snapshot or issue comment.                                | GitHub fetch shows #1817 status `Open Epics`.                                                             | Update/confirm before PR handoff if permissions allow.                                | Codex            | planned        |
| #1837-#1842 | Epic And Board Placement                      | Card Chat or conversation-card work uses this same parent/sub-issue and board placement flow; do not create loose chat/card issues outside an epic swimlane.                                                                    | not applicable/workflow          | Scope review.                                                       | This epic does not change Card Chat or conversation-card issue creation.                                  | Leave unchecked unless maintainer wants workflow evidence.                            | Codex            | not applicable |
| #1837-#1842 | Delivery Board Workflow                       | Keep `Workflow State` current: `New`, `Triaged`, `In Progress`, `PR Open`, `Ready for Human Review`, `Blocked`, `Waiting for User`, or `Done`.                                                                                  | project workflow                 | ProjectV2 field updates.                                            | Current fetched status is triaged/open.                                                                   | Update as work progresses, if project permissions allow.                              | Codex            | planned        |
| #1837-#1842 | Delivery Board Workflow                       | When an agent starts work, set the issue label to `status: in progress`, set project `Status` and `Workflow State` to `In Progress`, and fill `Owner / Agent`.                                                                  | project workflow                 | Label and project field snapshots.                                  | Not updated yet in this context.                                                                          | Update before final handoff if permissions allow.                                     | Codex            | planned        |
| #1837-#1842 | Delivery Board Workflow                       | When implementation starts, fill the `Branch` field with the active branch name.                                                                                                                                                | project workflow                 | Project branch field.                                               | Active branch is `codex/epic-1817-hybrid-retrieval`.                                                      | Update before final handoff if permissions allow.                                     | Codex            | planned        |
| #1837-#1842 | Delivery Board Workflow                       | When a PR is opened, set `Workflow State` to `PR Open`, fill `Pull Request`, and keep `Human Review Required` set to `Yes`.                                                                                                     | project workflow                 | PR URL and project field snapshot.                                  | No PR yet.                                                                                                | Update after PR creation.                                                             | Codex            | planned        |
| #1837-#1842 | Delivery Board Workflow                       | When the PR is ready for maintainer review, set `Workflow State` to `Ready for Human Review` and replace the issue label with `status: ready for human review`.                                                                 | project workflow                 | Green PR checks and field/label snapshot.                           | No PR yet.                                                                                                | Update after required checks are green.                                               | Codex            | planned        |
| #1837-#1842 | Delivery Board Workflow                       | Do not mark `Done` until the PR is merged, closure evidence exists, the issue is closed, and project `Status` is set to `Done`.                                                                                                 | human-owned/post-merge           | Issues remain open and not `Done`.                                  | Issues are open.                                                                                          | Leave post-merge closure to human maintainer.                                         | Human maintainer | planned        |
| #1837-#1842 | Expected Verification                         | Required GitHub check: `ci`.                                                                                                                                                                                                    | verification/CI                  | Final PR check status.                                              | No PR yet.                                                                                                | Open PR and monitor checks after local gates.                                         | Codex            | planned        |
| #1837-#1842 | Expected Verification                         | Reuse/extension/generalization evidence or gap rationale is documented in the issue or linked PR.                                                                                                                               | architecture/evidence            | This ledger, PR reuse section, issue comments.                      | This ledger records initial reuse/gap rationale.                                                          | Update after implementation.                                                          | Codex            | in progress    |
| #1837-#1842 | Expected Verification                         | Core local gates are run as relevant: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run arch:check`, and `npm run arch:check:negative`.                                                         | verification                     | Command outcomes after latest changes.                              | Baseline targeted test passed before edits.                                                               | Run full relevant local gates before PR.                                              | Codex            | planned        |
| #1837-#1842 | Expected Verification                         | Retrieval/RAG changes run relevant gates: `check:retrieval-quality`, `check:grounded-retrieval-quality`, and `check:grounded-faithfulness`.                                                                                     | verification                     | Command outcomes after latest changes.                              | Not run for final diff yet.                                                                               | Run all three retrieval gates.                                                        | Codex            | planned        |
| #1837-#1842 | Expected Verification                         | UI changes run keiko-ui typecheck/lint, UI coverage, accessibility, and editor release-evidence gates where applicable.                                                                                                         | not applicable unless UI changes | UI gate output or scoped rationale.                                 | No UI changes planned.                                                                                    | Mark not applicable if final diff remains non-UI.                                     | Codex            | planned        |
| #1837-#1842 | Expected Verification                         | Documentation changes run format and Markdown/link checks where applicable.                                                                                                                                                     | verification/docs                | `format:check` and nearest docs/link checks if available.           | Docs are changed by this ledger.                                                                          | Run `format:check`; run docs/link gate if applicable.                                 | Codex            | planned        |
| #1837-#1842 | Expected Verification                         | Security review when trust boundaries, auth/session, secrets, CSP, model access, execution, patch application, external calls, or evidence redaction changes.                                                                   | security review                  | Written redaction/trust-boundary disposition.                       | Evidence and diagnostics are affected; no secrets or external calls added.                                | Record security review after tests.                                                   | Codex            | planned        |
| #1837-#1842 | Expected Verification                         | Qodana/static-analysis review when security-sensitive or shared control-plane code changes.                                                                                                                                     | verification/security            | Static-analysis command or scoped rationale.                        | Retrieval diagnostics/eval only; no shared control plane expected.                                        | Decide after final diff and record.                                                   | Codex            | planned        |
| #1837-#1842 | Review Settlement and Formal Issue Completion | The implementation PR waits for required GitHub checks before merge.                                                                                                                                                            | workflow/CI                      | PR check status.                                                    | No PR yet.                                                                                                | Monitor CI after PR.                                                                  | Codex            | planned        |
| #1837-#1842 | Review Settlement and Formal Issue Completion | All actionable review findings are fixed or explicitly dispositioned in the PR before merge.                                                                                                                                    | workflow/review                  | Review thread disposition.                                          | No PR yet.                                                                                                | Address review findings if any.                                                       | Codex            | planned        |
| #1837-#1842 | Review Settlement and Formal Issue Completion | Acceptance Criteria and Expected Verification checkboxes are updated only when evidence exists.                                                                                                                                 | workflow/evidence                | Issue body updates after gates.                                     | Checkboxes remain unchecked.                                                                              | Update only after proof exists.                                                       | Codex            | planned        |
| #1837-#1842 | Review Settlement and Formal Issue Completion | Delivery board fields are updated before handoff, including `Owner / Agent`, `Branch`, `Pull Request`, and `Human Review Required`.                                                                                             | project workflow                 | ProjectV2 field snapshots.                                          | No PR yet.                                                                                                | Update before final handoff if permissions allow.                                     | Codex            | planned        |
| #1837-#1842 | Review Settlement and Formal Issue Completion | Required documentation, PR evidence, issue comments, migration notes, screenshots, logs, or follow-up issues are completed when requested by this issue.                                                                        | evidence/docs                    | This ledger, issue comments, PR body, and follow-up URLs if needed. | Ledger started.                                                                                           | Finish release evidence after verification.                                           | Codex            | planned        |
| #1837-#1842 | Review Settlement and Formal Issue Completion | The issue remains open until implementation is merged, review findings are settled, and closure evidence is recorded.                                                                                                           | human-owned/post-merge           | Issues remain open.                                                 | Issues are open.                                                                                          | Do not close issues.                                                                  | Human maintainer | planned        |

## Child-Specific Implementation Ledger

| Source | Section             | Exact criterion text                                                                                      | Classification            | Evidence required                                                       | Current evidence                                                                                             | Planned implementation or test                                        | Owner agent      | Status      |
| ------ | ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------- | ----------- |
| #1837  | Deliverables        | Current-state audit of lexical, vector, hybrid, RRF, diagnostics, and evidence behavior.                  | audit/evidence            | Read-first map with file references.                                    | Existing implementation inspected in `scoped-vector-search.ts`, `types.ts`, `fixtures.ts`, and gate scripts. | Finalize audit summary below.                                         | Codex            | in progress |
| #1837  | Deliverables        | Inventory of quality gates and fixture coverage.                                                          | audit/evidence            | Gate and fixture inventory in this document.                            | Existing gates and fixtures inspected.                                                                       | Update after gate integration.                                        | Codex            | in progress |
| #1837  | Deliverables        | Prioritized quality-gap list mapped to remaining child issues.                                            | audit/evidence            | Gap list tied to #1838-#1842.                                           | Gap list drafted below.                                                                                      | Complete before issue updates.                                        | Codex            | in progress |
| #1837  | Deliverables        | Reuse decision record proving the existing retrieval pipeline remains the base.                           | architecture              | Reuse map and final diff.                                               | Existing pipeline selected as base.                                                                          | Preserve existing entry point.                                        | Codex            | in progress |
| #1837  | Acceptance Criteria | The audit identifies existing functions, packages, tests, and diagnostics that own hybrid retrieval.      | audit/evidence            | File/function inventory.                                                | Initial map below.                                                                                           | Complete after final diff.                                            | Codex            | in progress |
| #1837  | Acceptance Criteria | Quality gaps are measurable scenarios, not vague ranking concerns.                                        | verification              | Fixture ids and scorecards.                                             | Gaps mapped to exact, semantic, multilingual, and strategy fixture scenarios.                                | Add fixtures and gate output.                                         | Codex            | planned     |
| #1837  | Acceptance Criteria | Lexical, vector, fusion, budget, and evaluation gaps are distinguished.                                   | audit/evidence            | Gap taxonomy.                                                           | Initial taxonomy below.                                                                                      | Update with final evidence.                                           | Codex            | planned     |
| #1837  | Acceptance Criteria | No second retrieval pipeline or managed service is proposed.                                              | architecture              | Diff and architecture checks.                                           | No new service or pipeline planned.                                                                          | Keep implementation scoped.                                           | Codex            | in progress |
| #1837  | Acceptance Criteria | Next child issues can proceed with baseline evidence and target scenarios.                                | workflow/evidence         | This ledger and baseline test output.                                   | Targeted baseline tests passed before edits.                                                                 | Record final baseline/after evidence.                                 | Codex            | planned     |
| #1838  | Deliverables        | Lexical retrieval improvements in existing FTS/BM25 path.                                                 | implementation            | Regression coverage for exact lexical behavior and safe query handling. | Existing FTS/BM25 and exact fallback already present.                                                        | Add exact fixtures and hostile-input test without replacing FTS/BM25. | Codex            | planned     |
| #1838  | Deliverables        | Fixtures for exact terms, phrases, IDs, API names, policy clauses, and error strings.                     | verification              | New fixture taxonomy and passing scorecards.                            | Missing as first-class eval fixtures.                                                                        | Add exact technical fixture with synthetic safe content.              | Codex            | planned     |
| #1838  | Deliverables        | Diagnostics updates for lexical candidate participation if needed.                                        | implementation/evidence   | Diagnostics include safe lexical count and strategy.                    | Lexical count exists.                                                                                        | Add selected strategy to diagnostics.                                 | Codex            | planned     |
| #1838  | Deliverables        | Performance notes if query construction changes materially.                                               | performance/evidence      | Rationale notes.                                                        | No material SQL shape change planned.                                                                        | Record no material query-construction change unless diff changes.     | Codex            | planned     |
| #1838  | Acceptance Criteria | Exact technical-query fixtures improve or remain stable without degrading semantic fixtures.              | verification              | Scorecards before/after and gate output.                                | Baseline targeted tests passed.                                                                              | Run updated fixture suite and retrieval gates.                        | Codex            | planned     |
| #1838  | Acceptance Criteria | Malformed and hostile inputs do not cause SQL injection, crashes, or raw diagnostic leakage.              | security/verification     | Hostile-input low-level test.                                           | Current query builder parameterizes SQLite and catches FTS errors.                                           | Add regression test for hostile exact/FTS input and diagnostics.      | Codex            | planned     |
| #1838  | Acceptance Criteria | The implementation remains scoped to existing SQLite FTS/BM25 index.                                      | architecture              | Diff and no new search backend.                                         | Plan uses existing index.                                                                                    | Verify final diff.                                                    | Codex            | planned     |
| #1838  | Acceptance Criteria | Capsule-scoped retrieval remains enforced.                                                                | security/verification     | Existing and updated scoping tests pass.                                | Existing scoped tests cover capsule isolation.                                                               | Run targeted retrieval tests.                                         | Codex            | planned     |
| #1838  | Acceptance Criteria | Quality evidence records before/after behavior for targeted lexical scenarios.                            | evidence                  | Gate output and ledger verification log.                                | Baseline targeted tests passed before edits.                                                                 | Record final fixture scorecards.                                      | Codex            | planned     |
| #1839  | Deliverables        | Calibrated candidate budget behavior for lexical, vector, and fused sets.                                 | implementation/evidence   | Tests and rationale for strategy profile budgets.                       | Existing exact/broad/balanced budgets inspected.                                                             | Document budget choices and run tests.                                | Codex            | planned     |
| #1839  | Deliverables        | Evidence-safe diagnostics for per-leg and fused participation.                                            | implementation/security   | Diagnostics type/tests show count-only fields.                          | Existing diagnostics count dense, lexical, and fused candidates.                                             | Add selected strategy; keep diagnostics body-free.                    | Codex            | planned     |
| #1839  | Deliverables        | Fixtures for budget boundaries, duplicates, and truncation.                                               | verification              | Existing and new fixture/test coverage.                                 | Existing broad diversity and oversized dense tests cover duplicates/guided/ANN behavior.                     | Record existing coverage; add strategy fixture coverage.              | Codex            | planned     |
| #1839  | Deliverables        | Rationale documenting budget choices and ADR-0036 alignment.                                              | docs/architecture         | Budget rationale in this ledger/release evidence.                       | ADR-0036 read.                                                                                               | Add final rationale below.                                            | Codex            | planned     |
| #1839  | Acceptance Criteria | Candidate budgets improve or stabilize quality against committed fixtures.                                | verification              | All shipped fixtures meet thresholds.                                   | Existing suite passes before edits.                                                                          | Run full updated eval suite.                                          | Codex            | planned     |
| #1839  | Acceptance Criteria | Diagnostics explain participation with counts and modes, not raw private content.                         | security/evidence         | Diagnostics tests and redaction review.                                 | Existing diagnostics are count/enumeration fields.                                                           | Add strategy enum tests.                                              | Codex            | planned     |
| #1839  | Acceptance Criteria | ADR-0036 RRF behavior is preserved unless an ADR update is reviewed.                                      | architecture              | RRF formula unchanged; architecture checks pass.                        | Existing RRF k=60 code inspected.                                                                            | Do not change RRF formula.                                            | Codex            | planned     |
| #1839  | Acceptance Criteria | Performance does not regress beyond accepted thresholds.                                                  | performance/verification  | Retrieval gates and targeted tests complete within normal gate budgets. | Not measured after final diff.                                                                               | Run gates; record if no material candidate increase.                  | Codex            | planned     |
| #1839  | Acceptance Criteria | Budget behavior is deterministic enough for tests and release evidence.                                   | verification              | Determinism tests over every fixture.                                   | Existing determinism tests cover subset only.                                                                | Expand determinism test to all fixtures.                              | Codex            | planned     |
| #1840  | Deliverables        | Strategy semantics for broad, exact, and balanced modes.                                                  | implementation/docs       | Strategy diagnostics and documentation.                                 | Existing strategy resolver/profiles inspected.                                                               | Expose selected strategy and document semantics.                      | Codex            | planned     |
| #1840  | Deliverables        | Implementation updates in existing retrieval option handling.                                             | implementation            | Type and runner changes pass strategy through existing options.         | Retrieval query already accepts `strategy`; eval query does not.                                             | Add eval query strategy field and pass-through.                       | Codex            | planned     |
| #1840  | Deliverables        | Fixtures for exact, semantic, and mixed questions.                                                        | verification              | New fixtures and scorecards.                                            | Existing fixtures do not cover mixed strategy explicitly.                                                    | Add exact, semantic, multilingual, and mixed strategy fixtures.       | Codex            | planned     |
| #1840  | Deliverables        | Safe diagnostics for strategy and per-leg participation.                                                  | implementation/security   | Diagnostics tests show enum/count-only fields.                          | Per-leg counts exist.                                                                                        | Add strategy enum.                                                    | Codex            | planned     |
| #1840  | Acceptance Criteria | Broad, exact, and balanced modes produce documented, measurable differences.                              | verification/docs         | Low-level tests and release evidence explain expected differences.      | Existing code has profile-specific budgets and broad query transforms.                                       | Add diagnostics tests for auto/explicit strategies.                   | Codex            | planned     |
| #1840  | Acceptance Criteria | Exact mode improves exact-match scenarios without disabling required semantic fallback unless documented. | verification              | Exact fixture passes and dense fallback tests still pass.               | Existing exact profile keeps dense path active.                                                              | Run exact and semantic fixtures.                                      | Codex            | planned     |
| #1840  | Acceptance Criteria | Broad mode preserves semantic recall and multilingual behavior where fixtures cover it.                   | verification              | Broad semantic/multilingual scorecards pass.                            | Existing broad diversity fixture passes.                                                                     | Add multilingual fixture and run gates.                               | Codex            | planned     |
| #1840  | Acceptance Criteria | Balanced mode remains the safe default unless reviewed otherwise.                                         | architecture/verification | Auto strategy diagnostic test and docs.                                 | Resolver defaults to balanced for short non-exact queries.                                                   | Pin with diagnostics test.                                            | Codex            | planned     |
| #1840  | Acceptance Criteria | No second retrieval pipeline or hidden planner is introduced.                                             | architecture              | Diff and architecture checks.                                           | No new planner planned.                                                                                      | Verify final diff.                                                    | Codex            | planned     |
| #1841  | Deliverables        | Expanded fixture taxonomy for exact, semantic, multilingual, and mixed workloads.                         | verification              | Named fixtures and registry tests.                                      | Missing as first-class taxonomy.                                                                             | Add four fixtures and registry coverage.                              | Codex            | planned     |
| #1841  | Deliverables        | Safe synthetic corpora and queries.                                                                       | security/verification     | Fixture review and tests.                                               | Existing fixtures are synthetic.                                                                             | Keep all new content synthetic, no paths/secrets/endpoints.           | Codex            | planned     |
| #1841  | Deliverables        | Expected retrieval/evidence outcomes with update guidance.                                                | verification/docs         | Fixture expected chunks and guidance.                                   | Expected outcomes exist per fixture.                                                                         | Extend docs and report output.                                        | Codex            | planned     |
| #1841  | Deliverables        | Documentation for running and interpreting gates locally.                                                 | docs                      | Operating guidance in this ledger.                                      | Not final yet.                                                                                               | Add guidance after gate wiring.                                       | Codex            | planned     |
| #1841  | Acceptance Criteria | Fixtures cover exact technical, semantic paraphrase, and multilingual scenarios at minimum.               | verification              | Fixture ids and passing scorecards.                                     | Existing suite lacks this taxonomy.                                                                          | Add fixtures and tests.                                               | Codex            | planned     |
| #1841  | Acceptance Criteria | Fixtures exercise lexical, vector, and hybrid paths where supported.                                      | verification              | Scorecards and low-level diagnostics tests.                             | Existing tests exercise all paths separately.                                                                | Combine fixture taxonomy with diagnostics tests.                      | Codex            | planned     |
| #1841  | Acceptance Criteria | No fixture uses customer data, secrets, private paths, or live endpoints.                                 | security                  | Fixture content review.                                                 | Existing fixtures are synthetic.                                                                             | Use synthetic docs and safe IDs only.                                 | Codex            | planned     |
| #1841  | Acceptance Criteria | The suite fails on known regression examples or records why not yet reproducible.                         | verification              | Mutation/sensitivity and threshold tests.                               | Existing mutation witness covers topK sensitivity.                                                           | Expand threshold/determinism tests over every shipped fixture.        | Codex            | planned     |
| #1841  | Acceptance Criteria | Gate docs tell agents which commands to run before claiming quality movement.                             | docs                      | Operating guidance and verification log.                                | Repository AGENTS already lists gates.                                                                       | Add #1817-specific gate guidance.                                     | Codex            | planned     |
| #1842  | Deliverables        | Release evidence summary for #1817.                                                                       | evidence/docs             | Final evidence summary with commands and outcomes.                      | This ledger is initial, not release evidence.                                                                | Add after gates and PR.                                               | Codex            | planned     |
| #1842  | Deliverables        | Gate outcome matrix with commands, pass/fail status, and skipped-gate rationale.                          | evidence                  | Verification log below.                                                 | Not final yet.                                                                                               | Fill after final gates.                                               | Codex            | planned     |
| #1842  | Deliverables        | Known limitations and follow-up recommendations.                                                          | evidence/docs             | Limitations section and follow-up URLs if needed.                       | Not final yet.                                                                                               | Add after implementation.                                             | Codex            | planned     |
| #1842  | Deliverables        | Operating guidance for reindexing or configuration if required.                                           | docs/operations           | Guidance section.                                                       | No persisted schema change planned.                                                                          | Record no reindex required unless final diff changes index semantics. | Codex            | planned     |
| #1842  | Acceptance Criteria | All quality claims are backed by local gate output or documented limitations.                             | evidence                  | Gate output and limitations.                                            | Not final yet.                                                                                               | Record after gates.                                                   | Codex            | planned     |
| #1842  | Acceptance Criteria | Quality deltas are reported without raw private content or sensitive diagnostics.                         | security/evidence         | Evidence contains fixture ids, counts, and metrics only.                | This ledger is body-free except synthetic fixture descriptions.                                              | Keep final evidence redacted.                                         | Codex            | planned     |
| #1842  | Acceptance Criteria | Evidence distinguishes exact, semantic, multilingual, hybrid, and strategy behavior.                      | evidence                  | Scorecard taxonomy and diagnostics tests.                               | Not final yet.                                                                                               | Add final taxonomy.                                                   | Codex            | planned     |
| #1842  | Acceptance Criteria | Parent epic #1817 is not closed until child criteria are evidence-backed.                                 | human-owned/post-merge    | Epic remains open.                                                      | Epic is open.                                                                                                | Do not close the epic.                                                | Human maintainer | planned     |
| #1842  | Acceptance Criteria | Remaining risks become follow-up issues or explicit deferrals.                                            | evidence/workflow         | Follow-up URLs or explicit no-follow-up rationale.                      | Not final yet.                                                                                               | Decide after gates and review.                                        | Codex            | planned     |

## Current Read-First Reuse Map

The implementation extends existing retrieval surfaces and avoids duplicate subsystems:

- Retrieval entry point: `runLocalKnowledgeRetrieval` and `searchVectorsForScope` remain the only
  Local Knowledge search path.
- Lexical leg: existing SQLite FTS5/BM25 tables, `chunk_lexical_index`, exact-text fallback, and
  multilingual normalization remain authoritative.
- Dense leg: existing embedding adapter boundary, vector identity checks, scoped brute-force/ANN
  paths, and guided dense rerank remain authoritative.
- Fusion: ADR-0036 RRF rank fusion remains unchanged; raw vector and lexical scores are not mixed.
- Diagnostics: existing `RetrievalDiagnostics` is extended with a closed strategy enum,
  strategy-specific candidate budgets, and query-variant counts while keeping diagnostics
  count-only and body-free.
- Evaluation: existing deterministic `runRetrievalEval` harness, fixtures, and report renderer are
  extended rather than replacing the harness.
- Gate surface: existing `check:retrieval-quality` is extended to run Local Knowledge scorecards
  alongside workspace retrieval cases.
- UI/server surfaces: left untouched unless later verification finds a contract gap.

## Prioritized Quality Gaps

1. Exact technical workload coverage is not first-class in the Local Knowledge quality gate. This
   maps to #1838 and #1841. Status: implemented by `exact-technical`.
2. Semantic paraphrase and multilingual Local Knowledge workloads are not first-class gate fixtures.
   This maps to #1840 and #1841. Status: implemented by `semantic-paraphrase` and
   `multilingual-retrieval`.
3. The selected broad/exact/balanced strategy is not visible in diagnostics, even though candidate
   counts are already safe. This maps to #1839 and #1840. Status: implemented by
   `RetrievalDiagnostics.strategy`.
4. The retrieval-quality gate only reports workspace search quality; Local Knowledge eval scorecards
   are deterministic but not part of that command. This maps to #1841 and #1842. Status:
   implemented by the expanded `check:retrieval-quality` script.
5. Release evidence for candidate budgets, strategy semantics, and known limitations is missing.
   This maps to #1842. Status: in progress in this ledger.

## Implementation Snapshot

Status after implementation and post-audit hardening on 2026-07-05:

- `RetrievalDiagnostics` now includes the resolved retrieval `strategy` as one of `balanced`,
  `exact`, or `broad`, plus dense/lexical/fused candidate budgets and query-variant counts. The
  diagnostics remain closed count/enum fields; no raw query text, candidate body, source path,
  endpoint, provider payload, or private content is added.
- Exact lexical fallback now prefilters a bounded exact-text candidate pool in SQLite, then applies
  boundary-aware identifier and quoted-phrase matching in the retrieval layer before truncation.
  This prevents near-collisions such as `ADR-0036` matching `ADR-00360`, avoids computed SQL
  ranking over the full exact-text pool, and keeps dense, BM25, and RRF scores separated.
- Quoted phrases now resolve `auto` retrieval to exact strategy and are searched through the
  existing `chunk_lexical_index.exact_text` field. One-token quoted phrases such as `"policy"` are
  treated as exact lookup signals.
- Short exact terms and acronyms recognized by the existing exact-term parser, such as `API` and
  `ADR`, now reach the exact-text fallback instead of being filtered out before lookup.
- The Local Knowledge eval runner now seeds `chunk_lexical_index` rows through
  `upsertLexicalRows`, so deterministic fixtures exercise the same SQLite FTS/BM25 lexical leg as
  production retrieval instead of vector-only scoring.
- `RetrievalEvalQuery` now accepts the existing public retrieval `strategy` option and passes it to
  `runLocalKnowledgeRetrieval`; a focused module-mock regression test pins the forwarding contract.
- Four new synthetic fixtures were added:
  - `exact-technical`: exact ADR id, API name, policy clause, and error-code retrieval.
  - `semantic-paraphrase`: broad semantic query with wording that differs from the corpus.
  - `multilingual-retrieval`: German-language query with English evidence, proving deterministic
    cross-lingual vector recall rather than same-language lexical overlap.
  - `mixed-strategy`: exact, broad, and balanced queries in one capsule.
- Fixture registry, determinism, and threshold tests now iterate `ALL_FIXTURES`, preventing future
  registry drift.
- `check:retrieval-quality` now runs both the existing workspace retrieval budget and the Local
  Knowledge fixture scorecards, then prints only fixture ids and aggregate metrics.
- Candidate budgets are now strategy-aware in the existing retrieval path: exact mode gives the
  lexical/fused side the largest budget, broad mode keeps a dense-oriented fused budget, and
  balanced mode remains the middle default. ADR-0036 RRF rank fusion is still `RRF_K = 60`, raw
  vector scores and BM25 scores remain separated until rank fusion, and no direct cross-space score
  comparison was introduced.
- No persisted schema change, index migration, or managed service was introduced. Existing user
  Knowledge Pods do not require a migration for this change; the lexical seeding change is limited
  to the deterministic eval harness, while production indexing already owns lexical rows.

## Verification Log

Baseline targeted verification before edits on 2026-07-05:

- `npm test -- --run packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.test.ts packages/keiko-local-knowledge/src/evaluations/runner.test.ts packages/keiko-local-knowledge/src/evaluations/fixtures.test.ts`
  - PASS; 3 files and 69 tests.

Focused verification after the implementation pass:

- `npm test -- --run packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.test.ts packages/keiko-local-knowledge/src/evaluations/runner.test.ts packages/keiko-local-knowledge/src/evaluations/fixtures.test.ts scripts/__tests__/check-retrieval-quality.test.mjs`
  - PASS; 4 files and 80 tests.
- `npm run check:retrieval-quality`
  - PASS; workspace retrieval cases: 15, top1 100.0%, recall@5 100.0%, MRR 1.000, nDCG@5 1.000,
    line-hit 100.0%, generated leaks 0.
  - PASS; Local Knowledge fixtures: 15 of 15 passed, aggregate recall 1.000, precision 1.000, MRR
    1.000, nDCG 1.000, source isolation 1.000, no-evidence accuracy 1.000.

Focused verification after post-audit hardening:

- `npm test -- --run packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.test.ts`
  - PASS; 44 focused retrieval tests, including quoted-phrase exact retrieval and strategy-specific
    budget diagnostics.
- `npm test -- --run packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.test.ts packages/keiko-local-knowledge/src/evaluations/runner.test.ts packages/keiko-local-knowledge/src/evaluations/fixtures.test.ts scripts/__tests__/check-retrieval-quality.test.mjs`
  - PASS; 4 files and 82 tests after formatting.
- `npm test -- --run packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.test.ts packages/keiko-local-knowledge/src/evaluations/runner.test.ts packages/keiko-local-knowledge/src/evaluations/runner-strategy.test.ts packages/keiko-local-knowledge/src/evaluations/fixtures.test.ts scripts/__tests__/check-retrieval-quality.test.mjs`
  - PASS; 5 files and 87 tests after the final audit-repair pass. This includes exact identifier
    near-collision coverage, short acronym lookup, one-token quoted phrase lookup, strategy
    forwarding, and Local Knowledge quality-gate failure tests.
- `npm test -- --run scripts/__tests__/check-retrieval-quality.test.mjs`
  - PASS; 1 file and 7 tests after extracting the workspace-quality helper for lint compliance.
- `npm run typecheck`
  - PASS; package build, package graph, and root `tsc --noEmit` completed after the stricter
    diagnostics shape.
- `npm run check:retrieval-quality`
  - PASS; workspace retrieval cases: 15, top1 100.0%, recall@5 100.0%, MRR 1.000, nDCG@5 1.000,
    line-hit 100.0%, generated leaks 0.
  - PASS; Local Knowledge fixtures: 15 of 15 passed, aggregate recall 1.000, precision 1.000, MRR
    1.000, nDCG 1.000, source isolation 1.000, no-evidence accuracy 1.000.

Final local verification on 2026-07-05:

- `npm run format`
  - PASS; Prettier completed across the repository.
- `npm run typecheck`
  - PASS; package build, package graph, and root `tsc --noEmit` completed.
- `npm run lint`
  - PASS; root ESLint and `@oscharko-dev/keiko-ui` ESLint completed with zero warnings.
- `npm run format:check`
  - PASS; all matched files use Prettier style.
- `npm test`
  - PASS; 972 files passed, 16,431 tests passed, 1 skipped.
- `npm run arch:check`
  - PASS; dependency-cruiser, import policy, and contract boundary checks completed.
- `npm run arch:check:negative`
  - PASS; the architecture gate fired on all 44 negative fixtures as expected.
- `npm run check:retrieval-quality`
  - PASS; workspace retrieval cases: 15, top1 100.0%, recall@5 100.0%, MRR 1.000,
    nDCG@5 1.000, line-hit 100.0%, generated leaks 0.
  - PASS; Local Knowledge fixtures: 15 of 15 passed, aggregate recall 1.000, precision 1.000,
    MRR 1.000, nDCG 1.000, source isolation 1.000, no-evidence accuracy 1.000.
- `npm run check:grounded-retrieval-quality`
  - PASS; baseline cases: 10, top1 100.0%, recall@3 100.0%, nDCG@3 1.000,
    citation-support 100.0%; reranker-reversed and embedding-flat regression controls failed closed.
  - Note: the script emitted Node's existing `ExperimentalWarning` for SQLite; no raw private content
    was emitted.
- `npm run check:grounded-faithfulness`
  - PASS; fixtures: 8, unsupported detection 100.0%, citation precision 100.0%,
    abstention-on-empty 100.0%.
  - Note: the script emitted Node's existing `ExperimentalWarning` for SQLite; no raw private content
    was emitted.
- `npm run check:release-impact`
  - PASS; current package version has reviewed update-impact metadata.
- `npm run check:version-consistency`
  - PASS; every workspace package and exported `KEIKO_*_VERSION` constant reports 0.2.11.
- `npm run build && npm run check:package-surface`
  - Initial result: FAIL; the package-surface guard rejected TypeScript incremental metadata
    generated under package `dist/` trees.
- `npm run prune:package-build-artifacts && npm run check:package-surface`
  - Intermediate result: FAIL; after pruning, build outputs were older than formatted source/package
    inputs.
- `npm run clean && npm run build && npm run build:ui && npm run prune:package-build-artifacts && npm run check:package-surface`
  - Intermediate result: FAIL; `dist/cli/index.js` still needed the established `prepare:bin` step.
- `npm run prepare:bin && npm run check:package-surface`
  - PASS; editor bundle-size check passed and package-surface passed with 4,162 files and
    `dist/ui/static` present.
- `npm run clean && npm run build && npm run build:ui && npm run prune:package-build-artifacts && npm run prepare:bin && npm run check:package-surface`
  - PASS after post-audit hardening; editor bundle-size check passed and package-surface passed with
    4,165 files and `dist/ui/static` present.
- `npm run typecheck`
  - PASS after the final script extraction; package build, package graph, and root `tsc --noEmit`
    completed.

## Release Evidence Summary

- Exact technical behavior is covered by `exact-technical` and the low-level hostile-input lexical
  test. The exact fixture uses synthetic ADR/API/policy/error-code terms and passes through
  `check:retrieval-quality`.
- Semantic behavior is covered by `semantic-paraphrase`, which uses the deterministic scripted
  embedding adapter so the gate does not depend on any provider call.
- Multilingual behavior is covered by `multilingual-retrieval`, a German-language synthetic fixture
  with deterministic vector recall.
- Hybrid and strategy behavior is covered by `mixed-strategy`, `broad-query-diversity`, strategy
  diagnostics tests, and existing guided/ANN/lexical-degraded tests.
- Candidate budgets are strategy-aware and exposed as redacted diagnostics: exact uses the highest
  lexical/fused budget, broad keeps dense-oriented fusion for recall/diversity, balanced remains the
  safe default for short non-exact queries, and all modes still fuse by ADR-0036 RRF.
- Evidence is redacted: gate output reports fixture ids, aggregate metrics, counts, enums, and pass
  states only. It does not print source bodies, raw queries, private paths, endpoints, tokens, or
  provider payloads.

## Security And Architecture Disposition

- No hosted search service, managed dependency, provider SDK import, hidden planner, or second Local
  Knowledge retrieval pipeline was added.
- The Model Gateway boundary remains unchanged; the deterministic eval adapter continues to exercise
  the existing embedding adapter port.
- The hostile-input regression uses SQL/FTS-looking text and verifies retrieval stays capsule-scoped,
  vector rows remain intact, and diagnostics do not echo raw hostile text.
- `RetrievalDiagnostics.strategy` is a closed enum, and its budget/query-variant companions are
  numeric counts only. They add strategy explainability without exposing query content or raw
  candidate data.
- No persisted schema or production index migration was introduced. Existing production indexing
  already owns lexical rows; the new lexical seeding is limited to eval fixtures.

## Known Limitations And Follow-Ups

- Diagnostics now identify the resolved strategy, per-leg/fused counts, strategy-specific budgets,
  and query-transform variant counts. They do not yet expose per-capsule truncation counts; add a
  follow-up only if operators need that extra observability beyond the current #1817 acceptance
  criteria.
- Performance audit follow-up: broad-query rewrite fan-out currently reruns lexical collection and
  dense candidate processing for every unique query variant. Synthetic package-level measurement on
  2026-07-05 showed a warm 25k-row broad query rising from 11.58 ms with one variant to 59.18 ms
  with four variants. This is a bounded, diagnostics-visible cost (`queryVariantCount`), but a
  future optimization should evaluate early-stop, lexical-only rewrite expansion, or safe
  parallelism without reducing broad-query recall.
- Performance audit disposition: exact lexical ranking no longer asks SQLite to compute and sort an
  exact-match score across the filtered exact-text pool. The retrieval layer now boundary-filters and
  ranks a bounded candidate pool after SQL prefiltering, addressing the measured temp B-tree cost
  without adding schema or migration work.
- The grounded retrieval and faithfulness gates still emit Node's experimental SQLite warning in this
  local environment. The warning is non-sensitive and pre-existing for those gates.
- No additional follow-up issue is required for this implementation unless PR review or CI surfaces a
  new acceptance-blocking gap.

## Operating Guidance

- Run `npm run check:retrieval-quality` before claiming #1817 retrieval quality movement. The command
  now covers workspace retrieval and Local Knowledge exact, semantic, multilingual, hybrid, and
  strategy-specific fixture scorecards.
- Run `npm run check:grounded-retrieval-quality` and `npm run check:grounded-faithfulness` for
  grounded-answer retrieval changes or before final #1817 release evidence.
- A fixture failure should be investigated at the owning layer: lexical FTS/BM25 or exact-text rows
  for exact fixtures, scripted vector/topic behavior for semantic fixtures, RRF/candidate budgets for
  mixed strategy fixtures, and scope/grounding policy for isolation or no-evidence fixtures.
- Do not update fixture expectations to make a failing gate pass unless the changed behavior is
  intentionally reviewed and documented here, in the PR, and in the linked issue evidence.
- No reindexing or user migration is required for the current implementation. If production lexical
  normalization or persisted index semantics change in a future follow-up, add explicit reindex
  guidance and compatibility tests before claiming release readiness.
