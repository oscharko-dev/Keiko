# ADR-0120: MemoriaViva conflict-review advisory suggestions — a bounded model-gateway trust-boundary crossing for ambiguous `ReviewItem`s

## Status

Accepted

## Context

Issue #2130 asks for an optional, advisory suggestion ("keep A, likely supersedes B, because...")
attached to ambiguous MemoriaViva conflict `ReviewItem`s, to help a human reviewer decide faster.
The issue carries its own mandatory stop condition: implementation must not proceed until the
`architect` role has triaged whether sending memory content to a model for adjudication is an
acceptable trust-boundary crossing for this deployment. This ADR is that triage decision, recorded
where AGENTS.md §11 requires it — a behavioural change that introduces a new trust-boundary
crossing is exactly the kind of decision this repository documents, not assumes.

Two facts about the current system bound the design space:

1. `packages/keiko-memory-consolidation` (`runConsolidation` / `detectConflicts`) is a **pure,
   synchronous, zero-IO engine**. Same input + same options ⇒ byte-identical output is a
   load-bearing invariant relied on by its entire test suite. Every `keiko-memory-*` package is
   restricted by `.dependency-cruiser.cjs` (ADR-0019 direction rules 3a/6) to depend only on
   `keiko-contracts` + `keiko-security` — none of them may import `keiko-model-gateway`.
2. `keiko-server` is the **only** package in the dependency graph allowed to depend on both a
   `keiko-memory-*` domain package and `keiko-model-gateway` at once
   (`.dependency-cruiser.cjs:639-641`, rule `adr-0019-direction-6a-server-only-...`). Every other
   rule that allow-lists `model-gateway` (workflows, harness, evaluations, cli) excludes every
   `memory-*` package.

The model-gateway call pattern itself is not new: ADR-0044 (prompt enhancer) and ADR-0055
(context-engineering) already establish "best-effort call via `modelPortFactory`, degrade on
failure, never throw out of the enclosing function" as the proven shape, live in
`packages/keiko-server/src/chat-compaction-model-summary.ts`. What is new here is narrower and
more consequential: **whether MemoriaViva conflict content — durable, potentially
user-disclosed, `provenance`-classified memory — is permitted to cross that boundary at all**, and
under what gate. ADR-0116/ADR-0117 are the precedent for MemoriaViva's env-gated rollout
mechanics, but neither one sends memory content to a model; this is the first MemoriaViva feature
that does.

## Decision

We will implement the advisory suggestion entirely in `keiko-server`, as a best-effort enrichment
pass that runs after the pure engine returns and before the job is finalized, gated by a
fail-closed sensitivity rule and a new default-off environment flag.

1. **No engine changes.** `runConsolidation` / `detectConflicts` stay untouched, synchronous, and
   byte-identical. The existing `ConsolidationSummaryGenerator` hook (`types.ts:134-145`) is
   **not** reused — it is a synchronous port scoped to merge-body text generation, not decision
   advisory; forcing it to support an async gateway call would require making `runConsolidation`
   itself async, a breaking change to every consolidation caller and test, disproportionate to
   this issue. This is a disclosed non-reuse decision, not an oversight.
2. **Additive contract field.** `ReviewItem` (`keiko-memory-consolidation/src/types.ts`) gains
   `suggestedResolution?: { recommendedWinnerId: MemoryId; rationale: string }`. The pure engine
   never populates it. The identical field is mirrored onto
   `MemoryConsolidationReviewItemWire` in `packages/keiko-contracts/src/memory-consolidation-wire.ts`,
   the file that already mirrors `ReviewItem` field-for-field for the wire boundary.
3. **Server-side enrichment, gated.** In `memory-consolidation-handlers.ts`'s `scheduleJob`, after
   `runConsolidation` returns and only when `KEIKO_MEMORY_CONFLICT_ADVISORY=1`, a new module
   (`memory-conflict-advisory.ts`) enriches eligible `ReviewItem`s using `deps.modelPortFactory`,
   mirroring `chat-compaction-model-summary.ts`'s `AbortController` + timeout race. Enrichment
   failures are logged via `emitServerDiagnostic`/`serverDiagnosticFromError` with a dedicated
   `source` tag and never thrown; `server.ts`'s top-level catch is not involved and does not need
   to be.
4. **Eligibility carve-out, not a fabricated confidence score.** `conflicts.ts` never computes a
   numeric confidence for `potential-conflict` pairs. Rather than inventing one, eligibility reuses
   the evidence the engine already attaches: every `multi-way-duplicate` item is eligible; a
   `potential-conflict` pair is eligible **unless** its evidence is exactly one entry of kind
   `negation-polarity` (`conflictEvidenceForPair`, `conflicts.ts:204-213`) — a clean "X" vs. "not
   X" flip, which Issue #2130's own Purpose section says already gets adequate heuristic coverage
   ("clusters that are not a clean negation flip ... the human reviewer gets no assistance"). This
   is free (reuses an existing field) and non-arbitrary (grounded in the issue's own carve-out
   language, not a new heuristic).
