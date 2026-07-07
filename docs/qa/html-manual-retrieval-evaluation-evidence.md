# HTML Manual retrieval evaluation & pilot release gates — closure evidence (Epic #1858)

Local closure evidence for Epic #1858 and child issues #1902, #1903, #1904, #1905, and #1906. This
record is body-free: it names evaluation fixtures, gates, and their outcomes, but does not include
any manual body, raw crawled page, private filesystem path, private URL, query token, credential,
cookie, prompt, or provider endpoint. All fixture content is hand-authored synthetic device-handbook
text; no customer manual is committed.

Following ADR-0111, this is a conservative, evidence-and-mapping closure: it audits the epic's
acceptance criteria against shipped artifacts and defines which gates govern release, rather than
adding a new runtime subsystem. The evaluation mechanism, scorecards, and leakage guards already
existed (Epics #1826, #1816/#1819, #1853–#1856); this epic extends their fixture and gate coverage
to HTML manuals.

## What is proven

1. **Goldset taxonomy and fixtures (#1902).** The Knowledge Pod goldset taxonomy
   (`docs/local-knowledge/knowledge-pod-retrieval-goldset-ledger.md`) gains seven HTML-manual query
   classes not previously scored — table-row lookup, frameset navigation, code-block, malformed-page
   salvage, denied-link vs citation-open, index-page, and HTML-manual-scoped multilingual — added as
   `html-manual-*` fixtures in `packages/keiko-local-knowledge/src/evaluations/fixtures.ts`. The
   fixtures test enforces that every registered fixture id also appears in the ledger taxonomy, so
   the two cannot drift.
2. **Retrieval, grounding, and citation scorecards (#1903).** The new fixtures run inside the
   existing `check:retrieval-quality` gate against the unchanged `PASS_THRESHOLDS` (recall,
   precision, MRR, nDCG, source isolation, citation quality, no-evidence accuracy, context-budget
   fit). No new metric or scorecard mechanism was introduced. Each new class is registered in
   `REGRESSION_PROBE_FIXTURE_IDS`, so repointing its ground truth at a decoy must drop the scorecard
   below the floors — the gate is proven non-tautological for every new axis.
3. **Redaction and leakage gates (#1904).** The evidence safe-text guard
   (`isKnowledgePodEvidenceSafeText`) gains two leak classes that previously had no coverage anywhere
   — HTTP cookie headers and chat/prompt template scaffolding — at the owning layer in
   `packages/keiko-contracts/src/local-knowledge-pods.ts`. HTML-manual-scenario leakage tests assert
   raw body, private path, token query, credential URL, cookie, prompt, provider endpoint, and
   customer-hostname shapes are rejected in both evidence and retrieval-activity text, and that
   benign manual evidence (section paths, anchors, multilingual headings, counts) is not
   over-redacted.
4. **Private pilot runbook (#1905).** `docs/qa/html-manual-retrieval-pilot-runbook.md` gives
   operators a body-free procedure and evidence template for testing a real manual locally, split by
   browser-only, indexing, chat, refresh, and (unsupported) rendered-capture states.
5. **Release closure mapping (#1906).** This document defines the required-versus-advisory gate
   matrix below and links the pilot runbook and leakage gates into release readiness.

## Representative end-to-end run

Measured by `npm run check:retrieval-quality` (deterministic, network-free) and the co-located
evaluation suites. Values are the body-free scorecard aggregate.

| Metric                                      | Value                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Local Knowledge fixtures scored             | 27 (7 new `html-manual-*` classes added by this epic)                                                                                |
| Fixtures passing all eight thresholds       | 27 / 27                                                                                                                              |
| Aggregate recall / precision / MRR / nDCG   | 1.000 / 1.000 / 1.000 / 1.000                                                                                                        |
| Source isolation / no-evidence accuracy     | 1.000 / 1.000                                                                                                                        |
| Denied-link / malformed no-evidence         | `noEvidence = true`, reason `below-min-score`                                                                                        |
| Regression probes (all axes)                | every probe drops below floors (non-tautological)                                                                                    |
| Grounded retrieval / faithfulness gates     | PASS (unchanged scripted corpora)                                                                                                    |
| Leakage classes gated (evidence + activity) | raw-body, path, token-query, credential-url, cookie, prompt, provider-endpoint, customer-hostname; raw vectors excluded structurally |

## Gate command summary

Run from the repository root against this branch.

- `npm run typecheck` — TypeScript strict, full package graph.
- `npm run lint` — ESLint `--max-warnings=0`.
- `npm run format:check` — Prettier.
- `npm test` — Vitest (retrieval eval, HTML-manual goldset, leakage, and manual pipeline suites).
- `npm run check:retrieval-quality` — Local Knowledge scorecards + retrieval-mode comparison +
  non-tautology regression probes over `ALL_FIXTURES`.
- `npm run check:grounded-retrieval-quality` / `npm run check:grounded-faithfulness` — grounded
  ranking and citation-faithfulness gates.
- `npm run arch:check` / `npm run arch:check:negative` — ADR-0019 boundaries.

## Required vs advisory gates

The P0 HTML manual release surface is browser open → bounded index → grounded chat with citations.
The gates below are required for that surface; structure, refresh, and rendered-capture work carries
its own owning epics and is advisory here.

| Gate                                                 | Governs                                   | P0 release | Notes                                                          |
| ---------------------------------------------------- | ----------------------------------------- | ---------- | -------------------------------------------------------------- |
| `check:retrieval-quality` (html-manual-\*)           | Retrieval + citation quality over manuals | Required   | All new fixtures must pass; probes prove non-tautology.        |
| `check:grounded-retrieval-quality`                   | Grounded answer ranking                   | Required   | Unchanged corpora; must stay green.                            |
| `check:grounded-faithfulness`                        | Citation faithfulness / abstention        | Required   | Fabricated citations flagged; empty evidence abstains.         |
| Leakage suites (evidence + retrieval activity)       | Body-free evidence, no cookie/prompt leak | Required   | `local-knowledge-retrieval-activity`, `html-manual-leakage`.   |
| `typecheck` / `lint` / `format:check` / `arch:check` | Core quality and boundaries               | Required   | Standard gate surface.                                         |
| Private pilot runbook                                | Real-manual confirmation, body-free       | Advisory   | Operator-run; confirms synthetic classes on real content.      |
| Frameset / table-row / code-block depth              | Structure-preserving extraction depth     | Advisory   | Parser depth owned by Epic #1855; scored here, extended there. |
| Refresh diff/diagnose evidence                       | Manual pod refresh                        | Advisory   | Owned by Epic #1856.                                           |
| Rendered/JavaScript capture                          | Client-rendered manuals                   | Advisory   | Out of scope; owned by Epic #1857.                             |

## Known limitations and follow-ups

- This is local implementation and verification evidence only. The human-control invariant keeps
  GitHub issue/project updates and issue closure outside agent authority unless the maintainer
  explicitly requests them; the child-issue acceptance and deliverable checkboxes remain unchecked
  pending maintainer review of this record.
- The scorecards remain synthetic and deterministic by design. A private pilot (Issue #1905)
  confirms the classes hold on real content but commits no customer evidence; a gap found in a pilot
  is closed by adding a new synthetic fixture class here, not by committing real data.
- Structure-preserving parser depth for tables, framesets, and code blocks is owned by Epic #1855;
  this epic scores those classes but does not deepen the parser.
- Refresh/diff/diagnose evidence is owned by Epic #1856; rendered/JavaScript-executed capture is
  owned by Epic #1857. Both remain advisory for the P0 surface.
- Editor release-evidence and UI fingerprints are untouched by this epic (no `keiko-ui` or
  `keiko-editor` change), so those gates carry negligible risk from this change set.
