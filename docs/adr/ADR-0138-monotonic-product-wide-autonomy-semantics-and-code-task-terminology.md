# ADR-0138: Monotonic product-wide autonomy semantics and Code-task terminology

## Status

Accepted (Issue #2385, Epic #2384, 2026-07-16); capability-availability semantics clarified by
Issue #2857 (2026-07-31).

## Amends

This decision amends [ADR-0124](ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md),
[ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md), and
[ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md), and narrows the
`supervised-coding` disposition column of
[ADR-0128](ADR-0128-atlassian-connector-authority-and-security-design.md) D4. It replaces the
shared mode/resource/risk policy matrix defined in ADR-0125 D1 and adopted product-wide by
ADR-0129 D1/D2 with a total, monotonic matrix, renames one display label, and adopts the canonical
Code-task terminology register from Epic #2384. The three machine mode values, the fail-closed
effective-mode rule (ADR-0124 D2), the Authority Envelope contract (ADR-0124 D3), the
stricter-wins composition (ADR-0125 D1), the mode-independent hard denials (ADR-0129 D3), the
delivery contract (ADR-0129 D4, ADR-0135), and the server-owned runtime authority boundary
(ADR-0137) are unchanged.

## Context

ADR-0125 D1 fixed the shared mode policy matrix over the closed resource scopes
`workspace-contained`, `external-file`, `internet`, and `delivery` and the closed approval risks
`low`, `medium`, `high`, and `critical`. ADR-0129 made that matrix the product-wide authority
model, and ADR-0128 derived its connector disposition table from the matrix's `internet` row.

Epic #2384 (governed Code tasks with managed OpenCode and Codex runtimes) re-audited these
semantics and found two defects:

1. **The matrix is not monotonic in mode.** Under ADR-0125 D1, `governed-assist` allows
   workspace-contained work at every risk, while `supervised-coding` — a strictly higher authority
   posture — requires approval for high/critical workspace-contained work. Raising the mode can
   therefore make a fixed action stricter, which contradicts the product promise that the three
   postures form an ordered ladder of delegated authority and makes disposition tests and user
   expectations mode-order-dependent in the wrong direction.
2. **`supervised-coding` is too permissive outside the task workspace.** Allowing low/medium
   external-file and internet effects without approval does not match the middle posture's product
   meaning for Code tasks: routine contained edits, vetted commands, and verification proceed
   unattended, while anything that leaves the workspace or reaches the network asks first.

Separately, the runtime path around Code tasks has accumulated ambiguous vocabulary. "Sidecar"
has been used for a runtime artifact, a runtime process, a protocol adapter, and a host
composition, which are four different trust positions. Epic #2384 fixes a canonical terminology
register; this record adopts it as the decision-record vocabulary so later ADRs and contracts do
not re-diverge.

The display label **Approve for me** described the old middle-mode semantics ("Keiko approves
routine work on my behalf, everywhere below high risk"). Under the corrected matrix the middle
posture is workspace-scoped, so the label is renamed. The machine values are closed contract
values consumed across `keiko-contracts`, the editor-agent governance path, the connector lane,
and the coding-runtime authority service; they do not change.

## Decision

### D1 — Machine values stay; the middle display label becomes Supervised workspace

The shared machine vocabulary remains exactly:

- `governed-assist`, displayed as **Ask for approval**
- `supervised-coding`, displayed as **Supervised workspace** (renamed from **Approve for me**)
- `autonomous-delivery`, displayed as **Full access**

The machine values are closed contract values, not display copy; no call site, store, envelope,
evidence record, or wire payload changes. Display labels and mode descriptions remain contract
data in `CODING_WORKBENCH_MODE_POLICIES` in `@oscharko-dev/keiko-contracts`; this record changes
that data, not its home (ADR-0129 D5 unchanged). The user-facing meanings are:

- **Ask for approval** — reads and planning are allowed; edits, commands, network, dependency,
  and delivery effects require approval.
- **Supervised workspace** — routine contained edits, vetted commands, and verification are
  allowed; risky contained work and every external-file, internet, and delivery effect require
  approval.
- **Full access** — non-denied task-workspace, external-file, and internet effects may run
  unattended inside the validated Authority Envelope; delivery remains separately governed.

### D2 — One total, monotonic effect matrix

The complete mode/resource/risk matrix is replaced by the following total table. Effects remain
the closed tri-state `allowed`, `approval-required`, `denied` composed stricter-wins with every
independent gate exactly as before (ADR-0125 D1). Cells that change relative to ADR-0125 D1 are
marked.

| Mode | Resource scope | Low | Medium | High | Critical |
| --- | --- | --- | --- | --- | --- |
| `governed-assist` | `workspace-contained` | approval-required *(changed)* | approval-required *(changed)* | approval-required *(changed)* | approval-required *(changed)* |
| `governed-assist` | `external-file` | approval-required | approval-required | approval-required | approval-required |
| `governed-assist` | `internet` | approval-required | approval-required | approval-required | approval-required |
| `governed-assist` | `delivery` | approval-required | approval-required | approval-required | approval-required |
| `supervised-coding` | `workspace-contained` | allowed | allowed | approval-required | approval-required |
| `supervised-coding` | `external-file` | approval-required *(changed)* | approval-required *(changed)* | approval-required | approval-required |
| `supervised-coding` | `internet` | approval-required *(changed)* | approval-required *(changed)* | approval-required | approval-required |
| `supervised-coding` | `delivery` | approval-required | approval-required | approval-required | approval-required |
| `autonomous-delivery` | `workspace-contained` | allowed | allowed | allowed | allowed |
| `autonomous-delivery` | `external-file` | allowed | allowed | allowed | allowed |
| `autonomous-delivery` | `internet` | allowed | allowed | allowed | allowed |
| `autonomous-delivery` | `delivery` | approval-required | approval-required | approval-required | approval-required |

Summary of the delta: `governed-assist` workspace-contained becomes approval-required at every
risk; `supervised-coding` external-file and internet become approval-required at every risk; every
other cell is unchanged from ADR-0125 D1.

**Monotonicity invariant (normative and machine-tested):** with strictness ordered
`denied` > `approval-required` > `allowed` and modes ordered
`governed-assist` < `supervised-coding` < `autonomous-delivery`, for every fixed
(resource scope, risk) pair the matrix effect never becomes stricter as the mode rises. The shared
evaluator must be total over the closed enums and covered by an exhaustive test that asserts this
invariant over all 48 cells, so a future matrix edit cannot silently reintroduce an inversion.

**Fail-closed rule (unchanged in direction, restated for the total evaluator):** an unknown,
missing, or malformed mode value fails closed to `governed-assist`; an unknown resource scope or
risk value is rejected as `denied`. The effective mode remains the fail-closed minimum of
requested mode and deployment ceiling (ADR-0124 D2).

The matrix governs effectful actions only. It does not weaken any hard denial (ADR-0129 D3), any
Authority Envelope validation, budget, sensitive-path, or containment gate, or the separately
governed delivery path (ADR-0129 D4, ADR-0135): stricter-wins composition means an
`approval-required` or `allowed` cell can always be tightened, never loosened, by an independent
gate.

**Capability-availability clarification (Issue #2857):** a matrix disposition is the maximum
policy posture for an action that an implementing surface can already execute through a governed
capability. `allowed` does not create that capability, mount an executor, supply connector
credentials, or make a delivery substrate available. A missing or unsupported governed execution
path remains a mode-independent, fail-closed denial. In particular, the Unit-test, Bugfix-agent,
and managed OpenCode surfaces keep connector and delivery execution unavailable until they can
reuse an existing governed execution substrate with the same Authority Envelope validation,
policy composition, credential custody, confinement, cancellation, budgets, and body-free
evidence. They must not introduce a raw or parallel executor as a shortcut. This clarification
does not widen authority: D1 describes the maximum unattended posture inside a validated,
available capability, while independent availability and governance gates still compose
stricter-wins under D2.

### D3 — Product-wide impact of the corrected matrix

Because ADR-0129 D1 makes the matrix product-wide, this correction lands once, at the shared
matrix layer in `keiko-contracts`, and every consumer inherits it. The enumerated consumer impact
is:

1. **Editor-agent changesets (ADR-0125, partially superseded in D1).** `applyPatch` and
   `applyChangeset` map to `workspace-contained` mutation effects; in `governed-assist` they now
   compose to `review-required` and pass through the existing browser review mechanism before the
   server transaction can commit. ADR-0125 D1's statement that Ask for approval allows all
   workspace-contained risks is superseded; D2–D6 of ADR-0125 (docking, transaction, budgets,
   schema compatibility) are unchanged, and the review path they define is exactly the mechanism
   the new dispositions use. The explicit **Apply to editor** command, which already forced review
   under its derived Ask for approval authority, now agrees with the matrix instead of overriding
   it.
2. **Atlassian connector operations (ADR-0128 D4, narrowed).** The D4 disposition columns are
   derived from the shared `internet` row, so the **Supervised workspace** (`supervised-coding`)
   column is recomputed: rows 1, 2, 3, 5, 7, 9, and 10 (`sync-space`, `sync-project`,
   `search-issues-live`, `update-issue-fields`, `add-issue-comment`, `update-page`,
   `add-page-comment`) change from `allowed` to `review-required`; rows 4, 6, and 8 were already
   `review-required`. The **Ask for approval** and **Full access** columns are unchanged.
   ADR-0128's connector-scope gate, envelope admission, credential custody, egress, bounds,
   evidence, and risk tiers (D1–D3, D5–D8, and the D4 risk assignments) are unchanged; only the
   disposition derivation at the shared-matrix layer moves.
3. **Coding-runtime supervised action-kind admissions (consistent, no behavior change).** The
   supervised action kinds `file-edit` and `verification-command` map to `workspace-contained`
   effects at low/medium risk and therefore remain approval-free in `supervised-coding`. Before
   this record that outcome relied on the action-kind path; it now also matches the shared matrix,
   removing the divergence between the two evaluations. The server-owned runtime authority
   boundary (ADR-0137) is unaffected.
4. **Reads and planning never route through these approval classes.** Read and planning effect
   classes — including the editor `workspace-read` mapping from Issue #2298 (`queryGit`) and
   editor-state/context reads — are not mutation, command, network, or delivery effects and do not
   consume the matrix's approval-required cells. They remain envelope-gated, budget-charged, and
   sensitive-path-gated exactly as today. This preserves the Ask for approval meaning "reads and
   planning are allowed" without a special-case matrix row.

5. **Git Delivery admission (#3386, epic #3384 correction 5 — added after initial adoption).**
   `runBoundAuthority.authorizeGitDelivery` (`packages/keiko-server/src/gitDelivery/`) reads this
   matrix directly: a network-reaching operation (fetch/pull/push/pull-request/merge/commit)
   carries the `delivery` resource scope; every other Git operation
   (status/diff/branch-list/branch-create/branch-switch/stage/unstage) carries
   `workspace-contained`. `denied` maps to the pre-existing `mode-denied` reason (a hard denial;
   the matrix never actually returns `denied` for either scope, so this is a closed fallback, not
   a live path); `approval-required` maps to a dedicated `approval-required` denial reason,
   redeemable by the caller through a one-use claim bound to the accepted run's identity
   (`GitDeliveryApprovalRedemption`); `allowed` proceeds. `autonomous-delivery` is resolved
   outright at this layer per the **capability-availability clarification** above: Full access's
   `delivery` cells are `approval-required` in the shared matrix, but this coarse admission layer
   is not the execution path that redeems them for an operation whose own execute path already
   carries mandatory, mode-independent approval (`merge`, via its pre-existing approval-gated
   pack and `/merge/approve` route; `commit`, via the unconditional consumed-claim check its
   execute route now applies regardless of mode, added by #3386). The scope check that precedes
   this matrix lookup (`hasRequiredScopes`) now genuinely passes for a `delivery`-scoped operation
   in every mode: `productionRuntimeWorkspaceAuthority.ts` mints `source-control.read` /
   `source-control.write` and `delivery-substrate` (with the paired `connector-access` action class
   the shared contract's connector-scope invariant requires) whenever the matrix does not deny the
   `delivery` resource scope for the effective mode — which it never does, in any of the three modes
   (epic #3384 correction 5, item 1, closing a residual finding on this record's first landing).
   `runBoundAuthority.ts` still carries `deliveryScopeCheckDeferredToModeDecision`, the defensive
   fallback described in the previous revision of this paragraph, which skips the same scope check
   for a `delivery`-scoped operation below `autonomous-delivery`; with the corrected minting it is no
   longer load-bearing for correctness — removing it would not change any admission outcome, because
   the scope it would otherwise gate on is already present — and it is kept only so a future, more
   permissive edit to `hasRequiredScopes` cannot silently reopen the earlier gap. The network-policy
   leg of the same check stays intentionally mode-gated: `runtimeNetworkPolicy` mints a
   connector-scoped egress policy only at `autonomous-delivery`, because `fetch`/`pull`/`push`/
   `pull-request` need it and, unlike `commit` and `merge`, carry no execute-path approval
   enforcement of their own yet — a lower mode's approval-required delivery effect for one of those
   operations still fails `hasRequiredScopes` on that leg until #3387 wires their mint routes and
   redeemable claims; nothing in this record, `runBoundAuthority.ts`, or #3386 admits them unapproved
   in any mode, including Full access. The coding-runtime tool port (`codingToolAuthorityPort.ts`) is
   the second enforcement point named by epic #3384 correction 5 and reads the same matrix for its
   `workspace-contained`/medium path already; its `git`/`delivery` branches converging onto the
   identical evaluator is tracked by that correction, not restated here.

Every existing policy consumer named above must be enumerated and regression-tested in the
implementing child (#2385) before merge; no surface may keep a local copy of the old matrix or
introduce a Code-local parallel matrix.

### D4 — Canonical Code-task terminology register

The following register from Epic #2384 is adopted as the canonical vocabulary for the governed
coding-runtime path in all future ADRs, contracts, issues, and documentation:

| Term | Canonical definition | Concrete boundary |
| --- | --- | --- |
| **Code task** | Durable user-owned container for one coding objective, workspace binding, fixed runtime, transcript, plan, changes, problems, verification, grants, and delivery state. A task is not one message. | New Code-specific contracts/store/UI; existing Chat entities remain unchanged. |
| **Turn** | One user message and the resulting agent response inside a Code task. | Ordered under a Code task. |
| **Run** | One active execution interval that may span tool calls, questions, approvals, and read-only child agents. | Server-owned state. |
| **Task workspace** | The isolated Git worktree/managed clone or local-folder sandbox owned by one Code task. | Exact root, source identity, and revision are server-bound. |
| **Runtime** | The managed coding engine selected for a task. | Fixed for the task; changing runtime creates a linked successor task. |
| **Runtime adapter** | Protocol translator between one runtime's official protocol and Keiko's normalized run/tool/question/event ports. | Never an authority owner. |
| **Runtime host** | Keiko server composition that installs/resolves, launches, supervises, stops, and recovers a managed runtime process. | No global install, self-update, or browser process ownership. |
| **Authority Envelope** | Server-owned, task/run-scoped effective permissions, limits, workspace identity, policy version, and expiry. | Clients confirm choices but cannot mint or widen authority. |
| **Approval grant** | Bounded approval for one normalized action or a safe task-scoped command template. | Bound to template, safe arguments, workspace, source digest, policy version, and expiry. |
| **Session** | A synchronized browser connection observing or controlling an existing Code task. | Multiple windows do not create duplicate tasks or runs. |

**"Sidecar" is retired** as a term for this path because it previously named at least four
distinct trust positions. Use **runtime artifact**, **runtime process**, **runtime adapter**, or
**runtime host** precisely. Existing records that use "sidecar" (notably ADR-0124's title and D4)
are not rewritten; their banners point here, and the retired term must not appear in new
contracts, identifiers, or decision text. This register renames concepts, not accepted semantics:
ADR-0137's server-owned minting, delegation, confinement, and process-tree invariants apply
unchanged to the runtime host and runtime adapter.

### D5 — Amendment stamping

Amendment banners referencing this record are added at the top of the Status sections of
ADR-0124, ADR-0125, ADR-0128, and ADR-0129, following the existing supersession-banner convention
established in ADR-0124. No other text in those records is edited; their unaffected decisions
remain in force as enumerated in the Amends section above.

## Consequences

- Raising the autonomy mode can only relax or preserve, never tighten, the disposition of a fixed
  action — the property users, tests, and reviewers already assumed is now true and
  machine-verified.
- Ask for approval becomes what its label says: every effectful action asks first, while reads and
  planning stay fluent. Users who relied on unattended contained edits in the lowest mode must
  either approve them or select Supervised workspace; this is an intentional tightening.
- Supervised workspace loses unattended low/medium external-file and internet effects, including
  seven Atlassian connector operations that previously proceeded without review. Users who want
  those unattended select Full access; the connector risk-tier design keeps its meaning there and
  in future modes/tiers.
- One matrix edit in `keiko-contracts` propagates to the editor-agent path, the connector lane,
  and the coding runtime; the enumerated-consumer regression suite is the cost that keeps that
  propagation safe.
- The label rename touches display copy and its contract data only; no stored mode value,
  envelope, or evidence record migrates.
- Future records inherit one precise runtime vocabulary; "sidecar" survives only in historical
  records behind amendment banners.
- Policy disposition and capability availability remain separate: a surface without an existing
  governed connector or delivery execution path reports the capability unavailable and denies the
  effect, even when the shared matrix cell is `allowed`.

## Alternatives considered

### Keep the ADR-0125 matrix and fix monotonicity by loosening supervised-coding workspace-contained high/critical to allowed

Rejected. It restores monotonicity by widening authority instead of narrowing it, contradicts the
Supervised workspace product meaning, and would silently remove the approval pause on high-risk
contained work that ADR-0128's risk-tier design and Epic #2384 both rely on.

### Introduce a fourth mode for the new middle semantics

Rejected. ADR-0129 D1 forbids additional user-facing autonomy modes, every consumer would need a
migration for stored mode values, and the corrected matrix expresses the intended semantics inside
the existing closed set.

### Exempt Code tasks with a Code-local matrix and leave the shared matrix unchanged

Rejected. A parallel matrix is exactly the policy drift ADR-0124 and ADR-0129 exist to prevent;
the defect is in the shared matrix, so the fix belongs at the owning layer.

### Keep the "Approve for me" label with the corrected matrix

Rejected. The label describes the old semantics ("Keiko approves routine work everywhere below
high risk") and would misstate the corrected workspace-scoped posture at the exact moment the
posture changes.

## References

- [ADR-0124](ADR-0124-coding-autonomy-modes-and-sidecar-runtime-authority.md) — machine mode
  values, fail-closed effective mode, Authority Envelope; amended here (display semantics, matrix,
  "sidecar" retirement).
- [ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md) — tri-state matrix and
  editor docking; D1 matrix and middle label superseded here, review mechanics reused unchanged.
- [ADR-0128](ADR-0128-atlassian-connector-authority-and-security-design.md) — connector
  disposition table; supervised column narrowed here at the shared-matrix layer.
- [ADR-0129](ADR-0129-product-wide-authority-and-autonomy-model.md) — product-wide adoption rule
  that makes this a single-layer correction; amended here (labels, matrix reference).
- [ADR-0135](ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md) — delivery path,
  unchanged.
- [ADR-0137](ADR-0137-server-owned-coding-runtime-contracts.md) — server-owned runtime authority,
  unchanged; its invariants carry over to the runtime host/adapter vocabulary.
- Epic #2384 (Canonical Terminology Register, Architecture Invariants) and Issue #2385 (Scope,
  Acceptance Criteria).

## Date

2026-07-16
