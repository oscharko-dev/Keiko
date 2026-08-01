# External quality-gate activation

This runbook separates repository-owned OSS enforcement from hosted supplemental services. A free
hosted entitlement is not called open-source software. Hosted checks become merge-critical only
after exact-head failure and recovery are proven and durable zero-cost continuity is verified. The
deterministic core remains usable when a hosted producer is unavailable.

## Repository-owned enforcement

- CodSpeed: `codspeed.yml`, `.codspeed-policy.json`, the repository benchmark, and separate
  benchmark/policy workflows provide CPU-simulation comparison plus base-trusted settings
  enforcement.
- CodeRabbit: `.coderabbit.yaml` configures assertive advisory review without status, review,
  code-writing, or merge authority.
- Fallow: the root lockfile and `check:semantic-duplication` reject every introduced semantic clone
  group.
- Gitleaks: the checksum pin in `.github/workflows/ci.yml` rejects secrets anywhere in pull-request
  history.
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

- CodSpeed: CPU simulation; regressions above the 5% global threshold fail; one always-updated pull
  request report; no repository upload token or pull-request-visible OIDC grant. The dedicated
  `CodSpeed policy` workflow is loaded from the protected base, fetches only the exact-head policy as
  untrusted data, and fails closed when the live threshold, failure behavior, or report mode differs.
  Candidate code cannot execute in that workflow.
- CodeRabbit: assertive and advisory, with request-changes and every commit/review status disabled.
  Review details remain visible; all write/mutation, web-search, external command, cross-repository,
  and post-merge features are disabled.

Repository configuration overrides dashboard settings where the provider supports it.
Dashboard-only thresholds and entitlement state are verified in each activation audit.

## Zero-cost eligibility snapshot

Verified 2026-08-01. Terms can change; never add a payment method to preserve a gate.

- CodeRabbit was scheduled to downgrade from trial to Free on 2026-08-02. Its review quota was
  exhausted during migration PR #2876, and it emitted a successful status without reviewing the
  current head. It therefore remains advisory.
- CodSpeed is active as a public-repository project. No star floor or payment requirement was
  presented. The base-owned `CodSpeed policy` context is required; native performance comparison is
  advisory after shared-runner variance produced large false regressions on unchanged inputs.
- Greptile's authenticated eligibility screen required 50 stars while Keiko had 3. Keiko was
  already public and Apache-2.0/OSI licensed, so a license change could not remove that
  provider-specific popularity floor. The pending OSS application did not grant an entitlement.
  The 50-credit trial was exhausted on final canary head
  `b56de3aedc364a2ac6f5aa34a06ac5b6ba932efc`; Greptile omitted review and reported the credit cap.
  Both Greptile contexts were atomically removed from branch protection and the organization App
  was uninstalled. Repository configuration and the settlement workflow were then removed so the
  retired integration cannot consume CI time or produce dead checks.
- Socket remains active through its existing free GitHub App checks.
- SonarCloud remains on the Free plan. Issue #2874 tracks a non-destructive migration to the
  stronger free OSS plan.

Qodo and Keiko for Quality are retired and uninstalled. Qodo stopped after trial and its separate
OSS program required 100 stars. Popularity floors are vendor eligibility rules, not engineering
quality gates. Never buy, exchange, automate, or fabricate stars.

## Redacted live evidence ledger

Evidence is identified by immutable head, check/job identifier, timestamp, App ID, and outcome.
Service endpoints and comment bodies are deliberately omitted.

- CodeRabbit, App 347564, is not protected. It requested changes on
  `e3c89ce0eb5a77f44a4d8115be261160709a22d0` at 05:53:59 UTC and found three additional issues on
  `418aca9d78d9f9c8c3e1ac7d83696923e5c849bc` at 06:39:26 UTC. On
  `fc56da5acd526cbd6408a47b08793d25024d4e1d` it reported the review limit reached while emitting
  success. Branch protection removed its status and quota-dependent review authority.
- `CodSpeed Performance Analysis`, App 257293, failed deliberate slowdown head
  `1069aa9a7a75d7e3e19489a197af4671402de3a0` with a 51.48% aggregate regression in check
  91357704565, then passed restored head `d86f64250b226e815d66756f31b17e2e79f8c502` in check 91359719104. No regression was acknowledged and no baseline was changed.
- `CodSpeed policy`, GitHub Actions App 15368, rejected the candidate 10% drift in job 91356603600
  and accepted the restored 5% policy in job 91358992913.
- Later native CodSpeed checks 91361869877 and 91365139527 failed on heads that changed no benchmark
  or transitive production path. The first warned that runtime environments differed and reported
  multiple unrelated regressions; the second reported one unchanged benchmark 27.45% slower while
  another improved 7.3%. Both benchmark workflows succeeded. CodSpeed's own variance guidance says
  shared CI runner CPU, cache, and system-library differences can create regressions without code
  changes. The native performance status was removed from branch protection without acknowledging a
  regression, changing a baseline, or changing the 5% policy. It remains advisory.
- Greptile's native App 867647 and settlement context temporarily proved negative and recovery
  behavior. Native check 91356606358 and settlement job 91356603731 rejected the deliberate head
  with three P1 findings. Native check 91358998906 and settlement job 91358992919 passed the
  restored head with zero unresolved Greptile findings.
- On later exact head `b56de3aedc364a2ac6f5aa34a06ac5b6ba932efc`, Greptile omitted review after its trial account hit
  the 50-credit cap. The settlement context failed rather than accepting stale evidence. This
  durability failure triggered the documented rollback early: both Greptile contexts were removed,
  App installation 150407338 was uninstalled, and organization installation verification returned
  no Greptile installation. After the separate CodSpeed variance rollback, the final protected set
  contains 11 App-bound checks.
- The retired `Keiko for Quality` context was removed after its producer had been deleted. Qodo and
  Keiko for Quality were uninstalled after PR #2876 merged; organization installation verification
  returned no remaining installation for either App.

Greptile can be reconsidered only after a durable zero-cost entitlement is actually active and a new
live canary proves exact-head negative, recovery, quota independence, stable App identity, and
bounded settlement. A pending application is not authority to reinstall or require it.

## Promotion requirements

A hosted producer may become required only when a live pull request proves all of the following:

1. every eligible current head receives exactly one attributable status without prompting;
2. two successive updates prove stale success cannot satisfy a new head;
3. an intentionally injected defect fails and a repaired head succeeds;
4. bot authors, ready transitions, large diffs, cancellation, and service errors cannot omit or
   falsely green evidence;
5. exact check name and producer App ID are stable and app-bindable; and
6. plan limits, credits, or quota do not pace or omit required evidence; and
7. unchanged benchmark and transitive production inputs cannot fail because the execution
   environment changed.

CodeRabbit failed conditions 1, 2, and 6. Greptile later failed condition 6. Native CodSpeed
performance comparison failed condition 7. `CodSpeed policy` remains required because it is a
base-owned exact-head configuration validator rather than a shared-runner measurement.

## Failure handling

Missing, skipped, stale, quota-paced, or still-running output is an availability failure, not a
pass. Fix all findings from all producers in one repair head. A baseline update, ignore command,
thread dismissal, admin bypass, or threshold relaxation is not a repair. If a hosted service loses
zero-cost continuity, remove it through a reviewed atomic branch-protection update while the OSS
core remains enforced.
