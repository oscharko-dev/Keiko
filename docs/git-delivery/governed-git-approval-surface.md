# Governed Git Approval and Preview Surface

This document describes the governed Git approval and preview surface introduced in Issue #473
(Epic #470) and defined by
[ADR-0082](../adr/ADR-0082-governed-git-approval-and-preview-surface.md). It is written for engineers
building the later delivery slices on top of the surface, and for reviewers verifying that the surface
stays a pure projection of trusted backend facts — never a second policy system, and never an
execution path.

It builds directly on the contract surface from Issue #471
([ADR-0080](../adr/ADR-0080-governed-git-delivery-contracts.md)) and the execution and preflight
kernel from Issue #472 ([ADR-0081](../adr/ADR-0081-governed-git-mutation-execution-kernel.md), see
[governed-git-execution-kernel.md](governed-git-execution-kernel.md)).

## 1. Overview

The approval surface turns the kernel's content-free facts into a consistent, UI-safe **action sheet**
that an operator can read before any governed mutation runs. It answers four questions in one place:

- What would this action do? (the preview manifest)
- Does policy permit it, and is approval required? (the approval summary and policy explanation)
- If it cannot proceed, why — and is that a hard block or just a pending approval? (state and
  blocked-cause classification)
- What is the next step? (recovery hints)

The surface is a **pure projection**: it is a view over facts the trusted backend already computed, not
a parallel policy engine. Policy authority stays server-side via `evaluateGitPolicy` over trusted
policy packs; the kernel owns preflight. The contract module and the UI never re-derive policy meaning,
risk, or a block decision from a string — they render typed fields the trusted layers produced.

The surface is also **content-free**: it carries counts, flags, branch names, and typed codes only. It
never carries diff content, file paths, secrets, command strings, or raw subprocess output.

The surface spans three layers:

- `packages/keiko-contracts/src/git-delivery-action-sheet.ts` — the UI-safe projection contract: the
  types, frozen const tables, structural guards, and pure assemblers.
- `POST /api/git-delivery/action-sheet` (keiko-server BFF) — the only place trusted policy packs are
  evaluated; it runs the pure kernel phases and projects them into a sheet, behind a default-false
  deployment capability.
- `GitDeliveryActionSheetCard` (keiko-ui desktop) — a pure renderer of the projected sheet, with
  accessibility coverage.

## 2. The action-sheet contract

`buildGitDeliveryActionSheet(input)` assembles a `GitDeliveryActionSheet` from a
`GitDeliveryActionSheetInput` of content-free backend facts. The sheet carries:

- `schemaVersion`, `actionId`, `actionKind`.
- `state` — the three-state union (Section 2.1).
- `preview` — the preview manifest (Section 2.3).
- `approval` — the approval summary (Section 2.2).
- `policyExplanation` — the visible policy reason (Section 2.2).
- `recovery` — an ordered list of recovery hints (Section 2.5).
- `blocked` — a blocked detail present **iff** `state === "blocked"` (Section 2.4).

`isGitDeliveryActionSheet` / `parseGitDeliveryActionSheet` validate a sheet structurally, including the
`blocked`-present-iff-blocked invariant.

### 2.1 State

`GitDeliveryActionSheetState` is a closed three-state union the UI renders distinctly:

| State                  | Meaning                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `ready-to-execute`     | policy permits and any required approval is attached            |
| `waiting-for-approval` | resolvable by approving — required approval missing, or expired |
| `blocked`              | a hard block no approval can resolve                            |

`gitDeliveryActionSheetStateFor` derives the state deterministically. Order of precedence:

1. provider not ready → `blocked`
2. a blocking preflight finding → `blocked`
3. policy `blocked` with reason `approval-expired` → `waiting-for-approval`; any other `blocked`
   reason → `blocked`
4. policy `approval-gated` → `ready-to-execute` if an approval is attached, else
   `waiting-for-approval`
5. otherwise (`allowed` / `constrained`) → `ready-to-execute`

The `waiting-for-approval` state is the typed surface for the issue's "missing approvals" cause: it is
kept **distinct** from a hard block because it is resolvable by approving, not by changing the action.

### 2.2 Approval summary and policy explanation

`GitDeliveryApprovalSummary` carries:

- `necessity` — `not-required` / `required` / `impossible`, derived by
  `gitDeliveryApprovalNecessityForDecision`: `approval-gated` → `required`; `blocked` with reason
  `approval-expired` → `required` (resolvable by re-approving), any other `blocked` reason →
  `impossible`; `allowed` / `constrained` → `not-required`.
