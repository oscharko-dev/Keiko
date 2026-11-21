# Quality gate hardening plan (2026-11-21)

Owner order of 2026-11-21: analyse every quality gate and bring the gates to a resilient,
production-grade state. This plan records the measured baseline, the causes, the work packages in
order, and how each package is proven. It builds on the open proposals #4163 (pull-request CI
duration), #2360 (SonarCloud analysis), #4202 (type-aware ESLint memory) and #4123 (smoke flakes)
instead of replacing them.

Every number is marked **(M)** measured or **(E)** estimated.

## 1. Baseline, measured 2026-11-18 to 2026-11-21

Source: the last 300 runs of `ci.yml` (`gh run list`), the jobs of the 36 failed runs, their
check-run annotations, and the jobs of the 14 most recent successful pull-request runs.

| Measure                                                   | Value                              |
| --------------------------------------------------------- | ---------------------------------- |
| Pull-request runs completed                               | 283 **(M)**                        |
| of these cancelled (superseded by a push or a body edit)  | 214 **(M)**                        |
| of these failed / succeeded                               | 34 / 33 **(M)**                    |
| Head commits that were run more than once                 | 86 of 173 **(M)**                  |
| Run lifetime spent on runs that were then cancelled       | 69 hours in three days **(M)**     |
| Successful pull-request run, created to verdict           | median 71 min, p90 116 min **(M)** |
| Failed pull-request run, created to verdict               | median 67 min, p90 596 min **(M)** |
| Longest jobs, median: `ui`, `Core quality`, package shard | 47.5 / 31.0 / 25.0 min **(M)**     |
| Longest wait for a free runner seen on one job            | 57 min **(M)**                     |

Failing steps of the 36 failed runs **(M)**:

