# ADR-0176: Retire Keiko for Quality

## Status

Accepted (owner decision, 2026-09-13).

## Supersedes and amends

This decision supersedes [ADR-0170](ADR-0170-keiko-for-quality-as-an-external-reviewer.md) in full
and closes the reviewer surface it reintroduced. It amends
[ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md) by removing the bounded
auto-merge arming interlock that ADR-0170 D5 added to it.

ADR-0167 remains current for the Qodo retirement, the deterministic OSS gates, Sonar independence,
and the zero-payment boundary. ADR-0168 D2 remains current for CodeRabbit. ADR-0169 remains current
in full: its ten App-bound required checks are unchanged by this decision, and its D4 prohibition on
self-approving pins is untouched. ADR-0142 and ADR-0143 stay Superseded historical context.

## Context

Keiko for Quality is Keiko's own review bot. ADR-0170 adopted it here as an external, SHA-pinned
product consumed by a `pull_request_target` workflow, deliberately publishing **no** required status
context: its findings blocked only through GitHub's conversation-resolution rule.

The workflow has been disabled since 2026-08-16. For four weeks this repository therefore carried a
reviewer that ran on nothing, while still holding a consumer workflow, a review profile, three
repository variables, a protected environment, two repository secrets, five environment secrets, and
a bounded arming interlock written into the delivery rules that every agent reads.

That gap is not cosmetic. `vars.KEIKO_QUALITY_ENABLED` read `true` while the workflow was
`disabled_manually`, so the documented activation condition and the observable behaviour disagreed:
AGENTS.md and CONTRIBUTING.md instructed a delivering agent to wait for, and on expiry to cancel, a
run that could never start. Governance text describing a reviewer that does not run is worse than no
text at all, because it is followed.

The product is not abandoned. It is being rebuilt as a capability inside Keiko rather than consumed
as an external reviewer of Keiko's own repository. Reintroducing it later is a new decision with its
own trust analysis, not a revival of this configuration.

## Decision

### D1 — Remove the consumer surface completely

The consumer workflow (`.github/workflows/keiko-for-quality.yml`), the review profile
(`.github/keiko-for-quality.json`), its workflow test suite, its activation record, its operator
runbook, and its cost model are deleted. The `KEIKO_QUALITY_ENABLED`, `KEIKO_QUALITY_MODEL_ID`, and
`KEIKO_QUALITY_MODEL_PROTOCOL` repository variables are removed. No file, gate, package command, or
documented procedure in this repository refers to the reviewer as an active producer.

### D2 — Remove the credentials and the protected environment

The repository secrets `KFQ_APP_ID` and `KFQ_PRIVATE_KEY_PKCS8` and the `keiko-for-quality`
environment — with the App identity, model, and review-store signing secrets it scoped — are
deleted. A retired integration that keeps its credentials is a standing grant with no reviewed
consumer: the boundary ADR-0170 D3 relied on was the environment's protected-branches-only
deployment policy, and that boundary is only meaningful while something is entitled to cross it.

Removing the secrets does not uninstall the GitHub App that ADR-0170 D4 provisioned as the
findings-posting identity. Uninstalling it is an account-level action recorded here as a follow-up,
not something a repository change performs.

### D3 — The required-check set is unchanged

The reviewer published no required status, so its removal changes no protected context. The ten
App-bound required checks fixed by ADR-0169 D3 stand exactly as they are. Branch protection,
conversation-resolution blocking, and the ADR-0135 direct-check integration path are untouched.

### D4 — Review settlement keeps every remaining producer

CodeRabbit, SonarCloud, Socket, and the repository's own `ci` evidence remain the settlement
producers. The harvest window, the 10-minute agent reaction SLO, and the rule that no automation,
bulk action, timer, or dismissal resolves a review conversation are unchanged. Only the clauses that
waited on the retired reviewer are removed.

The prohibition on silently resolving a finding thread is **generalized rather than retired**: it
was written for this reviewer but is equally true for CodeRabbit, because a resolved thread is
invisible to duplicate suppression and the finding simply returns on the next push.

## Consequences

- No model-backed reviewer runs on a pull request in this repository. That is the honest state, and
  it is now what the documentation says.
- Review depth on a pull request rests on CodeRabbit plus the deterministic gates. Losing a second
  model-backed opinion is the accepted cost of not carrying a reviewer that does not run.
- The arming interlock disappears from the delivery rules, so auto-merge arming depends only on the
  required checks being green on the exact head and every review conversation being resolved.
- Reintroduction requires a new ADR, a new credential grant, and a fresh trust analysis.

## References

- [ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md)
- [ADR-0167](ADR-0167-zero-cost-autonomous-quality-gates.md)
- [ADR-0168](ADR-0168-quota-tolerant-review-settlement.md)
- [ADR-0169](ADR-0169-retire-codspeed-and-greptile.md)
- [ADR-0170](ADR-0170-keiko-for-quality-as-an-external-reviewer.md)