- `satisfied` — true only when `necessity === "required"` AND a valid granted approval is attached.
  Token expiry is enforced **upstream** by the policy evaluator (which holds the clock), so a
  granted-but-expired approval surfaces as `waiting-for-approval`, not as satisfied.
- `riskClass` / `riskSeverity` — from the same DATA-driven taxonomy (`gitDeliveryRiskClassForInputs`,
  `GIT_DELIVERY_RISK_CLASS_SEVERITY`) used by the contract and kernel.
- `requiredApprovers` — present only for an `approval-gated` decision.

`GitDeliveryPolicyExplanation` mirrors the trusted decision so the policy reason is visible without
re-derivation: `decision` (the policy `outcome`), `requiredApprovers`, `constraints` (present for a
`constrained` outcome), and `blockReason` (present for a `blocked` outcome). The UI confirm affordance
is gated on `state === "ready-to-execute"`; it never re-evaluates policy.

### 2.3 Preview manifest

`buildGitDeliveryPreviewManifest(input)` produces a `GitDeliveryPreviewManifest` — a consistent,
UI-safe superset of the kernel's content-free `GitDeliveryActionPreview`. Every field is a count, flag,
or name:

| Field                                                            | Meaning                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| `actionKind` / `riskClass` / `riskSeverity`                      | the action and its DATA-driven risk                     |
| `affectedBranchName` / `baseBranchName` / `remoteBranchName`     | branch targets, derived from the resolved inputs        |
| `estimatedFileCount` / `estimatedBytesDelta`                     | carried through from the kernel preview when present    |
| `touchesRemote`                                                  | true for `push` / `pr-create` / `pr-update` / `merge`   |
| `wouldCreateRemoteBranch`                                        | `setUpstreamTracking` for push, else the kernel preview |
| `wouldForcePublish`                                              | true only for a `push` with `forcePush`                 |
| `wouldTriggerChecks`                                             | tracks `touchesRemote`                                  |
| `pullRequest` / `mergeReadiness` / `branchProtection` / `checks` | optional provider state (absent without a provider)     |
| `expectedBlockers`                                               | the content-free expected-blocker summary               |

Optional fields are populated only when a value is present, so no `undefined` is spread into the
result (`exactOptionalPropertyTypes`-safe). No diff, path, secret, or command string ever appears.

### 2.4 Blocked cause and expected blockers

The hard-block causes are a closed `GitDeliveryBlockedCause` union — `policy`, `preflight`,
`provider-not-ready`. `gitDeliveryBlockedCauseFor` classifies them in the same precedence as the state
machine: provider-not-ready first, then a blocking preflight finding, then a policy `blocked` decision
whose reason is **not** `approval-expired`. A `GitDeliveryBlockedDetail` (present iff blocked) carries
the `cause` plus the typed `expectedBlockers`.

Each `GitDeliveryExpectedBlocker` is content-free and typed:

- `source` — `preflight` / `policy` / `provider`.
- `severity` — `blocking` (halts) / `advisory` (informs).
- `remediation` — `user-actionable` / `internal`.
- `reasonCode` — a stable display/i18n key from its producing layer (a preflight finding code, a block
  reason, or a merge-block reason).

All behaviour rides `source` / `severity` / `remediation`. `reasonCode` is the **only** string and it
is never parsed for meaning — it is a closed-vocabulary display key, localized in the UI layer. The
kernel's preflight finding codes therefore reach this contract only as opaque keys, never as a type the
contract leaf re-enumerates.

### 2.5 Recovery hints

`GitDeliveryRecoveryHint` carries:

- `actionHint` — from a closed `GitDeliveryRecoveryActionHint` vocabulary: `retry`, `stage-changes`,
  `configure-upstream`, `resolve-conflicts`, `abort-in-progress-operation`, `request-approval`,
  `adjust-policy-target`, `recover-via-strategy`, `wait-for-provider`.
- `remediation` — `user-actionable` / `internal`.
- `suggestedRecoveryStrategy` — present **only** for the `recover-via-strategy` hint; it names the
  concrete governed recovery strategy the kernel would run. The structural guard rejects a concrete
  strategy attached to any other hint.