| Cause class                           | Evidence                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Install fails in every job of the run | 7 Dependabot npm runs: `npm ci` ends in `ERESOLVE` (typescript-eslint against TypeScript 7), ~25 jobs each                                                                     |
| Test failure in a coverage shard      | 21 package-shard and 11 script-shard job failures                                                                                                                              |
| Browser smoke journey                 | 7 Firefox and 4 Chromium/WebKit job failures; `chat-send`, `a11y`, `atlassian-connectors-2246`, `support-report-download`, `memory-journal`, `voice-dialogue` each in 3–4 runs |
| SonarCloud scan                       | 6 job failures: lost runner, engine heap, bridge heap (#4481)                                                                                                                  |
| Drift or pinned-evidence gate         | `check:dependency-currency` 3, editor bundle gate 2, Activity Log gate 2, op-catalog drift 1                                                                                   |

Structural findings **(M, from the tree)**:

- Two analyses are sized close to the runner's RAM: the Sonar scan (Node.js 10240 MB plus an engine
  of up to 6144 MB on a 15983 MB runner, held by 8 GB of added swap) and `npm run lint`
  (`--max-old-space-size=12288`, #4202). The Sonar engine had 3783 of 3996 MB in use on
  2026-11-10 already; nothing reported that trend.
- The automatic re-run (ADR-0161) only covers jobs that executed zero steps. A job whose runner is
  lost mid-step is classified `genuine` and never re-run.
- `pull_request` `edited` events start the whole matrix again for an unchanged head commit.
- Only the coverage jobs restore the npm cache; five heavy jobs install cold. A broken lockfile is
  discovered separately by every job.
- `protected-branch-gate`, `change-scope`, `ci`, `dependency-review` and `main-promotion` have no
  `timeout-minutes`.
- Vitest and Playwright run with zero retries, and there is no lane that looks for
  non-deterministic tests before they reach a pull request. Roughly 100 unit-test files assert on
  wall-clock durations and about 80 use fixed sleeps.
- Several drift gates have no one-command repair (Sonar scope digests, `unwired-e2e-suites.json`,
  editor release evidence).

## 2. Target state

1. **No gate depends on luck.** Every memory-heavy step has a measured budget that leaves at least a
   quarter of the runner free, and a check that fails with a named reason before the runner dies.
2. **A red check means a defect in the change.** Infrastructure loss is re-run once automatically;
   non-deterministic tests are found by a dedicated lane and repaired, never retried silently.
3. **No work is done twice.** An unchanged head commit is never measured again; a broken install
   costs one job, not twenty-five.
4. **The verdict is fast.** Median pull-request verdict at or below 40 minutes (the #4163 target).
5. **The gates report their own health.** Failure rate, flake list, durations, queue time and
   memory headroom are produced by one command and one scheduled run, so a trend is seen weeks
   before it breaks a pull request.

No gate, rule, test, journey or assertion is removed or relaxed by any package below, and no
additional SonarCloud project, paid runner or required context is introduced.

## 3. Work packages, in order

### P1 — Memory budgets (Sonar and ESLint)

- **Sonar (done in this change):** the full SonarCloud analysis leaves the pull-request path and
  runs after integration, on every push to `dev` (ADR-0131 amendment 2026-11-21). A pull request
  is held by `check:sonar-rules` over its changed files inside `ci` and by the pre-push hook that
  runs the local SonarJS scan (`node scripts/install-git-hooks.mjs`, `.githooks/pre-push`). Splitting the
  TypeScript program was measured first and rejected: three parts left the largest at 4518 of 6370
  program files, because imports pull the server into every part, and a 6144 MB bridge still ran
  out of memory after eight minutes **(M)**. The `dev` scan keeps the configuration that passed in
  #4481.
- **Local pre-push scan (done in this change):** the first push with a changed `tests/e2e` file
  ran the local 4608 MiB bridge out of memory: one root-owned file made SonarJS build the whole
  6370-file program **(M)**. The changed-file scan now hands SonarJS programs rooted at the changed
  files with the owner's compiler options (615 program files for that push) and passes **(M)**.
- **ESLint (#4202):** read `scripts/lint-repository.mjs`, measure the peak per partition, and run
  each partition as its own process with a ceiling that fits the budget; the same budget rule as
  Sonar.
- **Budget evidence for every heavy step:** record peak resident memory of the scan, lint, the
  coverage shards and the builds (`/usr/bin/time -v`) into the job summary, and fail above three
  quarters of the runner's RAM.

### P2 — Stop paying for runs that cannot tell anything

- **Install preflight:** one job installs with the lockfile and runs the cheapest gates; the heavy
  jobs need it. A lockfile that cannot install then fails one job.
- **npm cache in every job** that installs (restore-only, the existing key).
- **`edited` events:** extend the ADR-0178 resolver so a pull-request run reuses earlier evidence
  only when that run's candidate merge tree equals the current pull-request merge commit's tree, the
  same binding ADR-0178 D1 uses for integration runs. A matching head commit alone never qualifies:
  `dev` may have advanced since. Without a matching candidate tree the matrix runs.
- **Lost runners (measured, not pursued):** the only runner-loss annotation in the measured window
  was "The job was not acquired by Runner of type hosted even after multiple attempts", on two
  zero-step macOS jobs. Both runs also carried genuine failures, so a new ADR-0161 signature would
  have re-run nothing **(M)**. The mid-step runner losses were the SonarCloud scan, which leaves the
  pull-request path in P1.
- **Timeouts (done in this change)** on the five jobs that had none.
- **Dependabot (done in this change):** the daily npm group failed `npm ci` with ERESOLVE in every
  job because it proposed TypeScript 7, which typescript-eslint 8.x does not accept. The TypeScript
  major is ignored like Vitest 5, matching its `major-deferred` closeout disposition.

### P3 — Deterministic tests

- **Smoke journeys (done in this change):** every repeat-failing journey of section 1 (chat-send,
  a11y, atlassian-connectors-2246, support-report-download, memory-journal, voice-dialogue) failed
  on the same cause: the startup update preflight read the public npm registry, and whenever a
  release newer than the checkout existed, the update notice intercepted the click. The smoke dev
  server's outbound traffic is hermetic now (`tests/e2e/support/dev-server-env.ts`), proven by
  `tests/e2e/dev-server-env-hermetic.static.test.ts`. The repeat-failing unit tests
  (`osv-scanner-workflow`, `workflow-hygiene-job`) failed on Dependabot action bumps whose pins
  must move with the bump; that is the intended review, not a flake.
- A nightly lane that repeats the unit suites and the smoke journeys several times with shuffled
  order and reports every test that does not give the same verdict each time. It files into the
  existing nightly reporting; it is not a required check.
- Lint rules for the three patterns that produced incidents: a bare short substring asserted
  against text that carries digests (#4481), wall-clock assertions outside
  `KEIKO_ENFORCE_WALL_CLOCK_BUDGETS` (ADR-0139 D1), and fixed sleeps. Existing violations go into a
  shrink-only register, like the UI lint bar.

### P4 — Drift gates repair themselves on request

- One command, `npm run gates:fix-drift`, that regenerates every generated or pinned artifact that
  has a deterministic source (op catalog, support-code inventory, tool catalog, zizmor anchors,
  Sonar scope digests through a new `--write`, ADR index), and prints what it changed.
- Every drift gate's failure message names that command.

### P5 — Speed (#4163, remaining items)

- Split the seven serial Playwright suites of `ui` into parallel legs under the same required
  context; rebalance the coverage shards by measured duration instead of file hash; build the
  packages once per run and hand the build to the jobs that need it.

### P6 — Gate health report

- `npm run report:ci-health`: the measurement of section 1 as a script, plus a weekly scheduled run
  that writes the table into its job summary and fails when a budget or a failure-rate ceiling is
  crossed.

## 4. Proof per package

| Package | Proven when                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1      | No pull-request run waits on a SonarCloud scan; `dev` analysis passes; lint passes in CI with a ceiling that leaves ≥ 4 GB of the runner free           |
| P2      | A body edit on a green head starts no heavy job; a deliberately broken lockfile fails one job; cancelled-run hours fall by ≥ 80 % in the following week |
| P3      | The repaired tests pass 50 consecutive local repeats; the nightly lane reports zero unstable tests for a week                                           |
| P4      | Each drift gate, broken on purpose, is repaired by the one command                                                                                      |
| P5      | Median pull-request verdict ≤ 40 min over 20 runs                                                                                                       |
| P6      | The report reproduces section 1 from the API without manual steps                                                                                       |

All packages land on one branch and one pull request against `dev`, one commit series per package,
in this order, with the local gates of AGENTS.md section 3 and `npm run gates:sonar` run before
each push. A push is made only after the previous run on that branch has finished, so no run is
cancelled by the delivery itself. The baseline of section 1 is measured again after the merge with
the same queries.
