# ADR-0161 — A run that never executed a step may be re-run once; a run that did, never

- Status: Accepted — Issue #2707, delivered on the `dev` integration branch.
- Extends: [ADR-0139](ADR-0139-agent-first-deterministic-quality-gates.md) D6 from bounded retry
  around an external-service CALL to bounded re-run around a job that never started. D6's mechanics
  are untouched: the SonarCloud scanner step keeps its own three attempts and 30/60-second backoff,
  and nothing here changes what any gate asserts.
- Constrained by: [ADR-0156](ADR-0156-measurement-and-verdict-separation.md) — "retry the
  measurement until it passes" stays rejected, and D5's "membership is established by construction,
  never by matching message text" governs how the classification is built.
- Compatible with: [ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md) D3 — the
  observer is not a required check, produces no required context, and no required check depends on
  it to repair or publish itself.

## Context

On 2026-07-25 a GitHub Actions incident failed required jobs with **zero executed steps** and the
annotation `GitHub Actions has encountered an internal error when running your job.` Restoring green
took three manual re-runs. Earlier the same week, SonarCloud 500s blocked three Dependabot pull
requests.

ADR-0139 D6 already answers the second class and only the second class. Its retry loop lives inside
the step that makes the external call, so it cannot reach a job that died before any step executed —
there is no step in which to run it. The two failure classes look identical from the outside (a red
required check) and are structurally opposite from the inside:

| Failure class            | Steps executed | Verdict produced about the tree | Existing coverage       |
| ------------------------ | -------------- | ------------------------------- | ----------------------- |
| Transient external call  | ≥ 1            | Yes — the step ran and failed   | ADR-0139 D6, in-step    |
| Runner death before start| 0              | None — nothing about the tree ran | Nothing                |

That second row is the whole justification. A job that executed zero steps asserted nothing about
the change; re-running it therefore cannot overwrite a verdict, because there is no verdict to
overwrite. Everything below exists to make sure only that row is ever acted on.

The counterweight is ADR-0139's Consequences clause — "a red required check implies a real defect in
the change (or a gate defect to be fixed at the gate), never runner weather". An automation that
re-ran anything else would falsify it. Measured over the 2026-07-20 → 2026-07-25 window and recorded
in [`docs/qa/infra-failure-retry.md`](../qa/infra-failure-retry.md), no run in it would have been
re-run: the 60 failed runs of the incident day were classified end to end and every one produced
`no action`, including all 45 genuinely red `ci` runs, and none of the 200 failed runs before them
contained a job with zero executed steps at all.

## Decision

**D1 — The load-bearing evidence is structural; the message signature only narrows it.** A failed
job classifies `infra` when its step list contains zero steps that reached a terminal state **and**
one of its failure-level annotations matches a pinned signature. The step count is a fact from the
REST payload, not a reading of any text, which is what ADR-0156 D5 requires of a membership test.
The pinned signature is an allowlist in the ADR-0139 D6 idiom — the same shape as that step's
`grep -qE` over transient scanner wordings — and it can only ever remove jobs from the structural
set, never add one. An unrecognised, reworded or absent annotation classifies `genuine`, so signature
drift degrades to the manual re-runs of today and never to over-retrying.

