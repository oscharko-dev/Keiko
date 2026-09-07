# ADR-0129: Product-wide authority and autonomy model

## Status

Accepted (2026-07-10; renumbered to 0129 on 2026-07-11 during epic integration).

> **Amended by [ADR-0138](ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md).**
> Display labels become **Ask for approval**, **Supervised workspace**, and **Full access**, and the
> shared policy matrix is replaced by ADR-0138's total monotonic matrix. The three machine values,
> product-wide adoption rule, hard denials, and delivery contract remain unchanged.

This record was first drafted as ADR-0127. During integration of Epic #2238, `origin/dev` had
advanced to include ADR-0127 (editor Git reads, diff rendering, and conflict-editing semantics,
Epic #2093) and the connector ADR-0128 from this epic. To avoid a number collision it was renumbered
to ADR-0129 — the next free number after refreshing `origin/dev` and checking all open pull requests
on 2026-07-11 — with no change to its decision content. Existing ADR numbers were not renumbered.

## Amends

This decision extends the scope of
[ADR-0124](ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md) and
[ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md) from the Coding Workbench and
editor surfaces to the whole product. It does not change any mode semantics, policy-matrix entry,
Authority Envelope field, budget rule, or hard denial that those records define. Where older
records still carry pre-three-mode, per-action-approval framing, ADR-0125 already stamped the
affected decisions (ADR-0058, ADR-0059, ADR-0060, ADR-0061, ADR-0062, ADR-0124); this record adds
no further supersessions.

## Context

ADR-0124 defined the three Coding Workbench autonomy modes (`governed-assist`,
`supervised-coding`, `autonomous-delivery`), the fail-closed deployment ceiling, and the Authority
Envelope. ADR-0125 docked those modes into the editor as **Ask for approval**, **Approve for me**,
and **Full access**, replaced the stale read-mostly and per-patch-review assumptions, and
established the shared mode/resource/risk policy matrix with tri-state dispositions.

Keiko's original posture restricted almost every autonomous action behind per-action approval.
Pilot deployments with customers and feedback from open-source users showed that this posture made
the product impractical: users could not delegate bounded work without constant interruption. The
maintainers decided that the three-mode model is the product's authority model, not an
editor-local convenience.

Keiko is growing autonomy-capable surfaces beyond coding: connectors to external systems
(issue trackers, wikis, source control), knowledge ingestion and refresh, browser and
documentation capture, memory operations, and workflows. Without one binding rule, each new
surface would invent its own approval vocabulary and envelope semantics — exactly the policy drift
at trust boundaries that ADR-0124 was written to prevent inside the Coding Workbench.

## Decision

### D1 — The three modes are the product-wide authority model

Every autonomy-capable surface in Keiko — current and future — is governed by the three modes
defined in ADR-0124 and corrected by ADR-0125, displayed as **Ask for approval**
(`governed-assist`), **Approve for me** (`supervised-coding`), and **Full access**
(`autonomous-delivery`). No surface may introduce an additional user-facing autonomy mode, a
surface-local approval envelope, or a parallel authority stack.

### D2 — One policy vocabulary, mapped through action classes

A surface expresses its operations as action or effect classes that map onto the shared workbench
policy vocabulary in `@oscharko-dev/keiko-contracts` (action classes, resource scopes, approval
risk, connector scopes, network modes), following the mapping pattern ADR-0125 established for the
editor agent. Dispositions remain tri-state (`allowed`, `review-required`, `denied`), are derived
from the central mode/resource/risk matrix, and compose with surface-specific baseline decisions
using stricter-wins. Genuinely new action classes are added to the shared contracts with an ADR
note; they are never declared surface-locally.

### D2a — The agent repository facade is an admission layer, not new Git authority

The typed agent repository facade applies this product-wide ceiling before it delegates an
operation: reads and previews remain available in every mode; workspace-contained executes require
at least `supervised-coding`; remote delivery executes (fetch, pull, push, pull request, merge) are
approval-required at every risk tier in every mode under ADR-0138 D2's total matrix, including
`autonomous-delivery` — reaching that mode alone never admits a delivery execute through this
facade, which has no approval channel of its own, so `approval-required` reads as inadmissible here
regardless of mode. A missing or invalid ceiling fails closed to `governed-assist`. Admission runs
before idempotency reservation or delegation, so a denied request cannot mutate the repository or
occupy a replay slot.

**Correction (KEIKO-0227, 2026-08-15).** This paragraph previously read "remote delivery executes
require `autonomous-delivery`," describing an independently-maintained threshold that admitted
delivery outright once that mode was reached, with no approval channel — consistent with neither
ADR-0138 D2's matrix (delivery is approval-required at every mode, including autonomous-delivery)
nor D4 below (delivery remains a separately governed action; ADR-0087 requires an explicit,
approval-gated merge). The facade's admission now derives from the same shared
`CODING_WORKBENCH_MODE_POLICIES` table D4 and ADR-0087 already govern, rather than an independently
maintained one; the text above reflects that convergence rather than the threshold it replaced.

The facade grants no shell, provider, credential, or Git execution authority of its own. An
admitted request still traverses the existing Git read or governed-delivery route and remains
subject to its Authority Envelope, policy pack, approval, preflight, workspace containment, and
mode-independent hard denials. The facade may narrow those authorities; it may never bypass or
widen them.

### D3 — Hard denials stay mode-independent

Invalid or expired authority, workspace escape, denied sensitive paths, secret exfiltration
(including stored connector credentials and tokens), unsupported actions, exhausted budgets, and
platform restrictions fail closed in every mode, on every surface.

### D4 — Delivery follows the governing deployment contract

Product delivery and authority widening remain separately governed delivery actions. For Keiko
repository work targeting `dev`, ADR-0135 supersedes the former per-action human approval rule:
accepted task authority permits branch commits, pushes, and pull-request updates, while the direct
app-bound required checks authorize GitHub native auto-merge. Direct pushes
to `dev`, force pushes, gate bypasses, and authority widening remain denied or separately approved.

This `dev` rule governs how agents contribute accepted work to the Keiko repository. It does not
add autonomous or background auto-merge scheduling to Keiko's end-user Governed Merge Gateway.
That product feature remains governed by ADR-0087: merge is an explicit, approval-gated action and
auto-merge scheduling is out of scope.

For an accepted end-user Code task in Full access, the validated live Authority Envelope may also
authorize the task's separate commit, push, and draft-pull-request execute calls without minting a
local-operator approval for each action. The execution service passes the existing
`{ required: false }` policy requirement to the Git kernel only while the exact capability,
workspace binding, action classes, connector scopes, deployment ceiling, and expiry all remain
valid. Ask for approval and Supervised workspace retain their exact, one-use operator approvals.
This narrow Code-task path does not apply to merge.

### D5 — Vocabulary home and naming

The machine vocabulary keeps its current home and module naming in
`@oscharko-dev/keiko-contracts` (the `coding-workbench` contract family). Rehoming or renaming to
a workload-neutral module is a cosmetic follow-up that requires its own ADR because it changes the
public package surface; until then, non-coding surfaces import the existing vocabulary. Semantics
defined here and in ADR-0124/ADR-0125 take precedence over module naming.

### D6 — Forward rule for decision records

New ADRs and epics for autonomy-capable surfaces must cite this record and document their
action-class mapping onto the shared vocabulary. Where a pre-three-mode record conflicts with this
model and is not already stamped, the conflicting part is treated as legacy and must be stamped
with the existing supersession convention before the new surface ships.

## Consequences

- Users get one authority model everywhere: the mode they select means the same thing in the
  editor, in connectors, in knowledge operations, and in future surfaces.
- Reviewers get one enforcement path to audit; policy drift between surfaces becomes an
  architecture violation instead of a review-time discovery.
- The coding-flavored contract names serve non-coding surfaces until a dedicated rehoming ADR
  lands; this is accepted noise, bounded by D5.
- Extending the action-class vocabulary is deliberately heavier than declaring a local one; this
  is the intended cost that keeps the matrix reviewable.

## References

- [ADR-0124](ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md) — mode definitions,
  Authority Envelope, connector scopes, evidence rules.
- [ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md) — corrected mode semantics,
  policy matrix, editor docking, supersession of stale per-action-approval records.
- [ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md) — deterministic,
  human-free repository delivery to `dev` through bounded direct required checks.
- `AGENTS.md` — human-control invariant and the three user-facing modes.
