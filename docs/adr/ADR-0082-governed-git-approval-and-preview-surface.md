# ADR-0082: Governed Git Approval and Preview Surface

## Status

Proposed

## Context

Epic #470 turns Keiko's read-only relationship to Git into a governed, end-to-end delivery platform.
Issue #471 (ADR-0080) delivered the typed contract surface: action kinds, a risk taxonomy, the
lifecycle envelope, policy packs with a deterministic `evaluateGitPolicy`, and provider-neutral
interfaces. Issue #472 (ADR-0081) built the execution and preflight kernel that consumes those
contracts and drives governed local Git writes through one repeatable lifecycle. Both layers are
content-free and deterministic, but neither presents anything to an operator.

Issue #473 is the next child: build the **approval and preview presentation layer** on top of those
foundations. The product value here is **informed consent** — before any governed mutation runs, the
operator must see a consistent, content-free explanation of what the action would do, whether policy
permits it, whether approval is needed, and what to do when it cannot proceed. The presentation must
never become a second source of authority: it is a view over backend facts, not a parallel policy
engine.

Five forces shape the design:

**Force 1 — Projection, not a second policy system.** The action sheet is a pure projection over
facts the backend already computed. Policy authority stays server-side via `evaluateGitPolicy` over
trusted policy packs; the kernel owns preflight. The contract and the UI never re-derive policy
meaning, risk, or block decisions from strings — they render typed fields the trusted layers
produced. A divergence between what the sheet shows and what the kernel would enforce is therefore
impossible by construction, not by discipline.

**Force 2 — Content-free presentation.** The surface carries counts, flags, branch names, and typed
codes only. It never carries diff content, file paths, secrets, command strings, or raw subprocess
output. The same confidentiality boundary that the contract envelope and the kernel snapshot hold is
preserved all the way to the browser, so an approval screen can be rendered without widening what
leaves the trusted backend.

**Force 3 — Behaviour in types, display keys for strings.** Every behavioural decision the UI makes —
which state to render, whether to enable the confirm affordance, how to classify a block, which
recovery hint to offer — is driven by a typed field (`source` / `severity` / `remediation` / `cause`
/ `state` / `necessity`). The one string that survives, `expectedBlocker.reasonCode`, is a stable
display/i18n key only, closed at its producing layer and never parsed for meaning.

**Force 4 — Missing approvals are a state, not a block.** A hard block is a condition no approval can
resolve. "Missing approvals" is qualitatively different: it is resolvable by approving. Conflating
the two would either over-state hard failure (suggesting the action is impossible when it is merely
pending) or under-state real blocks. The design surfaces missing approval as a distinct
`waiting-for-approval` state, kept separate from the three hard-block causes.

**Force 5 — Presentation, not execution.** This slice computes and displays; it does not mutate.
Local execution is the #472 kernel; remote and provider mutations (push / PR / merge) are #476–#478
behind a separate gateway. The endpoint is computational and read-only, and the UI confirm affordance
is gated on state and emits intent — it never runs git.

### Scope boundary (Issue #473)

