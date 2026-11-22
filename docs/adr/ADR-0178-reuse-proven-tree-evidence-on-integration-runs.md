# ADR-0178: Reuse proven tree evidence on integration runs

## Status

Accepted (owner decision, 2026-09-20). Amended 2026-09-25 (owner decision): the coverage chain and
the SonarCloud analysis run on every push to `dev` even for a proven tree — see D1 and Consequences.
Amended 2026-11-21 (owner order to stop paying for runs that cannot tell anything, PR #4513): a
pull-request run of a title- or body-only edit reuses the evidence of an earlier run that measured
the same candidate merge tree — see D6.

## Amends

- [ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md): the required matrix that
  proves an accepted change is measured once, on the pull-request head. The integration run on `dev`
  re-establishes that verdict from the pull-request run's evidence when — and only when — the
  integration commit's tree is byte-identical to the head that evidence binds.

## Context

Every merge into `dev` ran the complete required matrix a second time. Measured over the 100 most
recent `dev` push runs of `ci.yml` before this decision:

| Measurement                                                           | Value                      |
| --------------------------------------------------------------------- | -------------------------- |
| Total wall-clock time spent on `dev` push runs                        | 4,898 minutes (81.6 hours) |
| Mean duration of one `dev` push run                                   | 48 minutes                 |
| `dev` push runs that concluded `failure`                              | 15 of 100                  |
| `dev` commits whose tree an already-green pull-request run had proven | 100 of 100                 |

The second measurement cannot produce evidence the first did not, and the reason is structural
rather than statistical. `dev` is protected with linear history and signed squash merges, and branch
protection only integrates a head that is up to date with its base. The squash commit therefore
carries a new commit sha and the _identical tree sha_ as the pull-request head the matrix already
measured. A tree sha is the recursive content hash of the whole worktree — every source file, the
lockfile, and every workflow file under `.github/`. Two commits that share one cannot differ in a
single byte that a gate could read. This was verified against the five most recent merges at the
time of the decision (#3561, #3557, #3559, #3554, #3555): five of five carried a tree identical to
their pull-request head.

What the repetition did produce was false red. The 15 failures name no defect class that the
pull-request run could have missed; they are per-job infrastructure flake, re-rolled against a tree
already proven. Run 35496443122 is the representative case: `Cross-platform smoke (macos-latest)`
died after 3 minutes in a V8 heap check (`Check failed: !IsFreelistEntry()`, exit 133) — an engine
abort on a hosted runner, measured at 1 failure in 60 on that leg. The run kept going for a further
37 minutes before the aggregate reported red. Roughly 1% of per-job flake across the ~18 jobs a run
starts predicts ~15% of runs going red, which is what the ledger shows.

A red `dev` check is indistinguishable from a real defect until a human reads the log, so the
repetition did not add safety — it consumed 81.6 hours to manufacture a 15% chance of a false alarm
against code that was already proven.

## Decision

### D1 — A tree that a pull-request run proved green is not re-measured

An integration run (`push` to a protected integration branch, or `merge_group`) resolves, before any
gate starts, whether this commit's tree is already bound to complete green evidence. When it is, the
jobs whose verdict that evidence carries do not run: `semantic-duplication`, `core-quality`,
`coverage-packages`, `coverage-ui`, `coverage-scripts`, `coverage-sonar`, `build-scan-sbom-smoke`,
`cross-platform-smoke`, `portable-secure-read`, `firefox-smoke`, `webkit-smoke`, and `ui`.

With Node 26 as the sole baseline (owner decision, 2026-11-15), the duplicate
`node-26-compatibility` matrix is retired. The four package-coverage shards run the complete
root test inventory; Editor fast-path PRs run those same four test shards without coverage
instrumentation. Existing cross-platform/package lanes retain typecheck, UI build and native
optional install smokes. Reuse requires successful exact job names for all four package shards
and all three script shards; a partial matrix or a legacy compatibility result is insufficient.

Firefox and the other UI browser journeys execute in parallel. The required `ci` aggregate
joins both job results and rejects a failed, cancelled, missing or unexpected skipped Firefox
result, including when tree reuse is claimed. Only the existing Editor fast-path exception
permits Firefox to skip without reuse; `ui` still requires successful verified-tree resolution.

For admitted lifecycle events (ADR-0139 D4), `protected-branch-gate`, `secret-scan`,
`change-scope`, and the resolver itself always run: they cost
under two minutes in total and they judge the integration commit's own identity and history rather
than its content.

**Amendment (owner decision, 2026-09-25) — `dev` keeps its own SonarCloud analysis.** On a `push` to
`refs/heads/dev`, `coverage-packages`, `coverage-ui`, `coverage-scripts` and `coverage-sonar` run even
when the tree is proven. SonarCloud files an analysis under the branch or pull request the scanner
names: the pull-request analysis measures the same bytes, but it is filed under the pull request and
never advances `dev`'s branch history, new-code period or version events. After five days of reuse
(eleven merges, 2026-09-20 to 2026-09-25) the `dev` overview on SonarCloud still showed the last
full run, so the whole-project measures nobody's diff gate watches — overall coverage, duplication,
debt trend — had gone unobserved. The coverage chain is that analysis's input, so it runs with it;
the other six jobs remain reused, and a merge group or a push to another integration branch keeps
the plain guard. Cost: about 25 minutes of wall time per `dev` merge for this chain. The `ci`
aggregate needs no change: it already accepts `success` from a gated job that ran anyway and fails
closed on any other state, so a red `dev` analysis turns the integration run red.

### D2 — Reuse requires a complete, unambiguous evidence chain

`scripts/resolve-verified-tree-evidence.mjs` answers `true` only when every one of these holds:

1. the event is `push` or `merge_group` — a pull request never reuses anything;
2. a merged pull request exists whose `merge_commit_sha` is exactly this commit, which excludes a
   pull request that merely contains it;
3. that pull request's head tree sha equals this commit's tree sha;
4. a completed `pull_request` run of the same workflow on that head concluded `success`;
5. that run _executed_ every job D1 skips — a candidate that skipped one is not evidence, which
   forecloses a chain in which one reuse authorizes the next.

The portable secure-read matrix requires successful evidence for all four exact native job names,
not merely one matching matrix prefix. Missing or unsuccessful evidence for either macOS
architecture, Linux x64, or Windows x64 forces fresh execution. Its fixture is shared with the
post-merge portable workflow, while archive identity, staging, signing, and attestation remain
release-specific proofs outside this reuse claim.

### D3 — Every uncertainty runs the full matrix

Absent evidence, a malformed payload, an unreadable field, an API error, a missing environment
variable, or any unhandled condition resolves to `false`, and the complete matrix runs. The resolver
has exactly one success path and treats everything else as unproven.

### D4 — The aggregate still fails closed

The `ci` aggregate verifies the resolver's own job succeeded, that a reuse claim carries a complete
evidence identity (run id and tree sha), and that no gate _ran and failed_ on this run. Reuse
accepts only the `skipped` state D1's guard produces; a gate that executed and failed still fails
the aggregate. The non-reuse verdict is unchanged, including the documentation-only skip for the
cross-platform matrix and the editor fast-path skip for the packaging job.

### D5 — Changing CI forces a full run by construction

Workflow files live inside the tree, so any edit to `ci.yml`, to the resolver, or to any script a
gate invokes changes the tree sha and forecloses reuse for that commit. This decision cannot outlive
the evidence it cites, and needs no expiry, allowlist, or manual invalidation.

### D6 — A title- or body-only edit reuses the evidence of its unchanged merge candidate

A `pull_request` `edited` event whose `changes` name only `title` and `body` changes no byte a gate
reads except the metadata `check:review-bot-suppression` checks. Before this amendment every such
edit started the whole matrix again on the unchanged head; measured 2026-11-18 to 2026-11-21, 86 of
173 head commits were run more than once.

The binding is the candidate merge tree, the same binding D1 uses, never the head commit alone: a
pull-request run measures `refs/pull/<n>/merge`, and `dev` may have moved since the earlier run.
Every pull-request run therefore records the tree of the commit it checked out, and the event's base
sha, as the name of an artifact, `ci-candidate-tree-<tree sha>-base-<base sha>`, after confirming
that the checkout is the event's merge commit. The base is part of the binding because some gates
read it directly (the changed-file ranges), so an identical tree on another base is a different
measurement. The resolver reuses an earlier run only when all of these hold:

- the event is `edited` and its `changes` keys are a non-empty subset of `title` and `body`; a base
  retarget, any other key, an empty or malformed payload, or any other pull-request action runs the
  full matrix before any lookup;
- a completed, successful `pull_request` run of `ci.yml` on the edited head executed every reused
  job (D2 unchanged, so a run that itself reused evidence never qualifies);
- that same run recorded exactly this run's candidate merge tree and base.

The `Verified tree` job runs `check:review-bot-suppression` on every pull-request event before the
resolver, so the edited metadata is checked whether or not the matrix is reused. The `ci`
aggregate's D4 checks apply unchanged.

On a pull request, unlike on `dev`, the skipped jobs' names are protected checks. GitHub does not
evaluate a skipped job's name expression, so a skipped `ui` or `build-scan-sbom-smoke` reports its
raw expression and branch protection waits for `ui` and `Build, scan, SBOM, smoke` without end
(observed on #4513, 2026-11-22). The `reused-required-checks` job therefore reports exactly those
two protected names, for an open pull request's verified reuse only, and fails closed unless
`Verified tree` succeeded, verified the tree and named the evidence run and tree it reuses.

An edit cancels nothing (ADR-0157 D5, amended 2026-11-21): it waits as the pending run of the pull
request's one concurrency group until the run in flight finishes, and then resolves against it. An
edit right after a push therefore costs one short run once that push's run is green, instead of a
second full matrix next to it. When the earlier run failed, was cancelled or measured another tree,
the edit run measures the full matrix itself. GitHub keeps one pending run per group, so an edit
that arrives while a push's run is still pending replaces it; the edit run carries the same new
head, finds no green run for it, and measures the full matrix in the push run's place.

## Consequences

- An integration run of an already-proven tree completes in about two minutes for the reused gates
  instead of 48; on `dev` the coverage chain and the SonarCloud analysis still run (about 25
  minutes, amendment of 2026-09-25), and the reused gates cannot be turned red by infrastructure
  flake against code that is already proven.
- The pull-request run remains the complete arbiter. A title- or body-only edit run reuses it only
  for the identical candidate merge tree (D6). The quality bar is untouched: the same gates decide,
  once, on the bytes they actually judge.
- The packaging job's attestations are not re-emitted for an identical tree; they remain reachable
  on demand via `workflow_dispatch`, which never reuses evidence. SonarCloud's `dev` branch analysis
  IS re-emitted on every push to `dev` (amendment of 2026-09-25), because an analysis filed under a
  pull request does not advance the branch. The `dev` Banking Grade verification runs with that
  analysis on every push to `dev` (ADR-0131, amended 2026-11-21).
- `scripts/__tests__/verified-tree-evidence-reuse.test.mjs` pins both halves: that every job in D1
  carries the guard and can resolve it, and that the aggregate's fail-closed verdicts in D4 hold.
