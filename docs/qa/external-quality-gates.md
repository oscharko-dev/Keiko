# External quality-gate activation

This runbook separates repository-owned OSS enforcement from hosted supplemental services. A free
hosted entitlement is not called open-source software. Hosted checks become merge-critical only
after their live exact-head behavior is proven. Durable checks additionally require zero-cost
continuity; the explicit, time-bounded Greptile trial exception below requires a hard rollback.
The deterministic core remains usable without them.

## Repository-owned configuration

- CodSpeed: `codspeed.yml`, `.codspeed-policy.json`, the repository benchmark, and separate
  benchmark/policy workflows provide CPU-simulation comparison plus base-trusted settings
  enforcement.
- CodeRabbit: `.coderabbit.yaml` configures assertive advisory review without status, review,
  code-writing, or merge authority.
- Greptile: `.greptile/config.json`, `.greptile/files.json`, and the base-owned settlement workflow
  require an exact-head review, zero unresolved inline findings, and zero P0-P2 summary findings.
- Fallow: the root lockfile and `check:semantic-duplication` reject every introduced semantic clone
  group.
- Gitleaks: the checksum pin in `.github/workflows/ci.yml` rejects secrets anywhere in PR history.
- Drift pin: `scripts/check-external-quality-config.mjs` and its negative tests make integration
  weakening fail required `ci`.

Local verification:

```bash
npm run check:external-quality-config
npm run check:codspeed-policy
npm run check:semantic-duplication -- --changed-since origin/dev
npm run build:packages
npm run bench:codspeed
```

The benchmark suite is deterministic, synchronous, offline, and secret-free. It calls production
entry points and never re-derives their formulas. CPU simulation does not replace D12
reference-machine evidence, deterministic bundle budgets, retrieval latency, or affected end-to-end
performance gates.

## Hosted settings

- CodSpeed: CPU simulation, regressions above the 5% global threshold fail, one always-updated PR
  report, and no repository upload token or pull-request-visible OIDC grant. The dedicated
  `CodSpeed policy` workflow is loaded from the protected base, fetches only the exact-head
  `.codspeed-policy.json` as untrusted data, and fails closed when the live threshold, failure
  behavior, or report mode differs. Candidate code cannot execute in that workflow.
- CodeRabbit: assertive and advisory, with request-changes and every commit/review status disabled.
  Review details remain visible; all write/mutation, web-search, external command,
  cross-repository, and post-merge features are disabled.
- Greptile: strictness 2, logic/syntax comments, 4/5 confidence floor, every ready head including
  bot authors, 1,000-file ceiling, status plus one summary, and no code writing, approval, merge, or
  PR-description mutation.

Repository config overrides dashboard settings where the provider supports it. Dashboard-only
thresholds and entitlement state are verified in each activation audit.

## Zero-cost eligibility snapshot

Verified 2026-08-01. Terms can change; never add a payment method to preserve a gate.

- CodeRabbit is on a Pro Plus free trial scheduled to downgrade to Free on 2026-08-02. Its billing
  UI says the organization will be downgraded when the trial ends, and the cancel control is already
  disabled. No paid continuation is accepted. The review quota was exhausted during PR #2876.
- CodSpeed is active as a public-repository project. No star floor was presented.
- Greptile has a 14-day no-payment trial and a pending free-OSS exception. Its published
  application requires 50 stars while Keiko has 2. The temporary requirement is allowed only with
  the enforced rollback below.
- Socket is active; its existing free GitHub App checks remain direct and app-bound.
- SonarCloud is on the Free plan. Issue #2874 tracks a non-destructive migration to the stronger
  free OSS plan.

Qodo is retired: its review stopped after trial and its separate OSS program requires 100 stars.
Popularity floors are vendor eligibility rules, not engineering quality gates. Never buy, exchange,
automate, or fabricate stars.

## Live promotion ledger

