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
  is held by `check:sonar-rules` over its changed files inside `ci`; the skippable pre-push hook
  that runs the local SonarJS scan supplements it (`node scripts/install-git-hooks.mjs`, `.githooks/pre-push`). Splitting the
  TypeScript program was measured first and rejected: three parts left the largest at 4518 of 6370
  program files, because imports pull the server into every part, and a 6144 MB bridge still ran
  out of memory after eight minutes **(M)**. The `dev` scan keeps the configuration that passed in
  #4481.
- **Local pre-push scan (done in this change):** the first push with a changed `tests/e2e` file
  ran the local 4608 MiB bridge out of memory: one root-owned file made SonarJS build the whole
  6370-file program **(M)**. The changed-file scan now hands SonarJS programs rooted at the changed
  files with the owner's compiler options (615 program files for that push) and passes **(M)**.
- **ESLint (#4202, done in this change):** `scripts/lint-repository.mjs` already ran one process
  per partition. Each partition's peak resident memory is now measured (a preloaded
  `process.resourceUsage()` reporter, equal to `/usr/bin/time -l` to the kilobyte on
  `packages/keiko-security`, 4.75 GB **(M)**), written to the job summary, and held to 12 GiB, three
  quarters of the 16 GiB runner. A partition above it fails with its name and peak instead of
  taking the runner down. The Node heap ceiling stays in `package.json`, whose digest the design
  evidence pins. Measured locally over all 28 partitions: `keiko-server` peaks at 10.3 GiB, every
  other partition at 5.9 GiB or less **(M)**; `keiko-server` is the one to split next.
- **Budget evidence for every heavy step:** record peak resident memory of the scan, lint, the
  coverage shards and the builds (`/usr/bin/time -v`) into the job summary, and fail above three
  quarters of the runner's RAM.

### P2 — Stop paying for runs that cannot tell anything

- **Install preflight (measured, not pursued):** the broken installs of section 1 were the seven
  Dependabot TypeScript 7 runs, whose cause is removed below. A preflight job in front of every heavy
  job adds about a minute of install and setup to the critical path of every pull-request run, to
  save the runner minutes of a lockfile that cannot install; a failing `npm ci` already ends each job
  in under a minute **(M)**. That trades verdict time, target 4, for runner minutes that are not the
  bottleneck.
- **npm cache in every job (measured, not pursued):** on run 44932528367 a cold `npm ci` took
  12–18 s in Core quality, Semantic duplication and Build, scan, SBOM, smoke, and a warm one 9–17 s
  plus a 2–6 s restore in the coverage jobs **(M)**. The cache saves nothing measurable, so the jobs
  without it keep installing cold.
- **`edited` events (done in this change):** a title- or body-only edit reuses an earlier run's
  evidence only when that run recorded the same candidate merge tree on the same base (ADR-0178
  D6). A matching head commit alone never qualifies: `dev` may have advanced since. The edit waits
  in the pull request's one concurrency group instead of starting a second matrix next to the push
  run (ADR-0157 D5, amended). Without a completed green run of the same candidate tree the matrix
  runs.
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
- **Nightly lane (done in this change):** `.github/workflows/test-stability.yml` runs every night
  each eighth of the unit suites three times with different shuffle seeds, and the chromium smoke
  journeys with `--repeat-each=3 --retries=0`. `scripts/report-unstable-tests.mjs` names every test
  whose verdict changed between runs, was missing from a run or was reported flaky, and every test
  that failed each time, in the job summary, and turns the lane red, like E2E Extended; it is not a
  required check. `node scripts/report-unstable-tests.mjs vitest --repeats 6 -- <file>` reproduces
  one suspect locally. Proven 2026-11-21 with a coin-flip test: six shuffled runs named it unstable
  with four failures and two passes, and left its stable neighbour out **(M)**.
