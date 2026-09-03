# ADR-0135: Deterministic `dev` delivery and bounded quality gates

## Status

Accepted (maintainer decision, 2026-07-13); operationally amended after the 2026-07-14 liveness
incident; amended 2026-07-18 to adopt Qodo as the advisory review product in place of Gitar;
amended 2026-08-01 by ADR-0167 to retire Qodo/KFQ and adopt zero-cost autonomous gates; amended by
ADR-0168 for conditional CodeRabbit settlement; amended 2026-08-02 by ADR-0169 to retire
CodSpeed and Greptile and fix the protected set at ten checks; and amended 2026-08-02 by
[ADR-0170](ADR-0170-keiko-for-quality-as-an-external-reviewer.md), which reintroduces Keiko for
Quality as an external SHA-pinned reviewer and adds the bounded auto-merge arming interlock (D5)
to this decision's delivery rules; and amended 2026-09-03 so the PR Sonar check must analyze the
full candidate tree with the same cache posture as the `dev` push. The protected set is unchanged
by those amendments.

## Amends

This decision narrowly amends the repository-delivery parts of
[ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md) and
[ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md). Their product runtime authority,
workspace containment, sensitive-path, secret-exfiltration, evidence-redaction, budget,
deployment-ceiling, and authority-widening decisions remain unchanged.

For Keiko repository work targeting `dev`, this record supersedes the requirement for a separate
human review and per-merge approval after a maintainer has accepted the task or epic and bounded its
delivery scope.

This amendment is limited to Keiko's own contribution workflow: agents act on the assigned branch
and pull request, and GitHub branch protection performs repository integration. It does not amend
ADR-0087 or add native auto-merge scheduling to the Governed Merge Gateway that Keiko exposes to
end users for their target repositories.

## Context

Keiko epics are implemented by autonomous agents as large integration pull requests. Requiring a
maintainer to review or manually merge every completed epic does not scale and duplicates evidence
already produced by independent quality products and repository gates.

A raw successful processing check is not sufficient. During the live PR #2357 probe, Gitar emitted
a successful check while its dashboard still reported an unresolved finding. The initial response
was an external app-bound aggregate intended to validate every producer and current-head result.

The attempted aggregate activation then exposed the opposite risk. PR #2398 could not integrate
because Gitar stopped emitting a check under plan pacing, a full mutation run remained active for
hours, hosted-runner performance jitter failed the otherwise green UI job, and `Keiko for Quality`
reported terminal failure while inputs were still missing or running. PR #2441 could not repair the
aggregate through the same protection path it controlled. A gate that cannot reliably produce a
bounded decision is not a safe required gate; it is a repository-wide availability failure.

## Decision

### D1 — Accepted work receives a bounded repository delivery envelope

Once a maintainer accepts a task or epic for autonomous delivery, the assigned agent may create
commits, push its non-`dev` branch, create or update its pull request, and repair attributable review
or CI findings without a separate per-action approval. The authority is limited to the accepted
issue scope, its branch and pull request, repository budgets, and the current delivery attempt.

Direct pushes to `dev`, force pushes, history rewrites, unapproved gate bypasses, finding dismissal
for the purpose of obtaining green status, and authority widening remain denied. Work outside the
accepted scope requires a new or amended task authority.

### D2 — Every `dev` pull request is treated as a large epic integration

Every pull request targeting `dev` is reviewed as a potentially large, completed-epic integration,
regardless of observed file count. Executable production files, trust boundaries, migrations,
workflows, manifests, public contracts, and tests for critical behavior are reviewed before binary,
snapshot, lockfile, and generated evidence.

If a review product cannot inspect the complete executable and trust-boundary surface, it must
identify the unreviewed files. It must not issue a clean verdict by omission.

### D3 — Direct bounded checks own merge authority

Branch protection requires direct, exact-head checks whose producers are app-bound and whose
workloads are deterministic and bounded. The required set covers CI aggregation, action security,
CodeQL, build/SBOM/smoke, dependency review, UI functionality and accessibility, OSV, SonarQube
Cloud, and Socket Security. GitHub native auto-merge may integrate only after those checks succeed
and every review conversation is resolved.

No required check may depend on another required check to repair or publish itself. Missing or
pending required evidence remains blocking through GitHub's native semantics; it is never converted
to a terminal failure by a second aggregate.

An exact-head check is merge authority only when its analysis surface also represents the complete
candidate integration. In particular, the required Sonar run for a `dev` pull request disables the
target-branch sensor cache and proves full-project breadth from its own scanner log. A changed-files
or cache-restored PR analysis cannot authorize integration merely because the same workflow performs
a fresh scan after merge. This closes incident #3377, where an already-red `dev` was followed by a
green incremental PR verdict and another red post-merge scan.