In scope: the UI-safe action-sheet contract module in `keiko-contracts` (states, approval summary,
preview manifest, blocked-cause classification, recovery hints, and the pure projection helpers); the
keiko-server BFF endpoint that runs the pure kernel phases over trusted policy packs and projects
them into an action sheet behind a default-false deployment capability; and the keiko-ui desktop card
that renders ready / waiting / blocked / recovery states with accessibility coverage. Out of scope
(later children): execution of any mutation (local is #472; remote/provider is #476–#478), the
evidence ledger and audit export (#474), productized branch/commit UX (#475), and credential or
provider-API wiring.

## Decision

We introduce one module in `packages/keiko-contracts/src/`, one endpoint in the keiko-server BFF, and
one desktop card in keiko-ui. The contract module is the projection vocabulary the other two consume;
the server is the only place trusted policy packs are evaluated; the UI is a pure renderer of the
projected sheet.

1. **`git-delivery-action-sheet.ts`** (keiko-contracts) — the UI-safe action-sheet / preview /
   approval projection: the three-state union, the approval summary with its necessity taxonomy, the
   preview manifest, the blocked-cause classification, recovery hints, and the pure assemblers and
   guards that build and validate a sheet.
2. **`POST /api/git-delivery/action-sheet`** (keiko-server) — the BFF endpoint that runs the pure
   kernel phases over trusted server-side policy packs and projects them into a
   `GitDeliveryActionSheet`, gated by a default-false deployment capability.
3. **`GitDeliveryActionSheetCard`** (keiko-ui) — the desktop surface that renders the sheet's ready,
   waiting, blocked, and recovery states with accessibility coverage and browser tests.

### D1 — The action sheet as a pure projection (AC1)

`GitDeliveryActionSheet` is the top-level UI-safe manifest. It carries an `actionId`, the
`actionKind`, a `state`, a `preview` manifest, an `approval` summary, a `policyExplanation`, an
ordered list of `recovery` hints, and a `blocked` detail present iff `state === "blocked"`. It is
assembled by the pure `buildGitDeliveryActionSheet` from a `GitDeliveryActionSheetInput` — content-free
backend facts: the `GitDeliveryResolvedInputs`, the `GitDeliveryPolicyDecision` from `evaluateGitPolicy`
over trusted packs, the `GitDeliveryApprovalRequirement`, a `providerReady` flag from the deployment
capability gate, expected blockers and recovery hints mapped from the kernel's preflight findings, and
optional provider state.

The approval summary (`GitDeliveryApprovalSummary`) carries `necessity`
(`not-required` / `required` / `impossible`), a `satisfied` flag, the action's `riskClass` and
`riskSeverity`, and `requiredApprovers`. `necessity` is derived deterministically from the policy
decision (`gitDeliveryApprovalNecessityForDecision`): an `approval-gated` decision is `required`; a
`blocked` decision is `required` only when the reason is `approval-expired` (resolvable by
re-approving) and `impossible` otherwise; `allowed` and `constrained` are `not-required`. `satisfied`
is true only when approval is required AND a valid granted approval is attached — token expiry is
enforced upstream by the policy evaluator, which holds the clock, so a granted-but-expired approval
surfaces as `waiting-for-approval`, not as satisfied. The `policyExplanation` mirrors the trusted
decision (`decision.outcome`, `requiredApprovers`, `constraints`, and a `blockReason` when blocked) so
the policy reason is visible without re-deriving it. The confirm affordance is a UI concern gated on
`state === "ready-to-execute"`; it never re-evaluates policy.

### D2 — The content-free preview manifest (AC2)

`GitDeliveryPreviewManifest` is a consistent, UI-safe superset of the kernel's content-free
`GitDeliveryActionPreview`, enriched with branch targets (`affectedBranchName` / `baseBranchName` /
`remoteBranchName`), estimated scope (`estimatedFileCount` / `estimatedBytesDelta`, carried through
from the kernel preview when present), remote-impact flags (`touchesRemote`, `wouldCreateRemoteBranch`,
`wouldForcePublish`, `wouldTriggerChecks`), optional provider state (PR / merge-readiness /
branch-protection / checks), and the expected-blocker summary. It is built by the pure
`buildGitDeliveryPreviewManifest`, which derives `riskClass` from `gitDeliveryRiskClassForInputs` (the
same DATA-driven taxonomy the contract and kernel use) and computes remote impact from the resolved
inputs — for example, `wouldForcePublish` is true only for a `push` with `forcePush`, and
`wouldCreateRemoteBranch` from `setUpstreamTracking` (or the kernel preview for non-push kinds). Every
field is a count, flag, or name; no diff, path, or command string appears.

### D3 — Blocked-cause classification, no raw output (AC3)

The three hard-block causes are a closed `GitDeliveryBlockedCause` union — `policy`, `preflight`,
`provider-not-ready` — classified deterministically by `gitDeliveryBlockedCauseFor`: provider-not-ready
takes precedence (a default-false capability or unready provider blocks before anything else), then a
blocking preflight finding, then a policy `blocked` decision whose reason is not `approval-expired`.
The `GitDeliveryBlockedDetail` (present iff blocked) carries the cause plus the typed
`expectedBlockers`. Each `GitDeliveryExpectedBlocker` is content-free: a typed `source`
(`preflight` / `policy` / `provider`), `severity` (`blocking` / `advisory`), `remediation`
(`user-actionable` / `internal`), and a `reasonCode`. The `reasonCode` is the only string, and it is a
stable display/i18n key from its producing layer — a preflight finding code, a block reason, or a
merge-block reason — never parsed for behaviour. The action-sheet state machine
(`gitDeliveryActionSheetStateFor`) keeps the AC3 distinction from Force 4: an `approval-gated` decision
without an attached approval, or a `blocked`-but-`approval-expired` decision, resolves to
`waiting-for-approval`, never to a hard block.

### D4 — Recovery hints in the same surface (AC4)

`GitDeliveryRecoveryHint` carries a typed `actionHint` from a closed
`GitDeliveryRecoveryActionHint` vocabulary (`retry`, `stage-changes`, `configure-upstream`,
`resolve-conflicts`, `abort-in-progress-operation`, `request-approval`, `adjust-policy-target`,
`recover-via-strategy`, `wait-for-provider`), a `remediation` class, and — only for the
`recover-via-strategy` hint — a concrete `suggestedRecoveryStrategy` naming the governed recovery the
kernel would run. The structural guard enforces that a concrete strategy is present only for that
hint, so a recovery suggestion can never be silently attached to an unrelated action. The pure
`gitDeliverySuggestedRecoveryStrategy` closes the kernel's failure → suggested-strategy gap with a
deterministic default: a dirty worktree is preserved with `stash-and-reset`, an undone commit uses a
non-destructive `soft-reset`, and everything else uses a `mixed-reset` that resets the index but keeps
working-tree files. The recovery hints are part of the same sheet rendered in the ready and blocked
paths, so an operator never has to leave the surface to learn the next step.

### D5 — The BFF endpoint: trusted authority, capability gate, read-only

`POST /api/git-delivery/action-sheet` is the only place trusted policy packs are evaluated. It runs
the pure kernel phases — `evaluateGitPreflight` over a content-free worktree snapshot, then
`evaluateGitPolicy` over the trusted server-side policy packs — and projects the results into a
`GitDeliveryActionSheet` via the contract assemblers. The endpoint is gated by a **default-false
deployment capability**: when the capability is off, the action-sheet surface is unavailable and the
endpoint reports the provider as not ready rather than fabricating an `allowed` sheet. The endpoint is
computational and read-only — it executes no git and mutates no repository state — and it is subject to
the same CSRF protection and request validation as every other state-shaped BFF route. Authority
(policy and approval) is never client-asserted: the client supplies content-free inputs, and the
trusted layer computes the decision.

### D6 — Boundary preservation

This slice adds a presentation projection and one read-only endpoint; it weakens nothing. The
keiko-contracts module is a strict leaf — pure types, frozen const tables, and pure functions, with no
IO, clock, crypto, or randomness — and it imports only the git-delivery sibling atoms, never a kernel
(keiko-tools) type (ADR-0019). The kernel's preflight finding codes reach this layer only as opaque,
closed-vocabulary display keys, never as a type this leaf re-enumerates. The read-only terminal
baseline (`isTerminalCommandAllowed`) is untouched, and the governed write surface gains no new path:
the action sheet describes what the kernel would do, it does not do it.

## Consequences

### Positive

- A single content-free projection gives every consumer (the desktop card, future evidence and
  recovery surfaces) one consistent view of approval, preview, blocked cause, and recovery, all driven
  by typed fields rather than string parsing.
- Policy and preflight authority stay server-side; the contract and UI cannot diverge from the trusted
  decision because they render projected facts, not re-derived meaning.
- Missing approval is a resolvable `waiting-for-approval` state distinct from the three hard-block
  causes, so the UI can offer the right next step without conflating pending with impossible.
- The endpoint is read-only and capability-gated, so the approval surface ships without widening the
  execution surface or the confidentiality boundary.

### Negative

- The action sheet enriches but cannot exceed the facts the trusted layers compute; richer preview
  detail (for example finer file-level impact) requires the kernel and provider adapters to surface
  more content-free facts first.
- The confirm affordance only emits intent in this slice; an operator cannot complete a mutation from
  the sheet until the corresponding execution slice (#472 for local, #476–#478 for remote/provider) is
  wired to consume that intent.

### Neutral

- `expectedBlocker.reasonCode` is an i18n/display key, so localized copy for each code lives in the UI
  layer; adding a new code is additive at its producing layer and surfaces here without a contract
  change.
- The provider state on the preview manifest is optional; deployments without a configured provider
  render a complete local-action sheet with the provider fields absent.

## Alternatives Considered

### Alternative 1: Re-derive policy and block meaning in the UI from strings

Rejected. Parsing a reason string or inferring risk in the browser would create a second source of
authority that can silently diverge from `evaluateGitPolicy`. Force 1 requires the sheet to be a pure
projection of the trusted decision; behaviour is carried by typed fields, and the one surviving string
is a display key only.

### Alternative 2: Model "missing approvals" as a fourth blocked cause

Rejected. A hard block is a condition no approval can resolve; missing approval is resolvable by
approving. Folding it into the blocked causes would either overstate impossibility or weaken the
meaning of a real block. The distinct `waiting-for-approval` state keeps the AC1/AC3 distinction
explicit (Force 4).

### Alternative 3: Let the endpoint execute the mutation on confirm

Rejected as out of scope and as a boundary violation. Local execution is the #472 kernel and
remote/provider execution is #476–#478 behind a separate gateway. The endpoint is computational and
read-only; the confirm affordance emits intent. Coupling presentation to execution would put a
mutation path behind a presentation route (Force 5).

### Alternative 4: Carry richer preview content (diffs, paths, command output) to the UI

Rejected. The contract, the kernel snapshot, and this projection are content-free by design. Surfacing
diffs, paths, secrets, or raw subprocess output to the browser would widen the confidentiality
boundary the whole epic preserves; redacted execution detail is the evidence ledger's concern (#474),
not the approval surface's (Force 2).

## Related

- ADR-0080: Governed Git delivery contracts (the contract surface this projection consumes)
- ADR-0081: Governed Git mutation execution kernel (the preflight and lifecycle facts this surface projects)
- ADR-0019: Modular Package Architecture (leaf-package rules; the action-sheet module is a strict contract leaf)
- Issue #473: Governed Git approval and preview surface (this ADR)
- Issue #470: Epic — governed end-to-end Git delivery

## Date

2026-06-25