**D2 — A run is re-run-eligible only when EVERY failed job classifies `infra`.**
`POST /actions/runs/{run_id}/rerun-failed-jobs` is run-granular: it re-executes all failed jobs of
the run, not a chosen one. One failed job that executed a step therefore makes the whole run
`genuine`, and that is not a limitation being tolerated but the guarantee itself — a real defect can
never be re-executed behind an infrastructure excuse (ADR-0156: "a real defect may never hide behind
a slow measurement"). A run with no failed job at all is `genuine` too: the empty set is not
vacuously infrastructure weather.

**D3 — At most one automatic attempt per run, ever.** Eligibility requires `run_attempt == 1`, so
the observer is idempotent even if it fires twice, and a run it re-ran cannot be re-run again — the
second attempt's own completion event classifies `already-attempted`. A persistent outage therefore
still ends red and human-visible, which is exactly ADR-0139 D6's persistent-outage semantics one
layer out, and matches the repository's existing "one explicit rerun, then report it as an incident"
rule now generalized in [`docs/qa/review-standards.md`](../qa/review-standards.md).

**D4 — Eligibility is keyed on workflow file path; observation is keyed on display name.** Two lists
do two different jobs. `RERUN_ELIGIBLE_WORKFLOW_PATHS` in the classifier decides what may be
re-run and is keyed on the workflow FILE PATH, so a rename cannot inherit eligibility and a new
workflow starts excluded. The `workflows:` key of the `workflow_run` trigger decides what is
observed at all; GitHub keys it on display name and its schema requires it, so the excluded lanes are
named there deliberately — that is what makes their `excluded-lane / no action` verdict a record
rather than a silence. Both directions of drift fail toward no re-run, and the two lists are pinned
against each other by test.

The initial eligible set is `.github/workflows/ci.yml` and `.github/workflows/workflow-hygiene.yml`.
Issue #2707 named ci.yml and "the PR lane of `osv-scanner.yml`"; ADR-0159 phase 3 had already moved
that PR lane into `workflow-hygiene.yml`, which is therefore the successor listed here. What remains
in `osv-scanner.yml` is a nightly schedule re-reading a live vulnerability database — not
deterministic for a given tree, so not eligible. Wall-clock lanes are excluded for the reason
ADR-0156 already gives: a measurement is not retried until it passes.

**D5 — Every decision is a redacted record, and dry-run is the default.** The observer writes counts,
the run id, the workflow file path, the matched signature ids and a fixed reason phrase to its job
summary — never annotation text, log bodies, branch, commit, actor or title (AGENTS.md §7). The
classifier acts only under `--mode enforce`; the default is `--mode dry-run`, which classifies and
logs without calling any API, so a dropped mode argument produces observation rather than action.

**D6 — The observer holds one write permission and never runs the observed code.** `actions: write`
is what `rerun-failed-jobs` requires and is the only write grant; `checks: read` is what the
annotations the classifier reads require, since they live on the Checks API and `actions: *` does not
reach them; `contents: read` is the checkout. Omitting the Checks grant would not fail loudly — every
job would classify `genuine` for want of a signature it could not see, and the lane would quietly do
nothing. That is the fail-closed direction, and it is still a defect.
`workflow_run` executes the default branch's definition, and the checkout pins `ref` to
`github.event.repository.default_branch` explicitly rather than relying on that default — checking
out `workflow_run.head_sha` would run a pull request's own code under the elevated token, which is
the risk this trigger carries. The run id and mode reach the process through `env:` indirection and
are re-validated against a positive-integer and a two-literal pattern before either can reach an API
path. This is a documented, line-anchored `dangerous-triggers` risk acceptance in `.github/zizmor.yml`,
and `scripts/check-zizmor-anchors.mjs` now position-checks that rule's anchors like it already does
for `cache-poisoning`.

## Consequences

The re-run does not change any verdict semantics: it re-executes the identical gates against the
identical tree, and the second attempt is scored exactly like the first. Nothing becomes required,
nothing existing becomes advisory, and no threshold moves.

**The measured consequence to weigh: over the whole observation window the eligible set never
matched.** All four occurrences of the zero-step signature in the observable history landed in lanes
that D4 excludes — three in `keiko-for-quality-action.yml` and one in the dynamic CodeQL run — so the
three manual re-runs of 2026-07-25 would not have been avoided by this decision as scoped. That is
the accurate description of what ships: the mechanism and its proof are complete, the eligible set is
the initial one Issue #2707 names, and widening it to a required external aggregate is a separate
decision with its own risk profile. `docs/qa/infra-failure-retry.md` carries the evidence a future
widening should be argued from.

Failure attribution stays where it was. A red required check still means the same thing, because the
only runs this touches produced no assertion about the tree. What changes is that such a run now
carries a machine-written record of why it was or was not acted on, for every observed lane —
including the ones that are never eligible.

The costs are real and bounded: one short job per observed failed run (five observed workflows, five
minutes of timeout, no cache, no artifacts), one new elevated permission that exists nowhere else in
the repository, and one more line-anchored zizmor exemption to keep pointing at the right line.

Rollback is deleting `.github/workflows/infra-failure-retry.yml`. That fully restores manual re-runs;
`scripts/check-infra-failure-signature.mjs` is inert without a caller, and no required check, release
list or branch-protection entry references either file.

## Alternatives rejected

**Retry on a timer until the check passes.** ADR-0156 already rejects this for measurements, and it
is worse here: it converts a real regression into an intermittent one and destroys the property that
makes a red check actionable.

**Re-run the single failed job instead of the run.** GitHub's re-run endpoints are run-granular or
job-granular-with-dependents; re-running one job of a run whose other failure is genuine would still
re-execute the genuine one through its dependents. The run-level all-or-nothing rule in D2 is the
only formulation that cannot re-execute a real defect.

**Classify from the job log instead of the annotation.** Log text is unbounded, attacker-influenceable
in a pull request, and would put raw bodies inside the decision evidence. The annotation set is
GitHub-authored, bounded, and already redaction-safe as an id.

**Take the trigger's `workflows:` list as the authority.** It keys on display name, which a rename
changes silently, and it is the wrong direction of failure: a renamed lane would keep matching an
allowlist entry it no longer corresponds to. The path-keyed classifier list is the authority, and the
trigger list exists so exclusions are recorded rather than invisible.

**A third-party re-run action or a marketplace bot.** Issue #2707's OSS-only constraint, plus the
supply-chain cost of granting `actions: write` to a dependency. GitHub-native REST through
`GITHUB_TOKEN` needs no new trust.

**Make the observer a required check, or let a required check depend on it.** ADR-0135 D3 forbids a
required check that depends on another to repair itself, and D4 requires current-head emission and
bounded settlement before anything becomes required. The observer is neither and must stay neither.
