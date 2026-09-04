# ADR-0157 — Coverage shards produce evidence; one finalizing job judges it

- Status: Accepted — D1's **mechanism** amended by
  [ADR-0158](ADR-0158-one-coverage-ruler-per-question.md) D5: with the last `coverage.thresholds`
  block removed from the repository, no vitest configuration judges anything, so the derived
  `vitest.coverage.packages.shard.config.ts` was retired and the shards run against
  `vitest.coverage.packages.config.ts`. D1's property — a shard must not reach a verdict on its
  partial view — is unchanged and now holds structurally. D2 through D5 below stand as written.
- Amends: [ADR-0131](ADR-0131-ci-based-sonarcloud-analysis-and-banking-grade-gate.md) (D1, the
  topology of the `coverage-sonar` job; every other ADR-0131 decision stands)
- Extends: [ADR-0156](ADR-0156-measurement-and-verdict-separation.md) (D1, the producer/judge
  separation, from performance evidence to coverage evidence)
- D4 runtime-cache mechanism amended by
  [ADR-0164](ADR-0164-one-bounded-in-memory-usearch-hnsw-runtime.md): the retired sqlite-vec cache
  is replaced by the digest-pinned USearch cache; re-verification after every restore is unchanged.

## Context

A clean pull request reached auto-merge in roughly 32 minutes, and one job decided that number. On
run 30156130977 the `Coverage and SonarCloud` job took 1936 s, of which a single step —
`npm run test:coverage:quality` — took 1649 s: the package suite 1093 s, the keiko-ui suite 383 s,
the script suite 161 s, executed strictly one after another on one runner. Every other required job
finished within 22 minutes. Nothing else on the critical path was close.

The remaining terms were small and are worth recording, because the obvious suspects were not the
problem. `npm ci --ignore-scripts` cost 24–27 s, the full-history checkout 8–9 s, the bubblewrap
install 9–14 s, the Sonar Scanner download 1–2 s, and native vector-runtime provisioning under
1 s. The
pull-request Sonar analysis itself cost 221–230 s. Cold installation was never the bottleneck; three
serial test suites were.

Two structural facts compounded it. The workflow declared no `concurrency`, so a superseded
pull-request run kept a full set of runners busy producing evidence for a head commit that branch
protection would never read again. And the three suites are independent by construction: they share
no state, write to three different report directories, and are chained with `&&` only because they
were written as one step.

The obvious fix — run them in parallel and split the heavy one — has one hard obstacle. Vitest
evaluates `coverage.thresholds` at the end of every run, against the coverage that run produced.
`vitest.coverage.packages.config.ts` declares `perFile: true` and ten per-file floors on the gate
scripts. A shard executing a third of the test files therefore compares its partial view against
floors that describe the whole suite and fails on every gate script its slice never touched. This
was confirmed empirically on the real suite before any topology change, not on a fixture: sharding
it 1/3 with the judging configuration fails every one of the ten floors, e.g. `Coverage for lines
(0%) does not meet "scripts/check-sonar-main-quality-gate.mjs" threshold (90%)` and `Coverage for
lines (15.03%) does not meet "scripts/sonar-analysis-scope.mjs" threshold (90%)`.

The same shape had already been decided once. ADR-0156 D1 separated the D12 performance producer
from the gate that judges its output, for the same reason: a measurement that also judges destroys
the evidence when the verdict is negative. Coverage sharding is that decision applied to a second
kind of evidence.

## Decision

**D1 — A coverage shard measures; the finalizing job judges.** The package coverage suite runs as
three parallel shards that each write a vitest blob report and reach no verdict. The
`coverage-sonar` job merges the blobs with vitest's own `--mergeReports` — which merges the shards'
coverage maps and re-runs the reporters — so every floor is evaluated exactly once, on complete
coverage.

