# Epic #1820 Semantic Reranking Acceptance Ledger

Status: post-merge audit closure ledger for Epic
[#1820](https://github.com/oscharko-dev/Keiko/issues/1820) and child issues
[#1921](https://github.com/oscharko-dev/Keiko/issues/1921),
[#1922](https://github.com/oscharko-dev/Keiko/issues/1922),
[#1923](https://github.com/oscharko-dev/Keiko/issues/1923),
[#1924](https://github.com/oscharko-dev/Keiko/issues/1924),
[#1925](https://github.com/oscharko-dev/Keiko/issues/1925), and
[#1926](https://github.com/oscharko-dev/Keiko/issues/1926).

This file is the body-safe closure ledger for the merged semantic-reranking slice. It contains only
redacted, synthetic evidence: counts, gate names, status/mode/failure-kind enums, issue numbers, and
source file names. It never contains raw candidate text, queries, provider payloads, endpoints,
credentials, or private paths.

Fetched source-of-truth state on 2026-07-06:

- Epic #1820 and child issues #1921-#1926 were fetched from GitHub and are all closed.
- The implementation shipped as squash commit `66283ae2` on `dev`; only `docs/local-knowledge` and the
  reranker seams under `keiko-contracts`, `keiko-model-gateway`, `keiko-server`, and `keiko-ui` changed.
- Required implementation order recorded on the epic: #1921, #1922, #1923, #1924, #1925, #1926.

Post-merge audit note on 2026-07-06:

- An independent six-agent audit (one auditor per child, security-focused auditors on the #1923/#1924
  trust boundary) re-verified the merged slice against every child acceptance criterion.
- Verdict: production-sound, zero critical/high defects, and no sealed-content leak path on either
  reranking entry point. The audit added test/evidence/gate hardening and fixed one user-visible
  activity-projection defect (below). No production reranking ranking, budget, fusion, policy, schema,
  or Model Gateway behavior was changed by the hardening.

## Acceptance evidence by child issue

- **#1921 — reranker port + evidence-safe diagnostics.** SATISFIED. The reranker is a second stage over
  already-fused candidates (`grounded-answer-runner.ts` runs retrieval, then `referenceReranker.rerank`).
  `GroundedRerankerDiagnostics` (`keiko-contracts/src/bff-wire.ts`) carries only status/mode/counts/
  failure-kind/latency; leak-proofed by an injected secret+endpoint test in `grounded-model-reranker.test.ts`.
  Cross-space retrieval stays rank-only (ADR-0036 RRF; no vector-score normalization added). The existing
  `ReferenceReranker`/`requestConfiguredRerank` seams are reused, not duplicated.
- **#1922 — deterministic no-op baseline.** SATISFIED (audit fix applied). When no reranker is configured,
  `referenceRerankerForScope` returns a no-op that preserves fused order via `fallbackReferenceSelection`
  (now unit-tested for exact order preservation). Audit fix: a not-configured reranker no longer projects
  a false `degraded` Knowledge Pod activity row on the single-scope path (it now matches the hybrid path,
  which already suppressed it). The redacted not-configured diagnostics still surface on the context pack.
- **#1923 — Model Gateway-backed reranking with pod-policy eligibility.** SATISFIED. External reranking is
  reachable only through `requestConfiguredRerank` → `requestLiteLLMRerank` (the sole provider-SDK
  boundary). `referenceRerankerForScope` resolves `resolveScopeModelUsePolicy(...).externalReranking`
  before any document is built; a denied scope builds zero documents (`documentCount: 0`). Proven by an
  end-to-end spy test asserting the provider is never called on deny, plus a new mixed capsule-set test.
- **#1924 — sealed/local-only behavior.** SATISFIED. Sealed pods (`sealed-local`, deny external reranking)
  never reach the provider; deny-wins aggregation vetoes external reranking for the whole scope if any
  member denies it. Keiko ships no local reranker, so the honest current behavior is a redacted no-op that
  preserves fused order; `localReranking` is reserved forward-compat surface (now documented and commented).
- **#1925 — candidate budgets + failure/degradation controls.** SATISFIED. Reranker input is bounded by
  `maxPromptReferences` (count) and `maxExcerptChars` (per-excerpt), both clamped by `resolveGroundingLimits`.
  All 14 `GROUNDED_RERANKER_FAILURE_KINDS` resolve to `fallbackReferenceSelection` (fused order). Duplicate,
  out-of-range, and non-integer provider indices are rejected to a safe fallback — now unit-tested on both
  the Knowledge Pod (`applyReferenceRerankResults`) and hybrid (`applyModelRerankResults`) paths.
- **#1926 — quality/leakage/release evidence gates.** SATISFIED. `check:grounded-retrieval-quality` gates a
  baseline path and a `reranker-off` control above floors, and proves non-tautology by forcing the
  `reranker-reversed` (deliberately bad reranker) and `embedding-flat` regressions below floors. Leakage is
  proven by the transport, diagnostics, and state-failure wire-payload redaction tests. This ledger is the
  closure-evidence artifact.

## Post-merge audit findings and fixes

1. **[fixed — user-visible] False `degraded` activity for a not-configured reranker (single-scope path).**
   `retrievalActivityResultFromScoped` forwarded the reranker diagnostics unfiltered, and
   `addRerankerReasonCode` treated failure kind `not-configured` as `reranker-unavailable`, so every default
   answer (reranker optional) rendered a `degraded` pod. The hybrid path already suppressed this. Fix:
   share one `rerankerForRetrievalActivity` suppressor across both projections and remove the contradictory
   `not-configured`-as-degraded branch. Genuine failures (unavailable/invalid-response/timeout) still
   degrade. Regression: the no-op test now asserts `state: "searched"` and `degradedCount: 0`.
2. **[test hardening] No-op order-preservation, malformed-mapping, and mixed-scope deny coverage.** Added
   deterministic unit tests for `fallbackReferenceSelection` (exact order + budget cap) and
   `applyReferenceRerankResults` (duplicate/out-of-range/non-integer/empty), a duplicate-index case for the
   hybrid `applyModelRerankResults`, and an end-to-end mixed capsule-set test proving deny-wins blocks the
   provider call while synthesis proceeds.
3. **[doc/comment clarity] `localReranking` reserved surface and behavior notes.** Documented that
   `mode: "local-only"` under denial is a no-op (no local reranker runs), that a not-configured reranker is
   not a degradation, and the Knowledge-Pod vs hybrid budget split; added a code comment at
   `referenceRerankerForScope` that `localReranking` has no runtime consumer yet.
4. **[fixed — security/redaction] State-failure context-pack label leakage.** A follow-up audit found that
   not-ready/no-evidence state-failure answers already redacted `retrievalActivity` pod metadata but still
   copied raw selected-scope and lifecycle labels into the wire `contextPack`. The fix applies the same
   evidence-safe display fallback used by retrieval activity before setting `contextPack.scopeLabel`, and the
   lifecycle summary now emits deterministic opaque IDs for unsafe legacy capsule identifiers. Regression
   coverage now asserts the full grounded answer payload excludes email-shaped values, private paths, provider
   endpoints, and token-shaped labels on this path.

## Verification log

Post-merge audit re-verification on 2026-07-06 (branched from dev HEAD `acf222c4`). Test/evidence
hardening plus one activity-projection fix; no production reranking ranking, budget, fusion, policy,
schema, or Model Gateway behavior changed.

- `npm run typecheck` — PASS; package build, package graph, and root `tsc --noEmit` (strict) completed.
- `npm run arch:check` — PASS; no dependency violations (2593 modules, 7081 dependencies), ADR-0019
  import policy and contract boundaries hold.
- `npm run arch:check:negative` — PASS; all 40 negative architecture fixtures fired as designed
  (including trust-1 provider-SDK isolation and trust-9 local-knowledge no-egress).
- Targeted reranker/activity/policy tests — PASS. `local-knowledge-grounded-qa.rescue.test.ts`: 39
  tests (including the corrected no-op activity test, the new mixed capsule-set deny test, and the four
  new reranker-helper unit tests). Cross-package reranker/activity suite (`grounded-qa-hybrid`,
  `grounded-model-reranker`, `grounded-orchestrator`, `grounded-rerank`, `grounded-answer-runner`,
  `model-use-policy`, `knowledge-pods`, `bff-wire`): 8 files, 206 tests.
- `npm run check:grounded-retrieval-quality` — PASS; baseline cases 10 (top1 100.0%, recall@3 100.0%,
  nDCG@3 1.000, citation-support 100.0%); `reranker-off` control clears floors; `reranker-reversed` and
  `embedding-flat` regression controls fail closed (`ok=false`), proving the gate is non-tautological.
- `npm run check:grounded-faithfulness` — PASS; fixtures 8; unsupported-detection 100.0%,
  citation-precision 100.0%, abstention-on-empty 100.0%.
- `npm run lint` — PASS; root ESLint and `@oscharko-dev/keiko-ui` ESLint completed with zero warnings.
- `npm run format:check` — PASS; all matched files use Prettier style.
- `npm test` — PASS; full repository suite: 977 files, 16,568 tests passed, 2 skipped.

## Release evidence summary

- Reranker modes: `none` (not configured — default, safe no-op), `local-only` (policy-denied no-op that
  preserves fused order; no local reranker executes today), and `provider-backed` (external rerank via the
  Model Gateway when a reranker is configured and the scope allows it).
- Default behavior is deterministic and safe: with no reranker configured, fused order, citations, and
  answer text are unchanged, and the pod activity is reported as searched, not degraded.
- Quality movement is gated by `check:grounded-retrieval-quality`: the baseline and reranker-off control
  clear the floors, and the `reranker-reversed` and `embedding-flat` regressions fail closed, proving the
  gate is non-tautological rather than asserting a specific live-provider quality delta.
- Evidence is redacted: diagnostics and activity carry fixture-free counts and closed enums only.

## Security and architecture disposition

- No provider SDK is imported outside `keiko-model-gateway`; `arch:check` holds.
- Pod policy is resolved and enforced before any provider document array is built; denied/empty/missing
  policy fails closed to `externalReranking: "deny"` (sealed-local default, deny-wins).
- No sealed-pod candidate text can reach an external reranker on either the single-scope or hybrid path.
- State-failure/no-evidence wire context packs use the retrieval-activity evidence-safe display fallback, and
  lifecycle summaries hash unsafe legacy capsule identifiers, so unavailable pods cannot expose unsafe labels
  or identifiers before retrieval.
- The disjoint repository-file context-pack reranker operates on workspace `CandidateFile`s, never on
  policy-governed `KnowledgeCapsule` content, so it is correctly outside the pod-policy gate.

## Known limitations and follow-ups

- Keiko ships no local reranker. Sealed/denied pods degrade to a redacted no-op; the `localReranking`
  policy operation is reserved for a future local reranker and must gate that implementation when added.
- The `provider-backed` quality delta is proven only against deterministic synthetic fixtures. Certifying a
  real reranker model's absolute quality would require a non-hermetic smoke test outside CI determinism.
- Optional UX follow-up (not shipped, to avoid the editor release-evidence fingerprint churn): surface a
  "sealed pod — external reranking not permitted" note in the grounded-answer summary line. Denial is
  already visible in the retrieval-activity panel (`sealed`/`policy-denied`).

## Operating guidance

- Run `npm run check:grounded-retrieval-quality` and `npm run check:grounded-faithfulness` before claiming
  any reranking quality movement or before final release evidence.
- A reranker gate failure should be investigated at the owning layer: pod policy for denial, the Model
  Gateway adapter for transport/egress, `applyReferenceRerankResults` for malformed provider mappings, and
  `fallbackReferenceSelection` for no-op ordering.
- Do not change fixture or activity expectations to make a failing gate pass unless the behavior change is
  intentionally reviewed and documented here, in the PR, and in the linked issue evidence.
