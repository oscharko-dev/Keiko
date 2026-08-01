# Review settlement

How a review finding becomes a resolved conversation here, how long each step actually takes, and
which lever is left. The measurements behind every claim are in
[`settlement-latency-baseline.md`](settlement-latency-baseline.md); regenerate them with
`npm run report:settlement-latency`.

## The rule that nothing below may bend

A review conversation is resolved **only** after its finding was fixed and the producing reviewer
accepted the new head. No automation, bulk action, timer, dismissal, override, or scheduled sweep in
this repository resolves a conversation, and none may be added. Resolution is an ADR-0135 merge
precondition; converting it into a process step would turn a settlement guarantee into a formality.

## What the measurement changed about the diagnosis

The founding observation for Issue #2708 was that finding-bearing pull requests took 108–122 minutes
wall-clock while every required check was green at 25–32 minutes. Measured over 60 merged pull
requests, the median gap between the last required check turning green and the merge is
**0.1 minutes**. Auto-merge is not slow; there is nothing there to cut.

The cost sits in the repair rounds themselves — a median of 3 per finding-bearing pull request — and
inside those rounds, in reaction time: of 119 measured reactions, **69 exceed 10 minutes**, with a
520-minute maximum. Review bots publish while CI is still running, so a fast reaction lands the
repair inside the CI window that was going to elapse anyway, and a slow one adds its full duration to
the wall clock.

## Settlement model per producer

| Producer            | How a finding appears                                                                  | How it settles                                                              | What the delivering agent must do                                                                       |
| ------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **CodeRabbit**      | Inline review threads plus body-only findings and a request-changes review             | Re-review of the repaired current head clears its own request-changes state | Fix every finding, push once, and verify the automatic clear. Never use the ignore/override controls.   |
| **Greptile**        | Inline comments, summary, and a current-head status                                    | Re-review reports no blocking finding and all conversations are resolved    | Fix every finding before the next head; never treat a passing liveness status as thread settlement.     |
| **SonarCloud**      | Native quality gate plus issues that may sit below its summary thresholds              | The native gate and repository validator both see zero current-head issues  | Query the PR issue API, repair all findings, and rerun the exact local Sonar analyzer before pushing.   |
| **CodSpeed**        | A per-benchmark comparison against the `dev` baseline                                  | The repaired head is no more than 5% slower than the baseline               | Reproduce the affected production entry point locally; do not update the baseline to hide a regression. |
| **Repository `ci`** | Parallel job logs for tests, coverage, secrets, clones, architecture, and supply chain | Every dependency concludes success on the exact candidate                   | Repair the complete failure set locally and push one consolidated new head.                             |

The expensive mistake this table exists to prevent is discovering findings one CI round at a time.
Enumerate **every** finding from **every** producer above in one pass — failing job logs, the Sonar
issues API, every unresolved thread — and then work the whole list into a single new head. The
baseline's 15-, 17- and 19-round pull requests are what round-at-a-time costs.

## Agent reaction SLO

**After arming auto-merge, the delivering agent monitors the pull request and begins repairing a new
finding within 10 minutes of its appearance.**

This formalizes the proactive-monitoring practice that already exists as an operating habit. It is an
SLO, not a gate: nothing fails a check because a reaction was slow. Its measurement hook is the
`reactions (min)` column of `npm run report:settlement-latency`. A repair round yields a sample only
when a finding was actually published while the previous head was live — a round pushed for any other
reason (a rebase, a merge from `dev`, an author-initiated change) answered no finding and is
deliberately left unmeasured, so the reaction figures are never diluted by rounds that had nothing to
react to. Adherence is therefore visible per pull request and in the cohort median over the rounds
that did answer something.

Baseline adherence is **42%** (50 of 119 reactions within 10 minutes), median 11.4 minutes. That is
the number the post-adoption report tracks, and it is the honest substitute for Issue #2708's stated
"median checks-green-to-merged gap ≤30 minutes" target, which the same measurement shows is already
met at 0.1 minutes and would pass without anything improving.

## Current-head cadence

Every enabled reviewer is configured to re-run on each ready pull-request update. A prior green
review does not bind a new SHA. The delivering agent waits for all producers to settle, enumerates
all new findings together, and repairs the complete set in one head instead of cycling one producer
at a time.

## The remaining lever, reserved to the owner

**Merge-queue activation** is the one integration-latency lever this task does not pull. Every
required workflow already triggers on `merge_group` (ADR-0139 D7), so the wiring exists; enabling it
is a branch-protection change and therefore an owner decision, outside agent authority. It would
remove the re-validation a pull request needs after `dev` moves underneath it — the cost that shows
up in this baseline as `never-fully-green` rows on pull requests that were rebased or merged
administratively.

## Regenerating

```bash
GITHUB_REPOSITORY=oscharko-dev/Keiko npm run report:settlement-latency -- --count 60
```

The report reads merged pull requests targeting `dev` through the GitHub GraphQL API, pages them
below the node-cost limit, and retries a transient 5xx with bounded backoff in the ADR-0139 D6 idiom.
It writes nothing and requires no permission beyond reading the repository.
