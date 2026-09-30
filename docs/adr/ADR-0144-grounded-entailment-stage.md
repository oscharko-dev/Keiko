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
  `citation-attacher.ts` ships a deterministic **token-overlap** citation-support signal: a weak
  overlap flags the attached citation (`lexicalSupport: "weak"`) and never drops it (see the
  2026-09 amendment below).

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
  per-answer claim budget and a per-item excerpt cap.
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

**System B and hybrid connector markers use the same NLI judge.** Numeric `[n]` markers are segmented
with the same shared claim/citation contract and resolved only against the exact selected, redacted
candidate rendering that reached the answer model. The single-connector path contributes its
prompt-capped `[n] label + excerpt` rendering; the hybrid path contributes only its post-rerank,
prompt-selected connector candidates. Neither path performs a second search, consults a broader
corpus, or promotes a malformed, missing, or unselected marker into semantic evidence. The
token-overlap check is a soft signal on an attached citation, never a filter and never the semantic
success criterion. The shared NLI stage supplies the existing bounded, unavailable-to-WARN behavior and
body-free diagnostics for System B and hybrid connector citations as well as path-and-line citations.

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
and as System B's soft weak-support signal.

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

- Every user-facing grounded topology gains semantic citation-support verification when a compatible
  judge model is configured and policy allows it; otherwise the path is byte-identical (pinned by
  the existing grounded regression suites, which run with no judge configured). Hybrid verification
  covers both `[path:line]` folder evidence and `[n]` connector evidence; the reconciliation check
  is a separate downstream membership stage and is not itself the verification layer.
- A richer `keiko-evidence` verdict-tally manifest (beyond the operator diagnostic and the persisted
  uncertainty markers) remains an explicit K M2 follow-up.
- New contract surface is limited to two additive `UncertaintyMarkerKind` values (a third,
  `uncited-answer`, followed later — see the amendment below); no capsule-store schema, embedding
  identity, RRF fusion (ADR-0036), or connector change.

## Amendment (2026-09-30) — one marker grammar, refusals, uncited answers and judge sizing

A Knowledge Pod chat (German UI) exposed four defects in how this stage's inputs and outputs were
shaped, all on the numeric `[n]` connector path. The recorded behaviour is corrected as follows.

- **One marker grammar.** Numeric markers are parsed only by `findCitationMarkerGroups`
  (`keiko-contracts` `runtime/citation-markers`): `[1]`, the grouped `[1, 7, 8]` / `[1,7]` / `[1; 2]`,
  and the CJK/fullwidth bracket glyphs. The attacher, `reconcileNumericCitations`, the claim
  segmentation, the answer renderer and the copy stripper all use it; the
  private one-integer grammars that silently ignored every grouped marker are gone. Ranges (`[1-3]`) are deliberately not
  markers (`[0-9]`, `[2020-2024]`). Markdown code (a fenced block or an inline code span) is never
  scanned, so `const a = [1, 2, 3];` cites nothing. A fenced block is read where the renderer
  shows one: its fences may be indented or quoted. An inline code span ends wherever the chat
  renderer (`safe-markdown.ts`) ends an inline context: at every newline it does not join into one
  paragraph (a blank line, a fence, a heading, a thematic break, a list item, a table row, a block
  quote) and at every table cell pipe. Past the renderer's 16-level quote cap, which renders the
  quoted body as one text node, the quoted lines read as one paragraph. A cross-check test holds
  the grammar to the markers the renderer shows. Outside code, every index of every
  group is reconciled: a fabricated
  `[9, 10]` beside a real `[1]` dangles, because failing closed beats a quiet source attribution.
  The copy stripper removes only a grounded answer's groups whose every index names one of its
  references and leaves an ordinary answer's brackets untouched. Read-aloud text is the answer with
  its markers stripped by the same rule in the UI before synthesis (`speakableAnswerText`); the
  copy's repository-evidence tidy-up is not applied, so a bracketed path is spoken as written.
  `client.answer.speech-prepared` records the removed and kept groups under the synthesis request's
  correlation. The synthesis route sees only text, so it keeps grouped brackets as content.
