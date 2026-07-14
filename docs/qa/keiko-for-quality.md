# Keiko `dev` quality gates

## Current enforcement

Pull requests targeting `dev` are protected by 13 direct, app-bound checks on the exact current
head:

1. `ci`
2. `actionlint`
3. `Verify pinned action SHAs`
4. `zizmor`
5. `Analyze (actions)`
6. `Analyze (javascript-typescript)`
7. `Build, scan, SBOM, smoke`
8. `Review dependency diff (dev/main)`
9. `ui`
10. `Scan dependency lockfiles`
11. `SonarCloud Code Analysis`
12. `Socket Security: Project Report`
13. `Socket Security: Pull Request Alerts`

Branch protection uses strict current-branch checks and administrator enforcement. GitHub Actions
contexts are pinned to App ID `15368`, SonarQube Cloud to App ID `12526`, and both Socket contexts
to App ID `156372`. A same-named check from another producer does not satisfy protection.

GitHub invalidates prior evidence on every new commit. Native auto-merge may integrate only after
all direct required checks succeed, the branch is current with `dev`, and every review conversation
is resolved. No approving human review is required.

## Critical-path boundary

A check belongs in branch protection only when it is emitted for every eligible pull request,
machine-readable, bound to a stable producer App ID, and bounded by a repository-owned runtime.
The following analysis remains valuable but is not merge-critical:

- `Gitar` review may be absent when automatic processing is paused by plan pacing. Its comments and
  fixes remain advisory until the service proves current-head check emission within a bounded SLO.
- `Keiko for Quality` is dormant and non-required. The external aggregate cannot safely control the
  same protection path needed to repair its own evaluator.
- Full Stryker mutation analysis runs daily and through `workflow_dispatch`; focused local mutation
  remains required engineering evidence for tractable trust-boundary changes.
- Hosted-runner performance evidence uses ten samples after merge or on a release lane. Functional
  UI build, lint, typecheck, coverage, accessibility, smoke, editor E2E, and package checks remain in
  the required `ui` job.

## Failure classification

Treat these states differently:

- A completed direct check with a product, security, coverage, architecture, or deterministic
  functional failure is blocking and must be repaired at the owning layer.
- A missing quota-dependent check, a multi-hour analysis workload, or runner-performance jitter is
  an availability/evidence-lane defect. It must not be relabeled as a product failure.
- A pending direct required check remains pending through GitHub's native semantics. An aggregate
  must not convert missing or in-progress evidence into terminal failure.
- A new commit invalidates all prior head-bound results; stale success is never reused.

## Dormant aggregate implementation

The repository retains the open implementation under
[`../../infrastructure/keiko-for-quality/`](../../infrastructure/keiko-for-quality/) and its
redacted evaluator tests for audit and possible redesign. The GitHub App receives no Contents,
Actions, Administration, or repository-secret access. Its historical check and dashboard comment
are not merge authority.

The aggregate may be reconsidered only after live probes prove all of the following:

1. every pull-request head receives exactly one app-bound check without manual prompting;
2. missing or running inputs remain neutral/pending, while terminal failures remain red;
3. reconciliation settles within a documented SLO without repeated unchanged writes;
4. service quotas and vendor plan limits cannot omit required evidence;
5. the gate's own deployment and repair path does not depend on that gate succeeding; and
6. negative probes for stale head, wrong producer, failed direct checks, Socket warning, and Sonar
   failure all block, followed by a complete positive probe.

Until every condition is met and branch protection is changed through a reviewed maintainer
decision, `Keiko for Quality` remains advisory and non-required.
