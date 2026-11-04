# Review agent offline gate, 2026-11-01

The offline gate of Epic #4130 (Issue #4138, ADR-0182 D9) for the Keiko for Quality review agent.
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
npm run review:quality-gate -- --set development --iteration dev-1 \
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

| Iteration                            | Variant           | Change                                                                                                                                                                    | Configuration digest | Decided | Actionable                                                                                   | Findings per PR (max) | Settlements                                                                                        | Median wall time |
| ------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------- | -------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| smoke                                | product           | First composition run on two pull requests (`59c8f660d`).                                                                                                                 | `92566e836fef`       | 0       | n/a                                                                                          | 0                     | 2 model-failed                                                                                     | 137 s            |
| dev-1                                | product           | First full development run (`4f225dd8d`): Qwen corrections join the leading system message.                                                                               | `92566e836fef`       | 0       | n/a                                                                                          | 0                     | 29 skipped/policy-invalid, 1 model-failed                                                          | 1 s              |
| repro, probe-sampling, probe-nothink | product           | Three-PR probes on #2978, #2979 and #2981 (`bb1affec1`): the authority refusal is now logged; Reviewer sampling at the model's recommended values, then without thinking. | `61ad9712f5b4`       | 0       | n/a                                                                                          | 0                     | complete 2, model-failed 5, files-unprocessed 1, deadline-exceeded 1                               | 211 to 527 s     |
| dev-2 (first attempt)                | product           | `17342d886`: a macOS Reviewer failure settles on its own cause; counter-check wall time 300 s. Stopped after the role models' readiness lapsed.                           | `b752b79cb560`       | 0       | n/a                                                                                          | 0                     | 29 skipped/policy-invalid, 1 deadline-exceeded                                                     | 1 s              |
| dev-2                                | product           | `648cb03f8`: a role model whose readiness lapsed is checked again before the run.                                                                                         | `4c4d15ed983a`       | 0       | n/a (5 presented: 2 undecided, 3 unmatched)                                                  | 3                     | 14 budget-exhausted, 5 model-failed, 5 deadline-exceeded, 3 files-unprocessed, 3 complete          | 183 s            |
| dev-3                                | product           | `bf7574364`: the Reviewer is told to report each finding once confirmed and to plan for about 15 read or search calls; the Counter-checker to use at most four.           | `dfcb28e93038`       | 0       | n/a (1 presented, unmatched)                                                                 | 1                     | 18 budget-exhausted, 6 model-failed, 4 complete, 1 deadline-exceeded, 1 files-unprocessed          | 184 s            |
| dev-4                                | product           | `7b3437265` with `KEIKO_REVIEW_RUN_MAX_PROMPT_TOKENS=1500000`: the Reviewer prompt allowance raised from 600,000 to 1,500,000 tokens.                                     | `c2a4ccc7abfb`       | 4       | 75.0 % (3/4, Wilson 95 % interval 30.1 to 95.4 %; 15 presented, 2 undecided, 9 unmatched)    | 3                     | 10 model-failed, 8 budget-exhausted, 5 complete, 5 files-unprocessed, 2 deadline-exceeded          | 477 s            |
| dev-5                                | product           | `b6c850be8`: the review route buffers every upstream model call (`2b8e673dc`), and the Reviewer's default prompt allowance is 1,500,000 tokens.                           | `9b108e9e321b`       | 1       | 0.0 % (0/1, Wilson 95 % interval 0.0 to 79.3 %; 11 presented, 10 unmatched)                  | 3                     | 9 budget-exhausted, 9 deadline-exceeded, 7 complete, 4 files-unprocessed, 1 model-failed           | 775 s            |
| dev-6                                | product           | `912b930f5`: the counter-check wall time raised from 300 to 600 seconds.                                                                                                  | `7c5395d728e4`       | 3       | 33.3 % (1/3, Wilson 95 % interval 6.1 to 79.2 %; 13 presented, 10 unmatched)                 | 3                     | 11 budget-exhausted, 7 complete, 6 deadline-exceeded, 5 files-unprocessed, 1 model-failed          | 845 s            |
| dev-6                                | counter-check-off | `0feabae3c` (review code as `912b930f5`): every Reviewer candidate is presented without a counter-check.                                                                  | `e7801d852044`       | 4       | 100.0 % (4/4, Wilson 95 % interval 51.0 to 100.0 %; 24 presented, 5 undecided, 15 unmatched) | 3                     | 13 budget-exhausted, 9 complete, 6 files-unprocessed, 1 deadline-exceeded, 1 model-failed          | 631 s            |
| dev-6 (first attempt)                | roles-swapped     | `8982b14fd` (review code as `912b930f5`): Gemma as Reviewer, Qwen as Counter-checker. Stopped measuring after Gemma's server ran out of GPU memory.                       | `a216908b13b1`       | 0       | n/a                                                                                          | 0                     | 18 skipped/model-unavailable, 6 model-failed, 2 complete, 2 deadline-exceeded, 2 files-unprocessed | 2 s              |
| dev-6                                | roles-swapped     | `8982b14fd` (review code as `912b930f5`), rerun with the memory bounds below: Gemma as Reviewer, Qwen as Counter-checker.                                                 | `a216908b13b1`       | 0       | n/a (no candidate reported)                                                                  | 0                     | 11 complete, 11 files-unprocessed, 8 deadline-exceeded                                             | 762 s            |

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
- No finding, match or rate of the holdout was read before the stops. Only settlement counts and
  kinds and the Activity Log entries around the first review were read, to find the cause of the
  17 refusals and to watch progress.

## Seed gates

Not run yet.

## Decision

Not recorded yet.