- **Token overlap is a soft signal, never a filter — and never a confirmation.**
  `attachCitationsToAnswer` keeps every in-range marker attached so the reader can open its source.
  A weak claim/excerpt overlap flags the entry (`lexicalSupport: "weak"`) and is counted on the
  `search.citations.reconciled` activity line. When the numeric judge reads a weak citation's
  claim, its verdict (`unsupported-claim`, or its own `entailment-unavailable` on failure) decides.
  When no judge is available, or the judge read fewer claims for that marker than the answer uses
  it (a bracketed claim leaves no text after the claim stripper, so a reused marker is no verdict
  on it), or a claim citing it carried bracketed prose the stripper removed (the judge never read
  that prose, `NumericCitedClaim.hidesProse`), the Knowledge Pod answer carries the fail-closed
  `entailment-unavailable` caveat and the citation chip reads "unverified". A weakly supported
  citation is never presented as confirmed support (`withWeakCitationCaveat`).
- **A claim the judge would read only in part is undecidable.** The claim stripper removes every
  bracket, so `The API uses TLS [MFA is mandatory] [1]` reaches the judge as its TLS half. Whatever
  its lexical overlap, such a claim (path or numeric) is never judged: it counts as unavailable and
  the answer carries `entailment-unavailable`. `search.entailment.judged` records the count as
  `hiddenProseClaimCount`, and `search.citations.support-settled` records why a Knowledge Pod
  answer did or did not end with the caveat (`none`, `judge-undecided`, `no-judge`,
  `unjudged-citation`), once that decision is made.
- **Markers resolve only against the evidence the model was shown.** A window-fitted prompt keeps the
  highest-ranked references under their original numbers. The generator reports the references it
  sent (`AnswerGenerator.promptReferences`), and a marker beyond them is out of range, never attached.
- **`uncited-answer` is a third additive kind.** An answer with source-backed claims and no supported
  marker used to reuse `unsupported-citation`, which the UI reads as "references sources that were not
  in the retrieved evidence" — false for a merely uncited answer. A refusal (one shared detector,
  `runtime/no-evidence-answer`) makes no claim and carries neither kind. Only explicit "not enough
  evidence/information" statements are refusals unconditionally. A negated verb ("does not contain",
  "nicht erwähnt", "geht nicht hervor", "cannot answer") counts as a refusal only when its own
  sentence names the evidence it searched (documents, sources, context, repository); an
  attribution such as "according to the documentation", plain or as inline Markdown, with a
  possessive, version or compound source word ("the project's documentation"), names a source, not
  the place that lacks it. An
  absent-information noun ("keine Angaben", "no details") also counts with a search outcome
  ("gefunden", "available", "liegen … vor") in that sentence. Otherwise "The API does not provide
  authentication." or "The API returns no details on errors." is a negative fact, not a refusal.
- **The judge is sized per evidence item.** `maxExcerptChars` bounds each cited item, a numeric
  evidence block gets a framing allowance for its `[n] label` header and code fence, and one claim may
  cite up to `ENTAILMENT_MAX_EVIDENCE_ITEMS_PER_CLAIM` distinct items. Before this, the rendered block
  of a single full-length excerpt already exceeded the 900-character cap, so almost every cited claim
  degraded to `entailment-unavailable`. A single item longer than its cap still degrades (never judged
  against a partial excerpt). The stage's default cap follows the operator's grounding excerpt limit.

## Related

ADR-0019 (gateway isolation + contracts leaf rule), ADR-0036 (rank-only RRF — untouched; the stage
never feeds scores back into fusion), ADR-0135/ADR-0139 (delivery + D12 batching), the
`check:grounded-faithfulness` lineage (RB-4 / GEN-AI-GROUNDING-001).
