# ADR-0159 — One required context for workflow hygiene

- Status: Accepted — amended in place by its own delivery: phase 3 moved the job out of `ci.yml`
  into `.github/workflows/workflow-hygiene.yml`, because a workflow's `on:` block is per file and
  D2's `ready_for_review` obligation could not be met inside `ci.yml` at an acceptable cost (D1, D4)
- Amends: [ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md) (D3's
  enumerated required-check set; its direct-bounded-check principle is untouched and is precisely
  what this record executes)
- Amends: [ADR-0002](ADR-0002-ci-and-supply-chain-security-baseline.md) (the job topology of
  `actionlint` and `Verify pinned action SHAs` only; every tool, invocation, checksum, permission
  and fail-closed semantic it specifies is carried over character for character)
- Extends: [ADR-0131](ADR-0131-ci-based-sonarcloud-analysis-and-banking-grade-gate.md) D1 and
  [ADR-0157](ADR-0157-sharded-coverage-evidence-and-cached-provisioning.md) (in-workflow execution
  beats a second required context, from declining to add one to consolidating four that exist)

## Context

Four required check contexts on every pull request are micro-gates. Measured over the ten most
recent completed pull-request runs on `dev`, each spends more time being a job than doing its work:

| Context | Producer | Median | Max |
| --- | --- | --- | --- |
| `actionlint` | `ci.yml` job `actionlint` | 12.0 s | 14.0 s |
| `Verify pinned action SHAs` | `ci.yml` job `verify-pinned-shas` | 8.0 s | 10.0 s |
| `zizmor` | `ci.yml` job `zizmor` | 14.5 s | 20.0 s |
| `Scan dependency lockfiles` | `osv-scanner.yml` job `scan` | 20.0 s | 27.0 s |

Each figure is a whole job: runner acquisition, a full `actions/checkout`, then a tool that reads
`.github/workflows/` or the lockfiles and exits. Four runners, four checkouts, four rows on a
status list of 20+, and four entries in a branch-protection list a human maintains by hand — for
54.5 seconds of combined median work over one directory and one dependency graph.

