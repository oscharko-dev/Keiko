# ADR-0166: CodSpeed and Greptile quality signals

## Status

Superseded for activation and review topology by
[ADR-0167](ADR-0167-zero-cost-autonomous-quality-gates.md) on 2026-08-01. Its CodSpeed benchmark
design and general configuration boundaries remain adopted. ADR-0168 reactivates the Greptile
repository integration and makes emitted Greptile and CodeRabbit inline findings conditionally
blocking.

## Amends

This decision additively amends the repository-delivery boundary in
[ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md) and the measurement/verdict
separation in [ADR-0156](ADR-0156-measurement-and-verdict-separation.md). It does not change Keiko's
product runtime authority model or the D12 reference environment. Its original Qodo/KFQ topology and
required-check inventory are historical and superseded by ADR-0167.

## Context

Keiko already owns deterministic functional, security, architecture, coverage, package, browser,
and release-performance gates. Qodo and CodeRabbit also provide complementary code-review signals;
their different findings demonstrate that no single probabilistic reviewer is a complete oracle. Two
additional hosted products can close different gaps:

- CodSpeed compares stable algorithmic microbenchmarks across pull-request heads.
- Greptile performs codebase-aware review against repository-specific governance and architecture
  context.

Neither product is safe to make merge-critical merely because it can emit a status check.
ADR-0135 requires every protected context to prove exact-head emission, bounded settlement, stable
producer identity, and a repair path that cannot depend on the failing gate. Greptile is additionally
quota-dependent until its open-source entitlement is approved. CodSpeed begins without a `dev`
baseline, so its first pull request cannot yet prove comparison semantics.

## Decision

### D1 — CodSpeed measures synchronous production algorithms through CPU simulation

The repository owns one CodSpeed CLI manifest at `codspeed.yml` and one Node.js harness at
`benchmarks/codspeed.mjs`. Four separately named commands call public production entry points for
redaction, prompt-injection detection, context allocation, and editor text-edit application over
deterministic, secret-free fixtures. The action discovers the manifest directly, so the repository
does not install a telemetry-capable CodSpeed npm runtime into its dependency graph.

The `CodSpeed` workflow runs on every pull request targeting `dev`, every push to `dev`, and explicit
dispatch. It builds package entry points before measurement, uses CodSpeed CPU simulation, has a
20-minute timeout, persists no checkout credentials, and pins the action to a reviewed commit. The
public-repository upload path receives neither a long-lived token nor a pull-request-visible OIDC
grant.

CPU simulation measures repeatable synchronous algorithmic work. It does not measure browser
rendering, process startup, filesystem or network latency, memory growth, or user-perceived wall
clock. D12 reference-environment evidence, deterministic bundle budgets, retrieval latency, and
affected end-to-end performance gates retain their existing authority.

### D2 — Greptile design and retained CodeRabbit policy

ADR-0167 records the earlier Greptile rollback. ADR-0168 restores this design as current operating
guidance for the active no-payment trial and adds conditional CodeRabbit request-changes settlement.

The recommended `.greptile/` format is the source of repository review behavior. The root config:

- reviews every new ready-PR head targeting `dev`, including bot-authored pull requests;
- limits one review to 500 changed files, reports a status check, and updates one summary comment;
- focuses on `logic` and `syntax`, leaving formatting and style to deterministic repository gates;
- reads `AGENTS.md`, `CONTRIBUTING.md`, the shared `docs/qa/review-standards.md`, and the relevant ADR/quality
  policy rather than creating a second standards corpus;
- treats human control, fail-closed trust boundaries, redacted evidence, package direction,
  regression-pin integrity, and workflow supply-chain controls as high-severity review rules; and
- may suggest agent fixes but may not auto-approve, merge, edit the pull-request description, or
  recommend bypassing a gate.

Greptile remains independently observable so one review product cannot suppress or satisfy another
product's findings. Under ADR-0168, neither review bot has a required provider status, but every
inline finding emitted by either reviewer remains blocking through GitHub conversation resolution.

