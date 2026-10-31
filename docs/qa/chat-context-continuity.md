# Chat context continuity: baseline and paired qualification

Tracking: task #4155, parent epic #4154. Related provenance work: #2956.

## Delivery contract

Owner direction, 30 October 2026: measure the unchanged product first, publish the baseline, then
repair verified defects and repeat the same measurements. Keep the working pull request against
`dev` open for incremental review. Native auto-merge remains off.

The product source baseline is `e153759e6` (Keiko 1.3.3). Initial changes are qualification tooling
and tests only. Subsequent iterations repair measured defects and preserve the original subject.

Owner clarification: implementation and measurement proceed iteratively. A complete long campaign
does not block a repair already supported by a reproducible before case. The original product is
preserved in a separate checkout at `67638d66e`; its benchmark uses its own build, dependencies and
private state, so development cannot replace its executable subject.

## Iteration measurements

The quality scale is 0–10 for each explicitly named measurement, calculated as ten times its pass
fraction on the same frozen cases. Scores name their scope, case count, model where relevant and
unmeasured areas. A narrow score is not an overall production-readiness claim. An expanded matrix
receives a new version and is replayed on the baseline as well as the candidate.

| Iteration | Measurement                                                     | Before       | After         | Evidence                                                                                                                   |
| --------- | --------------------------------------------------------------- | ------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1         | Literal identifier retrieval, eight fixed producer-level cases  | 0/8 = 0.0/10 | 8/8 = 10.0/10 | Failure-first history suite: identifiers, Unicode dash, abbreviation, numeric/version and substring/punctuation cases      |
| 3         | Operational persistence, four fixed native-producer regressions | 0/4 = 0.0/10 | 4/4 = 10.0/10 | Audit retention/failure, newer captures and late turn completion; this selected defect suite is not a global quality score |

This iteration also passes current-policy credential-floor, exclusion and body-free logging checks.
The complete targeted history/content/continuity run passes 55 tests across three files. The
eight-case score measures retrieval availability; it does not claim live-model answer accuracy,
complete-history recall or a composite score for the remaining work.

The paired native-producer observations are retained as
[`iteration-00-structural.json`](evidence/4155/iteration-00-structural.json) and
[`iteration-01-structural.json`](evidence/4155/iteration-01-structural.json). Their harness and case
digests match exactly. The candidate was measured at `ba6f321e0`, before synchronizing subsequent
upstream `dev` changes, so this isolated delta is attributable to the retrieval iteration.

### Iteration 2: summary timing and duplicate work

The unchanged isolated runtime emitted six `SummaryRejected` diagnostics with reason `timed-out`
by the retained snapshot. The subject's detached summary timer is 15 seconds. This is observed
runtime evidence, not a claim that every attempt failed: the snapshot does not establish the total
attempt denominator. The body-free observation, source/build identity and exact selected diagnostic
fields are retained in [`iteration-00-summary-timeouts.json`](evidence/4155/iteration-00-summary-timeouts.json).

Two failure-first cases reproduce the defects: a healthy result after 20 seconds is discarded,
and two concurrent identical enrichments invoke the model twice. The candidate instead derives
the backstop from the existing normal buffered Gateway budget plus the shared transport grace,
bounded by the platform timer ceiling. It adds no Coding outage policy. Tests cover the buffered
floor, a larger configured timeout, overflow protection, cancellation and the unconfigured fallback.

Identical in-flight work is coalesced inside the exact handler graph and current configuration
identity. Existing `depsRoot` bindings let request-scoped copies share their composed owner; changed store/evidence/model-port views remain isolated. Keys include chat, model, safe prompt hash, response mode, source revision/boundary and
source-reference hash. Only transient hashes and ownership state are retained; there is no new
persisted response cache. Changed inputs/scopes remain separate, and failure releases the key so
the work can retry. Existing validated checkpoint reuse remains separate from this optimization.

