# Review agent offline gate, 2026-11-01

The offline gate of Epic #4130 (Issue #4138, ADR-0184 D9) for the Keiko for Quality review agent.
Definitions, labeling rules and the holdout discipline are in
[review-agent-measurement.md](review-agent-measurement.md).

## Pair and environment

| Item                             | Value                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reviewer                         | `qwen3.6-35b-a3b-4bit` (mlx-community/Qwen3.6-35B-A3B-4bit)                                                                                                                                                                                            |
| Counter-checker                  | `gemma-4-31b-it-4bit` (mlx-community/gemma-4-31b-it-4bit)                                                                                                                                                                                              |
| Serving                          | mlx_lm 0.32.2 behind LiteLLM 1.106.6 on loopback, one Apple silicon Mac with 64 GB. From the dev-6 roles-swapped rerun on, including the holdout: one decode at a time, 512-token prefill steps, prompt caches capped at 4 GB (Qwen) and 6 GB (Gemma). |
| Gateway configuration generation | recorded per run in its evidence                                                                                                                                                                                                                       |
| Dataset                          | `review-harvest-dataset.v1.json.gz`, digest `sha256:c6dfbede99249e9fda874649d4a938e4d3e69b4b8fb8e70be0d3c099b486f194`                                                                                                                                  |
| Holdout boundary                 | pull request #3066 (`REVIEW_EVALUATION_MANIFEST.holdoutFromPullRequest`)                                                                                                                                                                               |

## How a run is made

The composition is `tests/review-quality/`. It starts the real server composition and runs the
evaluation family's replay or seed gate through the composed review service, one review at a time.
Every run records its configuration digest (the committed review code, the variant and the pair),
its composition digest (every other package the pipeline runs, and the lockfile), the prompt digest, the dataset digest, the gateway configuration generation, the readiness probes,
each review's settlement, and per-role tokens and durations.

```bash
node scripts/testing/review-quality/run.mjs --set development --iteration dev-1 \
  --repository <evaluation clone> --config <gateway config> --state <state dir> --out <evidence dir> \
  --reviewer qwen3.6-35b-a3b-4bit --counter-checker gemma-4-31b-it-4bit
```

The evaluation clone is a local clone of Keiko with `origin` pointing at GitHub. The composition
fetches each replayed pull request's head through `refs/pull/<n>/head` when the clone lacks it, and
reviews the range from the merge base of its base and head commits to its head.

A finished replay can be scored again under changed scoring code without any new review. The owner
decided on 2026-11-04 that the scoring fixes from the independent review (R4130-006, R4130-007,
R4130-011, R4130-014) apply before anyone reads the holdout rate. Those fixes change the composition
digest and so the reuse key. `--resume-prior-keys` then names the earlier reuse keys whose stored
reviews the operator accepts. `--rescore` makes any case without such a review fail, so the re-scored
run starts no review and reads exactly the stored ones. Its evidence records the prior keys.

A replay probes both models again after it has prepared its pull requests, and retries a failed
probe up to five times, 30 seconds apart. Preparing the 229 holdout pull requests takes minutes,
and the probe before preparation does not keep the gateway connection open that long.

A replay stopped between reviews can continue with `--resume-since <instant>`, where the instant
lies before the original run's first review. The review service stores every review it settles.
The resumed run reads each stored review of the original run back through that service and
reviews the remaining cases. It reuses a stored review only when the pair and the exact base and
head commits match. It reviews two settlements again because neither measured the review:
`abandoned/interrupted`, which the stop causes, and `skipped/model-unavailable`, which a model the
review never reached causes. The evidence marks each reused review `resumed: true` and gives its
wall time from the stored start and settle times.

The development sample is the 30 most recent development pull requests with at least one decided
thread (a hit or a false alarm), because only decided threads can move the actionable rate:
#2978 to #3065. Every iteration replays the same sample.

## Iteration log

Each row is one recorded development-set run. No run before the final holdout run read a holdout
pull request; the replay refuses that, and every row's `split` is `development`.

