# Infrastructure-signature re-run observer

The operating record for `.github/workflows/infra-failure-retry.yml` and
`scripts/check-infra-failure-signature.mjs`. The decision behind them is
[ADR-0160](../adr/ADR-0160-bounded-re-run-for-infrastructure-signature-failures.md).

## What this lane is, and what it is not

It is a bounded automatic re-run for one failure class: a completed run whose **every** failed job
executed zero steps under a pinned runner-failure annotation. Such a job asserted nothing about the
tree, so re-running it cannot overwrite a verdict.

It is not a flaky-test retrier, not a quality gate, and not a required check. It never re-runs a run
in which any failed job executed a step, never re-runs a wall-clock or live-database lane, and never
re-runs the same run twice. When it declines, it says so in the run's job summary — the exclusions
are records, not silences.

The decision record covers every classification the observer completes. If the re-run API call itself
fails — a revoked permission, a GitHub outage — the observer reports the error on stderr and ends red
rather than writing a record it cannot stand behind; the observed run stays exactly as red as it was.

## Classifying a run by hand

Both forms are read-only unless `--mode enforce` is passed explicitly; `dry-run` is the default.

```bash
GITHUB_REPOSITORY=oscharko-dev/Keiko node scripts/check-infra-failure-signature.mjs --run-id 30157827347
```

An offline bundle — the shape the committed fixtures use — classifies without any network access:

```bash
node scripts/check-infra-failure-signature.mjs --input scripts/__tests__/fixtures/infra-failure-signature/infra-run-allowlisted.json
```

The same classification is available in GitHub through the workflow's `workflow_dispatch` input,
which defaults to `dry-run`; pick `enforce` only when the intent is to actually re-run.

## Classification vocabulary

| Classification      | Action    | Meaning                                                                            |
| ------------------- | --------- | ---------------------------------------------------------------------------------- |
| `infra`             | re-run    | Every failed job executed zero steps under a pinned signature, on an eligible lane |
| `genuine`           | no action | A failed job executed a step, no failed job at all, or any malformed/unknown shape |
| `excluded-lane`     | no action | The workflow file path is not on `RERUN_ELIGIBLE_WORKFLOW_PATHS`                   |
| `already-attempted` | no action | The run already carries `run_attempt >= 2`                                         |
| `self-event`        | no action | The observer's own run                                                             |

## Observation window, 2026-07-20 → 2026-07-25

Every failed run of 2026-07-25 was classified in `dry-run` mode against the live API (60 runs), and
the 200 failed runs preceding it back to 2026-07-20 were swept for the zero-step signature. **The
classifier took no action on any of the 260.**

| Classification      | Runs | Lanes                                                                                                                                                                                                     |
| ------------------- | ---: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `genuine`           |   45 | `ci.yml`                                                                                                                                                                                                  |
| `excluded-lane`     |   12 | `keiko-for-quality-action.yml` (3), `nightly-perf-evidence.yml` (3), dynamic CodeQL, `dependency-review.yml`, `e2e-extended.yml`, `code-task-real-binary.yml`, `mutation-security.yml`, `osv-scanner.yml` |
| `already-attempted` |    3 | `ci.yml`                                                                                                                                                                                                  |
| `infra`             |    0 | —                                                                                                                                                                                                         |

The sweep classified every failed run, which is deliberately wider than what the lane observes in
production: only `CI`, `Workflow hygiene`, `Nightly performance evidence`, `Mutation security` and
`OSV dependency scan` are named in the trigger's `workflows:` list. Runs of the other lanes above
would reach the same `excluded-lane` verdict, but no observer job would run to record it. That is the
two-list separation in ADR-0160 D4, measured.

Named evidence rows:

| Run           | Lane                           | Verdict                         | Why it matters                                                            |
| ------------- | ------------------------------ | ------------------------------- | ------------------------------------------------------------------------- |
| `30157827347` | `keiko-for-quality-action.yml` | `excluded-lane / no action`     | The incident job: 0 steps + `runner-internal-error`, but an excluded lane |
| `30157824170` | `keiko-for-quality-action.yml` | `excluded-lane / no action`     | Same shape, no annotation at all — would be `genuine` on an eligible lane |
| `30157827822` | `keiko-for-quality-action.yml` | `excluded-lane / no action`     | 0 steps, but a concurrency-cancel annotation — not a pinned signature     |
| `30157820170` | dynamic CodeQL                 | `excluded-lane / no action`     | A path that is not a repository workflow file at all                      |
| `30173151751` | `ci.yml`                       | `genuine / no action`           | A genuinely red eligible run: never retried                               |
| `30165609814` | `ci.yml`                       | `already-attempted / no action` | The one-attempt bound, demonstrated on real data                          |
| `30146422249` | `nightly-perf-evidence.yml`    | `excluded-lane / no action`     | The wall-clock exclusion ADR-0156 requires                                |
| `30145729968` | `mutation-security.yml`        | `excluded-lane / no action`     | The second named wall-clock exclusion                                     |

### The finding this window produced

All four occurrences of the zero-step signature in the observable history landed in lanes the initial
eligible set excludes. **As scoped, this observer would not have avoided the three manual re-runs of
2026-07-25** — those were `keiko-for-quality-action.yml` runs, and that lane is a required external
aggregate whose eligibility is a separate decision (ADR-0160 D4, Consequences). The mechanism, its
bounds and its proof are complete; the eligible set is the initial one Issue #2707 names. Widen it
only with evidence, and record the widening here.

## When the signature drifts

GitHub may reword a runner failure. The failure mode is safe by construction — an unrecognised
message classifies `genuine`, so the lane degrades to manual re-runs — but it is silent. To detect
it, classify the run by hand as above: a run that a human judged to be runner weather and that the
classifier calls `genuine` is either drift or a correct refusal, and the job summary's counts say
which. Add a new entry to `INFRA_ANNOTATION_SIGNATURES` only with a captured payload committed as a
fixture under `scripts/__tests__/fixtures/infra-failure-signature/`, exactly as the 2026-07-25
signature was added.

## Rollback

Delete `.github/workflows/infra-failure-retry.yml`. Manual re-runs are fully restored;
`scripts/check-infra-failure-signature.mjs` is inert without a caller, and no required check, release
list or branch-protection entry references either file. The line-anchored `dangerous-triggers`
exemption in `.github/zizmor.yml` becomes dead and should be removed with it — `npm run
check:zizmor-anchors` reports it as naming a workflow that does not exist.