The graph's existing disposal path cancels and drains detached summaries before disposing services.
A queued job cannot start after disposal, and an already-resolved response cannot persist after
shutdown begins. The existing four-job admission bound remains. `chat.compaction.summary.work`
records the chosen deadline, monotonic local duration, planned UTF-16 prompt size, whether the model
port was called, and a closed outcome. `accepted` means output validation succeeded; it does not
certify source coverage, semantic accuracy or durable checkpoint persistence. `coalesced` is not
provider KV-cache reuse and does not imply a cached-token count.

The six-file targeted run passes 107 tests, including bound request-copy and narrowed-store/model-port cases. An additional five-file Chat/dependency regression run passes 402 tests. The native-model success-rate delta and global quality
score remain open. This timing repair does not fix the separately measured sampled-source coverage.

### Iteration 3: required private continuity

Four native-producer regressions fail on `538eec7f079a1241185c9f77b2d6058e1db86315`:
audit retention removes the operational summary; enrichment disappears behind a newer capture
of the same prefix; audit-write failure breaks manual compaction; and late completion of an
earlier pending turn leaves a checkpoint's revision unchanged. The same four cases pass after
the private-checkpoint repair. This is a targeted robustness result, not a global quality score.

The candidate stores operational continuity in the existing private SQLite store, independently
of audit retention. Revision/boundary bindings, atomic generation checks, payload integrity,
the existing content projection and credential floor apply. Tests additionally cover reopen,
newer-summary races, cross-chat boundaries, canonical edits/deletion, unknown-field removal,
damaged state and body-free evidence. Buffered and streaming public handlers refuse to call
the model when the required private write fails; streaming reports an error instead of success.

The final broader run passes 264 tests in nine files. A separate public-handler fault run
passes 13 tests. Typecheck and the complete Activity Log gate pass, including its architecture,
negative-architecture and error-observability checks. Retrieval quality, grounded retrieval,
grounded faithfulness and ADR-index gates also pass. Delivery gates are recorded in the PR when
they finish. Full-prefix summary coverage, manual summary generation and native recall improvement
remain separate work; this repair does not establish them.

### Iteration 4: enforce the rendered recall budget

A failure-first test on `972f30e5ba0a07926a2e88648f857a7474a7e112` reproduces **854 locally
estimated tokens against an 800-token limit** with eight eligible candidate messages. The one-
and three-candidate controls already pass. The estimator changes its density floor for multiline
text, so adding estimates for individual lines undercounts the final block.

The candidate checks the complete chronological rendering, including its header and source
labels, before accepting each additional excerpt. All three cases pass, alongside 104 additional
checkpoint/summary/history tests. Recall evidence now explicitly reports the local-estimate
measurement source, configured budget and excerpts omitted by that budget. This verifies the
bounded excerpt renderer; provider token accuracy, historical discovery coverage and model
recall quality remain separate measurements.

### Unchanged native baseline: interim recall loss

The first hash-matched v4 re-score covers 23 recorded probe answers from the unchanged frozen
subject. All three prompt digests match the frozen corpus; all answer hashes match the private
SQLite snapshots. Re-scoring changes no result. Qwen plain Chat scores **2/9** after both its
fifth and sixth observed compaction. Seven early fields are explicitly unknown; only the two
later corrected fields remain correct. The originals remain stored, so this establishes failed
working recall, not irreversible deletion of all source messages.

This is an interim snapshot, not the completed ten-cycle/restart qualification. Native request
failures are retained separately. Grounded probes currently ask about conversation facts; they
do not establish source-answer accuracy. No model average or global 0–10 claim is derived from
these observations.

### Iteration 6: indexed canonical archive discovery

Two failure-first production-producer cases on `32b117e1c` place a German fact at the beginning
or middle of 50 completed turns, beyond the recent 1 MiB scan. Both return no excerpt despite
all 102 original messages remaining stored. With bounded indexed discovery both find the fact;
the recent scan ceiling and complete-block 800-token estimate budget remain unchanged.

The existing private SQLite store owns complementary external-content word/trigram indexes.
Migration, current assistant-response edits and cascading deletion maintain them transactionally.
Short literal identifiers and internal German compounds are tested. A canonical user anchor
preserves ordering when assistant timestamps are skewed, including a later duplicate claim.

