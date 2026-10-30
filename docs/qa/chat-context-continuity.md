# Chat context continuity: baseline and paired qualification

Tracking: task #4155, parent epic #4154. Related provenance work: #2956.

## Delivery contract

Owner direction, 30 October 2026: measure the unchanged product first, publish the baseline, then
repair verified defects and repeat the same measurements. Keep the working pull request against
`dev` open for incremental review. Native auto-merge remains off.

The product source baseline is `e153759e6` (Keiko 1.3.3). Initial changes are qualification tooling
and tests only. There is no production continuity repair in this first increment.

## Measurement design

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
