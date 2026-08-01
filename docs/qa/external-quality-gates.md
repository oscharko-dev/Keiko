# External quality-gate activation

This runbook separates repository-owned OSS enforcement from hosted supplemental services. A free
hosted entitlement is not called open-source software. Hosted checks become merge-critical only
after exact-head failure and recovery are proven and durable zero-cost continuity is verified. The
deterministic core remains usable when a hosted producer is unavailable.

## Repository-owned enforcement

- CodSpeed: `codspeed.yml`, `.codspeed-policy.json`, the repository benchmark, and separate
  benchmark/policy workflows provide CPU-simulation comparison plus base-trusted settings
  enforcement.
- CodeRabbit: `.coderabbit.yaml` configures assertive review on every `dev` pull request and push,
  with request-changes settlement for emitted findings but no required provider status.
- Greptile: `.greptile/` configures high-signal logic/syntax review on every eligible `dev` head,
  with no excluded authors, code-writing, or required provider status.
- Fallow: the root lockfile and `check:semantic-duplication` reject every introduced semantic clone
  group.
- Gitleaks: the checksum pin in `.github/workflows/ci.yml` rejects secrets anywhere in pull-request
  history.
- Drift pin: required `ci` validates the parsed local policy, while the protected-base
  `CodSpeed policy` workflow validates exact-head reviewer controls, inventory, and pull-request
  metadata without executing candidate code. The complete workflow tree and its base-executed
  scripts are pinned to the protected-base Git object IDs and modes.

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

- CodSpeed: CPU simulation; regressions above the 5% global threshold remain visible through one
  always-updated pull-request report and an informational status; no repository upload token or
  pull-request-visible OIDC grant. The dedicated
  `CodSpeed policy` workflow is loaded from the protected `dev` base, preflights bounded exact-head
  policy, reviewer configuration, commit, and complete-tree data, and fails closed when the live
  threshold, failure behavior, report mode, reviewer approval digest, governance inventory, trust
  anchor, or PR metadata differs. Candidate code and candidate validators cannot execute in that
  workflow.
- CodeRabbit: assertive, automatic on `dev`, incremental on every push, and never auto-paused.
  Request-changes is enabled so actual inline findings remain blocking; commit and general review
  statuses remain disabled so quota omission cannot deadlock merge. PR-description summaries and
  all write/mutation, web-search, external-command, cross-repository, and post-merge features are
  disabled.
- Greptile: logic/syntax review at strictness 2, automatic on every eligible `dev` update, 500-file
  cap, one updated summary, observable advisory status, and native inline comments. Description
  mutation, code writing, draft review, and author exclusions are disabled.

Repository configuration overrides dashboard settings where the provider supports it.
Dashboard-only thresholds and entitlement state are verified in each activation audit.
Required `ci` semantically parses the complete reviewer policy. The protected-base policy job also
rejects policy drift, truncated trees, oversized controls, non-regular governance paths, nested
cascading controls, trust-anchor mutation, and pull-request metadata that asks either bot to ignore, pause, or
bulk resolve review. It reruns on pull-request metadata edits and logs only redacted reason codes.
The interim reviewer policy, complete workflow tree, and base-executed script anchors are immutable
through normal pull requests until Keiko for Quality supersedes them; changing candidate policy and
validator together or adding a same-named Actions producer cannot self-approve. Comment commands
and manual thread resolution are forbidden by policy but
cannot be distinguished from a genuine repair by native conversation resolution; the future
base-trusted Keiko for Quality settlement owns that closure.

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
  provider-specific popularity floor. The pending OSS application has not yet granted a durable
  entitlement. The dashboard reported 14 trial days remaining on 2026-08-01 but also reported one
  author paused for insufficient credits. App `867647` was reinstalled as installation `150524978`
  with access limited to Keiko. Its review status is intentionally not protected; emitted inline
  conversations remain protected by GitHub's conversation-resolution rule.
- Socket remains active through its existing free GitHub App checks.
- SonarCloud remains on the Free plan. Issue #2874 tracks a non-destructive migration to the
  stronger free OSS plan.

Qodo and Keiko for Quality are retired and uninstalled. Qodo stopped after trial and its separate
OSS program required 100 stars. Popularity floors are vendor eligibility rules, not engineering
quality gates. Never buy, exchange, automate, or fabricate stars.

## Durable OSS reviewer path

