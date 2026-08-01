# External quality-gate activation

This runbook separates repository-owned OSS enforcement from hosted supplemental services. A free
hosted entitlement is not called open-source software. Hosted checks become merge-critical only
after their live exact-head behavior is proven. Durable checks additionally require zero-cost
continuity; the explicit, time-bounded Greptile trial exception below requires a hard rollback.
The deterministic core remains usable without them.

## Repository-owned configuration

| Signal     | Durable source                                                                | Role                                                              |
| ---------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| CodSpeed   | `codspeed.yml`, `.codspeed-policy.json`, `benchmarks/codspeed.mjs`, workflows | CPU-simulation comparison plus live settings enforcement          |
| CodeRabbit | `.coderabbit.yaml`                                                            | Assertive blocking review with no code-writing or merge authority |
| Greptile   | `.greptile/config.json`, `.greptile/files.json`, settlement workflow          | Independent current-head review with zero unresolved P0-P2        |
| Fallow     | root lockfile and `check:semantic-duplication`                                | Zero introduced semantic clone groups                             |
| Gitleaks   | checksum pin in `.github/workflows/ci.yml`                                    | Zero secrets introduced anywhere in PR history                    |
| Drift pin  | `scripts/check-external-quality-config.mjs` plus negative tests               | Required-`ci` proof that integration policy did not weaken        |

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
  report, and no repository upload token or pull-request-visible OIDC grant. The required `ci`
  aggregate queries the public project settings on every candidate head and fails closed when the
  live threshold, failure behavior, or report mode differs from `.codspeed-policy.json`.
- CodeRabbit: assertive, every ready head including bot authors, request-changes workflow enabled,
  failure status enabled, author override denied, review details visible, and all write/mutation,
  web-search, external command, cross-repository, and post-merge features disabled.
- Greptile: strictness 2, logic/syntax comments, 4/5 confidence floor, every ready head including
  bot authors, 1,000-file ceiling, status plus one summary, and no code writing, approval, merge, or
  PR-description mutation.

Repository config overrides dashboard settings where the provider supports it. Dashboard-only
thresholds and entitlement state are verified in each activation audit.

## Zero-cost eligibility snapshot

Verified 2026-08-01. Terms can change; never add a payment method to preserve a gate.

| Service    | State                                    | Continuity rule                                                                                                                                            |
| ---------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeRabbit | Active OSS Pro Plus                      | Public-repository entitlement; no star floor was presented. Rate limits still require live proof.                                                          |
| CodSpeed   | Active public-repository project         | Public repositories are free; no star floor was presented.                                                                                                 |
| Greptile   | 14-day trial; free-OSS exception pending | Published application requires 50 stars while Keiko has 2. Time-bounded required use is permitted; remove at least 24 hours before expiry unless approved. |
| Socket     | Active                                   | Existing free GitHub App checks remain direct and app-bound.                                                                                               |
| SonarCloud | Active Free plan                         | Issue #2874 tracks a non-destructive migration to the stronger free OSS plan.                                                                              |

Qodo is retired: its review stopped after trial and its separate OSS program requires 100 stars.
Popularity floors are vendor eligibility rules, not engineering quality gates. Never buy, exchange,
automate, or fabricate stars.

## Live promotion ledger

| Producer   | Exact status name               | App ID | [PR #2876](https://github.com/oscharko-dev/Keiko/pull/2876) evidence                                                                                                                                                                                                                                 | Protected |
| ---------- | ------------------------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| CodeRabbit | `CodeRabbit`                    | 347564 | Requested changes on `e3c89ce0eb5a77f44a4d8115be261160709a22d0` at 2026-08-01 05:53:59 UTC; the review on `418aca9d78d9f9c8c3e1ac7d83696923e5c849bc` at 06:39:26 UTC found three additional actionable issues                                                                                        | pending   |
| CodSpeed   | `CodSpeed Performance Analysis` | 257293 | Success on `418aca9d78d9f9c8c3e1ac7d83696923e5c849bc` at 2026-08-01 06:35:50 UTC; four benchmarks uploaded without a workflow credential grant                                                                                                                                                       | pending   |
| Greptile   | `Greptile Review`               | 867647 | P1 findings on `4b91c315823160652139a29de0d7a24e4af290c6` at 2026-08-01 05:51:24 UTC and `418aca9d78d9f9c8c3e1ac7d83696923e5c849bc` at 06:31:36 UTC, plus an outside-diff P1 on `e4f981efa67e363b78fd30bc2db36484402c83a2`; `3b9d90e50a74acd90734b3c59bd4aab374da895b` settled clean at 07:08:20 UTC | pending   |

The retired `Keiko for Quality` context was removed atomically from `dev` protection at
2026-08-01 06:28:25 UTC after its producer had been deleted. The other ten app-bound contexts were
preserved. Qodo and Keiko for Quality remain installed only until PR #2876 merges, so rollback does
not depend on removing an app before its replacement is live.

Greptile's no-payment trial expires on 2026-08-14. Issue #2877 requires removal of its required
context and installation by 2026-08-13 unless the free OSS application is accepted. Required
conversation resolution makes every unresolved inline Greptile finding blocking even though the
provider's completion status itself reports successful review execution. The `Greptile findings`
`pull_request_target` workflow also rejects P0-P2 findings that T-Rex can place only in the current
summary, binds the summary and provider App to the exact head, and never emits comment bodies. It
checks out and executes only the immutable base revision, has read-only permissions, and cannot run
pull-request code. Its context becomes eligible for protection only after this migration is on
`dev` and a subsequent pull request proves exact-head failure and recovery.

Promotion requires all of the following on a live pull request:

1. every eligible current head receives exactly one attributable status without prompting;
2. two successive updates prove stale success cannot satisfy a new head;
3. an intentionally injected defect fails and a repaired head succeeds;
4. bot authors, ready transitions, large diffs, cancellation, and service errors cannot omit or
   falsely green evidence;
5. exact check name and producer App ID are stable and app-bindable; and
6. plan limits, credits, or quota do not pace or omit required evidence.

Condition 6 is the durability rule for CodSpeed and CodeRabbit. By owner decision, Greptile may be
promoted during its no-payment trial after conditions 1–5 pass only when the ledger records the exact
provider expiry and a rollback issue that removes the context at least 24 hours beforehand. A trial
is never represented as zero-cost continuity.

CodeRabbit additionally must prove request-changes blocking and automatic clearing with GitHub
configured for zero human approvals. The atomic cutover removes the retired bridge and adds only
the proven contexts. The ledger is updated with pull-request URL, head SHAs, timestamps, App IDs,
and rollback before branch protection changes.

## Failure handling

Missing, skipped, stale, quota-paced, or still-running output is an availability failure, not a
pass. Fix all findings from all producers in one repair head. A baseline update, ignore command,
thread dismissal, admin bypass, or threshold relaxation is not a repair. If a hosted service loses
its zero-cost continuity, remove it through a reviewed atomic branch-protection update while the OSS
core remains enforced.
