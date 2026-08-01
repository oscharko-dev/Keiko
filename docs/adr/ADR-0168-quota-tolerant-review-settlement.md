# ADR-0168: Quota-tolerant review settlement

## Status

Accepted and amended (owner decisions, 2026-08-01). Issue #2879 implements the reviewer correction.
The amendment corrects the CodSpeed failure semantics and replaces an absolute, self-locking
control-plane rule with a bounded owner-authorized migration protocol. The authenticated Greptile
dashboard reported 14 days remaining in the no-payment trial when this decision was made; the OSS
entitlement application remains pending.

## Supersedes and amends

This decision supersedes ADR-0167 D2 where it disabled CodeRabbit's request-changes workflow, and
supersedes ADR-0167 D5 where it retired Greptile completely. It also supersedes ADR-0167's CodSpeed
failure semantics where a 5% report was treated as a blocking native status despite the same
decision classifying shared-runner comparisons as advisory. It amends ADR-0135 and ADR-0166
accordingly. ADR-0167 continues to govern Qodo/KFQ retirement, zero-cost repository gates, Sonar
independence, and the prohibition on payment, finding dismissal, fabricated popularity, regression
acknowledgement, and threshold relaxation. ADR-0135's no-bypass rule remains the default; D3 defines
the only separately approved bootstrap for replacing a self-locking base-owned control plane.

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

Post-merge repair PR #2882 reproduced the CodSpeed defect on an exact head that changed only test
event isolation. Native check `91411267180` reported one large regression and one larger improvement
while warning that the runtime environments differed. The immediately preceding `dev` baseline
check `91408944235` had failed a different unchanged benchmark with the same environment warning.
All deterministic performance and required checks passed. Because the optional native failure left
the pull request `UNSTABLE`, GitHub also rejected a late auto-merge request despite all eleven
required checks being green. The blocking dashboard setting therefore contradicts the already
advisory status assigned by ADR-0167 and can impede delivery without reproducible candidate evidence.

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

### D3 — Keep deterministic evidence required and the control plane changeable

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

CodSpeed retains a 5% regression threshold and an always-updated pull-request report. Its native
comparison is informational when the threshold is exceeded: repository policy sets
`failOnRegression: false`, and the live project must set `informationalCheckOnFailure: true`.
This does not relax the threshold or acknowledge a regression. It preserves the 5% signal while
preventing a shared-runner comparison, including one that reports different runtime environments,
from becoming merge authority. Required deterministic performance, bundle, retrieval, and latency
gates remain blocking. The required `CodSpeed policy` context validates this exact combination and
fails if the threshold, report cadence, or informational failure mode drifts.

For ordinary pull requests, the complete `.github/workflows` tree and every script executed by the
base-owned policy workflow remain protected-base trust anchors: candidate Git object IDs and modes
must equal the protected-base tree and blobs. Reviewer policies likewise remain fixed at approved
digests. A candidate therefore cannot weaken a validator, approve its own policy, or race the
base-owned producer with a same-named Actions job.

Absolute immutability is not a valid lifecycle rule because it makes a defective control plane
impossible to repair through the delivery process it governs. A trust-anchor migration is therefore
allowed only through this protocol:

1. An accepted ADR identifies the defect, desired invariant, exact paths, rollback, and canary.
2. The migration is isolated on a signed non-`dev` branch. All unaffected required checks must pass
   on the exact head, all review conversations must be resolved, and local required gates must pass.
3. The old base-owned check must fail only for the documented old contract or protected-anchor
   difference. Any additional failure blocks the migration.
4. Immediately before changing branch protection, the owner separately authorizes the exact target
   head and bounded transition. An ADR alone is not that operational authorization.
5. Before changing the required set, every unrelated open pull request targeting `dev` is frozen:
   native auto-merge is disabled and the owner verifies that none can merge during the transition.
   The obsolete self-locking context may then be removed only for the exact migration. No direct push
   to `dev`, force push, finding dismissal, regression acknowledgement, threshold relaxation, or
   unrelated merge is permitted. Native auto-merge integrates only the recorded migration head after
   every remaining requirement succeeds.
6. As soon as the merge commit becomes the protected base, the updated base-owned context is restored
   to the required set. A negative head must prove self-authorization is rejected; a byte-restored
   recovery head must pass. Immutable heads and check/job identifiers are recorded without finding
   bodies.
7. Before integration, a changed candidate head, an unrelated pull request that cannot be frozen, a
   second mergeable pull request, or a non-atomic transition restores the complete recorded
   required-context set and stops the migration.
8. After integration, any restoration or validation failure freezes all `dev` delivery. Recovery
   requires separate owner authorization bound to one signed exact-head revert or repair branch; it
   follows this same bounded transition and never uses a direct push. Recovery is complete only when
   branch protection contains the recorded eleven App-bound contexts with their expected producers,
   every base-owned check passes from the new protected base, and the negative and byte-restored
   recovery heads prove rejection and recovery. The canary must cover post-merge restoration failure,
   wrong-head authorization, an incomplete required-context set, and a failing base-owned check. If
   those conditions cannot be validated, delivery remains blocked and the required set must not be
   weakened or rebound to an obsolete self-locking implementation.

The steady-state protected set remains eleven App-bound checks. Native PR comments are not an event
source for that topology; reviewer pause/resolve comments are therefore prohibited policy until a
base-trusted Keiko for Quality settlement replaces this interim boundary. Branch protection
continues to require every review conversation to be resolved.

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
- CodSpeed continues to report changes against the 5% threshold, but shared-runner variance cannot
  produce a blocking native status.
- Normal pull requests cannot rewrite their own base-owned gate. A defective trust anchor can be
  replaced only through an exact-head, separately authorized, reversible migration with a live
  negative-and-recovery proof.
- Hosted review stays replaceable, and the long-term path can be genuinely self-hosted OSS.

## References

- [Issue #2879](https://github.com/oscharko-dev/Keiko/issues/2879)
- [Autonomous quality gates](../qa/autonomous-quality-gates.md)
- [External quality-gate runbook](../qa/external-quality-gates.md)
- [Review settlement](../qa/review-settlement.md)
- [CodeRabbit automatic review controls](https://docs.coderabbit.ai/configuration/auto-review)
- [CodeRabbit configuration reference](https://docs.coderabbit.ai/reference/configuration)
- [CodSpeed customization](https://codspeed.io/docs/features/customization)
- [CodSpeed benchmark variance](https://codspeed.io/docs/instruments/cpu/regression-causes)