Evidence source: [PR #2876](https://github.com/oscharko-dev/Keiko/pull/2876).

- CodeRabbit — `CodeRabbit`, App 347564, not protected. It requested changes on
  `e3c89ce0eb5a77f44a4d8115be261160709a22d0` at 2026-08-01 05:53:59 UTC. Its review on
  `418aca9d78d9f9c8c3e1ac7d83696923e5c849bc` at 06:39:26 UTC found three more actionable issues.
  On `fc56da5acd526cbd6408a47b08793d25024d4e1d`, CodeRabbit reported “Review limit reached” yet
  emitted a success status. By 2026-08-01 08:46 UTC, live branch protection had removed its
  App-bound status and the quota-dependent native review rule while preserving all other checks
  and conversation resolution.
- CodSpeed — `CodSpeed Performance Analysis`, App 257293, protection pending. It succeeded on
  `418aca9d78d9f9c8c3e1ac7d83696923e5c849bc` at 2026-08-01 06:35:50 UTC and uploaded four
  benchmarks without a workflow credential grant.
- CodSpeed — `CodSpeed policy`, GitHub Actions App 15368, protection pending. The base-trusted
  workflow first becomes eligible after this migration reaches `dev`; the subsequent canary must
  prove exact-head candidate-data validation before protection.
- Greptile — `Greptile Review`, App 867647, protected during the bounded trial. It emitted P1
  findings on `4b91c315823160652139a29de0d7a24e4af290c6` at 2026-08-01 05:51:24 UTC and
  `418aca9d78d9f9c8c3e1ac7d83696923e5c849bc` at 06:31:36 UTC, plus an outside-diff P1 on
  `e4f981efa67e363b78fd30bc2db36484402c83a2`. Head
  `3b9d90e50a74acd90734b3c59bd4aab374da895b` settled clean at 07:08:20 UTC.
- Greptile billing evidence observed 2026-08-01 states “until Aug 14, 2026” and shows no payment
  method. The conservative expiry ceiling is `2026-08-14T00:00:00Z`; rollback
  [#2877](https://github.com/oscharko-dev/Keiko/issues/2877) is due by
  `2026-08-13T00:00:00Z`.

The retired `Keiko for Quality` context was removed atomically from `dev` protection at
2026-08-01 06:28:25 UTC after its producer had been deleted. The other ten app-bound contexts were
preserved. Qodo and Keiko for Quality remain installed only until PR #2876 merges, so rollback does
not depend on removing an app before its replacement is live.

Greptile's UI exposes only the calendar-date expiry, 2026-08-14, rather than a time zone. Keiko
therefore fails safe at the earlier normalized ceiling `2026-08-14T00:00:00Z`. Issue #2877 requires
removal of both Greptile contexts and the installation by `2026-08-13T00:00:00Z` unless the free OSS
application is accepted. Owner-bound automation `keiko-greptile-trial-rollback` is active for
2026-08-12 20:00 Europe/Berlin (18:00 UTC). It must apply and verify the removal, then record
redacted evidence on #2877. A generic approval or admin bypass cannot waive the deadline, and an
attempt without successful live verification is not evidence.

Required conversation resolution makes every unresolved inline Greptile finding blocking even
though the provider's completion status itself reports successful review execution. The
`Greptile findings` `pull_request_target` workflow separately rejects P0-P2 findings that T-Rex can
place only in the current summary, binds the summary and provider App to the exact head, and never
emits comment bodies. It checks out and executes only the immutable base revision, has read-only
permissions, and cannot run pull-request code. Its context becomes eligible for protection only
after this migration is on `dev` and a subsequent pull request proves exact-head failure and
recovery.

Promotion requires all of the following on a live pull request:

1. every eligible current head receives exactly one attributable status without prompting;
2. two successive updates prove stale success cannot satisfy a new head;
3. an intentionally injected defect fails and a repaired head succeeds;
4. bot authors, ready transitions, large diffs, cancellation, and service errors cannot omit or
   falsely green evidence;
5. exact check name and producer App ID are stable and app-bindable; and
6. plan limits, credits, or quota do not pace or omit required evidence.

Condition 6 is the durability rule for CodSpeed and CodeRabbit. CodeRabbit failed conditions 1, 2,
and 6 when quota omission produced a false-green status, so it remains advisory. A future promotion
would require a new live request-changes/automatic-clear probe plus durable zero-cost evidence.

By owner decision, Greptile may be promoted during its no-payment trial after conditions 1–5 pass
only when the ledger records the provider-exposed expiry, a conservative time-zone-normalized
ceiling, and an active owner-bound rollback automation that removes and verifies both contexts and
the installation before the deadline. A pending OSS application or generic approval never disables
that rollback. A trial is never represented as zero-cost continuity. The ledger records pull-request
URLs, head SHAs, timestamps, App IDs, and rollback before branch-protection changes.

## Failure handling

Missing, skipped, stale, quota-paced, or still-running output is an availability failure, not a
pass. Fix all findings from all producers in one repair head. A baseline update, ignore command,
thread dismissal, admin bypass, or threshold relaxation is not a repair. If a hosted service loses
its zero-cost continuity, remove it through a reviewed atomic branch-protection update while the OSS
core remains enforced.
