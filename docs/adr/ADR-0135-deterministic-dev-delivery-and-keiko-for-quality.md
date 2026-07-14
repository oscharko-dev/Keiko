# ADR-0135: Deterministic `dev` delivery and Keiko for Quality

## Status

Accepted (maintainer decision, 2026-07-13).

## Amends

This decision narrowly amends the repository-delivery parts of
[ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md) and
[ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md). Their product runtime authority,
workspace containment, sensitive-path, secret-exfiltration, evidence-redaction, budget,
deployment-ceiling, and authority-widening decisions remain unchanged.

For Keiko repository work targeting `dev`, this record supersedes the requirement for a separate
human review and per-merge approval after a maintainer has accepted the task or epic and bounded its
delivery scope.

## Context

Keiko epics are implemented by autonomous agents as large integration pull requests. Requiring a
maintainer to review or manually merge every completed epic does not scale and duplicates evidence
already produced by independent quality products and repository gates.

A raw successful processing check is not sufficient. During the live PR #2357 probe, Gitar emitted
a successful check while its current dashboard comment still reported one unresolved finding. A
safe hands-free workflow therefore needs one independent, app-bound aggregate that validates the
exact current head, producer identities, findings, and stability of all constituent evidence before
GitHub may execute native auto-merge.

## Decision

### D1 — Accepted work receives a bounded repository delivery envelope

Once a maintainer accepts a task or epic for autonomous delivery, the assigned agent may create
commits, push its non-`dev` branch, create or update its pull request, and repair attributable review
or CI findings without a separate per-action approval. The authority is limited to the accepted
issue scope, its branch and pull request, repository budgets, and the current delivery attempt.

Direct pushes to `dev`, force pushes, history rewrites, gate bypasses, finding dismissal for the
purpose of obtaining green status, and authority widening remain denied. Work outside the accepted
scope requires a new or amended task authority.

### D2 — Every `dev` pull request is treated as a large epic integration

Every pull request targeting `dev` is reviewed as a potentially large, completed-epic integration,
regardless of observed file count. Executable production files, trust boundaries, migrations,
workflows, manifests, public contracts, and tests for critical behavior are reviewed before binary,
snapshot, lockfile, and generated evidence.

If a review product cannot inspect the complete executable and trust-boundary surface, it must
identify the unreviewed files and remain blocking. It must not issue a clean verdict by omission.

### D3 — Gitar owns the autonomous repair loop, not final merge authority

Gitar Auto-Apply is enabled for `dev` pull requests. It may push signed, non-force fix commits to the
pull-request branch for code-review findings and attributable CI failures, add deterministic
regression or boundary tests, and re-run review after every fix.

The repair loop remains bounded by Gitar's productive-strategy exhaustion and Keiko's explicit
failure policy. It may not run `gitar unblock`, dismiss findings to obtain a green result, weaken a
gate, push directly to `dev`, or merge a pull request whose current evidence is incomplete.

Gitar Auto-Approve and Auto-Merge are orchestration signals only. Gitar's documented auto-approval
evaluation is fail-open on internal evaluation errors and does not inspect CI status. Its approval
therefore never replaces the aggregate decision.

### D4 — `Keiko for Quality` is the sole final merge authority

The dedicated GitHub App and required check are both named `Keiko for Quality`. The app uses the
existing Keiko logo and is installed only on `oscharko-dev/Keiko` with checks write plus pull
request, issue/comment, and metadata read permissions. It receives no Contents, Actions,
Administration, or repository-secret access.

The check is emitted by an external runtime from a protected revision, never by pull-request code
or repository Actions. It remains pending or failed unless every required check is successful on
the exact current head and comes from its allowlisted GitHub App ID. It additionally validates the
current, parseable, zero-finding Gitar and Socket evidence and the complete SonarCloud, mutation,
coverage, security, dependency, architecture, build, UI, and release evidence contracts.

Missing, stale, skipped, neutral, cancelled, timed-out, unstable, differently produced,
unparseable, or non-zero-finding evidence is blocking. A new commit invalidates every prior
aggregate result.

### D5 — GitHub native auto-merge performs the integration

After Gitar has a clean current-head review, it may arm GitHub native auto-merge. GitHub may execute
the signed squash merge only after branch protection reports `Keiko for Quality` and every direct
required check successful, the branch is current with `dev`, and every review conversation is
resolved.

No independent human review, approving review count, final maintainer handoff, or manual merge
click is required. Administrators are subject to the same required checks and may not bypass the
aggregate. The platform deletes the merged feature branch and records the normal GitHub audit
trail.

### D6 — Deployment is an activation boundary

Auto-merge must not be enabled until the `Keiko for Quality` App has:

1. emitted its exact check name and stable App ID from the deployed external runtime;
2. failed every documented negative live probe, including stale head, wrong producer, missing/red
   check, Sonar threshold failure, Gitar finding, Socket warning, and mutation failure;
3. passed a complete positive current-head probe; and
4. been added to `dev` branch protection as an app-bound required check with administrator
   enforcement.

Until those conditions are satisfied, autonomous repair may run but automatic merge remains
disabled. This is a credential and deployment prerequisite, not a human review gate.

### D7 — Webhooks accelerate evaluation; scheduled reconciliation guarantees liveness

GitHub webhooks provide immediate evaluation but are not a single point of liveness. The external
runtime must also reconcile all open pull requests targeting `dev` on a bounded schedule by
resolving the exact repository installation with App authentication. It combines discovered pull
requests with its metadata-only tracked set and evaluates each pull request once per sweep.

Duplicate and replayed webhook deliveries remain rejected. Missing or delayed delivery cannot
leave a new pull request permanently without `Keiko for Quality`; the next reconciliation creates
or updates the app-bound check. Reconciliation must retain the same exact-head, producer-ID,
pagination, redaction, and fail-closed rules as event-driven evaluation. It must not continuously
rewrite an unchanged dashboard comment or create a webhook feedback loop.

## Consequences

- Maintainers authorize the task boundary once instead of reviewing or merging each completed PR.
- Agents and Gitar can iterate until all deterministic gates are green without human intervention.
- A compromised or fail-open constituent product cannot independently merge because `Keiko for
  Quality` validates its current evidence and producer identity.
- The external App deployment and credentials become critical infrastructure and require redacted,
  least-privilege operational handling.
- Webhook failures degrade evaluation latency to the bounded reconciliation interval rather than
  blocking every new `dev` pull request indefinitely.
- A blocked or exhausted repair loop leaves the PR open and red; it never broadens authority or
  bypasses evidence.

## References

- [Keiko for Quality policy](../qa/keiko-for-quality.md)
- [Gitar review policy](../qa/gitar-review-policy.md)
- [ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md)
- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md)
