# Review gate lab: 4-bit against 8-bit

`lab.sh` serves the review model pair on one Mac and runs the offline review gate
(ADR-0182 D9, Issue #4138) against it. It is meant for the quantization diagnostic proposed on
Epic #4130 after the holdout failed on coverage. The same development sample and seed set run once
with the 4-bit pair and once with the 8-bit pair, on the same code and the same machine. Only the
weights differ.

The script creates everything in `$KEIKO_REVIEW_LAB` (default `~/keiko-review-lab`), outside the
checkout. Every server listens on loopback only. The LiteLLM master key is generated once into
`$KEIKO_REVIEW_LAB/.env` (mode 600). It reaches the Keiko server only through the environment, and
the script never prints it.

## What the runs measure

| Run           | Cases                                                                                                    | Wall time at 4 bit on an M5 Pro with 64 GB |
| ------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `development` | The 30 newest eligible development PRs. The selection is deterministic, so both runs review the same 30. | about 3.6 hours                            |
| `seeds`       | The 13 required seeds, one advisory seed and three clean controls                                        | about 1 hour                               |

Expect the 8-bit runs to take longer. Generation on Apple silicon is limited by memory bandwidth,
and 8-bit weights move about twice the bytes per token.

Neither set touches the holdout. The holdout was measured once on 2026-11-06 and is spent.

## Requirements

- An Apple silicon Mac. The 8-bit pair needs 71.5 GB of weights plus two bounded prompt caches of
  4 GB and 6 GB, so plan for a machine with 128 GB. The 4-bit pair needs 38.8 GB of weights.
- By default, macOS lets the GPU use about three quarters of the RAM: about 96 GB on a 128 GB Mac,
  which fits the 8-bit pair. `lab.sh` changes no system setting.
- About 115 GB of free disk for both pairs in the Hugging Face cache (`~/.cache/huggingface`).
- `python3` (the holdout used 3.14), `node` and `npm` in the versions the root `package.json` `engines`
  require, `git`, `curl`, `openssl` and `lsof`.
- A Keiko checkout of branch `claude/4130-8bit-diagnostic-kit` or later, with `npm ci` and
  `npm run build:packages` done. The checkout must have no uncommitted changes, because the gate
  refuses to run on uncommitted review code.
- No other model server or LiteLLM on ports 8080, 8081 and 4000. To use other ports, set
  `KEIKO_REVIEW_LAB_REVIEWER_PORT`, `KEIKO_REVIEW_LAB_COUNTER_PORT` and
  `KEIKO_REVIEW_LAB_GATEWAY_PORT` for every `lab.sh` command.

## Procedure

Run everything from the checkout root.

1. **Set up both pairs.** This creates a Python virtual environment with `mlx-lm` 0.32.2 and
   `litellm` 1.106.6, the versions the holdout used. It downloads the four models at their pinned
   revisions, writes the configs and clones Keiko as the evaluation repository. The downloads are
   about 110 GB in total.

   ```bash
   scripts/testing/review-quality/lab/lab.sh setup 4bit
   scripts/testing/review-quality/lab/lab.sh setup 8bit
   ```

2. **Check the generated gateway configs** with Keiko's own config parser:

   ```bash
   scripts/testing/review-quality/lab/lab.sh check 4bit
   scripts/testing/review-quality/lab/lab.sh check 8bit
   ```

3. **Run the four measurements**, one at a time. Each `run` waits until macOS can reclaim enough
   memory (42 GB for 4 bit, 84 GB for 8 bit), starts the pair and the gateway, runs the gate and
   stops everything again, also on failure or Ctrl-C. Close other memory-heavy apps first.

   ```bash
   scripts/testing/review-quality/lab/lab.sh run 4bit development
   scripts/testing/review-quality/lab/lab.sh run 8bit development
   scripts/testing/review-quality/lab/lab.sh run 4bit seeds
   scripts/testing/review-quality/lab/lab.sh run 8bit seeds
   ```

   A model server whose generation thread dies answers every later request with 404. A watchdog
   restarts the pair when that happens and records it in `$KEIKO_REVIEW_LAB/logs/restarts.log`.

4. **Hand back the evidence.** Each run writes `evidence.json` and `summary.md` under
   `$KEIKO_REVIEW_LAB/evidence/<quant>-<timestamp>/<iteration>-product/`. The iteration is
   `dev-<quant>-<timestamp>` for a development run and `seeds` for a seed run. They are body-free: counts, settlements,
   digests, token counts and durations, with no source text, prompt or model output. Attach the four
   `summary.md` files and `evidence.json` files to the epic, or share them with the Keiko agent
   session. Also send `logs/restarts.log` if it exists.

To stop a lab that is still up, for example after a crash, run `lab.sh stop`.

`cleanup-proof.sh` checks the cleanup without models or network. It runs `lab.sh run` against stub
servers on ports 18080, 18081 and 14000 and checks that a failing gate, Ctrl-C, SIGTERM and a taken
port each keep the right exit status and leave no server running.

## Model builds

| Role            | 4 bit                                                            | 8 bit                                                            |
| --------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| Reviewer        | `mlx-community/Qwen3.6-35B-A3B-4bit` at `38740b847e4c` (20.4 GB) | `mlx-community/Qwen3.6-35B-A3B-8bit` at `e06a74e6236a` (37.7 GB) |
| Counter-checker | `mlx-community/gemma-4-31b-it-4bit` at `696d436c4047` (18.4 GB)  | `mlx-community/gemma-4-31b-it-8bit` at `f5f3dc92ab4a` (33.8 GB)  |

`lab.sh` holds the full revisions. Both pairs are served with the same settings as the holdout:

- the Reviewer in Qwen's non-thinking mode, at temperature 0.7, top-p 0.8 and top-k 20;
- the counter-checker at temperature 1.0, top-p 0.95 and top-k 64;
- an 8,192-token output limit, one request at a time and a 512-token prefill step.

## How to read the comparison

The expectations and decision rules are in the diagnostic proposal on Epic #4130. In short: if
8-bit lowers model failures and wrong counter-check rejections while its reviews still finish in
time, it is worth its memory. Budget exhaustion and unprocessed files are expected to stay about the
same, because they follow from the tokens the Reviewer resends on each tool call, not from weight
precision.