CodeRabbit's existing review role is now pinned by `.coderabbit.yaml` instead of mutable dashboard
defaults. It uses the assertive review profile, reviews every ready pull-request update, discloses
review details, and consumes the same repository governance and path-specific trust-boundary rules.
Untrusted web context, commands from non-organization members, automatic repository linking,
auto-approval, post-merge actions, and every code-writing finishing touch are disabled. ADR-0167
records the live quota/false-green evidence; ADR-0168 therefore keeps its status optional while
granting merge authority only to unresolved native inline conversations. Request-changes review
state is informative because `dev` does not require approving reviews.

### D3 — Repository configuration is required; hosted verdicts are staged

`npm run check:external-quality-config` is a deterministic required-`ci` configuration gate. It
originally pinned CodSpeed, CodeRabbit, and Greptile integration boundaries. ADR-0167 later retired
the Greptile integration after quota pacing; the current gate pins CodSpeed dependencies, action
identity, simulation mode, triggers, permissions, timeout, benchmark command, and the live-observed
5% failing-status dashboard policy, plus the semantically parsed CodeRabbit and Greptile review
policies, restricted commands, no-mutation boundaries, the reviewed Greptile context inventory, and
the prohibition on cascading nested Greptile controls. The same required lane rejects PR metadata
that suppresses either reviewer. It proves the retained repository-owned integrations have not
silently weakened. It does not claim that a hosted service ran.

The original staging decision kept hosted CodSpeed and Greptile checks outside branch protection
during initial observation. CodSpeed used a 5% global threshold and Greptile used a 4/5 dashboard
confidence floor; informational-on-failure and Greptile auto-approval were disabled. ADR-0167 records
the later live results: Greptile was removed, native CodSpeed comparison became advisory after
shared-runner variance, and the base-owned `CodSpeed policy` validator became required.

### D4 — Historical promotion standard retained and extended by ADR-0167

No CodSpeed or Greptile context may be added to `dev` branch protection until a follow-up change
records all of the following against live pull requests:

1. every eligible current head receives exactly one attributable check without manual prompting;
2. two successive head updates settle within the documented runtime bound and stale success cannot
   satisfy the new head;
3. an intentionally injected defect produces a failing verdict and its repair produces success;
4. forks, bot-authored pull requests, drafts becoming ready, large diffs, cancellation, and service
   errors cannot omit or falsely green the check;
5. the producer App ID and exact check name are stable and can be pinned by branch protection; and
6. plan limits, credits, or open-source eligibility cannot pace or omit required evidence.

Promotion is an explicit branch-protection change with an activation ledger and rollback path. A
service that cannot satisfy all six conditions stays advisory. ADR-0167 adds reproducible execution
provenance to this standard and records that Greptile and native CodSpeed comparison did not retain
required authority. No hosted-service acknowledgement is equivalent to fixing a regression, and
acknowledgement cannot be used to bypass a protected gate.

## Consequences

- Keiko retains advisory algorithmic performance comparisons without substituting noisy hosted
  execution for D12 evidence or deterministic pull-request budgets.
- Greptile supplies an independent review perspective during the active trial; Qodo and KFQ remain
  retired, while both active review bots conditionally block only findings they actually emit.
- The required `ci` context fails on integration drift even when a hosted vendor is unavailable.
- ADR-0168 preserves the current 11-context branch-protection set and owns review settlement.
- Greptile's OSS application remains pending; no payment method is introduced.

## References

- [External quality-gate runbook](../qa/external-quality-gates.md)
- [Keiko `dev` quality gates](../qa/autonomous-quality-gates.md)
- [CodSpeed GitHub Actions](https://codspeed.io/docs/integrations/ci/github-actions)
- [CodSpeed CLI](https://codspeed.io/docs/cli)
- [Greptile `.greptile/` configuration](https://www.greptile.com/docs/code-review/greptile-config)
