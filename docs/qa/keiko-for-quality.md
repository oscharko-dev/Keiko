# Keiko `dev` quality gates

## Current enforcement

Pull requests targeting `dev` are protected by 14 app-bound checks on the exact current head:

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
14. `Keiko for Quality`

Branch protection requires linear history, signed commits, and resolved review conversations.
GitHub Actions contexts are pinned to App ID `15368`, SonarQube Cloud to App ID `12526`, both
Socket contexts to App ID `156372`, and `Keiko for Quality` to App ID `4290143`. A same-named
check from another producer does not satisfy protection.

GitHub invalidates prior evidence on every new commit. Native auto-merge may integrate only after
all required checks succeed on the exact current head and every review conversation is resolved.
No approving human review is required.

## Critical-path boundary

A check belongs in branch protection only when it is emitted for every eligible pull request,
machine-readable, bound to a stable producer App ID, and bounded by a repository-owned runtime.
The following analysis remains valuable but is not merge-critical:

- `Qodo` review is comment-only; its summary comment may be absent when automatic processing is
  paused. The comment remains advisory, and evidence currency is the head SHA embedded in it rather
  than a check-run emission SLO.
- `Keiko for Quality` is required and app-bound since the ADR-0142 cutover (2026-07-19): the six
  live-probe conditions below were proven on live pull requests (ledger in
  [`keiko-for-quality-action-evaluation.md`](keiko-for-quality-action-evaluation.md)) and the
  maintainer promoted the check. Repair path when the aggregate itself is broken: a fix pull
  request still needs all 14 required checks, `Keiko for Quality` included; only when the
  aggregate is unavailable and cannot go green on its own fix does the documented ADR-0135 D7
  administrator escape in the
  [liveness runbook](../troubleshooting/keiko-for-quality-liveness.md) apply, as the explicit,
  owner-approved exception. The aggregate never re-checks the 13 direct contexts.
- Full Stryker mutation analysis runs daily and through `workflow_dispatch`; focused local mutation
  remains required engineering evidence for tractable trust-boundary changes.
- The per-pull aggregate is the Qodo bridge only (Issue #2508,
  [ADR-0143](../adr/ADR-0143-keiko-for-quality-narrowed-to-the-qodo-bridge.md)): it binds the
  comment-only Qodo review to the exact current head and applies the stability window. It does not
  re-check the direct required contexts — branch protection is their single authority — and it does
  not wait for the scheduled/manual full mutation lane, which does not emit a pull-request check.
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

## Advisory aggregate implementation

The repository retains the open implementation under
[`../../infrastructure/keiko-for-quality/`](../../infrastructure/keiko-for-quality/) and its
redacted evaluator tests. The GitHub App receives no Contents, Actions, Administration, or
repository-secret access. Its check and dashboard comment are not merge authority.

Since Issue #2508 ([ADR-0143](../adr/ADR-0143-keiko-for-quality-narrowed-to-the-qodo-bridge.md))
the evaluator is narrowed to the Qodo bridge: it requires a current-head (or fresh
merge-parent-bound), app-id-verified, parseable Qodo summary with zero blocking findings, and
applies the stability window to that evidence. Unresolved findings publish a `failure` conclusion;
missing, stale, unparseable, or still-settling evidence keeps the check `in_progress`. The 13
direct required checks and Socket's comment alerts are no longer re-checked — branch protection and
the organisation-level Socket policy own those decisions directly — which removes the
per-evaluation check-runs listing and the `SOCKET_RISK_*` configuration surface.

**Worker era (retired 2026-07-19; kept for the rollback template only).** The following two
paragraphs describe the retired Cloudflare Worker's reconciliation model. The canonical Action is
event-driven instead: `check_run`/`issue_comment`/`workflow_dispatch` triggers with per-pull
concurrency, no cron, no D1 (see the execution-shell section below).

The scheduled reconciliation sweep retained a merged pull request for up to one hour. This bounded
post-merge lane lets the 60-second review-product stability window finish and updates the exact-head
advisory check before deleting persisted tracking. Closed, unmerged, wrong-base, expired, and
successfully reconciled pull requests are removed from tracking.

The sweep runs every two minutes and re-evaluates only pull requests whose verdict can still move —
never evaluated, still waiting on evidence, a changed head, or a settled verdict older than the
liveness backstop (`RECONCILE_BACKSTOP_MS`, default 15 minutes). A settled pull request whose exact
head is unchanged is skipped; a webhook, not the cron, carries its next same-head evidence. This
directly serves probe 3 (reconciliation without repeated unchanged writes) and lowers Cloudflare and
D1 usage while preserving fail-closed currency: every head move is re-evaluated, and the backstop
still re-checks each settled pull request periodically (Issue #2507).

The aggregate may be reconsidered only after live probes prove all of the following:

1. every pull-request head receives exactly one app-bound check without manual prompting;
2. missing or running inputs remain neutral/pending, while terminal failures remain red;
3. reconciliation settles within a documented SLO without repeated unchanged writes;
4. service quotas and vendor plan limits cannot omit required evidence;
5. the gate's own deployment and repair path does not depend on that gate succeeding; and
6. negative probes for a stale-head review, a wrong producer, an unresolved Qodo finding, and an
   unparseable summary all block the aggregate — while a failed direct required check still blocks
   the merge through branch protection natively — followed by a complete positive probe.

All six conditions were proven on live pull requests on 2026-07-19 (probe ledger in
[`keiko-for-quality-action-evaluation.md`](keiko-for-quality-action-evaluation.md)), and the
maintainer promoted `Keiko for Quality` to a required, app-bound branch-protection check the same
day.

## GitHub Action execution shell (canonical since 2026-07-19)

The evaluator is a pure function and does not depend on any hosting shell. Since the ADR-0142
cutover (2026-07-19) it runs as the GitHub Action
(`.github/workflows/keiko-for-quality-action.yml` + `scripts/keiko-for-quality-action.mjs`) under
the canonical check name and dashboard marker, with no D1 database, no scheduled cron, no manual
`wrangler deploy`, and no webhook secret — "merge = deployed". The base-branch `check_run` and
`issue_comment` triggers run the workflow definition from `dev`, which pull-request code cannot
alter, so the Action preserves the Worker's tamper-resistance. Since the cutover it publishes
under the App-bound identity the branch-protection pin requires (`KFQ_APP_ID` /
`KFQ_PRIVATE_KEY_PKCS8` repository secrets, App id `4290143`); the `GITHUB_TOKEN` fallback
identity remains only as the documented failure signature for missing or invalid secrets — the
pinned context rejects it, so the gate fails closed until the secrets are repaired (see the
[liveness runbook](../troubleshooting/keiko-for-quality-liveness.md)).

All six live-probe conditions above were proven on live pull requests before the cutover; the
probe ledger, trade-off analysis, tamper-resistance comparison, empirical equivalence evidence,
and the rollback plan (`wrangler deploy` from `infrastructure/keiko-for-quality/` plus reverting
the workflow identity block) are in
[`keiko-for-quality-action-evaluation.md`](keiko-for-quality-action-evaluation.md); the decision is
recorded in
[ADR-0142](../adr/ADR-0142-keiko-for-quality-github-action-execution-shell.md).
