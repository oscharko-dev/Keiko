# ADR-0139: Agent-first deterministic quality gates

## Status

Accepted (2026-07-16); amended for the local-only #3347 diagnostic on 2026-09-01; amended
2026-09-03 to make required pull-request Sonar analysis dev-equivalent and non-incremental.

## Amends

- [ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md) — keeps the bounded
  delivery envelope, direct-check merge authority, and advisory classification, and re-partitions
  _which_ verifications run inside the pull-request critical path.
- [ADR-0042](ADR-0042-editor-architecture.md) D3.6 performance budgets stay authoritative and
  unchanged; this record only moves _where_ wall-clock budgets are enforced.

## Context

Keiko is delivered predominantly by autonomous coding agents inside human-validated authority
envelopes (ADR-0129, ADR-0135). The Foundation-wave integration (PR #2463) produced hard evidence
that the gate _cost model_ — not the gate _strictness_ — was misfitted to that delivery mode:

1. **Whole-tree evidence binding.** The committed D12 performance comparison bound its
   `sourceTreeSha256` to effectively every tracked path (`packages/`, `scripts/`, `tests/`,
   `.github/workflows/`, `src/`). Any commit — including changes to scripts that are never loaded
   by the measured product — invalidated the evidence and forced a ~2 h Linux paired-measurement
   regeneration. Combined with the strict "branch up to date with `dev`" requirement, an active
   integration branch turned this into an unbounded regenerate/merge race: four regenerations were
   required in one integration, of which exactly one was caused by a change to the measured
   product.
2. **Non-deterministic assertions in required checks.** The required `ui` job executed single-shot
   wall-clock budgets (`stop p75 ≤ 200 ms`, `max long task ≤ 50 ms`) on shared two-core runners,
   with a session-wide `PerformanceObserver` that was never scoped to the measured window. The
   identical suite passes reproducibly on controlled hardware. The repository's own policy already
   states that hosted-runner performance evidence runs outside the PR critical path; the required
   path had drifted from that policy.
3. **Local/CI asymmetry.** `npm run agent:pre-pr` did not cover everything the required checks
   execute (e.g. the packaging smoke's shell-spawn guardrail), so agents discovered CI-only gates
   only after pushing — the exact failure mode the local-first policy exists to prevent.
4. **Repeat cost.** The pre-PR gate is fail-fast and non-incremental: a one-line fix to a test file
   re-ran ~65 minutes of checks whose inputs had not changed.
5. **External-service outages as code failures.** A SonarCloud-side HTTP 504 during JRE
   provisioning consumed a required check and demanded a manual re-run.

The corrective direction is not weaker gates. The gates caught four real defects during the same
integration. The direction is: **deterministic checks become cheap and non-repeating; inherently
noisy measurements move to controlled contexts with scheduled automation.**

## Decision

### D1 — The required PR path is deterministic by construction

A check may be GitHub-required for `dev` integration only if it is deterministic for a given
source tree: type checking, linting, formatting, hermetic unit/integration tests, coverage
ratchets, architecture rules, static security scans, packaging smokes, bounded-behaviour e2e
assertions (caps, counts, markers, redaction), and validation of committed evidence documents.
Authoritative wall-clock assertions (latency percentiles, long-task ceilings, memory-over-time) are
enforced only in controlled measurement contexts: the official D12 producer environment and the
scheduled performance workflow, both of which set `KEIKO_ENFORCE_WALL_CLOCK_BUDGETS=1`. In required-runner
context the same specs still verify their bounded-cap composition (byte, marker, retained-entry,
and variable caps) but reduce the repeated latency-sampling loops that exist only to feed those
percentiles — a full ten-sample stop/flood loop can exceed the E2E timeout on a shared two-core
runner even when nothing regressed. A shared-runner scheduling spike can therefore neither fail a
budget assertion nor time out an integration. The budgets themselves are unchanged and continue to
be enforced deterministically at PR time through the committed D12 evidence document, which was
measured under the controlled environment with the full sample count.

Separately, a regression pin for a pure-CPU algorithm may also run as an opt-in developer
pre-flight micro-benchmark in the version-pinned local Linux gate container when it is not invoked
by any required CI context, enables the wall-clock environment variable only for its focused child
process, and separately pins the deterministic behavioral invariant in ordinary tests. Such a
local check is diagnostic only: it does not produce D12 evidence, confer an integration verdict,
or widen the set of required wall-clock assertions. This narrow allowance keeps isolated
algorithmic pins such as the bounded workspace-pattern normalization check available as a focused
developer pre-flight without reintroducing shared-runner timing into the pull-request path.

### D2 — Performance evidence binds the measured product, not the repository

`sourceTreeSha256` for editor performance evidence is computed over the measured surfaces only:
the editor and UI packages, the server editor subsystem, the shared contracts package, the runtime entry wiring (`src/`), the root lockfile, and the TypeScript configuration (package.json itself is not a subject; a build-script change that alters the bundle is caught by the deterministic bundle-evidence rebuild). The D12 measurement toolchain keeps its
own dedicated digest (`measurementHarnessSha256`) exactly as before. Paths that cannot alter the
measured product — repository tooling under `scripts/` outside the toolchain list, workflows,
non-e2e tests, documentation — no longer invalidate evidence. Freshness stays fail-closed: stale,
tampered, dirty, or non-canonical evidence is still rejected; what changes is that "stale" now
means "the measured product changed", not "any file changed".

### D3 — Scheduled automation owns evidence drift; agents own evidence causality

A scheduled workflow (`nightly-perf-evidence`) re-runs the official D12 producer against the
pinned baseline on a clean Linux environment. If the refreshed document differs from the committed
one, the workflow opens a bot pull request through the normal required-check path (API-signed
commits, no gate bypass). Pull-request agents regenerate evidence only when their own change
touches a measured surface (D2; superseded by D10 — since 2026-07-19 only a measurement-toolchain
edit regenerates in-flight) — using the repository-provided
one-command producer wrapper (`npm run perf:evidence:regen`), which encodes the container
orchestration (pinned Node/npm image, bubblewrap, Playwright provisioning, baseline checkout,
independent re-validation) so the procedure is reproducible and not session folklore.

### D4 — Local-first parity is mechanical, and iteration is incremental

> Superseded (2026-07-19): [ADR-0145](ADR-0145-retire-the-agent-pre-pr-aggregate-gate.md) retires
> the `agent:pre-pr` aggregate wrapper this decision introduced; the underlying deterministic
> checks and the required CI matrix remain unchanged.

Every deterministic required check is represented as a step of `npm run agent:pre-pr`, including
the packaging shell-spawn guardrail and the installable-package smoke (platform-skipped where the
authoritative platform is Linux, with the container path documented). The pre-PR gate maintains a
content-addressed step cache (`.agent/pre-pr-cache.json`): each step declares its input scope, and
a step re-runs only when the content hash of its inputs changes. Cache entries record the input
digest and the step's last verdict; `--no-cache` bypasses the cache (diff scoping still applies —
combine with `--full` to force complete re-execution), and CI never uses the cache.
This turns the fix-iteration loop from ~65 minutes into minutes without removing any check.

The gate is additionally diff-scoped by default: it computes the change set versus the
integration base and runs only the steps whose declared input scope that change set intersects,
reporting every out-of-scope step visibly with its reason (steps without a declared scope always
run, and a cache group runs as one unit). Agents iterate in fresh worktrees where the step cache
starts cold, so content addressing alone still paid the full matrix once per session; scoping
makes the first run proportional to the change as well. `--full` restores the complete sequence,
and the required CI run on the pull request remains the authoritative full matrix — scoping moves
local verification effort, never the enforcement bar.

"Full matrix" includes the analysis surface inside each required check. SonarCloud's default PR
sensor cache previously made that sentence false: the workflow ran, but its JavaScript/TypeScript
analyzer freshly processed only changed files and could miss a full-tree warning that appeared on
the subsequent `dev` push. Required Sonar scans therefore disable the analysis cache and the
scanner-log validator proves full-project breadth before accepting the result.

The matrix also shares one immutable integration subject. Full-tree lanes check out `github.sha`
and verify that the PR merge commit's parents exactly match the event base and head before they run.
Combined with strict required-status-check branch protection, concurrent agents are serialized by
GitHub's candidate invalidation and re-check semantics rather than by post-merge agent monitoring.

### D5 — Static guards prefer precision to suppression

Guardrail scanners must not require suppression markers for provably safe constructs. The
shell-spawn guardrail's pattern is corrected so `shell: false` (in any spacing) never matches,
via a lookahead anchored before whitespace consumption; `SECURITY-SHELL-OK:` markers remain
reserved for genuine `shell: true` usages with their justification. False-positive fixes of this
class are treated as gate defects, not as occasions for suppression comments.

### D6 — External-service steps retry before they fail

Required steps that call external services (SonarCloud scanner provisioning and analysis
submission) wrap the call in bounded retry with backoff. A persistent outage still fails closed —
availability of the review product remains a quality property (ADR-0135 D4) — but a transient
5xx no longer consumes an integration attempt.

### D7 — Merge-queue readiness removes the up-to-date race

All required workflows also trigger on `merge_group` so that GitHub's merge queue can validate the
true integration result once, serially, instead of every open branch re-validating against a
moving `dev`. Enabling the queue itself is a branch-protection change and stays a human decision;
with D2 in place the evidence source-tree binding remains valid across queue integration whenever
the queued merge does not alter measured surfaces, and the scheduled refresh (D3) corrects the
residual drift.

### D8 — The scanner-log gate exempts one benign SCM-metadata warning class

`check-sonar-analysis-log.mjs` fails closed on any scanner `WARN`/`ERROR`, with one precisely
scoped exception: `File '<path>' was detected as changed but without having changed lines`. This
warning is SCM metadata — SonarCloud's git blame attributed zero changed lines to a file that is
still in the changed-file set, which is routine when pull-request analysis runs against the GitHub
merge ref. It carries no rule, coverage, or rating signal, and the SonarCloud quality gate keeps
enforcing all of those independently. The exemption matches only that exact wording, so every other
warning — including any real SCM failure such as a missing revision — still fails the gate.

### D9 — D12 binds dependency state per revision

The pinned baseline and candidate are each provisioned from the exact `package-lock.json` at their
respective commit. The execution manifest and immutable comparison bind both digests by revision;
every raw measurement and bundle input must match the digest for the revision it measured. Runtime,
browser, hardware, warm-up, and measurement-toolchain provenance must still match across revisions.
This makes dependency changes part of the measured candidate while preserving the exact pinned
baseline. Requiring both commits to have an identical lockfile would deadlock the first dependency
change after a baseline was pinned; substituting either lockfile into the other checkout would no
longer measure an exact commit. Both failure modes are therefore rejected.

The pinned baseline is identified by exact commit and by the source-tree and lockfile digests the
evidence independently re-derives; it does not need to be a Git ancestor of the candidate. This keeps
the same D12 reference usable after squash-only integrations without weakening the trust boundary:
the producer still refuses a dirty baseline checkout, a baseline checkout at any commit other than
the pin, or a document whose pinned-baseline digest no longer matches the checked-out baseline.

### D10 — The pull-request lane checks evidence integrity; the regeneration lane owns source freshness

D2 narrowed the performance subject; in practice the subject still spans surfaces broad enough
(the whole UI and contracts packages plus the root lockfile) that unrelated merged work invalidated
committed timing evidence several times per day, and every invalidation demanded a ~35-minute
Linux re-measurement from whichever pull request happened to be open — an unwinnable race against
integration velocity that measured nothing new about the pull request itself.

The freshness gate therefore runs in two modes. The pull-request lane (default,
`check:perf-evidence:editor` in CI and `agent:pre-pr`) validates evidence integrity: canonical
structure, budgets, stamps, the pinned-baseline anchor digest, and the measurement-toolchain
digest (changing the ruler still requires re-measuring, on the pull request that changes it). It
no longer requires the recorded source tree, the current lockfile, or a clean subject working tree
to match HEAD. The regeneration lane (`--enforce-source-freshness`, asserted by
`perf:evidence:regen` immediately after producing evidence, where the tree matches by
construction) enforces the full exact-tree contract unchanged. The measurement-toolchain digest
itself binds only files that shape produced measurements — producers, the checker the producer
self-check imports, the measuring specs, their configs, fixtures, and support; pure harness
consumers (unit tests, static spec-structure tests) are not part of the digest, so editing a test
never forces a re-measurement.

Per-pull-request performance protection does not regress: the deterministic bundle gates
(`check:editor-release-evidence`, `check:editor-bundle-size`) rebuild the shipped editor on every
pull request and fail on any change to what users load, and the scheduled nightly lane (D3)
re-measures `dev` daily and fails loudly on a budget breach. Timing evidence may lag `dev` by at
most one nightly cycle; it can no longer be silently wrong, hand-edited, or measured with a
different toolchain. This supersedes the D2/D3 expectation that a pull request touching a measured
surface regenerates timing evidence in-flight.

## Invariants that do not change

Performance budgets, coverage ratchet floors and per-file floors, architecture and trust-boundary
rules, evidence redaction, signed commits, fail-closed behaviour on invalid authority or tampered
evidence, the advisory (non-required) status of unbounded analyses, and the ADR-0135 delivery
envelope all remain exactly as governed. This record moves _where_ and _how often_ verifications
execute; it does not lower any threshold.

## Consequences

- Unrelated `dev` movement no longer invalidates performance evidence; since D10 the
  regenerate/merge race is gone entirely — editor and non-editor work alike trigger no per-PR
  regeneration, and only a measurement-toolchain edit re-measures in-flight.
- Required checks become reproducible for agents: a red required check implies a real defect in
  the change (or a gate defect to be fixed at the gate), never runner weather.
- The scheduled workflow adds one nightly Linux run and occasional bot pull requests.
- The pre-PR cache introduces declared input scopes per step; an over-narrow scope could skip a
  necessary re-run, so scopes are deliberately conservative and the cache is content-addressed,
  versioned, and disabled in CI.