> **Amended by [ADR-0158](ADR-0158-one-coverage-ruler-per-question.md) D5 — read this before the
> paragraph below.** As adopted, this decision achieved "a shard must not judge" with a second
> configuration file: the shards ran against `vitest.coverage.packages.shard.config.ts`, which was
> `vitest.coverage.packages.config.ts` with `coverage.thresholds` removed and nothing else changed,
> and `scripts/__tests__/vitest-config-parity.test.mjs` failed if the two drifted in anything but
> `thresholds` while pinning the ten floors' numeric values.
>
> ADR-0158 D1 moved those ten per-file floors into
> `docs/qa/package-coverage-baseline.json`, leaving no `coverage.thresholds` block anywhere in the
> repository. The derived configuration then transformed nothing, so it was deleted and the shards
> run against `vitest.coverage.packages.config.ts` directly. **The decision's property is unchanged
> and now holds structurally** — there is no threshold for any run to evaluate — and the parity test
> asserts that structurally instead, over every vitest configuration. The floors' numeric values are
> pinned at their new home in `scripts/__tests__/check-package-coverage.test.mjs`.

The obstacle that made the split necessary is recorded in Context above and remains the reason no
vitest configuration may declare `coverage.thresholds` again.

The keiko-ui and script suites declare no thresholds and therefore need no measure/judge split. They
run as their own jobs and hand their finished LCOV and summary to the finalizer unchanged.

**D2 — Merge before evaluate is structural, not conventional.** The finalizer depends on all three
suites through `needs:`, and downloads and reassembles their evidence before the first gate runs. A
per-file floor read off one shard's partial summary silently under-reports; `coverage-summary.json`
carries only covered/total counts with no line identity and is not losslessly concatenable, so it is
regenerated rather than merged. No gate ever sees a shard-local view.

**D3 — Any non-success shard result fails the required lane closed.** `coverage-sonar` runs under
`if: always()` and its first step rejects every shard result that is not `success` — `failure`,
`cancelled` and `skipped` alike. Without `always()` a failed shard would leave the job *skipped*,
and a skipped context reads like "not applicable" rather than "a coverage suite did not execute". A
silently skipped shard must never let the context pass with a suite unexecuted.

The claim is about job results, and one pre-existing exception is worth stating plainly: the
`feat/keiko-editor` guard sits on the measuring *steps*, not on the jobs, exactly as it did when the
three suites shared one step. On a pull request against that branch the jobs still run and still
report `success` with no suite executed. That lane's semantics are unchanged by this record, and no
lane targeting `dev` has that property.

ADR-0135 D3 is unaffected. `Coverage and SonarCloud` is not itself a required status check; the
14 required contexts are listed in `CONTRIBUTING.md`, and `ci` — the in-workflow fail-closed
aggregate ADR-0131 D1 already established — is the one that observes it. No required check depends
on another required check, and pending shard evidence stays pending rather than becoming a synthetic
terminal failure.

**D4 — Caches may save a download; they may never substitute an artifact.** The coverage jobs
restore three GitHub-native caches: the npm download cache (`~/.npm`), the provisioned USearch
runtime, and the pinned Sonar Scanner CLI archive. `node_modules` is never cached or restored.
Every cached artifact is re-verified after restore, inside the job that restored it:
`npm ci --ignore-scripts` always executes and re-verifies every package against the lockfile's
integrity hashes; `provision-usearch.mjs` recomputes the native addon's SHA-256 against its
platform-pinned value; the scanner archive is re-checked with `sha256sum --check`, which fails the
job closed on a
mismatch, because a digest mismatch on a content-addressed artifact is tampering, not staleness. The
remediation for a corrupted cache is to evict the entry, never to skip the verification.

Caching is confined to jobs holding `contents: read` and nothing else. Every ci.yml job with
signing-relevant permissions — `build-scan-sbom-smoke` and `ui`, both `attestations: write` and
`id-token: write` — continues to use no cache at all, so a poisoned entry has no privileged
consumer. This is the same reasoning `.github/zizmor.yml` records for the `cache-poisoning` rule.

**D5 — Superseded pull-request runs are cancelled; integration runs are never grouped at all.**
The workflow runs for pull-request code-head actions (`opened`, `reopened`, `synchronize`, and
`ready_for_review`), not for metadata-only `edited` events. It declares `concurrency` with
`cancel-in-progress` true for those `pull_request` events, grouped by pull-request number. A
superseded pull-request run has no consumer: its evidence binds a head that the next push already
replaced. A title or description edit cannot alter executable evidence and therefore launches no CI
pipeline.