The preferred pilot is
[Alibaba Open Code Review](https://github.com/alibaba/open-code-review) (Apache-2.0). Its CI
integration can run on pull-request updates, deterministically inventories and bundles changed
files, reviews bundles in parallel, emits structured findings, and posts valid findings through the
native GitHub Pull Request Review API. A custom provider can point at Ollama's local
OpenAI-compatible endpoint, so neither a hosted review subscription nor a model API is required.

That pilot is not activated by this change because a trustworthy deployment needs an isolated,
always-available self-hosted runner and a qualified local model endpoint. Public pull-request code
is hostile input: the base-owned workflow may read it for review but must never execute it, and its
comment token must be ephemeral and least-privilege. The pilot remains supplemental until latency,
coverage, prompt-injection containment, thread identity, update cadence, and finding precision pass
a live negative/recovery canary.

[PR-Agent](https://github.com/The-PR-Agent/pr-agent) (MIT) is the mature fallback; it supports
GitHub Actions, update reviews, and Ollama through LiteLLM. Open Code Review is preferred because its
deterministic file inventory, isolated parallel bundles, positioning pass, and reflection pass fit
Keiko's complete-surface review requirement more directly.

Two hosted options are not promoted into the OSS foundation:

- [Sourcery](https://github.com/sourcery-ai/sourcery) is immediately free for public repositories
  without a documented star floor, but its hosted reviewer and model execution remain vendor
  services. It can be evaluated only under the same quota-tolerant thread-settlement policy.
- diffray advertises unlimited free reviews for public OSI-licensed repositories without an
  application, but its published Terms also state that access requires payment after a 14-day
  trial. That contradiction must be resolved in writing before installation.

## Redacted live evidence ledger

Evidence is identified by immutable head, check/job identifier, timestamp, App ID, and outcome.
Service endpoints and comment bodies are deliberately omitted.

- CodeRabbit, App 347564, is not protected. It requested changes on
  `e3c89ce0eb5a77f44a4d8115be261160709a22d0` at 05:53:59 UTC and found three additional issues on
  `418aca9d78d9f9c8c3e1ac7d83696923e5c849bc` at 06:39:26 UTC. On
  `fc56da5acd526cbd6408a47b08793d25024d4e1d` it reported the review limit reached while emitting
  success. Branch protection removed its status and quota-dependent review authority.
- PR #2878 contains three native `greptile-apps` review threads and eight native `coderabbitai`
  review threads; all eleven are resolved. This proves GitHub conversation resolution can enforce
  emitted findings without requiring either quota-dependent provider status.
- `CodSpeed Performance Analysis`, App 257293, failed deliberate slowdown head
  `1069aa9a7a75d7e3e19489a197af4671402de3a0` with a 51.48% aggregate regression in check
  91357704565, then passed restored head `d86f64250b226e815d66756f31b17e2e79f8c502` in check 91359719104. No regression was acknowledged and no baseline was changed.
- `CodSpeed policy`, GitHub Actions App 15368, rejected the candidate 10% drift in job 91356603600
  and accepted the restored 5% policy in job 91358992913.
- PR #2702 proves that App binding alone does not identify an Actions producer. On exact head
  `3c52db4e2ba09accd8a5ef064810072e0f31ea4c`, App 15368 emitted two
  `Analyze (javascript-typescript)` checks: job 89678420586 failed, job 89678489596 later succeeded,
  and the pull request merged. The base reviewer gate therefore pins the complete workflow-tree
  object ID; a candidate cannot add a later same-named `CodSpeed policy` producer.
- Later native CodSpeed checks 91361869877 and 91365139527 failed on heads that changed no benchmark
  or transitive production path. The first warned that runtime environments differed and reported
  multiple unrelated regressions; the second reported one unchanged benchmark 27.45% slower while
  another improved 7.3%. Both benchmark workflows succeeded. CodSpeed's own variance guidance says
  shared CI runner CPU, cache, and system-library differences can create regressions without code
  changes. The native performance status was removed from branch protection without acknowledging a
  regression, changing a baseline, or changing the 5% threshold. It remains advisory. ADR-0168
  subsequently requires the live failure status itself to be informational so runner variance
  cannot leave an otherwise mergeable pull request `UNSTABLE`.
- Greptile's native App 867647 and settlement context temporarily proved negative and recovery
  behavior. Native check 91356606358 and settlement job 91356603731 rejected the deliberate head
  with three P1 findings. Native check 91358998906 and settlement job 91358992919 passed the
  restored head with zero unresolved Greptile findings.
- On later exact head `b56de3aedc364a2ac6f5aa34a06ac5b6ba932efc`, Greptile omitted review after its trial account hit
  the 50-credit cap. The former settlement context failed rather than accepting stale evidence. Its
  required contexts and installation `150407338` were removed. ADR-0168 later restored App access as
  installation `150524978` under quota-tolerant settlement: no Greptile context is protected, actual
  inline findings remain blocking, and the protected set remains 11 App-bound checks.
- The retired `Keiko for Quality` context was removed after its producer had been deleted. Qodo and
  Keiko for Quality were uninstalled after PR #2876 merged; organization installation verification
  returned no remaining installation for either App.

Greptile is active only as a quota-tolerant supplemental reviewer. A durable zero-cost entitlement
would justify a new availability canary, but no provider status becomes required merely because the
application succeeds.

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

CodeRabbit failed conditions 1, 2, and 6. Greptile later failed condition 6. Both therefore remain
outside branch protection while their actual review threads are conditionally blocking. Native
CodSpeed performance comparison failed condition 7. `CodSpeed policy` remains required because it
is a base-owned exact-head configuration validator rather than a shared-runner measurement.

## Failure handling

Missing, skipped, stale, quota-paced, or still-running output from a required producer is an
availability failure, not a pass. Quota-paced review bots have no required provider context; absence
is neither evidence nor a blocker. Fix all findings they do emit in one repair head. A baseline
update, ignore command, bulk resolution, thread dismissal, admin bypass, or threshold relaxation is
not a repair.