5. **Fail-closed sensitivity gate: public-only.** Before any model call, skip the entire
   `ReviewItem` (no call issued) if **any** memory referenced by `relatedMemoryIds` /
   `sourceMemoryIds` has `provenance.sensitivity !== "public"`. This is the strictest of the two
   existing idioms in the codebase — stricter than `isPersistableMemoryCandidate`
   (`memory-capture-policy.ts:52-63`, excludes only `restricted`) and matching `shouldPromote`
   (`keiko-memory-governance/src/maintenance.ts:211-217`, requires exactly `public`). It is also
   consistent with the classification policy's own stated semantics
   (`keiko-memory-capture/src/policy.ts:10,68`: "ANY non-public sensitivity flips the approval
   flag"). Issue #2130 explicitly leaves `confidential` as "pending security review" rather than
   pre-approved; public-only is the correct reading until a dedicated review broadens it.
6. **Redact both directions, not just gate on sensitivity.** The sensitivity gate stops content
   that is already classified non-public; it does not guarantee a `public` body is free of
   incidental secrets a human simply did not flag. Mirroring
   `chat-compaction-model-summary.ts`'s `buildSummaryPrompt`/`redactedString`: every memory body
   assembled into the outbound prompt is passed through `deps.redactor` first. Mirroring that same
   file's `sanitizeSummaryContent`/`normalizeSummaryText`: the model's returned `rationale` is
   passed through the same redactor plus a code-fence / pseudo-role-marker / length-cap sanitizer
   before it is allowed onto `suggestedResolution.rationale`. Sanitizer rejection is an
   `"invalid-response"` outcome, never a partial or best-guess acceptance. This is also what makes
   Issue #2130's Deliverables constraint ("no verbatim reproduction of memory bodies beyond what
   the reviewer already sees") actually enforced rather than merely intended.
7. **Env flag.** `KEIKO_MEMORY_CONFLICT_ADVISORY`, default OFF, resolved once via a small pure
   function mirroring `memorySemanticizationMultipliers(env)`'s shape (ADR-0117 D3).
8. **Bounded execution that respects cancellation.** The synchronous engine already exits early
   when `cancellationSignal()` returns true, polled once per cluster
   (`ConsolidationOptions.cancellationSignal`, `types.ts`). Once `runConsolidation` returns, that
   polling stops — but this design inserts a real, multi-second network window (model round trip)
   into a job state (`"running"`) that was previously milliseconds-long. `handleCancelConsolidationJob`
   only cancels synchronously for a `"queued"` job; for a `"running"` job it just flips
   `cancelRequested` and returns, with no code path that currently re-checks that flag once the
   engine call has already returned. We will (a) cap the number of advisory calls issued per job to
   a small bounded constant (analogous in spirit to `DEFAULT_MAX_CLUSTERS_PER_RUN`) and run them
   with limited concurrency rather than unbounded parallel calls, and (b) re-check
   `registry.get(jobId)?.cancelRequested` immediately after the advisory pass and before
   `finalizeTerminalJob`, finalizing as `"canceled"` if the flag flipped true during the window —
   so a cancel issued mid-advisory is honored instead of silently ignored. (Registry capacity
   eviction is not an added risk: `enforceCapacity`/`oldestTerminalJobId`
   (`memory-consolidation-registry.ts:96-105`) only ever evict **terminal** jobs; a job awaiting an
   advisory call is still `"running"` and cannot be evicted out from under the continuation.)
9. **Per-item degrade taxonomy, not a job-level flag.** An item that does not receive a suggestion
   because it was skipped by the per-job advisory cap is a different situation from one skipped for
   sensitivity, one that timed out, or one whose model response was rejected — and different again
   from `ConsolidationResult.truncated` (which is about vault selection, not advisory capacity). We
   will not overload `truncated` for this. Each item's internal advisory result carries its own
   reason (`"not-configured" | "sensitivity-blocked" | "timeout" | "model-call-failed" |
   "invalid-response" | "budget-exceeded"`); only a `"suggested"` outcome populates the wire field,
   every other outcome leaves it `undefined` — a byte-identical-shape degrade — and is logged
   server-side, never surfaced as a job-level error.
10. **UI never pre-selects.** `MemoryConsolidation.tsx` renders the suggestion, when present,
    visually distinct from and without pre-selecting `ConflictResolutionControl`'s own action. The
    human reviewer's existing accept/reject/resolve-conflict actions are unchanged in every
    respect; this ADR does not touch the "3+ member clusters always require operator review" rule.

## Consequences

### Positive

- Reviewers get assistance exactly on the clusters that need it (ambiguous ones), at zero cost and
  zero trust exposure on the clusters the engine already helps with a clean negation flip.
- The trust-boundary crossing is bounded on every axis that matters: content class (public-only,
  fail-closed), call shape (existing proven `modelPortFactory` best-effort pattern), blast radius
  (default-off env flag, additive contract field, unchanged reviewer actions), and observability
  (per-item degrade reasons, never a silent failure).
- Zero changes to the pure consolidation engine or its invariants; zero new dependency edges beyond
  the one edge (`keiko-server` → `keiko-model-gateway`) that already exists and is already the only
  legal place for this call.

### Negative

- Adds a real multi-second network-bound window inside a job state that was previously always
  fast, which is new operational surface (timeouts, partial availability, gateway load) for a
  feature whose value is "helps reviewers decide faster," not correctness-critical.
- The cancellation-during-advisory gap (D8) is a genuinely new race that did not exist before this
  feature and must be closed as part of this implementation, not treated as acceptable residual
  risk.
- A second, independent conflict re-validation already exists downstream at resolution time
  (`keiko-memory-governance`'s `detectConflictPair`, disclosed pre-existing fragility, unrelated to
  and unchanged by this ADR) — the advisory suggestion can in rare cases recommend a resolution
  that the resolution-time validator later disagrees with. This is a pre-existing limitation, not
  introduced here, and is called out so it is not mistaken for a defect in this feature.

### Neutral

- The env flag follows the ADR-0117 rollout shape (D3: initial opt-in, not a post-rollout rollback
  lever like `KEIKO_MEMORY_FUSION`), so flipping the default later is a separate, evidence-gated
  decision, not implied by this ADR.
- `confidential`-sensitivity content remains out of scope pending a dedicated security review, per
  Issue #2130's own Out-of-Scope section; broadening the gate is a follow-up decision, not a
  reinterpretation of this one.

## Alternatives Considered

### Alternative 1: Async-ify or repurpose the existing `summaryGenerator` port

- **Pros**: Reuses an existing, already-designed extension seam instead of adding a new module.
- **Cons**: `ConsolidationSummaryGenerator` is synchronous by contract and scoped to merge-body
  text, not decision advisory; making it async would force `runConsolidation` itself to become
  async, breaking every existing consolidation consumer and test and forfeiting the
  byte-identical-output invariant the whole package is built on.
- **Why rejected**: The blast radius (breaking the pure-engine contract for every caller) is wildly
  disproportionate to one advisory field on ambiguous items.

### Alternative 2: Perform the model call inside `keiko-memory-consolidation` itself

- **Pros**: Keeps advisory generation co-located with conflict detection; one fewer cross-package
  hop.
- **Cons**: Requires adding a `keiko-model-gateway` dependency edge to a `keiko-memory-*` package,
  which `.dependency-cruiser.cjs` direction rules 3/6 forbid for every memory package by design
  (ADR-0019); also breaks the pure/synchronous/zero-IO invariant the package's entire test suite
  assumes.
- **Why rejected**: Violates an enforced architectural boundary and a load-bearing purity
  invariant for no compensating benefit — `keiko-server` is already the one place allowed to hold
  both dependencies.

### Alternative 3: Send every `potential-conflict` / `multi-way-duplicate` item unconditionally (no negation-only carve-out)

- **Pros**: Simpler eligibility rule; no special-casing of evidence shape.
- **Cons**: Spends trust-boundary exposure and gateway cost on a class of conflicts (clean
  negation flips) that the issue's own Purpose section says already gets adequate heuristic
  coverage; every unnecessary call is also an unnecessary chance for the sanitizer to reject a
  response or the timeout to fire, for a case where the reviewer did not need help.
- **Why rejected**: The carve-out is free (an existing field, one length/kind check) and is
  directly grounded in the issue's own text, not a fabricated heuristic — there is no real
  simplicity being traded away.

### Alternative 4: Gate on "confidential-or-below" (exclude only `restricted`) instead of "public-only"

- **Pros**: Matches `isPersistableMemoryCandidate`'s existing capture-time threshold; would let
  more clusters receive advisory help.
- **Cons**: Weaker than the codebase's own precedent for irreversible externally-visible actions
  (`shouldPromote` requires exactly `public`); the classification policy module's own comment
  states any non-public sensitivity "flips the approval flag" — i.e., `confidential` is already
  treated as requiring a human gate, not as safe-by-default; Issue #2130 explicitly marks
  `confidential` as "pending security review," not pre-approved.
- **Why rejected**: Sending memory content to an external model call is a different, one-way kind
  of exposure than an internal capture-time promotion; the fail-closed reading is required until a
  dedicated review says otherwise, and this ADR is that review's outcome for `public` only.

## Related

- ADR-0019: package dependency direction and domain-package isolation (the boundary this design
  operates inside).
- ADR-0044: prompt-enhancer architecture (origin of the `modelPortFactory` best-effort call shape).
- ADR-0055: context-engineering orchestrator/harness wiring (second precedent for the same call
  shape).
- ADR-0116: realtime voice live memory recall (MemoriaViva env-gated rollout precedent).
- ADR-0117: type-aware memory decay / semanticization (env-gate resolver-function shape this ADR's
  `KEIKO_MEMORY_CONFLICT_ADVISORY` mirrors).
- Issue #2130 (the request and mandatory stop condition this ADR discharges).

## Date

2026-07-08
