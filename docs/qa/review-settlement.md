# Review settlement

How a review finding becomes a resolved conversation here, how long each step actually takes, and
which lever is left. The measurements behind every claim are in
[`settlement-latency-baseline.md`](settlement-latency-baseline.md); regenerate them with
`npm run report:settlement-latency`.

## The rule that nothing below may bend

A review conversation is resolved **only** because its finding was fixed, or explicitly dispositioned
with a rationale written in that thread. No automation, bulk action, timer or scheduled sweep in this
repository resolves a conversation, and none may be added — that resolution act is an ADR-0135
merge precondition, and converting it into a process step would turn a settlement guarantee into a
formality. Everything in this document removes redundant steps around that act. It never performs it.

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

| Producer              | How a finding appears                                                                               | How it settles                                                                                                                                            | What the delivering agent must do                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CodeRabbit**        | Inline review comments create threads; **nitpicks live only in the review body and have no thread** | A fix-push auto-resolves thread-anchored findings once CodeRabbit re-reviews the new head                                                                 | Fix and push. Answer body-only nitpicks with a top-level pull-request comment — no thread exists to reply on. If a thread does not auto-resolve, reply inline with the fix evidence and resolve it. |
| **Qodo**              | Edits one summary comment in place, head-SHA stamped                                                | Never resolves by discussion: `Keiko for Quality` parses the finding **count** out of the review body, so only a new head with the finding gone clears it | Fix and push. Resolving the thread or rejecting the finding in prose does not turn the check green — only code does.                                                                                |
| **Keiko for Quality** | The required check bridging Qodo's advisory review (ADR-0142/0143)                                  | Settles on the exact current head after the 60 s stability window, bounded by a 5 min settle cap                                                          | Wait for the new head's evaluation. A KFQ success against a stale head is not a pass — check `commit_id` currency.                                                                                  |
| **SonarCloud**        | Quality gate plus issues that can sit **below** the gate's own thresholds                           | Clears when the issues are gone on the current head                                                                                                       | Query `api/issues/search?...&pullRequest=<n>&resolved=false` directly. The gate summary hides findings that do not breach it, and those still cost a later round if they surface.                   |

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

## KFQ cadence: reviewed, unchanged

`STABILITY_WINDOW_MS=60000` and `maxSettleWaitMs=300000` stay as they are. Against a median settlement
span of 5.6 minutes and a 0.1-minute final gap, the 60-second window is not a measurable contributor,
and it is load-bearing for a reason the numbers do not show: Qodo edits its summary in place, so a
same-head re-review can invalidate a just-published verdict. Shrinking the window re-opens exactly
the stale-verdict class that probes 3 and 6 in [`keiko-for-quality.md`](keiko-for-quality.md)
negative-tested. Treat that probe suite as a pin — relocate or strengthen, never relax (AGENTS.md §7).
Any change to either constant requires all six live probes re-run green, in its own commit, with the
evidence linked.

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
