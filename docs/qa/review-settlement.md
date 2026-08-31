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

- **CodeRabbit:** conditional request-changes review on every `dev` pull request and new push; quota
  can omit a current-head review. An omitted review creates no required status, but every emitted
  inline finding blocks until repaired and its conversation is resolved. Review-body and summary
  output remains advisory because it has no resolvable native thread. Never use ignore,
  bulk-resolve, dismissal, or bypass controls.
- **SonarCloud:** native gate plus issues that may sit below summary thresholds. Query the PR issue
  API, repair all findings, rerun the exact local analyzer, and require both native and repository
  validators to see zero current-head issues.
- **Repository `ci`:** parallel tests, coverage, secret, clone, architecture, and supply-chain
  evidence. Repair the complete failure set locally, push one consolidated head, and require every
  dependency to conclude success on that exact candidate.
- **Keiko for Quality (ADR-0170), when `vars.KEIKO_QUALITY_ENABLED` is `true`:** external
  SHA-pinned reviewer, no required status. Every published finding blocks until repaired and its
  conversation is resolved. Settlement is by the run for the **current head**, not by the presence
  of comments: a run can be absent, cancelled, or expired, and none of those is a clean review —
  say so rather than treating silence as approval. Its incomplete-review notice is itself a
  blocking conversation and is resolved by re-running a complete review, never by resolving the
  thread. Arming interlock and cancellation are ADR-0170 D5.

The expensive mistake this table exists to prevent is discovering findings one CI round at a time.
Enumerate **every already-published** finding from **every** active producer above in one pass —
failing job logs, the Sonar issues API, every unresolved thread — and then work that list into a
single new head. Do not wait for a producer that has not yet spoken. The baseline's 15-, 17- and
19-round pull requests are what round-at-a-time costs; the 10–30 minute band in issue #3342 is what
waiting for unpublished producers costs.

## Agent reaction SLO

**When a review finding is published on the current head, the delivering agent begins repairing it
within 10 minutes of its appearance.** Auto-merge arming is not a prerequisite for that clock.

This formalizes the proactive-monitoring practice that already exists as an operating habit. It is an
SLO, not a gate: nothing fails a check because a reaction was slow. Its measurement hook is the
`in-SLO` column of `npm run report:settlement-latency` (counts produced by the reporter, never a
hand-restated percentage). A repair round yields a sample only when a finding was actually published
while the previous head was live — a round pushed for any other reason (a rebase, a merge from `dev`,
an author-initiated change) answered no finding and is deliberately left unmeasured, so the reaction
figures are never diluted by rounds that had nothing to react to. Adherence is therefore visible per
pull request and in the cohort median over the rounds that did answer something.

Baseline adherence (2026-07-26) is **42%** (50 of 119 reactions within 10 minutes), median 11.4
minutes. The 2026-08-28 post-adoption cohort was **23.3%** (7 of 30), median 22.5 minutes. The
2026-08-31 follow-up in [#3342](https://github.com/oscharko-dev/Keiko/issues/3342) was **23.5%**
(8 of 34), median 19 minutes — still a regression against baseline. That share is the honest
substitute for Issue #2708's stated "median checks-green-to-merged gap ≤30 minutes" target, which
the same measurement shows is already met (follow-up median final gap 0.6 minutes) and would pass
without anything improving.

## Current-head cadence

Every enabled reviewer is configured to re-run on each ready pull-request update. A prior green
review does not bind a new SHA.

**Harvest window.** From the first finding published on a head, the delivering agent has 10 minutes
to push one repair. During that window it enumerates every finding already published by every
producer into that one head. It does not wait for CI to turn green, for a reviewer that has not yet
spoken, or for the ADR-0170 D5 interlock — that interlock gates auto-merge arming, not repair. A
finding that appears after the head is pushed starts a new 10-minute window on the new head.

If the same session cannot begin the repair within 10 minutes, the next agent that touches the pull
request starts from the unresolved-thread list immediately.

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
It writes nothing and requires no permission beyond reading the repository. The `in-SLO` column is
produced by the reporter from `REACTION_SLO_MINUTES`; do not recompute the share by hand.
