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
subjects. Models share the existing local gateway and execute chronologically rather than creating
concurrent inference load.

`--duration-ms`, `--cycles` and `--repetitions` support explicit diagnostic smoke runs. A shortened
run does not qualify the default duration/cycle acceptance. Predeclared metadata records those
settings. Unobserved compaction and failed requests remain recorded; a terminated campaign is not
a successful qualification. Read the complete ledger, not just its successful answer rows.

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

There is **no completed multi-hour baseline, post-compaction recall result, candidate comparison,
MCP live qualification or production-readiness claim yet**. Update this section only from actual
recorded runs.

## Code-grounded audit hypotheses

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
