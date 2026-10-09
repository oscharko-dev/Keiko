# ADR-0180: One bounded server-owned follow-up on declared insufficiency

## Status

Accepted (2026-10-09, Issue #3889, Epic #3881). The owner accepted the pass with the
normal-installation default **on** in the
[recorded decision](https://github.com/oscharko-dev/Keiko/issues/3889#issuecomment-6076008027).
This records the architectural decision; completion requires the integrated producer and its
current-head verification evidence.

## Context

A connected-folder answer can discover that the selected evidence omits a necessary file. Returning
that declaration immediately makes the human repeat the same request, although the server can
already validate and read an explicitly addressed file within the connected scope. Model prose
alone is neither read authority nor evidence that a file was read.

The existing grounded orchestration, explicit-path admission, prompt fitter, gateway admission and
Activity Log provide the execution and evidence boundaries. This decision extends those owners with
one bounded pass. It does not introduce a tool loop, a second workspace reader or a new capability
store.

## Decision

### D1 — Only an admitted unread declaration can trigger the pass

The server parses at most three distinct exact prose lines, `Missing evidence: [relative/path]`,
as untrusted answer data. Quoted, indented and code examples cannot declare a read. It classifies the
answer and validates every declared path through the same explicit-path admission
used for connected-folder query references. The pass requires `answerKind === "insufficiency"`, at
least one admitted unread in-scope path, and available authority and budgets.

Already-read files, malformed paths, denied sensitive files, workspace escapes and out-of-scope
declarations cannot authorize a read. A refusal, clarification or ordinary answer cannot trigger the
pass. Candidate declaration text is not a workspace command, and the model receives no workspace
tools. Selected Files exceptions retain their existing human-owned admission semantics; a model
declaration cannot create an exception.

### D2 — One additional synthesis slot, shared with marker repair

Each logical turn has at most two application-level synthesis calls: the initial answer and either
one citation-marker repair or one follow-up answer. Spending the second slot for either purpose
leaves no slot for the other. A second insufficiency answer returns with its truthful declarations;
there is no third synthesis call and no recursive follow-up.

The ceiling covers answer generation. Existing bounded entailment verification and gateway
transport or context-window retries retain their own admission and settlement contracts; they do
not grant another synthesis slot. In particular, the entailment stage in
[ADR-0144](ADR-0144-grounded-entailment-stage.md) remains responsible for claim support, and marker
membership alone never establishes entailment.

The follow-up uses the same connected scope and original authority. Retrieval, selection and prompt
assembly consume the remaining search-call, read, excerpt-byte, model-input-token and elapsed
budgets. Gateway spend, circuit, concurrency and cancellation admission still apply. High budget
pressure or insufficient remaining resources refuses the pass rather than resetting a budget.

### D3 — The default is on, with a closed off switch

`ExplorationBudget.followUpPassesMax` accepts only `0` or `1`. The server setting
`KEIKO_CONNECTED_FOLLOW_UP_PASSES_MAX` defaults to `1` for a normal installation; an explicit invalid
value fails closed to `0` and produces body-free configuration-rejection evidence. An explicit
caller budget can narrow the server limit, never widen it. Setting `0` returns the normalized first
answer and records the disabled disposition. Health and `keiko status` do not acquire a new readiness
requirement.

This setting is independent of `KEIKO_REPO_SEMANTIC_REFRESH_FILES_MAX`, whose default remains `0`.
Allowing a follow-up neither grants document embedding nor rewrites a Knowledge Pod.

### D4 — Deliver only the selected normalized answer

The existing answerer uses `stream: false` and retains a bounded provider response through
classification, declaration reconciliation and sanitization before delivery or assistant-history
persistence. Provider output limits and the existing result sanitizer bound the retained answer.
The first insufficiency answer therefore cannot appear as a partial client answer while the server
is still deciding whether to replace it.

When a pass is refused or disabled, the first normalized answer remains the final answer. When the
pass runs, the second normalized answer replaces it. Abort propagates through retrieval and the
second gateway call. Existing stream/resource, circuit and spend settlement complete before the
terminal delivery packet; cancellation or a failed extra call cannot leave an unsettled resource.

### D5 — Citation reliability is observed metadata, not authority

The existing `ModelCapability` record carries optional `citationBehaviour` with the closed values
`cites`, `cites-after-repair` and `never`; absence means unknown. The configured value is descriptive.
Skipping marker repair requires current-generation observations of actual substantive answers
with source evidence, not a persisted assertion or a readiness probe.

The server reuses the generation-owned verified-capability record for a private window of at most
eight closed outcomes. Reliability requires at least three outcomes and direct citations throughout
the retained window; a repair or missing-citation regression removes it. The observer is captured for the actual model
deployment and generation, runs once for the final outcome of an eligible turn, and ignores late
observations from a replaced deployment. Citation-only sealed metadata refinements retain this
window and the existing readiness timestamps; real configuration or deployment replacement
invalidates it.

The sealed capability configuration persists only the closed descriptor, using the existing
credential vault and configuration producer. A persistence failure leaves citation confidence
unknown and emits the existing body-free gateway diagnostic. It never creates trusted readiness,
changes tool authority, widens egress or fails resource settlement.

### D6 — Reconstruct both passes without answer or path bodies

The existing Activity Log records the first declaration and the final follow-up disposition under
the same logical turn correlation and process. `followUpPass` distinguishes initial `0` from
follow-up `1`. The original query and selected-scope identities remain stable even when the second
selection plan or prompt-pack fingerprint changes. Selection and answer companion records carry
bounded counts and closed states where the completed operation's field cap is full.

The canonical counters include `followUpPassCount`, `followUpTrigger`,
`followUpAdmittedPathCount` and `followUpOutcome`. The trigger is `insufficiency-declared` or `none`;
the outcome is `answered`, `still-insufficient`, `budget-refused`, `elapsed-refused` or `disabled`.
The second prompt receives its own `chat.context.selected` evidence and normal gateway lifecycle.
No raw declaration, source body, provider endpoint or capability-observation body enters the log.

Support reconstruction joins the real scope and logical turn across sibling operations and both
passes. An answered follow-up disposes the initial declared-unread condition even when prompt
fingerprints differ. Historical records without these fields remain unknown; new telemetry cannot
retroactively diagnose them.

## Rejected alternatives

- **Giving the model workspace tools:** would expand authority and require a separate tool loop for
  a server-owned read that the existing admission path already supports.
- **Unbounded passes or a separate repair allowance:** would permit loops and unpredictable spend
  after the original two synthesis slots were consumed.
- **Treating prose or saved citation metadata as trusted capability:** would turn unverified model
  output into read authority or suppress necessary citation validation after a deployment change.
- **Streaming the initial answer before classification:** would expose a discarded insufficiency
  answer and make final history diverge from the answer already shown to the human.

## Consequences and verification

Connected-folder chat can read an admissible missing file and answer within the same turn without
adding a model tool surface. Knowledge Pod and hybrid follow-up execution remain outside #3889;
their existing grounding and verification contracts continue to apply.

Pointed producer tests prove answered and still-insufficient outcomes, disabled and exhausted
budgets, elapsed refusal, abort propagation, denied/out-of-scope declarations, and the shared
two-call ceiling. The latency gate adds a separately budgeted follow-up scenario while retaining
all existing scenario thresholds. The Activity Log scenario exercises the actual producer twice:
disabled follow-up exposes the unread finding, and accepted follow-up answers it without that
finding. Required final gates and live-lab evidence remain completion requirements.

## Related decisions

- [ADR-0052](ADR-0052-deterministic-context-engineering-layer.md): context profiles, input fitting and
  allocation; remaining budgets are reused, never reset.
- [ADR-0022](ADR-0022-connected-context-privacy.md): selected-scope admission, evidence confidentiality
  and path-free answer summaries.
- [ADR-0144](ADR-0144-grounded-entailment-stage.md): separate membership and semantic claim support.
- [ADR-0179](ADR-0179-activity-log-package-boundary.md): one Activity Log writer and canonical reader,
  with no parallel report registry.