Two additional failure-first cases show why admission must precede the candidate budget: 80
matching pending or orphan assistant rows initially crowd out the completed original. Both pass
after adding the canonical/legacy admission prefilter; actual turn resolution still rechecks it.
Store tests also cover cross-chat isolation, invalid query syntax, reopen, old-data backfill and
FTS integrity. The schema inventory explicitly includes the two virtual indexes and their eight
shadow tables; the all-table credential-column sweep remains intact.

This fixes measured archive-discovery cases. Native before/after model quality remains to be
measured. Giant single-message interior retrieval, complete model-summary source processing and
the full source/security matrix remain separate acceptance work; full coverage is not claimed.

## Measurement design

### Reusable two-model laboratory and offline comparison

The existing native laboratory runs both configured Chat subjects, Gemma and Qwen, through the
same plain/grounded corpus. Model-specific outcomes remain separate. Required operational state,
original-message eligibility and checkpoint safety are model-independent invariants; summary
fidelity, effective token limits and latency still require qualification per model.

Every campaign phase now carries its trial identity. Previously, pressure/cycle/failure identifiers
omitted the repetition number, so separate short campaigns reused the same identifiers. The
laboratory now persists an independent result, scored probes, failures and elapsed time for each
repeat. Long-campaign outcomes are captured before short repetitions begin, so later work cannot
change the point at which they were qualified. Existing interrupted artifacts remain unchanged.

Offline analysis requires no BFF, model, browser or container:

```bash
node scripts/testing/coding-workbench-lab/chat-continuity-report.mjs \
  --baseline /private/baseline/ledger.json --output /private/baseline-report.json
node scripts/testing/coding-workbench-lab/chat-continuity-report.mjs \
  --baseline /private/baseline/ledger.json --candidate /private/candidate/ledger.json \
  --output /private/comparison.json
```

Reports bind their input and corpus manifests with SHA-256 and identify their analysis module.
Outputs are fresh private files; existing reports and input ledgers cannot be overwritten. Raw
answers, private chat objects and unknown input fields are not copied. Comparisons reject changed
model rosters, configuration, hardware, content policy, schedule, prompt digests or oracle digests.
Different oracle versions require a separately hash-matched common re-score before comparison;
the report does not silently reinterpret them. Unequal observed probe coverage produces no numeric
gain. Recall ledgers alone establish no causal latency improvement.

The 0–10 observed score is ten times accepted critical answers divided by scored critical questions,
reported separately for controls, cycle probes and restart. Missing measurements are null.
Execution failures, planned/observed repetitions and qualification remain separate. An observed
score of 10 does not erase failed requests or missing tests. This nine-field fixture supplies no
global production-quality grade, supplementary-detail acceptance or complete source/security proof.

All 37 retained native answers from the terminated unchanged baseline have now been re-scored
under the same v4 oracle. Each answer hash matches its private canonical snapshot; each initial
agreement remains stored, and no score changes. The observed cycle-probe results are:

| Model / lane   | Correct / questions | Observed score / 10 | Cycles | Execution failures |
| -------------- | ------------------- | ------------------- | ------ | ------------------ |
| Gemma plain    | 27 / 27             | 10.00               | 3      | 3                  |
| Gemma grounded | 90 / 90             | 10.00               | 10     | 2                  |
| Qwen plain     | 46 / 90             | 5.11                | 10     | 0                  |
| Qwen grounded  | 89 / 90             | 9.89                | 10     | 0                  |

Qwen plain's final probe is 2/9 (2.22/10). Restart and five short repetitions are missing; every
lane remains unqualified. Grounded questions here measure conversation facts rather than source
answer accuracy. Improvements to laboratory accounting are not model-quality improvements.

### Resumption delivery checks