| Iteration                            | Variant           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Configuration digest | Decided | Actionable                                                                                                                                                                              | Findings per PR (max) | Settlements                                                                                        | Median wall time |
| ------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| smoke                                | product           | First composition run on two pull requests (`59c8f660d`).                                                                                                                                                                                                                                                                                                                                                                                                                         | `92566e836fef`       | 0       | n/a                                                                                                                                                                                     | 0                     | 2 model-failed                                                                                     | 137 s            |
| dev-1                                | product           | First full development run (`4f225dd8d`): Qwen corrections join the leading system message.                                                                                                                                                                                                                                                                                                                                                                                       | `92566e836fef`       | 0       | n/a                                                                                                                                                                                     | 0                     | 29 skipped/policy-invalid, 1 model-failed                                                          | 1 s              |
| repro, probe-sampling, probe-nothink | product           | Three-PR probes on #2978, #2979 and #2981 (`bb1affec1`): the authority refusal is now logged; Reviewer sampling at the model's recommended values, then without thinking.                                                                                                                                                                                                                                                                                                         | `61ad9712f5b4`       | 0       | n/a                                                                                                                                                                                     | 0                     | complete 2, model-failed 5, files-unprocessed 1, deadline-exceeded 1                               | 211 to 527 s     |
| dev-2 (first attempt)                | product           | `17342d886`: a macOS Reviewer failure settles on its own cause; counter-check wall time 300 s. Stopped after the role models' readiness lapsed.                                                                                                                                                                                                                                                                                                                                   | `b752b79cb560`       | 0       | n/a                                                                                                                                                                                     | 0                     | 29 skipped/policy-invalid, 1 deadline-exceeded                                                     | 1 s              |
| dev-2                                | product           | `648cb03f8`: a role model whose readiness lapsed is checked again before the run.                                                                                                                                                                                                                                                                                                                                                                                                 | `4c4d15ed983a`       | 0       | n/a (5 presented: 2 undecided, 3 unmatched)                                                                                                                                             | 3                     | 14 budget-exhausted, 5 model-failed, 5 deadline-exceeded, 3 files-unprocessed, 3 complete          | 183 s            |
| dev-3                                | product           | `bf7574364`: the Reviewer is told to report each finding once confirmed and to plan for about 15 read or search calls; the Counter-checker to use at most four.                                                                                                                                                                                                                                                                                                                   | `dfcb28e93038`       | 0       | n/a (1 presented, unmatched)                                                                                                                                                            | 1                     | 18 budget-exhausted, 6 model-failed, 4 complete, 1 deadline-exceeded, 1 files-unprocessed          | 184 s            |
| dev-4                                | product           | `7b3437265` with `KEIKO_REVIEW_RUN_MAX_PROMPT_TOKENS=1500000`: the Reviewer prompt allowance raised from 600,000 to 1,500,000 tokens.                                                                                                                                                                                                                                                                                                                                             | `c2a4ccc7abfb`       | 4       | 75.0 % (3/4, Wilson 95 % interval 30.1 to 95.4 %; 15 presented, 2 undecided, 9 unmatched)                                                                                               | 3                     | 10 model-failed, 8 budget-exhausted, 5 complete, 5 files-unprocessed, 2 deadline-exceeded          | 477 s            |
| dev-5                                | product           | `b6c850be8`: the review route buffers every upstream model call (`2b8e673dc`), and the Reviewer's default prompt allowance is 1,500,000 tokens.                                                                                                                                                                                                                                                                                                                                   | `9b108e9e321b`       | 1       | 0.0 % (0/1, Wilson 95 % interval 0.0 to 79.3 %; 11 presented, 10 unmatched)                                                                                                             | 3                     | 9 budget-exhausted, 9 deadline-exceeded, 7 complete, 4 files-unprocessed, 1 model-failed           | 775 s            |
| dev-6                                | product           | `912b930f5`: the counter-check wall time raised from 300 to 600 seconds.                                                                                                                                                                                                                                                                                                                                                                                                          | `7c5395d728e4`       | 3       | 33.3 % (1/3, Wilson 95 % interval 6.1 to 79.2 %; 13 presented, 10 unmatched)                                                                                                            | 3                     | 11 budget-exhausted, 7 complete, 6 deadline-exceeded, 5 files-unprocessed, 1 model-failed          | 845 s            |
| dev-6                                | counter-check-off | `0feabae3c` (review code as `912b930f5`): every Reviewer candidate is presented without a counter-check.                                                                                                                                                                                                                                                                                                                                                                          | `e7801d852044`       | 4       | 100.0 % (4/4, Wilson 95 % interval 51.0 to 100.0 %; 24 presented, 5 undecided, 15 unmatched)                                                                                            | 3                     | 13 budget-exhausted, 9 complete, 6 files-unprocessed, 1 deadline-exceeded, 1 model-failed          | 631 s            |
| dev-6 (first attempt)                | roles-swapped     | `8982b14fd` (review code as `912b930f5`): Gemma as Reviewer, Qwen as Counter-checker. Stopped measuring after Gemma's server ran out of GPU memory.                                                                                                                                                                                                                                                                                                                               | `a216908b13b1`       | 0       | n/a                                                                                                                                                                                     | 0                     | 18 skipped/model-unavailable, 6 model-failed, 2 complete, 2 deadline-exceeded, 2 files-unprocessed | 2 s              |
| dev-6                                | roles-swapped     | `8982b14fd` (review code as `912b930f5`), rerun with the memory bounds below: Gemma as Reviewer, Qwen as Counter-checker.                                                                                                                                                                                                                                                                                                                                                         | `a216908b13b1`       | 0       | n/a (no candidate reported)                                                                                                                                                             | 0                     | 11 complete, 11 files-unprocessed, 8 deadline-exceeded                                             | 762 s            |
| dev-7 (first attempt)                | product           | `d88963ad5`: the review code of #4381 before its last two commits. Stopped after 17 minutes, in its first review: the fourth of four parts was refused (`quarantine-limit`).                                                                                                                                                                                                                                                                                                      | n/a                  | 0       | n/a                                                                                                                                                                                     | 0                     | none (stopped in the first review)                                                                 | n/a              |
| dev-7                                | product           | `3d166c931`, the tree of the epic commit `bc1f0ca28`: the diff package in up to 12 parts with a fresh runtime instance per part, three lines after a change, a read allowance of 24 per session, described schema corrections, one defect definition, the counter-check allowance and phase limit per part, and a readiness check before each session. The lab gateway allowed two schema corrections per call (`maxRetries: 2`, the Gateway Setup default; earlier runs used 1). | `e05f7da3dca3`       | 12      | 45.5 % gated (10/22: 10 hits, 2 false alarms, 8 undecided, 2 duplicates; Wilson 95 % interval 26.9 to 65.3 %); 83.3 % of the decided (10/12); 39 presented, 17 unmatched                | 3                     | 13 complete, 8 deadline-exceeded, 4 budget-exhausted, 4 model-failed, 1 files-unprocessed          | 2311 s           |
| probe-allowance                      | product           | `7c02f9a9f`, the tree of #4392, on five pull requests that dev-7 left incomplete (#3011, #3028, #3043, #3046, #3065): a Reviewer read allowance of 16, a second Reviewer session after a failure without a candidate, the early stop of counter-checks, a counter-check limit of 900 seconds with a read allowance of 8, hunks larger than a part shown as windows, and the tool-call proof renewed before a session.                                                             | `057faee9d45d`       | 2       | 50.0 % gated (1/2: 1 hit, 1 false alarm); 4 presented, 2 unmatched                                                                                                                      | 2                     | 3 complete, 1 budget-exhausted, 1 model-failed                                                     | 1460 s           |
| dev-8                                | product           | `d9e25dbc5`, the tree of #4394: the changes of the probe, an output budget of 4,096 tokens for each counter-check turn and the gateway's one repair of a turn that used it up.                                                                                                                                                                                                                                                                                                    | `c349d939b497`       | 15      | 59.1 % gated (13/22: 13 hits, 2 false alarms, 5 undecided, 2 duplicates; Wilson 95 % interval 38.7 to 76.7 %); 86.7 % of the decided (13/15); 37 presented, 15 unmatched                | 3                     | 16 complete, 5 deadline-exceeded, 5 model-failed, 4 budget-exhausted                               | 2621 s           |
| probe-replay                         | product           | `d9e25dbc5`, the tree of dev-8, on the six small pull requests that dev-8 lost to counter-checks only (#2997, #3011, #3020, #3040, #3041, #3048). A lab proxy in front of the Counter-checker's model server put the reasoning of each earlier tool-call turn back into the request; Keiko's code is unchanged.                                                                                                                                                                   | `c349d939b497`       | 1       | 50.0 % gated (1/2: 1 hit, 1 undecided); 6 presented, 3 unmatched                                                                                                                        | 3                     | 3 complete, 1 model-failed, 1 deadline-exceeded, 1 budget-exhausted                                | 1725 s           |
| dev-9                                | product           | `5bbec5121`, a lab tree whose review code equals the epic commit `fc5d65a39`: the merge of dev 1.5.0 (no prompt-token allowance, #4346), the three fixes of #4423 and the review profile's plugin fields of #4424. The Counter-checker's provider sends the current turn's reasoning back (`reasoningHistory: current-turn`).                                                                                                                                                     | `e26662b1572e`       | 15      | 50.0 % gated (12/24: 12 hits, 3 false alarms, 8 undecided, 1 duplicate; Wilson 95 % interval 31.4 to 68.6 %); 80.0 % of the decided (12/15); 41 presented, 16 unmatched, 1 unmeasured   | 3                     | 23 complete, 5 model-failed, 1 deadline-exceeded, 1 files-unprocessed                              | 2298 s           |
| dev-10                               | product           | `06aadd425`, a lab tree on the merge of dev 1.5.1: the fixes of #4451 (diff package parts), an end to a Reviewer session that repeats one report with acknowledgements that say what a refused report lacks, and a coding run that reaches its envelope deadline settling as failed. Review code as the epic commit `1310c91ea` without its refusal of inactive role models and its review fetch runner.                                                                          | `b2d9ed2b1eef`       | 16      | 72.7 % gated (16/22: 16 hits, 0 false alarms, 6 undecided, 0 duplicates; Wilson 95 % interval 51.8 to 86.8 %); 100.0 % of the decided (16/16); 45 presented, 21 unmatched, 2 unmeasured | 3                     | 24 complete, 4 model-failed, 2 deadline-exceeded                                                   | 3099 s           |

Reading of the runs so far:

- dev-1 and the first dev-2 attempt measured no review. The role models' readiness lasts five
  minutes, and nothing renewed it between reviews, so every later run was refused before it
  started (`skipped/policy-invalid`). `cc23c7856` checks a lapsed model again before the run.
- In dev-2 the Reviewer used up its 600,000-token prompt allowance in 14 of 30 reviews, with a mean
  of 324,067 prompt tokens and 5,154 completion tokens per review. Each tool call resends the whole
  conversation, so about 25 calls of 20,000 to 25,000 tokens exhaust it. Most of those runs ended
  before the Reviewer reported anything.
- The Counter-checker reached its 300-second wall time on 13 of 23 candidates, which then count as
  undecided and are not presented. About 80% of Gemma's completion tokens are reasoning, at about
  13 tokens per second. Its chat template suppresses thinking only at the start of a turn, not
  after a tool result, so a template switch cannot turn it off.
- Four Reviewer runs ended on `invalid-tool-call`: a second invalid `keiko_review_report` or
  search call after the one schema repair.
- dev-3 shows that the budget instructions did not change the Reviewer's behaviour. Its mean rose
  to 395,913 prompt tokens per review. Budget-exhausted runs still made 20 to 30 read and search
  calls, and the runs that reported did so only after 18 to 22 calls. Nine candidates were reported
  in all and one was presented. Seven Reviewer turns produced the full 8,192 completion tokens
  without a tool call.
- dev-4 is the first run that measured the actionable rate. The Reviewer averaged 677,761 prompt
  tokens per review and reported 31 candidates. The Counter-checker confirmed 15, refuted 7 and left
  9 undecided, at about 190 seconds per check. The development verdict is `pass` on 4 decided
  findings, which is too few to predict the holdout result.
- Nine of the ten model-failed runs ended on `invalid-tool-call`. In seven of them the provider
  stream had already delivered text before the invalid tool call (`afterFirstChunk`), so the
  gateway could not retry and the one schema correction never ran. In the other two the corrected
  call was invalid again. Eight `turn-rejected` lines are the prompt-allowance refusals that settle
  as `budget-exhausted`.
- From dev-4 on, the configuration digest also covers the run-budget operator settings
  (`KEIKO_REVIEW_RUN_MAX_PROMPT_TOKENS` and the duration and coding-envelope keys), and the
  evidence records their values.
- dev-5 shows the buffered review route working. Model-failed runs fell from 10 to 1: the gateway
  scheduled 17 schema repairs and only one Reviewer run still ended on `invalid-tool-call`. The
  other nine failed turns are prompt-allowance refusals (`turn-rejected`), which settle as
  `budget-exhausted`.
- The Reviewer averaged 933,304 prompt tokens per review and reported 50 candidates. The
  Counter-checker settled 48 of them: 11 confirmed, 17 refuted (16 `evidence-mismatch`, 1
  `guarded-elsewhere`) and 20 undecided because the 300-second wall time ran out. Two candidates
  stayed unchecked. Every `deadline-exceeded` settlement is a counter-check that ran out of time,
  not the run's own duration.
- Gemma generated about 12 tokens per second in every hour of the run (median per call), so the
  timeouts come from the model's speed, not from contention. Decided checks took 58 to 285 seconds;
  timed-out checks had made 1 to 8 tool calls.
- The one decided finding was a false alarm, so the development verdict is `fail` at 0/1. With 1
  to 4 decided findings per run, the development rate cannot tell dev-4 and dev-5 apart: most
  presented findings overlap no historical thread (`unmatched`) and count in no rate.
- In dev-6 the 600-second wall time cut the counter-checks that ran out of time from 20 of 48 to
  7 of 42. The Counter-checker settled all 42 candidates: 14 confirmed, 20 refuted (15
  `evidence-mismatch`, 5 `guarded-elsewhere`) and 8 undecided (7 out of time, 1 out of prompt
  budget). Decided checks took 81 to 582 seconds, and the counter-checks of one review took 438
  seconds on average.
- The Reviewer averaged 851,283 prompt tokens per review. Ten Reviewer turns were prompt-allowance
  refusals and one ended on `invalid-tool-call`; the tool refused 7 reports as schema-invalid.
- dev-6 presented 13 findings: 1 hit, 2 false alarms and 10 unmatched. dev-4, dev-5 and dev-6 each
  decided 1 to 4 findings, 8 in all, of which 4 are hits.
- The counter-check-off variant presented 24 of the Reviewer's 30 candidates (the limit of three
  per pull request held back the rest): 4 hits, no false alarm, 5 undecided and 15 unmatched. With
  the counter-check on, dev-4 to dev-6 refuted 7 to 20 candidates per run. Each run draws different
  candidates, so these runs cannot show whether a refuted candidate was a real defect.
- The first roles-swapped attempt measured 6 reviews. Gemma as Reviewer reported no candidate in
  them: two reached the 20-minute run duration and two ended `files-unprocessed`. At 11:07 UTC
  Gemma's server ran out of GPU memory (`kIOGPUCommandBufferCallbackErrorOutOfMemory`) during a
  Reviewer conversation. Its generation thread died, the server answered every later request with 404, and
  the remaining 24 reviews ended `model-failed` or `skipped/model-unavailable`.
- Gemma has 10 full-attention layers at about 80 KB of KV cache per token, so a Reviewer
  conversation of 40,000 tokens holds about 3.3 GB per cached sequence. Qwen's hybrid attention
  keeps its cache far smaller, and no product run hit the limit.
- From the rerun on, both model servers decode one request at a time, prefill in 512-token steps
  and cap their prompt caches at 4 GB (Qwen) and 6 GB (Gemma). None of these settings changes what
  a request generates. KV quantization is not available for Gemma's sliding-window layers in
  mlx_lm 0.32.2. The lab runner restarts a server whose generation thread died and records each
  restart.
- The roles-swapped rerun measured all 30 reviews, and no server needed a restart. Gemma as
  Reviewer reported no candidate: no `keiko_review_report` call reached the tool. It made 103 tool
  calls (71 reads, 24 searches, 8 discovers) and then ended its turn. In 12 reviews only one model
  call completed. Its reviews averaged 74,780 prompt and 5,451 completion tokens, with a median
  wall time of 762 seconds, and 8 reached the 20-minute run duration.
- With no candidate, the roles-swapped variant has no rate to compare. The roles as decided (Qwen
  as Reviewer, Gemma as Counter-checker) remain the holdout configuration.
- dev-7 is the first development run of the pipeline as it stood after the holdout: the diff package
  in parts, the per-part counter-check allowance and phase limit, and the changes of #4381. Its
  evidence is `evidence.json` with sha256
  `fa9b166afce3ee991f8db8e706f503c9509b8da7f05f9d4326a03f28eb1844f3`.
- The first attempt found a defect within 17 minutes. On macOS every Reviewer session leaves its
  runtime instance holding a run whose end cannot be proven, the next session sets that instance
  aside for five minutes, and only one instance could be set aside. The fourth part of the first
  review started 4 minutes after the second had ended and was refused. The seed set has only
  single-part reviews, so no seed run could show it. #4381 ends the older instance instead
  (`quarantine-replaced`); in the full run that happened 19 times and no part was refused for it.
- The full run was stopped once and resumed. The gateway's forced tool-call proof expires after 24
  hours, and nothing in a review renews it, so 24 hours and 8 minutes after the server's start the
  fourth part of the 25th review was refused as `model-unavailable`. The gate process was stopped
  before that review settled, the stored row settled `abandoned/interrupted`, and the resumed run
  reused the 24 settled reviews and reviewed the other six. A server start renews the proof.
- dev-7 presented 39 findings, against 13 in dev-6: 10 hits, 2 false alarms, 8 undecided, 2
  duplicates and 17 unmatched. It is the first development run with more than four decided
  findings. Its gated rate of 45.5 % is below the 50 % threshold, and its interval of 26.9 to
  65.3 % includes it.
- 17 of 30 reviews did not settle `complete` (56.7 %, limit 20 %). The figures below are those of
  the 30 settled reviews; the interrupted 25th review, which was reviewed again, is left out. Three
  causes overlap:
  - Counter-checks out of time. Of 198 checks, 48 confirmed, 124 refuted and 26 ended undecided,
    25 of them on the 600-second limit. 15 of the 17 incomplete reviews have an undecided check,
    and 6 are incomplete for that reason alone. The decided checks took 210 seconds at the median
    and 571 at most, at about 12 completion tokens per second.
  - Files that no part holds. 6 reviews left 21 files unprocessed, all for the part budget. In 5
    of them one file's first hunk alone is larger than a part (13,832 tokens), typically a large
    new file. One review of 198 changed files needed more than the 12 parts a review may have.
  - Reviewer sessions that failed. Of 100 sessions, 88 completed, 7 ended `budget-exhausted` and 5
    `model-failed` (3 invalid tool calls after two corrections each, 2 empty answers). Five of the
    budget failures are the prompt allowance, at 23 or 24 reads; the other two are sessions the
    read allowance stopped before any report.
- The read allowance of 24 does not keep a session inside its prompt budget. 52 of the 100 sessions
  used all 24 reads, at 444,000 to 1,562,000 prompt tokens (median 885,000), and they filed 158 of
  the 198 candidates of all sessions. The 9 sessions that made 9 to 16 reads used 472,000
  at the median. 26 sessions made no read call at all and ended within seconds (median about 16,400
  prompt tokens); the log does not show whether their parts held anything to find.
- The Reviewer used 59.1 million prompt tokens, 1.97 million per review at the mean. The reviews
  took 26.4 hours in all: 10.3 hours of Reviewer sessions and 16.06 hours of counter-checks.
- 5.30 of those 16.06 hours of counter-checks were spent on candidates that could no longer be
  presented, because three candidates checked before them were already presentable. Stopping
  there would have changed one review from `incomplete` to `complete`.
- dev-8 is the development run of the changes made after dev-7. Its evidence is `evidence.json`
  with sha256 `d7b5c6c8638f0f976557a7f987d3fea14d88be72b1dd982fd49a0d04802ca70a`. It ran 26.4 hours
  without an interruption: the tool-call proof was renewed twice before a session
  (`gateway.readiness.automatic.started`, trigger `review-launch`), the first time 24 hours and 5
  minutes after the server's start, and no part was refused.
- dev-8 presented 37 findings: 13 hits, 2 false alarms, 5 undecided, 2 duplicates and 15
  unmatched. Its gated rate of 59.1 % is above the 50 % threshold, and its interval of 38.7 to
  76.7 % includes it.
- 14 of 30 reviews did not settle `complete` (46.7 %, limit 20 %), against 17 in dev-7. What blocks
  each of the 14, counted once per review and cause:
  - A counter-check without a verdict: 10 reviews, and the only cause in 8 of them. Of 172 checks,
    37 confirmed, 122 refuted, 1 ended undecided by its own verdict, 9 ran into the 900-second
    limit and 3 failed as `model-failed`.
  - A Reviewer session that the read allowance stopped and that filed no report: 4 reviews, the
    only cause in 1 (the rule of R4130-054).
  - A Reviewer session that failed after it had filed a candidate: 2 reviews (3 sessions, each at
    the read allowance: an invalid report call after two corrections, an exhausted output budget,
    and one whose cause the gateway's lines do not name).
  - Files that no part holds: 2 reviews with 16 files, both with another cause as well. One is the
    review of 198 changed files.
  - A Reviewer session out of its prompt allowance: 1 review, with an undecided check as well.
- In 10 of the 12 counter-checks without a verdict a turn used its whole output budget. The gateway
  scheduled its repair 18 times inside counter-checks. In the 3 `model-failed` checks the repaired
  attempt used the whole budget again. In 7 of the 9 checks on the limit a turn had needed the
  repair, and in 6 of them the limit ended the check during the repaired attempt. In the other 2
  the last turns took 2,400 to 3,900 output tokens each.
- The Counter-checker's reasoning grows with the turns of a check. Its median reasoning was 181
  tokens in the first turn, 437 in the sixth, 605 in the ninth and 1,521 in the tenth, the turn
  after the read allowance is used. Turns that used their output budget cluster at turns 6, 7
  and 10. Keiko does not send a model's earlier reasoning back to it, so each turn starts from
  the tool calls and results alone. Whether that causes the growth is not measured yet.
- The Reviewer's sessions: 112 sessions for 109 parts. Three sessions that failed without a
  candidate were started again, and all three second sessions completed, with 3, 4 and 4
  candidates. 101 of the 109 parts ended with a completed session. 60 sessions used all 16 reads,
  at 266,000 to 1,472,000 prompt tokens (median 631,000); in dev-7 the sessions at 24 reads used
  885,000 at the median. 39 sessions made no read call.
- The early stop left 31 candidates unchecked in 7 reviews because three findings were already
  presentable. Five reviews had a hunk shown as windows.
- The Reviewer used 45.5 million prompt tokens, 1.52 million per review at the mean (dev-7: 59.1
  and 1.97). The reviews took 26.4 hours in all: 8.5 hours of Reviewer sessions and 17.8 hours of
  counter-checks.
- Two lab probes on the tree of dev-8 tested why a counter-check turn uses its whole output budget.
  Neither changes Keiko's code, and both ran on the six small pull requests that dev-8 lost to
  counter-checks only, so their failure counts regress towards the run's base rate of 12 of 172.
  - probe-replay sent the Counter-checker's earlier reasoning back between its tool calls, which
    Gemma 4's prompt format asks for and Keiko did not do. Its evidence is `evidence.json` with
    sha256 `ac5beb01fbd53dd7b58e05962210673809849697528398387c760199ba32c9e5`. The median reasoning
    of turns 3 to 9 fell to 20 to 90 tokens, with 236 at turn 8 (dev-8: 276 to 605). The turn after
    the read allowance is used stayed long (2,246 tokens at the median), and 2 of 16 checks still
    ended without a verdict after one turn used its whole budget. One of the three incomplete
    reviews had no failed check: the rule of R4130-054 failed a silent read-limited part.
  - The second probe also switched the Counter-checker to Gemma's official thinking mode. It was
    stopped after four reviews, so it has no evidence file: 11 checks, 6 confirmed, 3 refuted and 2
    without a verdict, again after a turn that used its budget twice. Thinking mode is not
    adopted.
  - The stock chat template marks "no thinking" only on a turn that does not follow a tool result,
    and the model reasons on its first turn all the same, so a template cannot switch its
    reasoning off.
  - The merge of dev 1.5.0 brings a provider setting that sends the reasoning back
    (`reasoningHistory`). The lab uses it from iteration 9 on. A turn that runs away is left to the
    second counter-check session.
- From the merge of dev 1.5.0 on, two recorded values are not comparable with earlier rows: the
  configuration digest, because the two retired prompt-token settings are no longer part of it,
  and `describedPathCount` on `gateway.tool-catalog.repair`, which now counts only the listed
  paths whose schema gives a description. Review runs have no prompt-token allowance from then on
  (#4346).

- dev-9 is the first development run after the merge of dev 1.5.0. Its evidence is
  `evidence.json` with sha256 `a5b50d36f9859b1807035a13da028736cc38c082b1b7e62b470edeecfb3b4280`.
  It was paused three times so another session could use the machine. Each pause cut the review
  in flight, which settled `abandoned/interrupted` and was reviewed again on resume, so all 30
  pull requests have a settled review.
- dev-9 presented 41 findings: 12 hits, 3 false alarms, 8 undecided, 1 duplicate, 1 unmeasured and
  16 unmatched. Its gated rate of 50.0 % is at the threshold, and its interval of 31.4 to 68.6 %
  includes it. Its configuration digest is not comparable with the rows before the merge.
- 7 of 30 reviews did not settle `complete` (23.3 %, limit 20 %), against 14 in dev-8. What blocks
  each of the 7, counted once per review and cause:
  - A Reviewer session that sent one `keiko_review_report` call again and again until the run's
    20 minutes ended it: 2 reviews, the only cause in both. One session sent a finding it had
    already filed 25 more times, the other sent 29 reports that the intake refused as
    `schema-invalid`. Both had filed candidates before (6 and 3). The acknowledgements said
    `duplicate` and `rejected` without saying why or what to do. The run settled
    `recovery-required` without a cause, so the part read `model-failed` although the time limit
    ended it.
  - A Reviewer session that the gateway failed with `invalid-tool-call` after it had filed
    candidates: 2 reviews, the only cause in 1. The repaired call was refused again for the same
    argument: `condition` of `keiko_review_report` once, `directory` of
    `keiko_workspace_discover` once. The log names the argument, not what the model sent.
  - Files that no part holds: 2 reviews (#2981 with 14 of 198 files, #3037 with 2 of 36), the only
    cause in #3037, which had one of its 12 parts unused.
  - A candidate without a verdict after its second counter-check session: 2 reviews, the only cause
    in both (one `model-failed`, one `deadline-exceeded`).
- Counter-checks: 161 sessions for 153 candidates. 10 first sessions ended without a verdict (5 on
  the 900-second limit, 5 `model-failed`); 8 of them were started again, and 7 of those decided.
  41 sessions confirmed, 109 refuted and 1 ended undecided by its own verdict.
- The Reviewer: 111 sessions for 109 parts, 6 of them failed: the 2 that repeated a report, the 2
  refused tool calls, and 2 without a candidate whose second sessions both completed. 14 of the 23
  complete reviews had a part whose session was refused a read; in 3 such a part reported nothing.
- Without a prompt-token allowance the Reviewer used 48.5 million prompt tokens, 1.62 million per
  review at the mean (dev-8: 1.52 million). The two sessions that repeated a report used 1.67 and
  1.84 million each. Reviewer sessions took 1,113 seconds per review at the mean, counter-checks
  1,799.

- dev-10 is the development run of the changes made after dev-9. Its evidence is `evidence.json`
  with sha256 `2fa1359693c54dbcb4686e85490e52d2b4f84bfd1e69cfb429a177f4cb5fee15`. Six pauses, so
  another session could use the machine, each cut the review in flight, which settled
  `abandoned/interrupted` and was reviewed again on resume. All 30 pull requests have
  a settled review.
- dev-10 presented 45 findings: 16 hits, 0 false alarms, 6 undecided, 0 duplicates, 2 unmeasured and
  21 unmatched. Its gated rate of 72.7 % is above the threshold, and its interval of 51.8 to 86.8 %
  is above it too. These are development numbers; only the holdout decides.
- 6 of 30 reviews did not settle `complete` (20.0 %, at the limit of 20 %), against 7 in dev-9.
  What blocks each of the 6, counted once per review and cause:
  - A candidate whose second counter-check failed on the model: 3 reviews, the only cause in 2.
    The first check of that candidate failed on the model in 2 of them and reached the 900-second
    limit in 1.
  - A candidate whose second counter-check reached the 900-second limit: 2 reviews, the only cause
    in both. The first check of that candidate reached the limit in 1 of them and failed on the
    model in 1.
  - Each candidate is classed by its last check. A Reviewer part whose first session failed and
    whose second session completed is not a cause.
  - A Reviewer session that used its whole output budget after it had filed candidates: 1 review,
    the only cause there. A Reviewer session that reached the run's time limit without a candidate
    is the second cause of one of the reviews above; it ran in the sleep described below.
- The failed counter-checks have one mechanism. In the session traced, the fifth turn streamed
  4,095 events, 4,093 of them reasoning, and reached its 4,096-token output budget after 311
  seconds. The gateway's steered repair ended the same way, and the session failed. The
  Counter-checker decodes about 13 tokens a second, so a turn that reasons through its budget
  costs five minutes, and two of them nearly fill the 900-second limit. 5 of the 8 checks that
  reached that limit had used 5,600 to 8,200 output tokens.
- The other 3 checks that reached the limit ran while the lab machine slept with its lid closed
  (`pmset -g log`: clamshell sleep, then sleep between short maintenance wakes on 2026-11-18). One
  started at a maintenance wake and received its first response headers 694 seconds later, at the
  next wake. The two others are both checks of the only blocking candidate of one review; the
  second of them ended when the lid was opened. The run measures durations in wall time, while the
  limit's timer does not advance during sleep, so the three settled 35 to 858 seconds past 900
  wall-clock seconds. They measure the machine, not the Counter-checker. The review whose only
  blocker is the candidate checked twice in that sleep is incomplete because of sleep.
- Counter-checks: 192 sessions, counting the sessions of the reviews the pauses cut. 46 confirmed,
  124 refuted, 1 ended undecided by its own verdict, 13 failed on the model and 8 reached the time
  limit.
- The repeat limit ended a Reviewer session in 3 complete reviews. 19 of the 24 complete reviews had
  a part whose Reviewer reached its read allowance; in 2 such a part reported nothing.
- The Reviewer used 54.7 million prompt tokens, 1.82 million per review at the mean. Reviewer
  sessions took 1,223 seconds per review at the mean, counter-checks 2,418.

## Final holdout run

The single holdout run started at 17:36 UTC on 2026-11-02 with the product configuration
(`0edb7387a`, review code as `912b930f5`, so the configuration digest of the development runs).

- The first 17 reviews (#3066 to #3090) settled `skipped/model-unavailable` within 30 seconds.
  The gate had prepared the 229 pull requests for 5.5 minutes after its readiness probe. The first
  review's own readiness probe of the Reviewer then failed with `EPIPE` on the loopback gateway
  connection, and the reviews that followed skipped until the next probe passed. No model saw
  these 17 pull requests.
- By 12:59 UTC on 2026-11-03 the run had settled 87 reviews. The gate was stopped then, right after
  the 87th settled, for a machine restart; the review that had just started was interrupted before
  any model call. The run is continued with `--resume-since 2026-11-02T17:35:00Z` (`c90b64cdf`),
  which reuses the 70 stored reviews that measured something and reviews the 17 refused ones, the
  interrupted one and the remaining pull requests.
- The resumed run started at 14:34 UTC on 2026-11-03 from the same commit. New runs went only to
  the 17 refused pull requests and the interrupted one; none of the 70 stored reviews was reviewed
  again. The first resumed review passed its readiness probe.
- The resumed run was paused at 07:53 UTC on 2026-11-04, right after the review of #3377 settled,
  for the owner's use of the machine. 129 of the 229 reviews had measured something by then. The
  pause stopped the gate's shell wrapper first, so the lab went down while the gate process ran on
  for about two minutes and moved the review of #3380 into its review phase with no model
  reachable. That review is settled `abandoned/interrupted` on the next start and reviewed again.
  The run continues with the same `--resume-since` value.
- The resumed run was paused again at 16:08 UTC on 2026-11-04, right after the review of #3418
  settled, because the models' memory froze the owner's machine. 135 of the 229 reviews had
  measured something by then. The review of #3419 had just started; it is settled
  `abandoned/interrupted` on the next start and reviewed again.
- Independent review finding R4130-002 showed that a resume matched stored reviews only on the pair
  and the commits. From `28156040a` on, every review's client request id carries a reuse
  key over the configuration and composition digests, and a resume reuses only reviews with the
  current key. Reviews stored earlier carry no key. A resume reuses them only with
  `--resume-legacy-digest`, which must equal the run's configuration digest. The holdout resumes
  with `--resume-legacy-digest sha256:7c5395d728e44fe28f7681aca24db2c7b15ff8b39183b9ae534fff27192f6b9d`,
  the dev-6 product digest that the holdout recorded at its start. Its composition is unchanged
  too: between `0edb7387a` and this head, the only change under `packages/` is the generated catalog
  digest constant in `packages/keiko-contracts/src/activity-log-identity.generated.ts`, and
  `package-lock.json` is unchanged. Every review in the state directory since the holdout start
  is a holdout review.
- R4130-027 widened the composition digest to the workspace dependency closure of `keiko-server`
  and `keiko-evaluations` (25 packages), the gate's non-test sources, `tsconfig.base.json` and
  `scripts/stage-dev-coding-runtime.mjs`. Over that whole set, `git diff --stat 0edb7387a` to this
  head shows two kinds of change. Under `packages/`, it shows only the generated catalog digest
  constant. Under `tests/review-quality/`, it shows the resume, evidence, argument and re-score
  handling of this PR, plus two removed `export` keywords in `repository.ts` and `server.ts`. None
  of them changes how a review runs or is scored, so the legacy reviews and the resumed reviews ran
  the same review code.
- The run resumed at 00:55 UTC on 2026-11-05 with the legacy digest above. The first keyed review
  was #3419, and its stored legacy review settled `abandoned/interrupted`. The owner paused the run
  twice more, each time right after a review settled, so another session could use the machine:
  from 17:08 to 17:11 UTC on 2026-11-05, and from 06:08 to 11:03 UTC on 2026-11-06. A review that
  had only started when a pause stopped it was reviewed again on the next start.
- The run finished at 12:52 UTC on 2026-11-06. All 229 pull requests were replayed and none was
  left unprepared. The evidence is `evidence.json` (sha256 `8fbe1afb4509a27ff294601b65cffc41a100a642b530807b1c6b79fe0549c712`).
- No finding, match or rate of the holdout was read before the run finished. Only settlement counts
  and kinds and the Activity Log entries around the first review were read, to find the cause of
  the 17 refusals and to watch progress.

### Holdout result

The run's own report printed `pass`. That verdict comes from the frozen gate code of the holdout
start, which predates the owner's scoring decisions of 2026-11-04: it left undecided findings out of
the rate (18 of 19) and did not gate the not-complete share. It is not the gate result.

The gate result is the offline re-score of the stored run. `rescoreReviewReplayRun` scores the
recorded finding locations again with the epic's scoring (R4130-006, -007, -010, -011, -014) over
dataset schema 2 (`sha256:376d45f51991cc68ec72c3d9ba40f29e0d93a9debf9cd47653cbb5aff481af8f`), and
`evaluateReviewPrecisionGate` evaluates the result. No review ran again; settlements, costs and
finding locations are the stored ones.

| Measure                                                   | Value                                    | Threshold     |
| --------------------------------------------------------- | ---------------------------------------- | ------------- |
| Verdict                                                   | fail                                     |               |
| Reviews that did not settle `complete`                    | 185 of 229 (80.8 %)                      | at most 20 %  |
| Actionable rate, hits / (hits + false alarms + undecided) | 53.1 % (17 / 32; 95 % CI 36.4 to 69.1 %) | at least 50 % |
| Acceptance rate, hits / (hits + false alarms)             | 100 % (17 / 17), not gated               |               |
| Findings per pull request                                 | mean 0.54, max 3                         | at most 3     |

The 124 findings split into 17 hits, no false alarm, 15 undecided, 10 unmeasured, no duplicate and
82 unmatched to any historical thread. The re-score matches findings against the anchors carried
to the head commit (R4130-007). Against the frozen report, it changed 23 finding outcomes:

| Frozen outcome | Re-scored outcome | Findings |
| -------------- | ----------------- | -------- |
| unmatched      | unmeasured        | 10       |
| hit            | unmatched         | 6        |
| unmatched      | hit               | 3        |
| false alarm    | hit               | 1        |
| undecided      | hit               | 1        |
| undecided      | unmatched         | 1        |
| unmatched      | undecided         | 1        |

The single reason for the failure is coverage.

| Settlement                      | Reviews |
| ------------------------------- | ------- |
| `complete`                      | 44      |
| `incomplete/budget-exhausted`   | 88      |
| `incomplete/files-unprocessed`  | 50      |
| `incomplete/deadline-exceeded`  | 28      |
| `incomplete/model-failed`       | 17      |
| `skipped/diff-too-large`        | 1       |
| `skipped/no-reviewable-changes` | 1       |

The Reviewer used a mean of 941,909 prompt tokens and 13,291 completion tokens per review, and the
counter-checker 31,388 and 5,152. The median wall time per review was 909 s.

### Behaviour changed after the measurement

Under owner decision 3, these review changes landed after the holdout and are not part of what it
measured:

- R4130-003: the review admits the role-model pair before it makes either model ready. A refused
  pair now loads no model. Every holdout review ran with an admitted pair, so this changes no
  measured review.
- The review service, runtime, worktree and diff fixes of #4250 to #4254 (merged through #4255),
  including the merge-base diff of R4130-008. The holdout ran the review code recorded in its
  configuration digest above.

## Seed gates

Under owner decision 3, the seed gates ran once on the final review code, after the holdout. The run
started at 13:54 UTC on 2026-11-06 from `c26c21bd4` with a fresh state directory, with the same pair
and variant as the holdout, and finished at 14:52 UTC. The evidence is `evidence.json` (sha256
`b5f7644e88b1356a6dc30d64ccfa1f5df01282655f73c14a68eb9828f6524603`).

The seed gate fails. It needs every required seed found. The run found 10 of 13 required seeds and
raised one false alarm on a clean control:

| Seed                                              | Role          | Outcome     | Settlement                     |
| ------------------------------------------------- | ------------- | ----------- | ------------------------------ |
| synthetic-off-by-one-boundary                     | required      | missed      | `complete`                     |
| synthetic-nullish-dereference-after-optional      | required      | incomplete  | `incomplete/model-failed`      |
| workspace-relative-candidate-resolved-against-cwd | required      | incomplete  | `incomplete/model-failed`      |
| synthetic-clean-named-constants                   | clean control | false alarm | `complete`                     |
| synthetic-clean-added-test                        | clean control | incomplete  | `incomplete/deadline-exceeded` |

The other 12 cases came out as expected: the other 10 required seeds were found, the advisory seed
was found, and `synthetic-clean-rename` stayed clean. Of the 17 reviews, 14 settled `complete`, 2
`incomplete/model-failed` and 1 `incomplete/deadline-exceeded`. The median wall time per review was
99 s.

The run's own report shows `synthetic-clean-added-test` as `clean`. Its review hit the deadline with
one candidate the counter-check had not decided, so the control was not measured (R4130-040). The
seed scoring now reports such a control as `incomplete`. Only two of the three clean controls were
measured, so the one false alarm is a lower bound. The recall verdict does not depend on clean
controls and is unchanged.

### Seed runs after the first gate result

Each later change to the review pipeline was followed by a seed run with the same pair. The seed
set runs as often as needed; none of these runs read a holdout pull request. No run of a tree
under review found every required seed. Two runs of prompt variants on local branches did; the last
reading bullet names them.

| Date       | Tree                                                                                          | Required found | Required seeds not found                                                    | False alarms on clean controls | Settlements                 |
| ---------- | --------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------- | ------------------------------ | --------------------------- |
| 2026-11-08 | `546ef5daf` (diff package in parts, #4320)                                                    | 10 of 13       | 3 incomplete: unchecked-input, secretbox-authentication, workspace-relative | 2                              | 14 complete, 3 model-failed |
| 2026-11-09 | `840ec9357` (epic branch with #4320, run to capture the invalid tool calls)                   | 11 of 13       | workspace-relative missed; secretbox-authentication incomplete              | 1                              | 16 complete, 1 model-failed |
| 2026-11-09 | `572cf0d25` (described schema repairs, first commit of #4330)                                 | 12 of 13       | off-by-one missed                                                           | 1                              | 17 complete                 |
| 2026-11-10 | `712f39913` (one defect definition, #4332) plus five lab-only commits, local head `d5b6de1d8` | 12 of 13       | off-by-one missed                                                           | 0                              | 16 complete, 1 model-failed |
| 2026-11-12 | `ba4a5993b` (three lines after a change)                                                      | 12 of 13       | workspace-relative missed                                                   | 0                              | 17 complete                 |
| 2026-11-12 | `0929b4ed0` (local merge of the read allowance `d5eb80bd5` and `39144f91a`)                   | 12 of 13       | secretbox-authentication incomplete                                         | 0                              | 16 complete, 1 model-failed |
| 2026-11-12 | `0929b4ed0`, second run                                                                       | 11 of 13       | swallowed-error missed; workspace-relative incomplete                       | 0                              | 16 complete, 1 model-failed |

Each tree is the checkout commit the run's evidence records. #4330 merged as the squash
commit `1ed4787e9`, which also contains its second commit `883a8b355`; the trees from 2026-11-10 on
include `1ed4787e9`.

Reading of these runs:

- The three incomplete reviews of 2026-11-08 ended on an invalid tool call. The capture run was
  made to record such calls and had one incomplete review. The one incomplete review of 2026-11-10
  was the advisory seed; its cause was not determined.
- The 2026-11-10 run was made while every process start on the lab machine took about 13 seconds.
  It used a local branch that raised 20 timeouts and wall-time limits and re-pinned the
  governed-tools plugin digest one of those raises changed. Its prompts, token budgets and review
  logic were the tree's own, its durations are not comparable, and its configuration digest is not
  the tree's. It is evidence for the prompt change of #4332, not a gate verdict for a release.
- The five `missed` outcomes show the same failure pattern: off-by-one on 2026-11-06, 2026-11-09
  and 2026-11-10, and workspace-relative on 2026-11-09 and 2026-11-12. Each time the Reviewer
  reported the changed lines and named a consequence that a later check stops: an `undefined` item
  that the guard on the next line drops, or a path outside the workspace that the containment check
  still refuses. The Counter-checker refuted each candidate (`guarded-elsewhere` or
  `evidence-mismatch`) and cited that check, which is correct for the consequence as stated. The
  consequence that gets past the check was not reported. Why the Reviewer stops at the first
  consequence is open.
- With three lines after a change the off-by-one seed's guard is inside the hunk, and the
  2026-11-12 run found that seed. In the workspace-relative seed the check was already in view, so
  more context is not what that seed lacks.
- In the 2026-11-12 run on `ba4a5993b` one review, `secretbox-authentication-failure-swallowed`,
  used 970,637 of the run's 1,291,313 Reviewer prompt tokens in a single session.
- The two runs on `0929b4ed0` measure the Reviewer's read allowance of 24 calls. Their review code
  is the code of the merge commit `3eef798e7`, without the later rule that a session which was
  refused a read and filed no report is incomplete. One session of the 34 reached the allowance: 24
  calls were let through and one was refused, then the session filed its report and completed. No
  review ran out of prompt budget, and the Reviewer used 935,336 and 546,547 prompt tokens per run.
- The three required seeds these two runs did not find have three different causes, and none is the
  pattern above. In the first run the Counter-checker's model call failed and left the one candidate
  undecided. In the second run the Counter-checker refuted a correct report of the swallowed-error
  seed as `evidence-mismatch`, and the Reviewer's report call for the workspace-relative seed was
  invalid twice, so the turn failed with `invalid-tool-call` and the session ended without a
  candidate.
- The evidence of the two runs on `0929b4ed0` is `evidence.json` with sha256
  `734b3deae6cd9851c2fec9b2d3fae4956155c62848ef3ab05897622995cdcd2f` (first run) and
  `cd3275152373104874c8ead3cb6aad0cd7f498e23854d84b0cf78991ec8015a1` (second run).
- A session that the read allowance stops without an accepted report settles its run
  `incomplete/budget-exhausted` (R4130-054). That rule costs complete reviews: in the 418 stored
  reviews of the 4-bit gate runs, 30 of the 84 complete reviews made more than 24 model calls, and
  9 of those 30 had no accepted report. Model calls include reports, so at most 9 of the 84 would
  have settled `incomplete` under the rule. Development iteration 7 is read against that number.
- Two prompt variants were run twice each in the same night. Each is one local commit on top of
  `0929b4ed0`. The branches are kept on the lab machine and are not pushed, so these four runs are
  lab evidence that this repository cannot reproduce, and none of them is a gate verdict.

  | Variant                                                                                                          | Local head  | Run | Required found | Required seed not found                                   | False alarm on a clean control | `evidence.json` sha256                                             |
  | ---------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------- | --------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
  | Counter-checker: an overstated consequence is still a defect when the reported lines misbehave for another input | `5e17e26f9` | 1   | 13 of 13       | none                                                      | synthetic-clean-added-test     | `e2af883a76960ac1ddb6d868e57c3ecd23b51b9eec76a41c6e5a5cbe0458c83d` |
  | same                                                                                                             | `5e17e26f9` | 2   | 12 of 13       | secretbox-authentication incomplete (`deadline-exceeded`) | none                           | `78459bd2c5cf30f1f00440ae660689e2a94ff46e2fb12d732bfa71c49f0da7b3` |
  | Reviewer: work one input through the head and the base before reporting                                          | `6c8899b3b` | 1   | 13 of 13       | none                                                      | none                           | `d8cc6efb489b55df7c4359fa134b7f18c0f99e7dda8754c77cf5b77942d5b30a` |
  | same                                                                                                             | `6c8899b3b` | 2   | 12 of 13       | secretbox-binary-envelope-boundary missed                 | synthetic-clean-rename         | `4ab8063b5c8372cc32d3a02d5436e968397976e7afe4724f34e722890f8bf128` |

  A clean control drew a candidate in 1 of 6 reviews on the unchanged tree, in 2 of 6 with the
  Counter-checker variant and in 5 of 6 with the Reviewer variant. Two runs per variant do not
  separate either from the unchanged tree, so neither is adopted.

## Decision

The offline gate fails. The holdout fails on coverage, and the seed gate fails on one missed and two
incomplete required seeds. Children 9 to 12 of epic #4130 stay closed, and the review
area stays off by default (`KEIKO_REVIEW_ENABLED`). What to change before a new measurement is an
owner decision. Settlements show budget exhaustion, unprocessed files and deadlines as the main
causes. A new measurement needs a new holdout, because ADR-0184 D9 runs a holdout once.