Every other event gets a group of one, keyed on `github.run_id`. `cancel-in-progress: false` on a
shared group would not have been enough: GitHub cancels a previously *pending* run in a group
whenever a newer run enters it, independently of that flag, so three merges landing inside one CI
window would have dropped the middle run's evidence. A run alone in its group cannot be cancelled by
another, which is the property this needs — a cancelled required check on `dev` is indistinguishable
from a real defect, and that evidence binds an integration commit nothing else re-measures.

## Consequences

The critical path is set by the slowest coverage job plus the finalizer, instead of by their sum.
Three shards put the package suite at roughly the keiko-ui suite's duration, which is where further
package sharding stops paying without also splitting keiko-ui — deliberate headroom left to the
child that owns coverage-truth consolidation.

Nothing about the verdict changed. The same test files execute, at the same `maxWorkers: 2` per
process (GEN-TEST-FLAKE-002 is a per-process guarantee and a shard is a process), with the same 15 s
`testTimeout` and the same `reportOnFailure`. `docs/qa/package-coverage-baseline.json`, the
`thresholds` block, and `KEIKO_GATE_CONDITIONS` are untouched. The merged LCOV `SF:` record set
(1526 records) and the union of executed test files (1500) were compared against an unsharded run on
the same tree and matched exactly; the A/B output is recorded on the pull request that adopted this
record. A control comparing two *unsharded* runs of the same tree established the measurement's own
noise floor first, so the handful of per-file statement counts that differ between the two arms are
attributable to run-to-run nondeterminism in the measured code rather than to the merge.

Sharding must not become a source of runner weather (ADR-0139 D1). The worker cap is preserved per
shard and pinned by test; shards are `fail-fast: false` so one shard's result never masks another's;
and the finalizer treats a cancelled or skipped shard exactly like a failed one.

Rollback is a single revert of the adopting commit. Caches are purely additive: a cache miss
reproduces today's cold-install behaviour exactly, and no committed baseline, floor, or evidence
document moves, so there is no state to migrate back.

Two properties the single job got for free are now explicit. All four jobs check out the run's
immutable `github.sha` rather than the moving ref one checkout could safely use: the lane now has
six checkouts across four job definitions, and `refs/pull/N/merge` is rewritten whenever the head or
base moves, so the shards could otherwise measure one tree while the gates and the scanner judge
another, with nothing to detect the skew. And blobs key coverage by absolute path,
so the design assumes all four jobs share a workspace root — true on GitHub-hosted runners, and
worth re-checking before this lane ever moves to self-hosted ones.

The `.github/zizmor.yml` `cache-poisoning` ignores are line-anchored, as that file requires. This
workflow is scheduled to be edited by two further children of the same epic, so those anchors will
need re-verifying — which is the documented, intended failure mode, not a regression.

## Alternatives rejected

- **Disable the thresholds in the shard runs from the command line.** Only the four global metrics
  are reachable that way; the ten per-file floors are keyed by glob and would survive, so the shards
  would still fail. Zeroing floors on a command line is also the opposite of an auditable decision.
- **Concatenate the shards' LCOV and summary files instead of merging blobs.** LCOV concatenation is
  safe for the consumers in this repository, but `coverage-summary.json` sums `covered` and `total`
  per file; with vitest's default `all` semantics every included file appears in every shard, so
  summing double-counts both numerator and denominator. Rebuilding it needs the raw coverage —
  which is exactly what vitest's own blob merge already does, correctly, without new code.
- **Cache `node_modules` instead of the npm download cache.** Removes the one step that re-verifies
  every package against the lockfile, turning the cache into a trust anchor. Rejected outright.
- **Split the coverage work into a second workflow with its own required context.** Adds a
  branch-protection change and a second aggregate for no gain; ADR-0131 already rejected new
  required checks where an in-workflow aggregate achieves the same merge-blocking effect.
- **Cancel superseded `merge_group` or push-to-`dev` runs too.** Those runs are the only measurement
  of their integration commit, and a cancelled result is not distinguishable from a defect by
  anything downstream.