The earlier CI source-inventory failure is reproduced and repaired by refreshing only the source
count, from 980 to 982 server files. Every coverage metric and governed floor remains unchanged.
The support-code inventory is regenerated from current product sources. Repeated optional-field
projection logic is extracted behind explicit key allowlists; unknown fields remain excluded and
current redaction still applies. The semantic-duplication baseline only shrinks, from 921 to 917
groups. The reported editor-breakpoint browser case is attempted locally but requires Linux
Bubblewrap enforcement; macOS does not provide a success result for that required proof.

The existing connected-chat laboratory supplies authenticated application pairing, native BFF and
Gateway composition, the existing HTTP observation proxy, provider credential resolution, and
graceful lifecycle cleanup. No customer chat or external source is used. Credentials stay in the
native resolver and child environment; reports contain no credential, endpoint, prompt or answer.

The predeclared German corpus includes nine independently scored fields: project, owner, short
identifier, corrected budget, corrected date, initial decision, rejected alternative, pending step,
and a data-locality restriction. Initial facts and subsequent corrections use ordinary Chat sends.
Pressure notes contain no oracle answers. Plain and grounded Chat use the same agreements.

Recall probes execute against isolated SQLite online-backup snapshots and copied synthetic evidence.
Probe answers never enter the longitudinal chat. This prevents the measurement from repeatedly
teaching its own answers to the subject under test. The original private project identity and
checkpoint/message ownership remain unchanged inside each snapshot.

The answer oracle reports bounded lexical checks, not universal semantic correctness. A JSON object
and matching expected values establish only those predeclared fields. General-detail accuracy,
contradiction handling and source entailment need their own independent evaluation; they must not
be inferred from the nine-field score.

## Running the qualification

Provision and build the checkout with the root lockfile and repository prerequisites first.
Before starting consumers of package `dist`, create a forced-build provenance record:

```sh
node scripts/testing/coding-workbench-lab/chat-continuity-build.mjs --build
```

Both measurement commands reject dirty product inputs, missing provenance and changed compiled
output. Git is explicitly bound to this checkout. The record binds sorted tracked input paths and
content hashes, the observed package distribution, compiler metadata and Node version. A later
documentation-only commit may reuse an otherwise matching build record. The initial legacy runs
predate this guard; their provenance limitations remain explicit rather than being relabeled.

Choose a new private output directory outside the checkout and an explicit existing configuration.
The synthetic source project inside that directory must also pass Keiko's existing source-root
deny-list. Agent configuration directories such as `.codex` are deliberately refused.

```sh
node scripts/testing/coding-workbench-lab/chat-continuity-run.mjs \
  --phase baseline \
  --config /absolute/private/keiko.config.json \
  --output /absolute/private/new-baseline-directory
```

Defaults are a minimum two-hour longitudinal run, at least ten observed compaction cycles per
plain/grounded campaign, and five additional short repetitions per configured Chat model. Models
are read from the native configuration; embedding and voice models are not mislabeled as Chat
subjects. This first fixture copies only Chat providers: embedding, speech, enabled Memory and
actual MCP/source-result competition still require their separate qualifications. Its grounded
scope binds a synthetic document but does not by itself prove use of document evidence. Models
share the existing local gateway and execute chronologically rather than creating concurrent
inference load.

`--duration-ms`, `--cycles` and `--repetitions` support explicit diagnostic smoke runs. A shortened
run does not qualify the default duration/cycle acceptance. Predeclared metadata records those
settings. Unobserved compaction and failed requests remain recorded; a terminated campaign is not
a successful qualification. Read the complete ledger, not just its successful answer rows.
Failed campaigns stop after three execution failures; completed peers stop consuming model calls.
The final result includes control, cycle and post-restart recall, duration/count bounds and short
repetitions. Missing or incorrect critical fields leave the fixture qualification incomplete and
produce a nonzero exit status. Ledger replacement uses a private temporary file and atomic rename;
a failed replacement preserves the last complete snapshot. Provider observations retain only
nonnegative integer input/output/total token counters and closed finish categories.

The HTTP observation deadline is derived from the answering provider's existing buffered/streamed
Gateway budgets, with a transport grace, and recorded per model. It must not silently cut a native
model attempt short. SIGINT/SIGTERM cancel requests and drain waits, retain a terminated ledger and
close the owned private BFF. Final success is persisted only after runtime cleanup succeeds.

