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
| `compaction` | 6     | Real large Keiko checkout                                     | Actual cited source answer → two authored preference notes with real model acknowledgements → verified persisted checkpoint → general answer → mixed answer → source return, with unchanged scope.                             |
| `manual`     | 8     | Existing 100,000-file non-Git HTML folder                     | Original content-only late-target query → repeat → original entity query → depth-72 exact path → same-chat follow-up → general learned knowledge → mixed authority → source return.                                            |

The case catalog contains domain-neutral learned-knowledge questions. It does not select a product
router, introduce a topic classifier, enable Internet access, or supply model responses. The
existing ADR-0144 policy labels learned knowledge; source-specific claims still require actual
supplied evidence. Treat an unsupported repository assertion as a finding, even if the prose
sounds plausible. Assess mixed answers against the current cited implementation, rather than
checking wording against an expected sentence.

The campaigns schedule 25 qualification questions and two compaction setup turns, 27 turns total.
The setup notes contain authored working preferences, no repository facts, filenames, code, or
model responses. The driver sizes each note using the actual configured model's canonical
`countContextTokens` and `groundedHistoryLaneTokens`, after checking the authenticated context
status agrees with that profile. Each note targets 55% of the unchanged conversation lane: about
4,400 charged tokens when that lane is 8,000. It requests a real acknowledgement of at most twenty
words through the same grounded API, then waits for successful completion and persisted messages.
No assistant message is injected. These completed units can be compacted while the current user
message stays protected; user-only padding cannot establish that behavior.

After the second actual setup response, the canonical checkpoint, persisted boundary, model,
context budget and unchanged scope must be observed before the driver sends General, Mixed and
Source-return. Each follow-up records whether the verified checkpoint stayed identical or changed;
a new source manifest alone does not change the checkpoint. A missing or mismatched checkpoint
stops the sequence as unobserved. No third seed round, config change or budget increase is allowed.
The 27 scheduled turns are not a measured provider-call total: physical and completed synthesis,
retry, repair, embedding and entailment work are counted from their actual producers and logs.

## Prepare and execute

Preparation reads only the public case catalog and starts no server or model request:

```bash
node scripts/testing/coding-workbench-lab/connected-chat-run.mjs --campaign customer --prepare
node scripts/testing/coding-workbench-lab/connected-chat-run.mjs --campaign knowledge --prepare
node scripts/testing/coding-workbench-lab/connected-chat-run.mjs --campaign compaction --prepare
node scripts/testing/coding-workbench-lab/connected-chat-run.mjs --campaign manual --prepare
```

After the source hold and CPU handoff, run from that checkout using its own built packages.
Supply the actual private metadata file, the explicit fixture/Keiko root, and an external output
file; do not print the metadata or launcher secret:

```bash
node scripts/testing/coding-workbench-lab/connected-chat-run.mjs \
  --campaign knowledge \
  --repo /absolute/path/to/held/Keiko \
  --runtime-state /private/lab/runtime.json \
  --request-timeout-ms 6000000 \
  --output /private/lab/knowledge-observations.jsonl
```

Use the canonical incident-fixture root for `customer`, and a complete normal Git clone of the
held Keiko source outside sensitive runtime directories for `knowledge` and `compaction`. Verify
its exact HEAD, tracked tree, tracked-file census and clean state before and after each campaign;
the runtime still executes the held checkout. Preserve any denied sensitive-root observation.
The prepared fixture must be materialized from the existing producer, with real
Git metadata created separately; do not execute its generated or dependency decoys. The existing
100,000-file non-Git HTML corpus for `manual`. That corpus has an external witness digest and
retained original questions, but no retained exact materialization generator; do not invent one or
call a smaller hermetic template its producer. The driver loads target paths from the private
witness and verifies its root and non-Git binding. Supply the existing witness through
`--corpus-witness /private/lab/3894-html-corpus-local.json` for actual execution. Source bodies never
enter records. Standalone scale/cache metrics remain the search-index owner's separate proof.

The original complete-coverage but authoritative-target-unread/uncited failure remains open until
the real model and current source qualify the content-only case. A successful exact-path control
does not establish that fix. The repeated question measures the actual second turn without
claiming a cold or warm cache from its position. All eight manual turns use one chat and unchanged
acknowledged scope. Inspect target facts and citations against the existing corpus privately;
neither nonzero citation counts nor the source return's general history authenticates manual facts.
For the synthetic targets only, a numeric fact witness is derived transiently from the existing
witness's primary value (or its explicit depth-72 delay). Record a unit-qualified presence boolean
and digest from source prose, excluding assessment and citation markers. This check cannot prove
negation, entailment or answer usefulness; inspect the actual answer and cited lines privately.
Revalidate the existing LiteLLM-to-local-Ollama selected-model mapping before the campaign and keep
only a route digest/closed disposition. Do not print aliases, endpoints, keys or configuration.

## Observations and acceptance

The driver uses the existing paired API session with a configurable client cancellation wait.
`--request-timeout-ms` accepts a positive integer up to 2,147,483,647 milliseconds; the default is
240,000 milliseconds. Choose the wait to cover the configured request envelope, including allowed
synthesis, transport recovery and retrieval. The current campaign explicitly uses 6,000,000
milliseconds to observe that existing envelope. This client wait does not enlarge the server's
authority, read, token, elapsed or spend grants, or the provider's configured timeout and retries.
Completion requires the actual answer and source-evidence review. The driver stops on refusal,
timeout, source drift or interrupted observation. A timeout does not prove that no provider request
occurred or that the server completed successfully; inspect the existing Activity Log before
deciding whether another campaign can start.

Local records contain response hashes and character counts, citation/declaration counts, expected
target-retained-evidence/cited booleans, canonical scope/query digests, actual final-prompt file counts, physical
and completed synthesis counts, repair/follow-up dispositions, compaction evidence counts, and the
existing support analyzer's sufficiency/findings. They contain no prompts, response bodies,
excerpts, raw source paths, model endpoints, credentials, or pairing attestations. The scenario
catalog's public questions are the reproduction input, not Activity Log evidence.

Manifest file presence establishes retained assembled evidence, not exhaustive physical workspace
reads or exact per-file final-prompt membership. An authenticated actual target citation witnesses
target membership in the final prompt; `filesInPrompt: 0` witnesses its absence. Otherwise that
membership remains unobserved. Declaration states are separate observations. Target-specific
physical reads remain unobserved; aggregate dedicated excerpt reads and index/search body reads
must remain distinct counts.

Compaction is a separate history observation. A grounded answer persists its chat checkpoint in
a separate evidence manifest; its source manifest need not contain a `compaction` array. The
reader retains every context-selection observation so a later synthesis event with zero history
counters cannot overwrite earlier compaction evidence. It loads the checkpoint through the
canonical checkpoint reader, using the request's actual `chat.continuity.capture` history revision,
and checks its coverage boundary against persisted messages from that same chat. The actual
request user message and returned assistant identity, unchanged acknowledged grounding identity,
manifest timing/model, and authenticated context-status compaction counts must agree. Retain only
hashes, counts, times and closed dispositions, including whether a model-summary field was present.
The validated checkpoint record's SHA-256 is separate from its optional producer `summaryRefHash`
and the source manifest's digest. Do not invent a missing summary hash or infer model authorship
merely from deterministic history compaction. Missing, mismatched or unreadable checkpoints remain
`unobserved` with a cause. Authored notes and a pending-compaction meter
projection alone do not establish persisted compaction.

Read the actual writer/formatter output through the canonical validated support reader. Preserve
malformed persisted lines and per-file termination through its hardened line iterator, and report
its integrity classification and counters;
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
