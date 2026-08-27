# ADR-0144: Grounded entailment stage — citation support, not just membership

## Status

Accepted (Issue #2563, Epic #2555, Program #2554 "Knowledge", 2026-07-19). Trust-boundary change
(a second model pass over the synthesized answer + fail-closed degradation semantics); the maintainer
security review is recorded on the delivering pull request.

## Context

Keiko's grounded-answer faithfulness moat verified citation **membership**: after generation,
`reconcileInlineCitations` (`packages/keiko-server/src/grounded-faithfulness.ts`) parses each inline
`[path:line]` citation and confirms the cited excerpt was actually in the evidence pack sent to the
model, surfacing fabricated (out-of-pack) citations as an `unsupported-citation` marker. That closes
the fabricated-citation class but is structurally blind to the harder failure: a **real, in-pack**
chunk cited for a claim it does **not** support. An answer that says "the retention period is 10
years [policy.md:12]" passes membership even when `policy.md:12` says 30 days — the citation is real;
only the claim is wrong. Locked decision N1 of the Knowledge north star (#2554) makes proof the
brand core, so entailment certification is mandatory scope; M1 (#2555) is where the thesis becomes
falsifiable.

### Two faithfulness subsystems (the load-bearing finding)

A subsystem inventory established that the grounded-answer estate has **two** citation-faithfulness
mechanisms, not one shared engine — this shapes where the entailment stage lands:

- **System A — the shared leaf** (`grounded-faithfulness.ts`, `[path:line]` citations). Consumed by
  the three `ConnectedContextPack` topologies dispatched from `grounded-qa.ts`: single folder
  (`grounded-orchestrator.ts` `runGroundedExploration`), multi folder (`grounded-qa-multi-source.ts`),
  and hybrid (`grounded-qa-hybrid.ts`). These did **membership-only** reconciliation — this is the
  verified entailment gap.
- **System B — the connector path** (`grounded-qa` dispatches a lone connector to
  `local-knowledge-grounded-qa.ts` → `runGroundedAnswer`, `[n]` citations). Its
  `citation-attacher.ts` already ships a deterministic **token-overlap** citation-support check
  (`citationPassesFaithfulness`).

The original issue text assumed `runGroundedAnswer` served all four topologies and named its
`citationFaithfulness` seam as the wiring point; the code shows `runGroundedAnswer` is the
single-connector path only. This ADR records the corrected placement.

## Decision

### D1 — The entailment stage lands in the shared System-A leaf, as an injected capability

The reusable entailment primitives live in `grounded-faithfulness.ts` (the file the issue names),
keeping the leaf dependency-light (contract types only):

- `EntailmentVerdict = "supported" | "unsupported" | "unavailable"` and the `EntailmentJudge` port
  (`judge({claimText, excerptText}) => Promise<EntailmentVerdict>`).
- `segmentCitedClaims` / `splitClaimSpans` — bracket-aware sentence segmentation that never splits
  inside a `[routes.ts:5]` citation, pairing each claim span with its inline citations.
- `reconcileClaimEntailment` — runs **strictly after** membership reconciliation and **only** over
  citations that passed membership (a fabricated citation is never double-reported), bounded by a
  per-answer claim budget and a per-claim excerpt cap.
- `buildPackExcerptTextResolver` — resolves the bounded, already-redacted excerpt text for a cited
  `[path:line]` from the in-pack `ContextExcerpt.content` (no second excerpt reader).
- `unsupportedClaimMarker` / `entailmentUnavailableMarker` — new `UncertaintyMarker` kinds
  (`unsupported-claim`, `entailment-unavailable`) added to `keiko-contracts`, following the
  `unsupported-citation` shape and tone.

The stage is an **injected optional capability** (`createEntailmentStage`,
`grounded-entailment-stage.ts`) constructed once per grounded ask and threaded into all three
System-A topologies (folder via `OrchestratorDeps.entailmentStage`, multi-source and hybrid via a
shared `appendGroundedAnswerEntailment` post-assembly merge). When it is absent the assembled pack is
byte-identical to the pre-#2563 behavior. For hybrid, the `packs` argument to that merge is
restricted to folder evidence (`folders.map((f) => f.pack)` at `grounded-qa-hybrid.ts`
`applyHybridEntailment`); connector evidence is not currently included, so hybrid's NLI stage sees
only the folder half of the answer's evidence.

**System B is left on its existing token-overlap check for M1.** It already performs citation-support
verification, so all four topologies verify support after this change (three via the new NLI stage,
one via the pre-existing lexical check). Unifying System B onto the shared NLI judge is deferred to
K M2 (#2556) substrate unification, matching that milestone's "one reranker facade / one eval
harness" scope — it is not smuggled into M1.

### D2 — The production judge is a Model-Gateway NLI pass over the same configured model

The gateway judge (`grounded-entailment-judge.ts`) routes exclusively through
`deps.modelPortFactory` (ADR-0019 trust-1; no provider SDK outside `keiko-model-gateway`), reusing
the `qi:judge-faithfulness` task profile (a structured-output chat capability at temperature 0) and
the untrusted-text hardening pattern of `qualityIntelligence/judgePort.ts` (control/invisible-char
scrub + prompt-delimiter neutralisation; claim and excerpt are DATA). Entailment verification is a
**second pass over the synthesized answer**, so it reuses the model that produced the answer
(`input.modelId ?? chat.selectedModel`) rather than a hardcoded judge model; a model that cannot
enforce the verdict JSON schema makes the stage inert.

Token overlap was deliberately **not** chosen for the production judge: the motivating failure
("10 years" cited to a "30 days" excerpt) has high lexical overlap and opposite meaning, so only a
semantic (NLI) judge catches it. Token overlap remains adequate for the deterministic gate (below)
and for System B's existing check.

### D3 — Policy gating on the resolved `answerSynthesis` decision (no new contract operation)

The stage is gated on the resolved per-capsule `answerSynthesis` model-use decision
(`resolveScopeModelUsePolicy` / `isScopeModelUseOperationAllowed`). This reuse is **honest**:
entailment verification is a second model pass over the synthesized answer, so a pod that denies
answer synthesis has no synthesized answer to verify — the stage is inert there by construction
(sealed-local pods included). A dedicated `entailmentVerification` operation was rejected because it
would edit `keiko-contracts` (a D12 subject and a contract-surface decision) for no honesty gain.
Folder scopes carry no capsule, so there the stage is governed only by whether a compatible judge
model is configured.

### D4 — Degradation is fail-closed to WARN, never fail-open, never blocking

Gateway unreachable, timeout, malformed judge output, or budget exhaustion yield the `unavailable`
verdict — a **first-class discriminant**, never an exception swallowed into `supported`. The answer
still returns, carrying an `entailment-unavailable` WARN marker plus a body-free operator diagnostic
(correlation id + counts + failure class — never claim text, excerpt text, or file content) via the
`ServerDiagnosticSink`. There is no configuration in which the stage silently reports "supported"
without judging, and none in which it blocks or empties the answer.

### D5 — The gate is non-tautological by construction

`check:grounded-entailment` (`grounded-entailment-eval.ts` + `scripts/check-grounded-entailment.mjs`)
scores the REAL segmentation/reconciliation/marker logic over distractor-dense fixtures with a
deterministic scripted judge implementing the same `EntailmentJudge` port (no network, no wall-clock
dependence). Floors are 1.0: every unsupported claim must be flagged, no supported claim may be
falsely flagged, and an `unavailable` judge must degrade to WARN. A fixed **checker-disabled probe**
re-runs the unsupported fixtures with a pass-through judge (always "supported"); if the score still
detected them the reconciliation would not depend on the checker, so `nonTautologyProven` is false
and the gate fails. This mirrors the `reranker-reversed`/`embedding-flat` discipline of
`check:grounded-retrieval-quality`.

### D6 — The certification baseline is the M8 comparison anchor

`docs/qa/grounded-certification-baseline.md` records, body-free, the current scorecards of
`check:grounded-faithfulness`, `check:retrieval-quality`, `check:grounded-retrieval-quality`, and the
new `check:grounded-entailment` at the recording commit. K M8 (#2562) measures the finished
certification matrix against this document; the moat floors of `check:grounded-faithfulness` are
unchanged at 1.0.

## Consequences

- The three System-A grounded topologies gain semantic citation-support verification when a
  compatible judge model is configured and policy allows it; otherwise the path is byte-identical
  (pinned by the existing grounded regression suites, which run with no judge configured). For the
  hybrid topology specifically, NLI verification covers only `[path:line]`-cited folder evidence;
  connector-`[n]`-marker-cited claims stay on the existing `citationPassesFaithfulness` token-overlap
  citation-support check (see D1 above and ADD-01/RAG-RETRIEVAL-ADD-01) pending a follow-up. The
  reconciliation check is a separate downstream stage that reads the same verdict — it is not
  itself the verification layer.
- A richer `keiko-evidence` verdict-tally manifest (beyond the operator diagnostic and the persisted
  uncertainty markers) and the System-B NLI unification are explicit K M2 follow-ups.
- New contract surface is limited to two additive `UncertaintyMarkerKind` values; no capsule-store
  schema, embedding identity, RRF fusion (ADR-0036), or connector change.

## Related

ADR-0019 (gateway isolation + contracts leaf rule), ADR-0036 (rank-only RRF — untouched; the stage
never feeds scores back into fusion), ADR-0135/ADR-0139 (delivery + D12 batching), the
`check:grounded-faithfulness` lineage (RB-4 / GEN-AI-GROUNDING-001).
