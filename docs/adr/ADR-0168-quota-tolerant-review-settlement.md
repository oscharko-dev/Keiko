# ADR-0168: Quota-tolerant review settlement

## Status

Accepted (owner decision, 2026-08-01). Issue #2879 implements the correction. The authenticated
Greptile dashboard reported 14 days remaining in the no-payment trial when this decision was made;
the OSS entitlement application remains pending.

## Supersedes and amends

This decision supersedes ADR-0167 D2 where it disabled CodeRabbit's request-changes workflow, and
supersedes ADR-0167 D5 where it retired Greptile completely. It amends ADR-0135 and ADR-0166
accordingly. ADR-0167 continues to govern Qodo/KFQ retirement, zero-cost repository gates, Sonar
independence, CodSpeed policy, and the prohibition on payment, gate bypass, finding dismissal,
fabricated popularity, and threshold relaxation.

## Context

Keiko's autonomous delivery model needs independent semantic review in addition to deterministic
analysis. CodeRabbit and Greptile find different defects, but both providers can omit a review when
a free quota is exhausted. Making either provider's per-head status required turns vendor quota into
a repository-wide outage. Removing the bots entirely discards useful findings.

An actual inline review conversation is different from an absent provider result: it is concrete
evidence attached to the pull request. GitHub already protects `dev` with required conversation
resolution, and live PR #2878 proves that both Apps create native review threads. The safe boundary
is therefore conditional settlement: absence does not authorize or deny merge, while every emitted
inline finding blocks until genuinely repaired and resolved.

## Decision

### D1 — Restore Greptile without quota-dependent required statuses

Install Greptile App `867647` with access limited to `oscharko-dev/Keiko`. Restore `.greptile/` and
its deterministic drift validation. Greptile reviews pull requests targeting `dev` and every
subsequent head, excludes no authors, emits observable advisory status, writes no code, and does not
edit the pull-request description.

Neither `Greptile Review` nor a repository-owned settlement context is required. A base-owned gate
that demands review evidence would recreate the quota deadlock; a gate that passes before a late
review arrives would create a race. GitHub's native conversation-resolution rule instead remains
the merge authority for every Greptile inline finding. PR #2878 records Greptile-created review
threads and their resolved state without retaining finding bodies.

### D2 — Make every emitted CodeRabbit inline finding blocking

Configure CodeRabbit App `347564` with the assertive profile, automatic review for `dev`, incremental
review on every new push, no commit auto-pause, no excluded authors, and `request_changes_workflow:
true`. Keep CodeRabbit commit statuses, general review statuses, code-writing features, external web
search, cross-repository context, and pull-request-description summaries disabled. Description
mutation retriggers required CI without adding merge evidence.

CodeRabbit has no required provider status. If quota prevents a review, no absent result deadlocks
the pull request. If CodeRabbit opens a finding, its request-changes review and GitHub's required
conversation-resolution rule blocks native auto-merge. Every inline finding must be repaired and
every conversation resolved; review-body or summary-only output is advisory because GitHub gives it
no resolvable conversation. Request-changes state is informative because `dev` has no required
approving-review rule. GitHub cannot infer a repair from a resolved bit, so manual or bulk
resolution, ignore, dismissal, and bypass remain prohibited rather than accepted settlement.

### D3 — Keep deterministic evidence unconditionally required

The eleven existing App-bound checks remain required and exact-head bound. They cover repository
CI, workflow hygiene, CodeQL, build/SBOM/smoke, dependency review, UI, SonarCloud, Socket, and
CodSpeed policy. Bot availability never replaces or weakens those deterministic gates.

The repository's required `ci` context validates both bot configurations semantically: target
branch, update trigger, no auto-pause or author omission, governance context, and no code-writing
capability. The required, base-owned `CodSpeed policy` workflow independently evaluates only `dev`
pull requests and treats the exact candidate head as data. It rejects unapproved reviewer-policy
digests, incomplete or non-regular governance inventories, cascading Greptile rule/config files,
and pull-request metadata containing review-suppression or bulk-resolution commands. It reruns when
that metadata is edited and never executes a candidate validator.

The complete `.github/workflows` tree and every script this workflow executes are an immutable
interim trust anchor: their candidate Git object IDs and modes must equal the protected-base tree
and blobs. This prevents a second Actions job with the same required context from racing the
base-owned producer. Reviewer policies are likewise fixed at the approved digests until Keiko for
Quality replaces this bridge. A normal pull request therefore cannot first weaken the validator and
then approve a policy change on a later head. The initial installation is
necessarily a one-time bootstrap because the old base cannot execute a new `pull_request_target`
step; a separate post-merge negative/recovery canary must prove the installed base-owned boundary.
Native PR comments are not an event source for the eleven-check topology; reviewer pause/resolve
comments are therefore prohibited policy until a base-trusted Keiko for Quality settlement replaces
this interim boundary. Branch protection continues to require every review conversation to be
resolved.

### D4 — Preserve the zero-payment boundary and evaluate a durable OSS reviewer

No payment method, paid upgrade, star purchase, fabricated popularity, or license change is part of
this activation. Keiko is already public and Apache-2.0 licensed; the pending Greptile application
is an entitlement decision, not a source-license defect.

Hosted bots remain opportunistic supplemental reviewers. A separately reviewed pilot may add a
self-hosted open-source reviewer using an open-source runtime and local model, but it receives no
merge authority until its comment identity, head cadence, bounded runtime, and finding quality are
proven. Provider marketing claims or a free trial are not continuity evidence.

## Consequences

- CodeRabbit and Greptile both inspect every eligible update when their free quota is available.
- Quota exhaustion cannot create a missing required check or halt autonomous delivery.
- Every actual inline finding from either bot remains blocking through native review-thread settlement.
- The required set remains eleven App-bound checks; no probabilistic reviewer can falsely satisfy
  the deterministic quality bar.
- Hosted review stays replaceable, and the long-term path can be genuinely self-hosted OSS.

## References

- [Issue #2879](https://github.com/oscharko-dev/Keiko/issues/2879)
- [Autonomous quality gates](../qa/autonomous-quality-gates.md)
- [External quality-gate runbook](../qa/external-quality-gates.md)
- [Review settlement](../qa/review-settlement.md)
- [CodeRabbit automatic review controls](https://docs.coderabbit.ai/configuration/auto-review)
- [CodeRabbit configuration reference](https://docs.coderabbit.ai/reference/configuration)
