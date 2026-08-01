# External quality-gate activation

This runbook separates repository-owned OSS enforcement from hosted supplemental services. A free
hosted entitlement is not called open-source software. Hosted checks become merge-critical only
after their live exact-head behavior is proven. Durable checks additionally require zero-cost
continuity; the explicit, time-bounded Greptile trial exception below requires a hard rollback.
The deterministic core remains usable without them.

## Repository-owned configuration

| Signal     | Durable source                                                               | Role                                                              |
| ---------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| CodSpeed   | `codspeed.yml`, `.codspeed-policy.json`, `benchmarks/codspeed.mjs`, workflow | CPU-simulation comparison plus live settings audit                |
| CodeRabbit | `.coderabbit.yaml`                                                           | Assertive blocking review with no code-writing or merge authority |
| Greptile   | `.greptile/config.json`, `.greptile/files.json`                              | Independent current-head logic/security/architecture review       |
| Fallow     | root lockfile and `check:semantic-duplication`                               | Zero introduced semantic clone groups                             |
| Gitleaks   | checksum pin in `.github/workflows/ci.yml`                                   | Zero secrets introduced anywhere in PR history                    |
| Drift pin  | `scripts/check-external-quality-config.mjs` plus negative tests              | Required-`ci` proof that integration policy did not weaken        |

Local verification:

```bash
npm run check:external-quality-config
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
  report, and no long-lived upload token or pull-request-visible OIDC grant. The signed-in settings
  surface was observed at the timestamp pinned by `.codspeed-policy.json`.
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

| Producer   | Exact status name               |  App ID | Negative/recovery proof | Zero-cost proof        | Protected |
| ---------- | ------------------------------- | ------: | ----------------------- | ---------------------- | --------- |
| CodeRabbit | pending live observation        | pending | pending                 | active OSS entitlement | no        |
| CodSpeed   | `CodSpeed Performance Analysis` | pending | pending                 | public repository      | no        |
| Greptile   | pending live observation        | pending | pending                 | exception pending      | no        |

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
