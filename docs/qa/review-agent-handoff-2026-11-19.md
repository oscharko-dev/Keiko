# Keiko for Quality: handoff, 2026-11-19

Epic #4130 moves from the agent session that drove it with the 4-bit lab pair to @oscharko, who
continues it with 8-bit models. This page states where the epic stands, what the measurements
show, what is open, and how to run the next measurement. The measurement record itself is
[review-agent-offline-gate-2026-11-01.md](review-agent-offline-gate-2026-11-01.md); the decisions
are in [ADR-0184](../adr/ADR-0184-keiko-for-quality-governed-pull-request-review-agent.md).

## Where the epic stands

- Branch `feat/epic-4130-keiko-for-quality` holds every change. It carries `dev` up to Keiko 1.5.3
  and nothing is open against it.
- Children #4131 to #4137 are closed. #4138, the offline gate, is open: the one holdout run failed.
  Work on children #4139 to #4142 does not start until a holdout passes, and the review area stays
  off by default (`KEIKO_REVIEW_ENABLED`). #4143, publishing to GitHub, waits for the live gate
  as well (ADR-0184 D9).
- The one holdout run (2026-11-02 to 2026-11-06, 229 pull requests from #3066) failed on coverage:
  185 of 229 reviews did not settle `complete` (limit 20 %), with an actionable rate of 53.1 %
  (17 of 32). The seed gate failed on one missed and two incomplete required seeds. #4138
  acceptance criterion AC1 runs the holdout exactly once, so the next holdout needs a new held-out
  set; choosing it is an owner decision.
- Since the holdout, 15 changes to the review code have landed (#4320 to #4484). They are listed in
  the iteration log of the gate record with what each development iteration measured.

## What the development iterations show

Every development iteration replays the same 30 development pull requests (#2978 to #3065) with
the 4-bit pair: Reviewer `qwen3.6-35b-a3b-4bit`, Counter-checker `gemma-4-31b-it-4bit`, on one
64 GB Mac.

| Iteration | Not complete      | Actionable (gated) | False alarms | Median wall time |
| --------- | ----------------- | ------------------ | ------------ | ---------------- |
| dev-7     | 17 of 30 (56.7 %) | 45.5 % (10 of 22)  | 2            | 2311 s           |
| dev-8     | 14 of 30 (46.7 %) | 59.1 % (13 of 22)  | 2            | 2621 s           |
| dev-9     | 7 of 30 (23.3 %)  | 50.0 % (12 of 24)  | 3            | 2298 s           |
| dev-10    | 6 of 30 (20.0 %)  | 72.7 % (16 of 22)  | 0            | 3099 s           |

dev-10 is the first development run at both limits: at most 20 % not complete, at least 50 %
actionable. These are development numbers on a sample the changes were tuned on; only a holdout
decides. One of dev-10's six incomplete reviews is a lab artefact: the machine slept with its lid
closed during it.

Two later runs were stopped early on purpose and are not iteration results:

- dev-11 (review code `1310c91ea`) settled 5 complete and 1 incomplete review before it was stopped
  for dev-12. It captured the Counter-checker's runaway answers described below.
- dev-12 (review code `0ef9935d6`, with #4484) settled its first review `complete` before it was
  stopped for this handoff. It had 11 candidates, and every counter-check decided: 2 confirmed,
  4 refuted `guarded-elsewhere`, 5 refuted `evidence-mismatch`. None of the 64 answers of its 11
  counter-checks used up the output budget. One review measures nothing about #4484; a full run
  does.

## What is open

1. **The Counter-checker's runaway turns.** Most remaining incomplete reviews come from
   counter-checks that end without a verdict. A Gemma turn reasons through its whole 4,096-token
   output budget, the gateway's steered repair does the same, and the check fails `model-failed`. At
   about 13 tokens a second, two such turns also fill most of the 900-second limit. The dev-11
   capture showed the cause in the one case it caught: no repetition loop, but a long deliberation
   over whether a candidate is a defect at all, and then over which refutation reason code to use.
   #4484 orders the reason codes, puts the non-defect rule first and names the case that caused it.
   Its effect is unmeasured. Its opt-in sentence can turn a confirmation into a refutation, so the
   next development run must report every known hit that moves from confirmed to refuted
   (R4130-090).
2. **Whether 8-bit weights change the picture.** The 4-bit pair decodes slowly, and its runaway
   turns cost minutes. The lab kit measures the 8-bit pair on the same code and sample (see below).
3. **A new holdout.** The next holdout needs a new held-out set and the same discipline: run once,
   no prompt tuning on it, no finding read before it finishes.
4. **The seed gate** runs once more on the final review code after the holdout.
5. **CI.** The package coverage shard 2/4 runs 26 to 45 minutes against a 45-minute job limit, on
   `dev` branches as well as on the epic. A timed-out shard is not a code failure; rerunning the
   failed jobs has passed every time.

## How to run the next measurement

The kit is [scripts/testing/review-quality/lab](../../scripts/testing/review-quality/lab/README.md).
It serves a pair with mlx_lm and LiteLLM on loopback and runs the gate against it, with the
gateway settings of development iterations 9 to 12.

```bash
scripts/testing/review-quality/lab/lab.sh setup 8bit
scripts/testing/review-quality/lab/lab.sh check 8bit
scripts/testing/review-quality/lab/lab.sh run 8bit development
scripts/testing/review-quality/lab/lab.sh run 8bit seeds
```

- The 8-bit pair needs a 128 GB Mac, on power with the lid open for the whole run.
- `run 4bit development` on the same machine gives the comparison on identical code.
- Each run writes `summary.md` and `evidence.json`. Add a row for each development run to the
  iteration log of the gate record, with the settlement counts and the gated rate.
- To see why a review is incomplete, start from its run in the state directory's Activity Log:
  `review.run.part`, `review.counter-check.completed` (`effect`, `verdict`, `durationMs`,
  `completionTokens`) and the gateway lines of the same correlation. `gateway.retry.scheduled`
  with `reason=output-exhausted-repair` marks a turn that used up its output budget, and
  `chat.response.streamed` says how much of it was reasoning (`reasoningEvents`).
- Before reading a run's time limits, check that the machine stayed awake over its window:
  `pmset -g log | grep -E "Sleep|Wake"`.

## Rules the epic ran under

These owner decisions are binding for the rest of the epic:

- The gated rate is hits / (hits + false alarms + undecided). The not-complete limit is 20 % and is
  never loosened.
- A holdout runs once, and holdout pull requests are never used to tune prompts.
- Work on children #4139 to #4142 does not start until a holdout passes.
- Pull requests into the epic branch may be merged once green and reviewed; only @oscharko merges
  into `dev`. `dev` syncs land on the epic branch as a fast-forward of a true merge commit, so the
  epic keeps `dev`'s ancestry.

The epic's own pull requests were reviewed in rounds by an independent agent session that posted
each round as a comment review with one inline thread per finding, numbered R4130-001 to
R4130-090. Every thread got a reply with a fix reference or an evidenced refutation. The next
free number is R4130-091.
