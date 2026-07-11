# ADR-0127: Product-wide authority and autonomy model

## Status

Accepted (2026-07-10).

ADR-0127 was allocated after refreshing `origin/dev` and checking all open pull requests on
2026-07-10. `origin/dev` ended at ADR-0126 and no open pull request claimed ADR-0127.

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

### D3 — Hard denials stay mode-independent

Invalid or expired authority, workspace escape, denied sensitive paths, secret exfiltration
(including stored connector credentials and tokens), unsupported actions, exhausted budgets, and
platform restrictions fail closed in every mode, on every surface.

### D4 — Delivery stays separately human-approved

Commit, push, pull-request creation, merge, and authority widening remain separately
human-approved delivery actions in all modes, unchanged from the human-control invariant.

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
- `AGENTS.md` — human-control invariant and the three user-facing modes.