Oracle revision `chat-continuity-v2` rejects mixed obsolete/current amounts or dates and numeric
substrings. Its manifest hashes positive and forbidden patterns including flags. The model-facing
prompts are unchanged. Scores from the legacy `v1` run need re-evaluation from matching private
probe answers under this oracle before comparison; they are not silently treated as `v2` results.

Oracle revision `chat-continuity-v3` additionally accepts equivalent euro spellings such as
`8100 Euro` and `€ 8.100`. Four failure-first cases reproduce the earlier false negatives,
alongside a previously accepted formatting control;
ambiguity and obsolete-value rejection remain enforced. Model-facing prompts are unchanged.
The isolated ongoing baseline retains its frozen `v2` oracle. Before comparison with a `v3`
candidate, re-score matching private baseline answers under `v3`, retain both scores and their
answer hashes, and report this oracle-only change separately from product improvements.

Oracle revision `chat-continuity-v4` adds clause-scoped decision-polarity checks, including Unicode
normalization. Reversed local-queue selection or external-fulltext rejection must not receive a
positive score merely because the expected nouns occur. Supported negated-opposite forms and
separate explanations about the other option remain accepted. The manifest identifies the rule
patterns, normalization and algorithm; the campaign also hashes the complete corpus module.
This remains a bounded lexical oracle, not a universal semantic judge. Preserve frozen v2/v3 runs
and re-score hash-matched answers under the common v4 oracle before comparison. Model-facing
prompts remain unchanged.

For the candidate, rerun with `--phase candidate`, the same corpus and equivalent configuration,
hardware and workload. Keep the original baseline artifacts immutable. Compare individual models
and modes separately; report changes of model, configuration or environment explicitly.

## Initial measured observations

| Subject                                | Actual result                                                                           | What it establishes                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Existing focused context/tool suites   | 194 tests passed across 7 files; 22.74 s                                                | Existing structural regression checks pass on the unchanged product          |
| Existing context-quality gate          | Passed; 2 allocator scenarios; 3 evicted repository files                               | Its fixed structural corpus satisfies its declared invariants                |
| Existing chat compaction latency probe | p95 11.73 ms in this run                                                                | Local deterministic assembly latency only; not provider or user-turn latency |
| Preliminary Gemma plain-chat control   | 9/9 declared fields before pressure                                                     | A positive control can recover the initial agreements and later corrections  |
| Preliminary runtime smoke              | Incomplete: the synthetic source root was inside a denied agent configuration directory | A laboratory setup defect, not evidence of a product-compaction defect       |

The initial runtime smoke used an earlier laboratory revision. It is retained as a preliminary
attempt, not promoted into the frozen baseline. It observed slow startup/readiness and real model
calls; those costs must remain distinguishable from compaction cost in the final report.

The legacy productive-API campaign recovered all nine declared fields in each of the four
before-pressure controls (Gemma/Qwen, plain/grounded) under its original oracle. After the first
manual compaction, both Gemma modes and Qwen plain scored 9/9; Qwen grounded scored 8/9, explicitly
reporting the rejected alternative as unknown. This is an observed score difference, not yet a
causal separation of model variability from compaction loss. The positive results also show why a
large reduction in occupancy alone does not establish forgetting.

The first nine completed probes were independently re-scored under oracle v2 after matching each
private SQLite answer to its recorded hash. Their scores were unchanged. The legacy run was then
stopped as a preliminary attempt: its fixed six-minute client deadline was shorter than the native
Gateway's ten-minute buffered-attempt floor and caused client cancellations. Its complete available
ledger, private probe databases, termination observation and uncertain in-flight call remain retained.
It is not a completed long-run qualification. Root verification also overlapped this preliminary
run; its timings cannot be presented as isolated compaction cost.

There is **no completed multi-hour baseline, repeated-compaction acceptance, candidate comparison,
MCP live qualification or production-readiness claim yet**. Update this section only from actual
recorded runs.

## Reproducible structural baseline