`gitDeliverySuggestedRecoveryStrategy(actionKind, worktreeIsDirty)` closes the kernel's
failure → suggested-strategy gap with a deterministic default: a dirty worktree is preserved with
`stash-and-reset`; an undone `commit` uses a non-destructive `soft-reset`; everything else uses a
`mixed-reset` that resets the index but keeps working-tree files. Recovery hints are part of the same
sheet rendered in both the ready and blocked paths, so the operator never has to leave the surface to
learn the next step.

## 3. The BFF endpoint

`POST /api/git-delivery/action-sheet` is the only place trusted policy packs are evaluated.

- **Request** — content-free inputs only: the resolved action inputs plus the worktree snapshot the
  server needs to evaluate preflight. The client never asserts authority (policy or approval).
- **Computation** — the endpoint runs the pure kernel phases: `evaluateGitPreflight` over the
  content-free snapshot, then `evaluateGitPolicy` over the **trusted server-side** policy packs. It
  maps the preflight findings to expected blockers and recovery hints, then projects everything into a
  `GitDeliveryActionSheet` via the contract assemblers.
- **Response** — a `GitDeliveryActionSheet` (Section 2). Content-free: counts, flags, names, and typed
  codes only.
- **Capability gate** — the surface is gated by a **default-false** deployment capability. When the
  capability is off, the endpoint reports the provider as not ready (`providerReady: false`) rather
  than fabricating an `allowed` sheet, so the sheet renders a `provider-not-ready` blocked state.
- **Authority rule** — policy and approval decisions are computed server-side from trusted packs and
  the policy evaluator's clock; they are never taken from the client.
- **CSRF** — the route is subject to the same CSRF protection and request validation as every other
  state-shaped BFF route.

The endpoint is **computational and read-only**: it executes no git and mutates no repository state.

## 4. The desktop surface

`GitDeliveryActionSheetCard` is a pure renderer of a projected sheet. It renders the ready, waiting,
blocked, and recovery states distinctly, driven entirely by typed fields:

- `ready-to-execute` — shows the preview manifest and the approval summary, and enables a confirm
  affordance.
- `waiting-for-approval` — surfaces the pending approval (and `request-approval` recovery), with the
  confirm affordance disabled.
- `blocked` — shows the blocked cause and the expected blockers, with no raw output.
- recovery hints render in the same surface in both the ready and blocked paths.

The confirm affordance is **gated on `state === "ready-to-execute"`** and **emits intent only** — it
does not run git. The card ships with accessibility coverage and browser tests (AC5). Display copy for
each `reasonCode` and `actionHint` is localized in the UI layer; the contract carries keys, not
sentences.

## 5. What this surface does not do

- It does not execute any mutation. Local execution is the #472 kernel
  ([governed-git-execution-kernel.md](governed-git-execution-kernel.md)); remote and provider
  mutations (push / PR / merge) are #476–#478 behind a separate gateway. The confirm affordance emits
  intent; it never runs git.
- It is not a second policy system. Policy authority stays server-side via `evaluateGitPolicy` over
  trusted packs; the contract and UI render projected facts and never re-derive policy meaning from a
  string.
- It does not carry diffs, file paths, secrets, command strings, or raw subprocess output. Redacted
  execution detail is the evidence ledger's concern (#474), not the approval surface's.
- It does not provide the evidence ledger or audit export (#474), productized branch/commit UX (#475),
  or any credential or provider-API wiring.

## 6. Mapping to the acceptance criteria

| AC  | Requirement                                                          | Where it lives                                                                                                                                             |
| --- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | Approval object + visible policy explanation; confirm gated on state | `GitDeliveryApprovalSummary` + `GitDeliveryPolicyExplanation`; state derived by `gitDeliveryActionSheetStateFor`; card confirm gated on `ready-to-execute` |
| AC2 | Content-free preview manifest                                        | `GitDeliveryPreviewManifest` via `buildGitDeliveryPreviewManifest` (counts, flags, names only)                                                             |
| AC3 | Blocked-cause classification, no raw output                          | closed `GitDeliveryBlockedCause` via `gitDeliveryBlockedCauseFor`; typed `GitDeliveryExpectedBlocker`; `reasonCode` is a display key only                  |
| AC4 | Recovery hints in the same surface                                   | `GitDeliveryRecoveryHint` + `gitDeliverySuggestedRecoveryStrategy`; rendered in the ready and blocked paths                                                |
| AC5 | UI + accessibility + browser tests                                   | `GitDeliveryActionSheetCard` with a11y coverage and browser tests                                                                                          |
