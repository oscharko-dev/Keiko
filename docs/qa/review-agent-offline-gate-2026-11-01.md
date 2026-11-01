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

| Iteration | Variant | Change | Configuration digest | Decided | Actionable | Findings per PR (max) | Settlements | Median wall time |
| --------- | ------- | ------ | -------------------- | ------- | ---------- | --------------------- | ----------- | ---------------- |

## Final holdout run

Not run yet.

## Seed gates

Not run yet.

## Decision

Not recorded yet.