The existing producer functions can also be observed without contacting a provider:

```sh
node scripts/testing/coding-workbench-lab/chat-continuity-structure.mjs \
  --output /absolute/private/new-structural-baseline.json
```

The model port in this structural probe returns a fixed synthetic result. It measures which source
messages reach that port and what the real checkpoint producer records, not model comprehension.
Original source messages are created through the native UiStore and remain present after the probe.

Measured on the unchanged product tree, with 40 eligible source messages:

| Observation                                                        | Result                                                               |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Pure short-identifier recall                                       | No excerpt returned for `Q7-42?`, although the original exists       |
| Source-message witness markers delivered to the summary model port | 12/40 (30%)                                                          |
| Persisted model-summary `coveredItems`                             | 40, with status `valid`                                              |
| Explicit all-history projection                                    | 40 originals become 1 gateway summary; 0 originals retained verbatim |
| Projection token counts                                            | 30,480 before; 946 summary tokens after                              |
| Canonical originals after measurement                              | All 40 still present                                                 |

The 40-item declaration must not be interpreted as 40 source messages actually supplied to the
summary model. The marker observation demonstrates a coverage distinction that the existing record
does not express. The all-history reduction demonstrates compression size and source availability,
not semantic loss by itself. These observations are independent of live-model answer quality.

The retained body-free artifact is
[`evidence/4155/structural-baseline.json`](evidence/4155/structural-baseline.json). Its product-tree
digest identifies the unchanged production subject even though its source head includes laboratory
tooling. Measurement tests check actual model-port input, canonical-message preservation, body-free
output and repeatability; they deliberately do not pin today's missing recall or partial coverage
as behavior that future repairs must preserve.

An independently repeated observation after forced-build attestation produced identical structural
results. Its source/distribution/compiler hashes use the new canonical digest method and are retained
in [`structural-baseline-attested.json`](evidence/4155/structural-baseline-attested.json). The original
artifact remains immutable; its older commit-tree digest is a different measurement method.
The original predates build attestation: no distribution, compiler, Node or build-provenance fields
were removed from it. It cannot establish a forced-build distribution identity. The attested
companion supplies that independent proof; current reproduction commands emit the complete new
shape. Tests additionally require the summary to exist and discover its evidence through the
store inventory rather than duplicating the productive run-id formula.

## Remaining code-grounded audit hypotheses

These are targets for controlled reproduction, not established causes of a reported customer loss:

- Automatic compaction starts at 90% of effective input budget and targets 70%.
- Manual maintenance currently folds the entire eligible history and does not directly schedule
  model enrichment.
- Model-summary input samples at most 16 turns, truncates long turns to opening/closing fragments,
  and applies an overall source bound. Its main summary text is limited to 1,200 characters.
- Grounded conversation continuity has a separate lane capped at 8,000 tokens or a third of input.
- Query-based history rehydration has lexical and bounded-scan limits; short identifiers and
  indirect references need explicit tests.
- Tool-loop token usage accumulates across model calls. Per-request occupancy must remain separate
  wherever that usage reaches the context meter.
- Continuity checkpoints currently depend on best-effort evidence persistence. Required operational
  continuity must be tested independently from audit-retention availability.

## Memory boundary

Context engineering is working-state management and can supply candidate knowledge to Memoria Viva.
Surviving several compactions establishes neither truth nor long-term relevance. Any later promotion
must retain original provenance, correction precedence, uncertainty and scope, and use the existing
memory capture/governance path. This qualification grants no new memory-promotion authority.

## Primary grounding

