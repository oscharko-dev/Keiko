# Review agent offline gate, 2026-11-01

The offline gate of Epic #4130 (Issue #4138, ADR-0182 D9) for the Keiko for Quality review agent.
Definitions, labeling rules and the holdout discipline are in
[review-agent-measurement.md](review-agent-measurement.md).

## Pair and environment

| Item                             | Value                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Reviewer                         | `qwen3.6-35b-a3b-4bit` (mlx-community/Qwen3.6-35B-A3B-4bit)                                                           |
| Counter-checker                  | `gemma-4-31b-it-4bit` (mlx-community/gemma-4-31b-it-4bit)                                                             |
| Serving                          | mlx_lm 0.32.2 behind LiteLLM 1.106.6 on loopback, one Apple silicon Mac with 64 GB                                    |
| Gateway configuration generation | recorded per run in its evidence                                                                                      |
| Dataset                          | `review-harvest-dataset.v1.json.gz`, digest `sha256:c6dfbede99249e9fda874649d4a938e4d3e69b4b8fb8e70be0d3c099b486f194` |
| Holdout boundary                 | pull request #3066 (`REVIEW_EVALUATION_MANIFEST.holdoutFromPullRequest`)                                              |

## How a run is made

The composition is `tests/review-quality/`. It starts the real server composition and runs the
evaluation family's replay or seed gate through the composed review service, one review at a time.
Every run records its configuration digest (the committed review code, the variant and the pair),
the prompt digest, the dataset digest, the gateway configuration generation, the readiness probes,
each review's settlement, and per-role tokens and durations.

```bash
npm run review:quality-gate -- --set development --iteration dev-1 \
  --repository <evaluation clone> --config <gateway config> --state <state dir> --out <evidence dir> \
  --reviewer qwen3.6-35b-a3b-4bit --counter-checker gemma-4-31b-it-4bit
```

The evaluation clone is a local clone of Keiko with `origin` pointing at GitHub. The composition
fetches each replayed pull request's head through `refs/pull/<n>/head` when the clone lacks it, and
reviews the range from the merge base of its base and head commits to its head.

The development sample is the 30 most recent development pull requests with at least one decided
thread (a hit or a false alarm), because only decided threads can move the actionable rate:
#2978 to #3065. Every iteration replays the same sample.

## Iteration log

Each row is one recorded development-set run. No run before the final holdout run read a holdout
pull request; the replay refuses that, and every row's `split` is `development`.

| Iteration                            | Variant | Change                                                                                                                                                                    | Configuration digest | Decided | Actionable                                  | Findings per PR (max) | Settlements                                                                               | Median wall time |
| ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------- | ------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------- | ---------------- |
| smoke                                | product | First composition run on two pull requests (`59c8f660d`).                                                                                                                 | `92566e836fef`       | 0       | n/a                                         | 0                     | 2 model-failed                                                                            | 137 s            |
| dev-1                                | product | First full development run (`4f225dd8d`): Qwen corrections join the leading system message.                                                                               | `92566e836fef`       | 0       | n/a                                         | 0                     | 29 skipped/policy-invalid, 1 model-failed                                                 | 1 s              |
| repro, probe-sampling, probe-nothink | product | Three-PR probes on #2978, #2979 and #2981 (`bb1affec1`): the authority refusal is now logged; Reviewer sampling at the model's recommended values, then without thinking. | `61ad9712f5b4`       | 0       | n/a                                         | 0                     | complete 2, model-failed 5, files-unprocessed 1, deadline-exceeded 1                      | 211 to 527 s     |
| dev-2 (first attempt)                | product | `17342d886`: a macOS Reviewer failure settles on its own cause; counter-check wall time 300 s. Stopped after the role models' readiness lapsed.                           | `b752b79cb560`       | 0       | n/a                                         | 0                     | 29 skipped/policy-invalid, 1 deadline-exceeded                                            | 1 s              |
| dev-2                                | product | `648cb03f8`: a role model whose readiness lapsed is checked again before the run.                                                                                         | `4c4d15ed983a`       | 0       | n/a (5 presented: 2 undecided, 3 unmatched) | 3                     | 14 budget-exhausted, 5 model-failed, 5 deadline-exceeded, 3 files-unprocessed, 3 complete | 183 s            |
| dev-3                                | product | `bf7574364`: the Reviewer is told to report each finding once confirmed and to plan for about 15 read or search calls; the Counter-checker to use at most four.           | `dfcb28e93038`       | 0       | n/a (1 presented, unmatched)                | 1                     | 18 budget-exhausted, 6 model-failed, 4 complete, 1 deadline-exceeded, 1 files-unprocessed | 184 s            |

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
- From dev-4 on, the configuration digest also covers the run-budget operator settings
  (`KEIKO_REVIEW_RUN_MAX_PROMPT_TOKENS` and the duration and coding-envelope keys), and the
  evidence records their values.

## Final holdout run

Not run yet.

## Seed gates

Not run yet.

## Decision

Not recorded yet.