On pull-request runs, every full-tree CI lane checks out the workflow run's immutable `github.sha`,
never the moving `refs/pull/<number>/merge` name. Manual runs instead bind the Sonar job and its
three coverage producers to `dev` as defined by ADR-0134 D3. Immediately after the trusted checkout
and Node setup, and before executing another repository command, each lane's direct consistency
script verifies that a pull-request checkout is clean and is a two-parent merge commit whose first
parent is the event's exact base SHA and whose second parent is its exact head SHA. Because the
candidate also controls the workflow and script, this assertion is not represented as an independent
trust boundary;
workflow review, CODEOWNERS, branch protection, and exact-current-head required checks own that
boundary. Repository branch protection keeps strict status checks enabled, so a concurrent `dev`
integration invalidates the old candidate and GitHub must produce and check a new one. Agent
instructions to inspect `dev` after their own merge are not a substitute for this pre-merge
invariant.

### D4 — Availability and runtime bounds are quality properties

A service or workflow can be required only if it emits a current-head check for every eligible pull
request without plan pacing, manual prompting, or a mutable dashboard contract. A required workflow
must also have a repository-owned timeout appropriate to the pull-request feedback loop.

Shared hosted-runner performance measurements are release evidence, not pull-request merge
evidence. They run with the documented ten-sample protocol after merge or on explicit release
lanes. Pull requests still require UI build, typecheck, lint, coverage and accessibility tests,
smoke E2E, editor E2E, package surface, and deterministic budget checks.

### D5 — Historical Qodo/KFQ topology (superseded)

The Qodo and Keiko for Quality topology below is retained only as historical decision context.
[ADR-0167](ADR-0167-zero-cost-autonomous-quality-gates.md) retires both products and replaces this
section's Qodo/KFQ activation state with repository-owned OSS gates. ADR-0169 retires CodSpeed and
Greptile. [ADR-0168](ADR-0168-quota-tolerant-review-settlement.md) continues to own CodeRabbit
settlement: it has no required provider status, while every emitted inline finding blocks until its
conversation is resolved.

The remainder of this D5 subsection describes the topology at the time of the original decision. It
is not current operating guidance, cannot satisfy branch protection, and must not be used to restore
any retired producer.

Qodo Code Review is the advisory review product. It is comment-only: it posts a single summary
review comment — the Bugs, Rule violations, and Requirement gaps counts — updated in place per head,
and never a check-run or a merge-authority approval. `Keiko for Quality` reads that comment, verifies
the producing GitHub App id on it (`performed_via_github_app`), and binds it to the head SHA embedded
in the comment body; missing, wrong-head, wrong-producer, or unparseable review evidence is treated
as absent. Qodo replaces Gitar, whose check-run once reported success while an unresolved finding
remained; Gitar stays installed and advisory only until Qodo proves green on live pull requests, then
is retired, and the swap changes no required check. `Keiko for Quality` may run as an advisory
external aggregate but remains non-required; its check and dashboard are not merge authority. Either
product may become required only after a live availability probe proves current-head emission,
bounded settlement, stable machine-readable evidence, and a failure mode that cannot deadlock its own
repair path.

Full mutation testing remains strict but runs daily and through explicit dispatch. Focused mutation
is a pre-publication tool for critical changes when its scope is tractable. The synchronous PR path
instead requires deterministic coverage ratchets, Sonar New Code analysis, architecture and sandbox
gates, security scans, and affected behavior/E2E tests. Mutation debt may never be hidden or lowered
to obtain green status.

### D6 — GitHub native auto-merge performs normal integration

After the direct required checks succeed on the exact current head, GitHub may execute the signed
squash merge. No independent human review, approving review count, final maintainer handoff, or
manual merge click is required. The platform deletes the merged feature branch and records the
normal GitHub audit trail.

### D7 — Maintainer break-glass restores the gate control plane only

An owner may explicitly authorize a temporary branch-protection repair when a required check is
proven unavailable, unbounded, or self-deadlocked. The recovery must preserve the independent direct
security and product-quality checks, record the exact removed context and incident evidence, and
land the durable workflow and policy correction through a normal pull request. Break-glass does not
authorize direct pushes to `dev`, force pushes, finding dismissal, or acceptance of an
uninvestigated product failure.

## Consequences

- Maintainers authorize the task boundary once instead of reviewing or merging each completed PR.
- Agents can iterate until deterministic direct gates are green without human intervention.
- External review and aggregate products can add evidence without becoming single points of
  repository-wide liveness failure.
- Full mutation and performance evidence remain strict on lanes whose runtime and environment fit
  those measurements.
- A blocked direct quality check leaves the PR open and red; an unavailable orchestration product
  does not masquerade as a product defect.
- Adding an external review product to branch protection requires explicit live availability and
  negative/positive activation evidence.
- ADR-0167 retires the historical Qodo/KFQ path; ADR-0168 owns current CodeRabbit settlement; and
  ADR-0169 retires CodSpeed and Greptile. No retired producer can satisfy a current gate.

## References

- [Autonomous quality-gate policy](../qa/autonomous-quality-gates.md)
- [Review standards](../qa/review-standards.md)
- [ADR-0167 zero-cost autonomous quality gates](ADR-0167-zero-cost-autonomous-quality-gates.md)
- [ADR-0168 quota-tolerant review settlement](ADR-0168-quota-tolerant-review-settlement.md)
- [ADR-0169 retire CodSpeed and Greptile](ADR-0169-retire-codspeed-and-greptile.md)
- [Mutation testing policy](../qa/mutation-testing.md)
- [ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md)
- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md)
