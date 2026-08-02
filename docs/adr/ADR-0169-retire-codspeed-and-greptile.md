# ADR-0169: Retire CodSpeed and Greptile

## Status

Accepted (owner decision, 2026-08-02). PR #2918 implements the retirement.

## Supersedes and amends

This decision supersedes every active CodSpeed and Greptile decision in ADR-0166, ADR-0167, and
ADR-0168. ADR-0168 D2 remains current for CodeRabbit. ADR-0167 remains current for the Qodo and
Keiko for Quality retirement, deterministic OSS gates, Sonar independence, and the zero-payment
boundary. This decision amends ADR-0135's required-check and reviewer topology.

## Context

Neither provider produced dependable merge evidence. Greptile exhausted trial credits, omitted
current-head review, and never obtained a durable zero-cost entitlement. Its useful output was
therefore opportunistic while its configuration, inventory, tests, and operational rules remained
permanent repository surface.

CodSpeed reported materially different regressions for unchanged benchmark inputs on shared GitHub
runners. Its native result could not distinguish candidate cost from runner provenance and was made
advisory. The remaining required `CodSpeed policy` job measured no product behavior; it only compared
repository policy with hosted settings.

That policy job also pinned the complete workflow tree and its own validator scripts to protected-base
Git object IDs. Any legitimate change to those files therefore caused the job to reject the pull
request that contained its repair. PR #2918 demonstrated the resulting self-deadlock. More migration
machinery around a signal with no merge value would increase risk without increasing assurance.

The owner uninstalled both GitHub Apps before this repository change. CodeRabbit, Socket Security,
and SonarCloud remain installed.

## Decision

### D1 — Remove both provider integrations completely

Delete the CodSpeed workflows, dashboard policy, CLI manifest, benchmark harness, validator,
contract, tests, package commands, and scanner exceptions. Delete the Greptile configuration,
governance inventory, validation, tests, and suppression commands. No dormant config, disabled
workflow, placeholder script, provider token, or pending installation request remains.

Historical ADRs and canary evidence continue to record why the integrations were evaluated and
retired. They are not active configuration.

### D2 — Keep performance enforcement deterministic and repository-owned

CodSpeed is not replaced by another hosted microbenchmark status. Merge authority remains with the
existing deterministic bundle budgets, retrieval and context quality gates, latency checks,
affected end-to-end tests, coverage ratchets, architecture checks, and D12 reference-environment
evidence. These gates answer reproducible questions in their documented reference environments.

### D3 — Keep CodeRabbit supplemental and retain ten required checks

CodeRabbit remains quota-tolerant supplemental review. Its provider status is not required. Every
inline finding it emits must be repaired, and GitHub's required conversation-resolution rule blocks
merge until the conversation is resolved. No human approving review is introduced.

The stable App-bound required set contains exactly ten checks:

1. `ci`
2. `workflow hygiene`
3. `Analyze (actions)`
4. `Analyze (javascript-typescript)`
5. `Build, scan, SBOM, smoke`
6. `Review dependency diff (dev/main)`
7. `ui`
8. `SonarCloud Code Analysis`
9. `Socket Security: Project Report`
10. `Socket Security: Pull Request Alerts`

The obsolete `CodSpeed policy` context is removed permanently. No Greptile or CodSpeed context may
satisfy or block delivery.

### D4 — Quality-gate code evolves through ordinary tested pull requests

Repository gate code must carry positive and negative regression tests and pass the same required
matrix as product code. A gate must not byte-pin the complete workflow tree or its own changeable
implementation and then require that pin to approve its repair. Exact-head binding, App identity,
least privilege, redacted evidence, and fail-closed evaluation remain mandatory; self-deadlocking
implementation equality is not a quality guarantee.

### D5 — Retire the already self-locked context in one bounded cutover

The protected-base implementation predates this decision and cannot approve deletion of its own
workflow and validator. After every other required check passes on the exact signed PR #2918 head
and every review conversation is resolved, remove only `CodSpeed policy` from `dev` branch
protection and let GitHub native auto-merge integrate that same head. Do not push directly to `dev`,
force-push, dismiss a finding, or bypass any remaining check.

After merge, verify that branch protection contains the exact ten-check set in D3 and that a fresh
pull request runs every required check without a missing or pending retired context. The removed
context is not restored; this is provider retirement, not a temporary gate bypass.

## Consequences

- Shared-runner variance and provider quota can no longer block or falsely satisfy delivery.
- The repository loses an unreliable hosted dashboard and one opportunistic reviewer, but loses no
  reproducible merge evidence.
- The required surface is smaller, deterministic, and free of the self-referential policy workflow.
- CodeRabbit findings, Sonar, Socket, coverage, secret, clone, architecture, and deterministic
  performance gates retain their existing authority.
- Future hosted providers require a new ADR and live negative/recovery evidence before installation;
  no popularity manipulation, payment workaround, or speculative dormant integration is accepted.

## References

- [PR #2918](https://github.com/oscharko-dev/Keiko/pull/2918)
- [ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md)
- [ADR-0166](ADR-0166-codspeed-and-greptile-quality-signals.md)
- [ADR-0167](ADR-0167-zero-cost-autonomous-quality-gates.md)
- [ADR-0168](ADR-0168-quota-tolerant-review-settlement.md)
- [Autonomous quality gates](../qa/autonomous-quality-gates.md)
- [External quality gates](../qa/external-quality-gates.md)
