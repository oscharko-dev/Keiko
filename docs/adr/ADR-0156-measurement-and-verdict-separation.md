# ADR-0156 — A measurement lane measures; the gate judges

- Status: Accepted
- Amends: [ADR-0139](ADR-0139-agent-first-deterministic-quality-gates.md) (D1 producer contract and
  D10 freshness ownership; every other ADR-0139 decision stands)

## Context

Between 2026-07-19 and 2026-07-25 the repository could not deliver. The cause was not one defect but
two, locking each other:

1. **The nightly D12 regeneration lane failed 12 of 12 runs.** `editor-debugging-2348.spec.ts`
   asserts wall-clock budgets *inside the measurement*, so an overrun aborts the run and **no
   evidence is produced at all** — instead of evidence recording the overrun. The last failure was
   54ms against a 50ms cap. The lane runs on `ubuntu-latest`, shared hardware; its own comments
   already recorded that "the full ten-sample loop timed out on shared runners". The "controlled
   measurement context" ADR-0139 D1 assumes does not exist there.

2. **Every pull request answered for the measurement toolchain.** The toolchain digest compares
   committed evidence against the current tree, unconditionally. So the moment one pull request
   edited a `D12_MEASUREMENT_TOOLCHAIN_PATHS` member, the required `ui` check went red on every
   other open pull request, with no fix available inside the diffs that tripped it.

Together: pull requests blocked on stale evidence, and the only lane that could refresh it could not
complete. Four of the twelve most recent failing CI runs were the second defect alone, none of them
caused by the diff they blocked.

A third property made it invisible: the lane opens a pull request when evidence drifts, but said
nothing when it could not produce evidence. Twelve consecutive failures went unnoticed until
delivery deadlocked.

## Decision

**D1 — The producer measures; it does not judge.** The official D12 producer runs at full sample
depth (`KEIKO_D12_FULL_SAMPLE_DEPTH`) so its percentiles are meaningful, and no longer asserts the
budgets it is measuring. A budget overrun lands in the evidence and fails at
`check-perf-evidence.mjs`, which evaluates the same numbers against the committed document
(`outputFlood maxLongTaskMs > D12_CAP_LONG_TASK_BUDGET_MS`). The verdict was never missing — it was
duplicated, and the copy inside the measurement decided whether evidence existed at all.

**D2 — Toolchain freshness is owed by the change that moved the ruler.** The pull-request lane
evaluates the measurement-toolchain digest exactly when the diff touches
`D12_MEASUREMENT_TOOLCHAIN_PATHS`, resolved against the pull request (or merge-group) base sha. The
regeneration lane keeps evaluating it unconditionally. An unresolvable base ref evaluates rather
than skips, and says so. Integrity, budgets and the pinned-baseline anchor stay unconditional; the
pinned baseline compares against a fixed commit and cannot drift.

**D3 — A repair lane that fails must be loud.** `nightly-perf-evidence.yml` opens or updates a
tracking issue on failure, naming the consequence: while it is down, no pull request touching the
measurement toolchain has a route to green.

**D4 — Gates that can be reproduced without CI should be, before pushing.** `docker/gates/` commits
the Linux gate environment so contributors and agents run the common failure classes locally.
Architecture-bound measurement, hosted analysis, other operating systems and attestations stay
CI-owned; `docs/qa/local-gates.md` records which is which.

**D5 — D1 applies to every judge in the producer, not only the innermost one.** Removing the budget
assertion from the measurement spec was not enough: `build-d12-perf-comparison.mjs` ran the complete
gate — `evaluateD12Comparison`, `evaluateEditorEvidence`, `evaluateFreshness` — over its own freshly
built document *before* writing it, and aborted on any failure. So the first thing the repaired lane
did was measure successfully for the first time in twelve attempts and then throw the result away.

The producer therefore partitions its own findings, at both places it judges: the raw-artifact
derivation that runs while the document is still being assembled, and the self-check that runs just
before it is written. A failure that says the measurement cannot be trusted — a malformed bundle,
wrong provenance, a digest that does not match its inputs — stays fatal at both, because writing
that document would poison the gate. A performance-budget verdict says the measured product got
slower or heavier; it is written into the evidence, reported on stderr, and enforced by
`check-perf-evidence.mjs` on the pull request.

**Membership in the verdict class is established by construction, never by matching message text.**
`performanceBudgetFailure` registers each verdict as it formats it, and `isPerformanceBudgetFailure`
answers by membership. A classifier that pattern-matched free text would be wrong in both
directions: five different message shapes exist (`> budget`, `>= budget`, `> allowed`,
`> N ms budget`, `reached budget`), and a genuine defect whose text happened to fit would be
silently downgraded. With membership, a site that forgets the wrapper simply stays fatal — the
fail-closed direction — and no message reporting an untrustworthy measurement can ever be mistaken
for a verdict. The class covers all seventeen budget comparisons in the file, wall-clock and memory
alike; releasing only the ones that happen to be flaking would leave the same deadlock behind a
different metric.

Two consequences follow and are pinned. A defect accompanying a verdict is still fatal — a real
defect may never hide behind a slow measurement. And `evaluateD12Comparison` no longer lets a verdict
short-circuit its second stage: stage 1 stops on ill-formed input because stage 2 reads what stage 1
proved, but a budget verdict proves nothing ill-formed, so stopping there would hide exactly the
defects the producer still treats as fatal.

## Consequences

- A noisy neighbour on a shared runner costs one measurement, not the ability to measure.
- A performance regression is now reportable. Under D1 alone the measurement itself completed for
  the first time in twelve attempts (`nightly-perf-evidence` run 30146295959, "2 passed") and the
  comparison then discarded it: stopped-projection p75 256.9 ms against the 200 ms budget, on a tree
  that already contained the #2698 fix for
  [#2695](https://github.com/oscharko-dev/Keiko/issues/2695) — a fix accepted on a source inspection
  precisely because no lane could measure it. That number lives in the run log, not in this
  repository, and that is the point: evidence that cannot be produced cannot contradict an
  assumption. Under D5 the same run publishes a document instead, and the gate rejects it by name.
- A toolchain change is answered for by its own pull request, and by no other.
- A broken repair lane is visible on day one instead of being inferred weeks later from deadlocked
  pull requests.
- Budget enforcement is unchanged in strength and now lives in exactly one place — the gate that
  reads the committed evidence. Proven by negative control: with a toolchain file in the diff the
  gate still fails; with the same evidence and an untouched toolchain it passes.

## Alternatives rejected

- **Raise the wall-clock budgets** so the shared runner stops tripping them. Lowers the bar for the
  product to fix a problem in the measurement environment.
- **Retry the measurement until it passes.** Converts a real regression into an intermittent one and
  hides exactly the signal the evidence exists to carry.
- **Move the toolchain digest out of the pull-request lane entirely.** Would let a change edit the
  ruler without re-measuring — the invariant the existing pins protect.