- [Anthropic: effective context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
- [Anthropic: compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [OpenAI: compaction](https://developers.openai.com/api/docs/guides/compaction)
- [The Compaction Cliff in Long-Running AI Agent Memory](https://arxiv.org/abs/2608.22752)

Provider-native features are compatibility-dependent comparators. Their existence is not evidence
that the configured local providers implement them or that Keiko's current paths invoke them.

Recent research informs explicit experiments, independently of provider guides:

[LongMemEval (ICLR 2025)](https://arxiv.org/abs/2410.10813v2) motivates separate extraction,
cross-session/temporal reasoning, updates and abstention cases. [LoCoMo](https://arxiv.org/abs/2402.17753)
adds long-range event/causal continuity and multimodal evaluation as useful experiment dimensions.
The current nine-field corpus does not claim to implement either complete benchmark.

| Primary work                                                      | Published/version date                               | Implication to test in Keiko                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [JustMem](https://arxiv.org/abs/2609.19877)                       | 17 September 2026; preprint                          | Vary discovery breadth and recover original evidence when a compact representation is insufficient                             |
| [TRACE](https://arxiv.org/abs/2608.06503)                         | Revised 14 October 2026; preliminary empirical study | Compare paired continuations at the same compaction boundary to separate state-loss effects from model variability             |
| [Compact-Bench v2](https://arxiv.org/abs/2610.31710v2)            | Revised 28 October 2026; preprint                    | Measure task continuation and recurring details separately; compare extractive retention with generated summaries              |
| [Bud ContextCompact 2.0](https://arxiv.org/abs/2610.25516)        | 18 October 2026; preprint                            | Test protected literal channels, complete newly folded spans and early enough triggers; measure summary latency and cache cost |
| [Rate–distortion view](https://arxiv.org/abs/2607.08032)          | 9 July 2026; survey/proposal                         | Evaluate task utility lost at each budget rather than the compression ratio alone                                              |
| [Continuous Context Management](https://arxiv.org/abs/2609.35540) | 28 September 2026; preprint                          | Treat per-turn compaction as an experimental arm; its untrained performance varies by model                                    |

Reported benchmark gains are the respective authors' results, not Keiko measurements. These papers
motivate experiments and acceptance evidence; novelty or a published claim does not establish local
production readiness. This retrieval iteration introduces no new persistent-memory architecture or
automatic memory promotion.

## Bounded optimization protocol (owner instruction, 2026-10-31)

The current archived-source candidate `c472621f55d43916c71ea46b69d8a888959d0b9e`
is attempt 1 of at most three consecutive attempts without a verified improvement.
A comparable increase becomes the new reference and resets that counter. Failed or
inconclusive measurements do not reset it. The current reference is Qwen Plain's
46/90 correct post-compaction fields across ten probes (5.1111/10), not a global
production-readiness score. The parent baseline campaign was terminated and does
not qualify restart/repetition or the other models by implication.

`evidence/4155/optimization-register.json` records the frozen protocol and counter.
The new full campaign retains the original two-model/four-lane schedule, native
context limits, ten-cycle/two-hour minimum, five repetitions, questions and oracle.
No threshold or question is changed to raise the score. Review admission, required
checks, error handling, privacy and source guarantees remain independent obligations.
After three non-improving attempts the owner authorized delivery closure and dev
integration subject to exact-head checks and resolved review conversations; native
auto-merge remains off.

### Retained-state replay: recovery evidence has a different scope

The reusable `chat-continuity-replay.mjs` CLI takes an explicit source ledger,
frozen subject checkout, native configuration, scored plain-chat ledger indices
and a fresh external private output directory. It checks corpus digests, verifies
the measured question and answer, removes that pair only from a private SQLite
clone, and hashes all unchanged canonical rows. It uses the ordinary authenticated
Chat route after the ordinary readiness probe, with the original question and no
expected answers. Original databases and frozen product trees remain unchanged.

The source snapshot was retained **after** the historical probe. Its inherited
derived state stays in the clone; therefore this is a cold-restart recovery test,
not an exact reconstruction of the earlier live state. In the selected historical
2/9 case, both the frozen old product and candidate answered 9/9 on identical
cloned originals. This does not establish an improvement or reset the counter.
Parallel exploratory runs caused readiness interference, were terminated and
remain in private evidence. Subsequent model comparisons run serially.

The Lab persists readiness/request/drain progress before waiting for the next
operation. An unknown persisted readiness field must never be interpreted as
proof that the request is still waiting for readiness. Missing or failed readiness
prevents Chat dispatch, and incomplete replay exits nonzero.