- **Lint rules (done in this change):** `scripts/lib/eslint-test-determinism.mjs` holds every test
  file of the root config to three rules: no measured wall-clock duration compared outside
  `KEIKO_ENFORCE_WALL_CLOCK_BUDGETS` (ADR-0139 D1; a timestamp ordered against another is allowed),
  no fixed sleep outside a polling loop (`setTimeout(resolve, n)` in a promise, `timers/promises`,
  `waitForTimeout`), and no negative substring assertion with at most four hexadecimal characters,
  which a 64-character digest contains with a chance of about 1 in 1000 (#4481). Over 4401 linted
  files they found 75 sleeps, 204 wall-clock comparisons and 19 short hex literals **(M)**. Six of
  those literals sat in JSON or prompt text that carries digests (`JSON.stringify(manifest)` and
  `not.toContain("503")`, for example) and were repaired with word boundaries, as #4481 did; the
  other 292 are held in the shrink-only register `eslint-suppressions.json`, pinned with a ceiling
  per rule by `scripts/__tests__/test-determinism-register.test.mjs`. The register shrinks
  through `node scripts/lint-repository.mjs --prune-suppressions`, the only flag that script
  forwards. `keiko-ui` keeps its own config and register (KEIKO-0118) and is not covered yet.

### P4 — Drift gates repair themselves on request

- **Done in this change:** one command, `node scripts/fix-gate-drift.mjs`, rebuilds the packages
  the generators read and regenerates every artifact whose expected state is derived from the tree:
  the op catalog, the support-code inventory, the tool catalog manifest and migration, zizmor
  anchors that only shifted, and the shrink-only legacy failure-path register. It prints what each
  repair changed. It is a script, not an npm script, because the design evidence pins the digest of
  `package.json`. The drift gates' failure messages name it. Proven 2026-11-21: with a line inserted
  into `ci.yml`, a reformatted op catalog and a changed support-code inventory, one run restored all
  three and named each file **(M)**; a corrupted anchor that is not a shift is refused for a human.
- Deliberately not in it: the Sonar scope digests and the ADR index are approvals, not drift (each
  re-pin carries its reason in a comment), and no coverage, i18n or performance baseline is ever
  written by it, so the command cannot bless a regression.

### P5 — Speed (#4163, remaining items)

- Split the seven serial Playwright suites of `ui` into parallel legs under the same required
  context; rebalance the coverage shards by measured duration instead of file hash; build the
  packages once per run and hand the build to the jobs that need it.
- **Done in this change:** the WebKit smoke left the `ui` job for its own two-shard
  `webkit-smoke` matrix, the same shape as `firefox-smoke`, and its verdict joins the required `ci`
  aggregate, which fails closed when either shard did not succeed outside an editor fast path.
  ADR-0178 reuses it like every other gated job. Over six green runs the `ui` step durations were
  Chromium smoke 14–18 min, WebKit smoke 15–19 min, Jira chat 2–4 min and each editor suite 1–3
  min **(M)**, so the split removes the longest serial step from the critical path: `ui` drops
  from about 47 to about 29 minutes, and each WebKit shard runs about half of its former step in
  parallel. The rebalanced coverage shards and the single package build remain open.

### P6 — Gate health report

- **Done in this change:** `node scripts/report-ci-health.mjs [--days 7] [--json]` measures the
  pull-request runs of `ci.yml` from the Actions API: completed, cancelled, failed and succeeded
  runs, heads run more than once, hours on runs that were then cancelled, verdict median and p90
  per outcome, and the jobs that failed most. `.github/workflows/ci-health.yml` runs it every
  Monday with `actions: read`, writes the table into the job summary, and fails when a ceiling is
  crossed (exit 1), or reports that it could not measure (exit 2). It is a script, not an npm
  script, for the same `package.json` digest reason as P4.
- Reproduction of section 1, 2026-11-21, same window of 300 runs **(M)**: 284 completed, 211
  cancelled, 37 failed, 34 succeeded, 84 of 174 heads run more than once, 68.1 cancelled hours,
  failed verdict median 67 / p90 596 min. Every count matches the hand measurement within the few
  runs the window moved. The successful verdict measured 82 / 180 min, not 71 / 116: the hand value
  came from a smaller sample, and the scripted value replaces it as the reference.
- Ceilings, at that scripted baseline: failed share of decided runs ≤ 0.53, successful verdict
  median ≤ 85 min. Heads run more than once carry no ceiling, because an ADR-0178 D6 edit run on
  the same head is intended and run metadata cannot tell it from a second matrix. The seven days
  before this change measured 84 of 149 decided runs failed, which crosses the first ceiling: the
  report is red on the state this plan exists to fix **(M)**.

## 4. Proof per package

| Package | Proven when                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P1      | No pull-request run waits on a SonarCloud scan; `dev` analysis passes; lint passes in CI with a ceiling that leaves ≥ 4 GB of the runner free |
| P2      | A body edit on a green head starts no heavy job; cancelled-run hours fall by ≥ 80 % in the following week                                     |
| P3      | The repaired tests pass 50 consecutive local repeats; the nightly lane reports zero unstable tests for a week                                 |
| P4      | Each drift gate, broken on purpose, is repaired by the one command                                                                            |
| P5      | Median pull-request verdict ≤ 40 min over 20 runs                                                                                             |
| P6      | The report reproduces section 1 from the API without manual steps                                                                             |

All packages land on one branch and one pull request against `dev`, one commit series per package,
in this order, with the local gates of AGENTS.md section 3 and `npm run gates:sonar` run before
each push. A push is made only after the previous run on that branch has finished, so no run is
cancelled by the delivery itself. The baseline of section 1 is measured again after the merge with
the same queries.
