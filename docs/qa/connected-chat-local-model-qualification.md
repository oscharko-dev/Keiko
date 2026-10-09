# Connected-chat local-model qualification — preparation for #3894

This is a bounded test plan, not completed qualification or closeout evidence. Reuse the existing
[LiteLLM/Gemma lab deployment](coding-workbench-lab/README.md), launcher pairing, private gateway
vault, and registered Activity Log reader. Keep the existing model services and operator
configuration unchanged. The Coding Workbench task drivers retain their `ledger-lab` guard; the
connected-chat driver exercises only project registration, chat scope, messages, and evidence.

## Stable source and measurement ownership

The orchestrator assigns one held, integrated source SHA before starting the runtime. Wait until
the search-index owner releases the CPU measurement window. Build/start and model calls must not
overlap the same-adapter 100,000-file cold/warm measurement. The held runtime metadata records the
actual SHA, loopback port, selected model, canonical external state directory, and launcher-secret
file. Keep that metadata and all credentials outside the checkout with owner-only permissions.
The driver rejects a source change before or after each model request.

Each campaign creates a fresh chat. Registration uses the explicit root; subsequent chat/message
requests use the production registration's returned `project.path`, including its OS alias. Scope
binding uses the canonical real path. No scope change occurs within a campaign.

## Bounded campaigns

| Campaign     | Turns | Scope                                                         | What the actual response must establish                                                                                                                                                                                        |
| ------------ | ----- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `customer`   | 5     | Canonical incident fixture from `check-retrieval-quality.mjs` | Trace → German follow-up → explicit nested file → basename → English orientation; actual fresh reads, supplied citations, honest declarations/repair and support sufficiency.                                                  |
| `knowledge`  | 8     | Real large Keiko checkout                                     | Production retrieval pipeline and original budgets → general decision advice in EN/DE → mixed source facts and recommendations → return to an explicit implementation file → freshness limits and an operational evidence gap. |
| `compaction` | 3     | Real large Keiko checkout                                     | Actual cited source answer → marked synthetic user-history padding → actual general answer → actual source return, with persisted compaction evidence and unchanged scope.                                                     |

The case catalog contains domain-neutral learned-knowledge questions. It does not select a product
router, introduce a topic classifier, enable Internet access, or supply model responses. The
existing ADR-0144 policy labels learned knowledge; source-specific claims still require actual
supplied evidence. Treat an unsupported repository assertion as a finding, even if the prose
sounds plausible. Assess mixed answers against the current cited implementation, rather than
checking wording against an expected sentence.

Compaction padding consists of at most 120 user messages, each 8,192 ASCII bytes (983,040 bytes
total), appended through the existing authenticated message API. Every message explicitly says
it is synthetic qualification context and neither repository evidence nor a model response. No
assistant message is injected or changed. This input bounds the experiment; it does not prove
compaction by itself. If the actual compaction counters/evidence do not show compaction, record that
state as unobserved instead of claiming coverage or increasing the input automatically.

## Prepare and execute

Preparation reads only the public case catalog and starts no server or model request:

```bash
node scripts/testing/coding-workbench-lab/connected-chat-run.mjs --campaign customer --prepare
node scripts/testing/coding-workbench-lab/connected-chat-run.mjs --campaign knowledge --prepare
node scripts/testing/coding-workbench-lab/connected-chat-run.mjs --campaign compaction --prepare
```

After the source hold and CPU handoff, run from that checkout using its own built packages.
Supply the actual private metadata file, the explicit fixture/Keiko root, and an external output
file; do not print the metadata or launcher secret:

```bash
node scripts/testing/coding-workbench-lab/connected-chat-run.mjs \
  --campaign knowledge \
  --repo /absolute/path/to/held/Keiko \
  --runtime-state /private/lab/runtime.json \
  --output /private/lab/knowledge-observations.jsonl
```

Use the canonical incident-fixture root for `customer`, and the held Keiko root for `knowledge`
and `compaction`. The prepared fixture must be materialized from the existing producer, with real
Git metadata created separately; do not execute its generated or dependency decoys. The existing
ordinary-folder/HTML lab remains the search-index owner's qualification; this campaign does not
claim those measurements.

## Observations and acceptance

The driver uses the existing paired API session with an ordinary 120-second client cancellation
ceiling per request. It stops on refusal, timeout, source drift, or interrupted observation. A
timeout does not prove that no provider request occurred or that the server completed successfully;
inspect the existing Activity Log before deciding whether another campaign can start.

Local records contain response hashes and character counts, citation/declaration counts, expected
target-read/cited booleans, canonical scope/query digests, actual final-prompt file counts, physical
and completed synthesis counts, repair/follow-up dispositions, compaction evidence counts, and the
existing support analyzer's sufficiency/findings. They contain no prompts, response bodies,
excerpts, raw source paths, model endpoints, credentials, or pairing attestations. The scenario
catalog's public questions are the reproduction input, not Activity Log evidence.

Read the actual writer/formatter output through the canonical validated support reader. Preserve
malformed persisted lines in that input and report its integrity classification and counters;
never discard them before analysis. For a healthy general-only answer, verify the actual
`search.answer.assessed` event has `phase: accepted-final`, the canonical scope/query identities,
and `outcome: assessment-only`, and check that it does not create a retrieval-miss finding. Compare
that with any naturally observed `still-insufficient` follow-up or `rejected-content-changed`
repair: its real source warning/finding must remain visible. If the model never produces either
state, record it as unobserved; the live campaign cannot claim that comparison from pure analyzer
tests. Do not alter model output, strip citations, or manufacture failures to obtain those states.

Inspect the real answer privately for usefulness, authority separation, citations, and uncertainty;
the counters alone cannot establish semantic quality. General-only answers should use labelled
learned knowledge without fabricated citations or source-miss warnings. Mixed answers should retain
authentic source citations and a separate assessment. The source return must use freshly admitted
evidence, not prior assessment suggestions as evidence. Actual retrieval may still run on a general
turn; retain its true counts rather than claiming that none occurred.

Compare at least one healthy explicit-file turn with the same configured model. Record natural
marker-free behavior only when the actual primary response and registered observation establish
it; never strip a model marker or manufacture a diagnostic to force a repair scenario. The existing
operator-disabled and two-physical-dispatch controls remain required alongside this live-model
qualification. This campaign does not certify other models, Linux execution, all prose semantics,
or final integrated-head gate acceptance. Closeout remains pending until the exact integrated gate
matrix and the required UI evidence checks pass.