All four hold exactly `permissions: contents: read`. None writes, signs, attests, caches, or
touches a secret. The least-privilege argument that ADR-0002 used to justify **three workflow
files** (Alternative 1: "the principle of least privilege requires separating the permission
scopes") does not reach these four jobs, because there are no distinct scopes among them to keep
apart.

ADR-0002 describes the two it introduced as separate jobs but never decides that they must be. Its
load-bearing constraint is name fidelity, not topology: "The check names are derived from GitHub
Actions job names (or job IDs when no `name:` field is present) and must match byte-for-byte, or the
check never reports and the PR stays permanently blocked" — and it declares `CONTRIBUTING.md`, not
itself, authoritative for the set. ADR-0002 has already been amended once by exactly this operation:
its own header records the architecture gate being "folded into the existing `ci` job rather than a
new job" (ADR-0020).

ADR-0011 D10 states the counterweight and is the text a reviewer should raise: the then-seven
required checks are "byte-exact and non-negotiable", and adding the `ui` job "does not rename or
remove any of the seven existing contexts". That is a promise D10 makes about D10's own change — it
binds a record that adds a context not to disturb the others, and it is kept. It is not a rule that
the set may never change; the set has since grown from seven to fourteen.

The repository has twice preferred fewer required contexts over more. ADR-0131 D1 established the
in-workflow fail-closed aggregate rather than a new required check, and ADR-0157 rejected splitting
coverage into "a second workflow with its own required context" as adding "a branch-protection
change and a second aggregate for no gain". Both declined to *create* a context. No record has yet
consolidated contexts that already exist, which is why this one is written rather than a cleanup
commit.

The charter is ADR-0158's, applied to a strictly easier case. That record could only remove a
coverage evaluation where a dominating evaluation kept running in a required context. Here nothing
is removed at all: four tools, four versions, four configurations, four fail-closed semantics, all
still executing on every pull request. What changes is how many check contexts report them.

## Decision

**D1 — One job runs all four tools; nothing about the tools changes.**

> **Amended by phase 3 — read this before the paragraph below.** The job was added to `ci.yml` in
> phase 1 and moved to its own file, `.github/workflows/workflow-hygiene.yml`, in phase 3. Nothing
> else about it changed: same job id, same `name:`, same steps, same pins, same permissions, same
> timeout, and the same check context produced under the same App id (15368), so branch protection
> never saw the move. The reason is D2's: a workflow's `on:` block is per file, and the trigger
> surface this job owes is the union of four jobs across two files.

A `workflow-hygiene` job whose check context is `workflow hygiene`. It runs, on one runner
after one checkout: actionlint 1.7.12 downloaded from the same URL and verified against the same
SHA-256 `8aca8db9…a3d8`, invoked as `./actionlint -color .github/workflows/*.yml`; the pinned-SHA
grep verbatim, including its `./` and `docker://` exemptions and its 40-hex pattern; zizmor 1.26.1
through `zizmorcore/zizmor-action@6599ee8b7a49aef6a770f63d261d214911a7ce02` (v0.6.0) with
`config: .github/zizmor.yml`, `advanced-security: false` and `annotations: true`, and `.github/zizmor.yml`
itself unchanged; and OSV-Scanner through
`google/osv-scanner-action/osv-scanner-action@9a498708959aeaef5ef730655706c5a1df1edbc2` (v2.3.8)
with `--config=osv-scanner.toml --recursive ./`. The job holds `permissions: contents: read` — the
union of the four, which is also each of the four, so no step gains an authority its own job did not
have.

No step carries `continue-on-error`. A failing step fails the job and the single context is red.

This is direct tool execution, not an aggregate over check results. ADR-0135 D3's prohibition on a
required check depending on another required check, and on pending evidence being converted to
terminal failure by a second aggregate, is not engaged by the job's shape: `workflow hygiene`
observes no check run and reads no other job's conclusion, and the `ci` aggregate does not and will
not `needs:` it.

**D2 — The evaluation surface is preserved by construction, and the one delta is named.** Three of
the four jobs run on every `ci.yml` event unconditionally, and the consolidated job inherits that.
zizmor's narrower job-level condition — pull requests based on `dev`, pushes to `refs/heads/dev`,
and `merge_group` — is reproduced at step level character for character. It is composed with
`!cancelled()` rather than replacing it, because a job never skips on account of a sibling job's
failure: `!cancelled()` is what makes a step behave like the independent job it came from, and it
narrows nothing.

The same `!cancelled()` guard is on the pinned-SHA and OSV steps, and it is not decoration. Four
independent jobs gave one property for free that four serial steps do not: every gate reports on
every run. Without the guard, an actionlint finding would hide a lockfile vulnerability until the
next round, and an epic whose subject is repair-round latency would have bought fewer contexts with
more rounds. The guard restores the property without softening the verdict — a failed step fails the
job whatever runs after it.

One real difference exists and is not waved away. `.github/workflows/osv-scanner.yml` declares
`types: [opened, ready_for_review, reopened, synchronize]` on its `pull_request` trigger; `ci.yml`
takes GitHub's default, `[opened, synchronize, reopened]`. The branch lists are byte-identical, as
are the `push` and `merge_group` triggers. `ready_for_review` is therefore the single event on which
the lockfile scan runs today and a `ci.yml`-hosted step would not, and because a lost trigger is a
stop and not a trade-off, phase 3 does not ship without preserving it.

It is not preserved by widening `ci.yml`'s `pull_request` types, which was this record's first
answer and is rejected on measurement. That event costs one 20-second job today; inside `ci.yml` it
would cost a full run — three coverage shards, `coverage-sonar`, the three-OS `cross-platform-smoke`
matrix, `build-scan-sbom-smoke` and `ui`. Worse, `ci.yml`'s concurrency group is `ci-pr-<number>`
with `cancel-in-progress: true` for pull requests, so marking a pull request ready while its run is
in flight would cancel that run and restart the matrix from zero on the same head. Buying a
20-second trigger with a cancelled 13-minute matrix is not a trade this epic can make.

A workflow's `on:` block is per file, so preserving the trigger at its real cost means giving the
bundle a trigger surface of its own. Phase 3 therefore hosts the job in
`.github/workflows/workflow-hygiene.yml`, declaring exactly the union: `ci.yml`'s `push` and
`pull_request` branch lists verbatim, `pull_request` types `[opened, ready_for_review, reopened,
synchronize]`, `merge_group` on `dev` (ADR-0139 D7), and `workflow_dispatch`. That is a strict
superset of the four jobs' combined surface, and it costs one ~30-second job on a draft-to-ready
transition instead of a cancelled matrix.

Issue #2706 scopes the job to `ci.yml`, so this is a deliberate deviation from the issue text in
service of the issue's own stop condition: a lost trigger is a stop, and the in-`ci.yml` options
were "lose `ready_for_review`" or "pay a cancelled 13-minute matrix for a 20-second scan". The
consolidation the issue asks for — four contexts into one, same tools, same rules — is delivered
exactly; only the file hosting it differs, and the check context, its App id and the
branch-protection entry are identical either way.

`.github/workflows/osv-scanner.yml` keeps `schedule` and `workflow_dispatch`. Every event-driven
lane — `pull_request`, `merge_group` and `push` — moves into the bundle. The `push` lane goes too,
against this record's first draft and against the issue text, because the bundle's `push` branch
list is byte-identical to the one `osv-scanner.yml` carried: keeping both would scan every pushed
commit twice, which is precisely the duplicate evaluation ADR-0158's charter admits removing when a
strictly dominating check keeps executing in a required context. What cannot move is `schedule`: it
re-reads a live vulnerability database against an unchanged tree, so a newly published advisory is
detected without anyone pushing. That cadence is the reason the workflow still exists, and it is
untouched — which is what the issue's "the scheduled detection cadence is unchanged" was protecting.

**D3 — A required context is bounded.** `workflow-hygiene` declares `timeout-minutes: 15`, which no
`ci.yml` job does today. ADR-0135 D4 requires a repository-owned timeout of anything that is
required, and a new required context is where that debt gets paid rather than inherited. Fifteen
minutes is roughly twenty times the combined median and cannot truncate a healthy run; it bounds a
hung download or a scanner stalled on a network read, which without it would sit until GitHub's
six-hour default.

**D4 — The rollout is three phases with no protection gap at any instant.** The invariant is that
each of the four checks is, at every moment, both executed on pull requests and covered by a
required context.

1. **Phase 1 (this record's adopting pull request).** The `workflow-hygiene` job is added. The three
   `ci.yml` micro-jobs and the `osv-scanner.yml` pull-request lane keep running and keep being
   required. Both shapes produce green contexts on every pull request; the bundle is required by
   nobody and can therefore be observed before it is trusted.
2. **Phase 2 (owner action, outside agent authority).** A single branch-protection update removes
   `actionlint`, `Verify pinned action SHAs`, `zizmor` and `Scan dependency lockfiles` from the
   required list and adds `workflow hygiene`, atomically. Both shapes are still executing when it
   happens, so neither ordering within the update can expose a gap.
3. **Phase 3 (the follow-up pull request).** The three micro-jobs are removed; the bundled job moves
   to its own workflow file with the union trigger surface (D2), taking the `osv-scanner.yml`
   pull-request and merge-queue lanes with it; and the required-check list is updated in
   `CONTRIBUTING.md`, `AGENTS.md` §10, `docs/qa/autonomous-quality-gates.md`,
   `RELEASE_REQUIRED_CHECKS` in
   `release.yml` and `portable-assets.yml`, and `reevaluationCheckNames` in
   the then-active external aggregate. Four structural pins are relocated, none relaxed: the
   `ci` aggregate slice in `dev-quality-workflows.test.mjs` moves to the generic
   next-top-level-key bound; `zizmor-workflow.test.mjs` re-anchors its four assertions on the
   bundled step; `osv-scanner-workflow.test.mjs` re-points its branch-coverage property at whichever
   workflow now owns each event; and `workflow-hygiene-job.test.mjs` follows the job to its new file.

The ordering is not a preference. Removing the jobs before the owner's update would leave branch
protection requiring four contexts that no workflow produces, which blocks every pull request in the
repository — including the one that would fix it — and converts a scheduling choice into an incident
under time pressure. The `osv-scanner.yml` `schedule` (`37 3 * * *`) and `workflow_dispatch` lanes
stay where they are in all three phases, so the scheduled detection cadence is unchanged; its three
event-driven lanes move into the bundle, whose branch lists are byte-identical, so branch coverage is
unchanged too. See D2 for why `push` moved rather than staying as the issue text says.

The documentation lists move in phase 3 rather than phase 1 for the same reason the jobs do.
`CONTRIBUTING.md` is authoritative for what branch protection actually requires (ADR-0002), and an
authoritative list that anticipates the owner's action is wrong for the whole window it anticipates —
to a contributor, and to an agent that reads AGENTS.md §10 to learn what must be green.

**D5 — The enumerated required-check set.** ADR-0135 D3's set is amended: the action-security and
dependency-lockfile categories are executed inside the single required `workflow hygiene` context.
The category coverage D3 lists — CI aggregation, action security, CodeQL, build/SBOM/smoke,
dependency review, UI functionality and accessibility, OSV, SonarQube Cloud, Socket Security — is
unchanged; four of its rows now report through one context. The exact before-and-after lists live in
Issue #2706 and are re-verified against live branch protection immediately before the owner's
update, because a list recorded days earlier is a claim, not a fact.

## Consequences

Required contexts per pull request fall by three, from fourteen to eleven, and three runners and
three checkouts stop being acquired per pull request. Nothing about what is checked changes: the
same four tools, at the same pinned versions, with the same configuration files, arguments and
exemptions, over the same directory and the same dependency graph.

Failure attribution moves from the context name to the step name. `actionlint` red used to be
legible from the checks list; now `workflow hygiene` is red and the failing step names the tool. The
annotations zizmor and actionlint emit are unaffected — they attach to file and line, not to a job.
This is the first ergonomic cost of the change, and it is why D2's `!cancelled()` guard matters: a
red `workflow hygiene` reports every hygiene finding it found, not the first.

Four availability domains become one, and this is the consequence to weigh before the phase-2 swap.
Two of the four steps pull a container from `ghcr.io` — the zizmor action pulls
`ghcr.io/zizmorcore/zizmor:1.26.1` and runs online audits against the GitHub API, and the OSV action
is itself a Docker action — and the third downloads a tarball from the GitHub release CDN. Today a
registry outage reddens `zizmor` and `Scan dependency lockfiles` while `actionlint` and `Verify
pinned action SHAs` still report green on their own runners. Afterwards it reddens the one context
that answers for all four. The merge outcome is identical either way, because all four are required
and any one of them red already blocks; what changes is that a re-run is no longer targetable at the
one gate that failed. At roughly 55 seconds for the whole bundle, re-running all four is not a cost
worth designing around — but the collapse is real and is not implied by "fewer contexts".

A skipped gate now reports as a green context rather than a grey one. On `workflow_dispatch`, and on
pull requests based on any branch other than `dev`, zizmor's condition is false: the standalone job
concluded `skipped`, and the step inside a job whose other three gates ran concludes `success`.
Branch protection already treated `skipped` as passing, so nothing about gating moves. It does
change one thing in phase 3's favour: `scripts/verify-release-required-checks.mjs` accepts only
`conclusion === "success"`, so where the release path previously depended on the release SHA being a
`dev` commit for `zizmor` to be anything but `skipped`, `workflow hygiene` reports `success` on its
own. Phase 3 re-verifies that when it edits `RELEASE_REQUIRED_CHECKS`.

`Verify pinned action SHAs` keeps auditing the file that now contains it. The grep reads
`.github/workflows/` recursively, so the consolidated job's own `uses:` lines — the checkout, the
zizmor action and the OSV action — are inside its scope exactly as they were when it was a separate
job. The gate remains self-enforcing.

Between phase 1 and phase 3 the four tools execute twice per pull request. That is the price of the
no-gap invariant, it is bounded by how long the owner takes, and at roughly 55 seconds of duplicated
work on runners that are not on the critical path it costs no wall-clock on the merge path.

Rollback is by phase and does not need a new decision. Reverting the phase-3 pull request re-splits
the jobs and restores the `osv-scanner.yml` pull-request lane; the owner then restores the
before-list recorded in Issue #2706. Reverting the phase-1 pull request removes the bundle. Because
each phase leaves both shapes or one complete shape executing, no rollback passes through a state
where a check is unexecuted.

Two structural pins in `scripts/__tests__/` slice `ci.yml` by job key and will need relocation in
phase 3, not relaxation (AGENTS.md §7). `dev-quality-workflows.test.mjs` bounds the `ci` aggregate
block with a lookahead on the literal `actionlint:` key at its two-space job indentation, and
`zizmor-workflow.test.mjs` anchors on `zizmor:` at that same indentation to assert
`advanced-security: false`, `annotations: true`, read-only permissions and
`persist-credentials: false`. The first is relocated to the generic next-top-level-key bound its
own sibling test already documents as the stricter idiom; the second moves to the
`workflow-hygiene` block, where the same four assertions must continue to hold.

`.github/zizmor.yml`'s `cache-poisoning` ignores are line anchors into `ci.yml` (308, 382, 448, 527,
606). The consolidated job is appended after them, so phase 1 shifts none; phase 3 removes lines
above nothing they anchor. Any future edit in this area re-runs zizmor rather than assuming, which
is what the config file's own header instructs.

## Alternatives rejected

- **Consolidate only the three `ci.yml` jobs and leave `Scan dependency lockfiles` alone.** Avoids
  the cross-workflow move and the `ready_for_review` question entirely, and reduces the required set
  by two instead of three. Rejected because the reason the OSV lane is separate is historical, not
  structural: it is the same tool class, the same permission, the same runner shape and the same
  sub-30-second workload, and leaving it out preserves the exact accretion this record exists to
  stop.
- **One phase: add the bundle and remove the micro-jobs together.** Rejected structurally. Branch
  protection is not part of the pull request, so a single-phase change is guaranteed to produce a
  window in which either four required contexts have no producer or four executed checks are not
  required. The first window blocks every pull request in the repository.
- **Bundle the external App-bound producers too** (SonarCloud, Socket, CodeQL, Keiko for Quality).
  Rejected: those contexts are pinned to producer App ids by ADR-0131, ADR-0134, ADR-0135 and
  ADR-0143. Re-pinning protection to a different producer is a different decision with its own ADR
  weight, and it is not what a hygiene bundle is for.
- **Keep `ci.yml`'s default `pull_request` types and accept losing `ready_for_review` for the
  lockfile scan.** The check run from the `opened` event binds the same head SHA and remains the
  evidence branch protection reads, so no coverage is lost in the branch-protection sense. Rejected
  anyway: OSV reads a live vulnerability database, so the second execution is a fresher read at the
  moment a pull request becomes reviewable, and Issue #2706 makes a lost trigger a stop rather than a
  trade-off.
- **Preserve `ready_for_review` by adding it to `ci.yml`'s `pull_request` types.** The obvious
  widening, and rejected on its measured cost in D2: it re-runs the entire matrix for a 20-second
  scan, and `cancel-in-progress: true` on the `ci-pr-<number>` group turns a draft-to-ready click
  during an in-flight run into a cancelled matrix restarting from zero.
- **Let the steps run serially with default `success()` conditions.** The simplest reading of "four
  serial steps", and rejected because it silently trades context count for repair rounds: one CI
  round would surface the first hygiene finding instead of all of them, in an epic whose measured
  problem is that finding-bearing pull requests take 108–122 minutes while checks go green at 25–32.
