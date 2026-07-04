# ADR-0080: Governed Git Delivery Contracts

## Status

Accepted

## Context

Epic #470 adds end-to-end governed Git delivery to Keiko. Issue #471 is the first child: define the
typed contract surface that every later slice (#472–#479) will build on. Today the product's only
relationship to Git is read-only terminal inspection: `isTerminalCommandAllowed` (keiko-tools,
ADR-0018 D3) allows `git status / diff / log / show / rev-parse / ls-files / describe / blame /
cat-file / branch / remote` and explicitly denies all mutating subcommands (commit, push, merge,
branch creation, etc.). That boundary must remain intact while a new, explicitly governed write
surface is introduced alongside it.

Three architectural forces require a careful design:

**Force 1 — No command-string smuggling.** The existing terminal policy works by inspecting
executable + arg strings. A new delivery surface must not be reachable through that path: governed
Git mutations must flow through a typed contract, not through a widened terminal allowlist.

**Force 2 — Provider neutrality.** GitHub is the first delivery target, but GitHub-specific concepts
(mergeable_state, required_status_checks, check_runs) must not leak into the core domain. Provider
adapters map the provider shape to a neutral interface; the domain never sees provider vocabulary.

**Force 3 — Leaf-package purity.** keiko-contracts is a strict dependency leaf (ADR-0019 direction
rule 1): no @oscharko-dev/* imports, no IO, no clock, no crypto, no randomness. All contracts and
validators must be pure functions over plain JSON.

### Existing vocabulary to compose

- `isApprovalTokenShape(token)` — validates a 64-hex-char SHA-256 approval token
  (`workflow-handoff.ts`). The Git approval model reuses this shape.
- `EvidenceGovernedWorkflowHandoff` — references evidence by opaque id/hash only (content-free).
  Git evidence references follow the same pattern.
- `WorkflowHandoffRequest` — a one-shot agent invocation envelope. Git delivery is multi-step
  (preview → approve → execute → result), so a new lifecycle envelope is required; the two shapes
  must not be confused.

### Scope boundary (Issue #471)

This ADR covers only the contract surface. It does not cover:

- Live Git execution engine (Issue #472+)
- UI components beyond wire-type payloads (Issue #473+)
- Credential or provider-API integration (Issue #474+)
- Evidence persistence beyond contract hook shapes (Issue #476+)

## Decision

We will introduce three new modules in `packages/keiko-contracts/src/`:

1. **`git-delivery.ts`** — action kinds, per-kind resolved inputs, risk-class taxonomy (with
   explicit ordinal severity and a frozen kind→risk-class default table), approval-intent model, and
   the composite lifecycle envelope covering resolved inputs / policy decision / approval requirement
   / preview / execution result / evidence reference.

2. **`git-delivery-policy.ts`** — repo-level and org-level policy-pack structures, typed rule shape
   (decision = `allowed | blocked | approval-gated | constrained`), an optional authorable
   `defaultRule` (deny-by-default as data), and a deterministic pure evaluator `evaluateGitPolicy`
   with a complete documented precedence matrix and a genuine fail-closed default.

3. **`git-delivery-provider.ts`** — provider-neutral interfaces for branch protection state, checks
   summary, pull-request state, merge readiness, remote-target policy, and provider-capability
   descriptor. No GitHub field names appear in these interfaces.

The three-file split reflects three different rates of change: provider shapes track GitHub API
evolution; policy-pack structures track org/repo governance requirements; core action kinds and risk
classes change infrequently as the domain matures.

**Module ownership and the acyclic graph.** `git-delivery.ts` is the core atom and imports nothing
from its two siblings; it owns the action kinds, risk taxonomy, the lifecycle envelope, the typed
constraint union, the policy decision, the provider-capability enum, the typed branch-pattern
matchers, the risk-class-ceiling helper, and the shared `GitDeliveryParseResult<T>`.
`git-delivery-policy.ts` and `git-delivery-provider.ts` import only from `git-delivery.ts`. The
resulting one-directional DAG has no cycles (verified by `arch:check`). The only internal import in
`git-delivery.ts` is `./workflow-handoff.js` for `isApprovalTokenShape` (a legal intra-package
relative import).

We will add all public exports to `packages/keiko-contracts/src/index.ts` under a `#471` block and
add the corresponding pin assertions to `packages/keiko-contracts/src/index.test.ts`.

The AC5 boundary test will live in `packages/keiko-tools/src/terminal-policy.test.ts` (new
`describe` block) asserting that the mutating subcommands the terminal policy denies remain denied
and that `GIT_DELIVERY_ACTION_KINDS` — the typed source of truth for governed actions — is a
structurally separate surface not accessible through `isTerminalCommandAllowed`.

### D1 — Action kinds and risk taxonomy (AC1, AC2)

`GitDeliveryActionKind` is a string-literal union; `GIT_DELIVERY_ACTION_KINDS` is its frozen array
source of truth. The ten kinds are:

```
branch-create | stage | unstage | commit | push
pr-create | pr-update | merge | abort | recovery
```

`GitDeliveryRiskClass` is a four-member union with an explicit ordinal severity field (not derived
from the name):

| Class | Ordinal | Coverage |
|---|---|---|
| `local-mutation` | 1 | branch-create, stage, unstage, commit, abort |
| `publish` | 2 | push |
| `protected-or-merge` | 3 | pr-create, pr-update, merge |
| `recovery-or-rewrite` | 4 | recovery |

`GIT_DELIVERY_ACTION_RISK_DEFAULTS` is a frozen `Record<GitDeliveryActionKind, GitDeliveryRiskClass>`
that maps every kind to its default risk class. An unknown kind (future extension, deserialized from
JSON before a schema migration) receives `recovery-or-rewrite` (ordinal 4, highest) from the
fail-closed evaluator rather than crashing.

Severity is DATA (read `GIT_DELIVERY_RISK_CLASS_SEVERITY[riskClass]`), not name-inference. No
downstream code may infer severity by inspecting the action kind string or shell arguments.

### D2 — Approval-intent model (AC1)

`GitDeliveryApprovalRequirement` is a discriminated union on `required: boolean`. When
`required: true`, the record carries:

- `approvalTokenHash: string` — a 64-hex-char SHA-256 hash of the approval token (never the token
  itself; validated by `isApprovalTokenShape`).
- `approvedByUserId: string` — opaque user identity reference.
- `approvedAtMs: number` — epoch-ms timestamp.
- `expiresAtMs: number | undefined` — optional expiry.

When `required: false`, only `required` is present. This keeps approval intent structurally
distinct from the absence of approval, so pattern-matching is exhaustive.

### D3 — Lifecycle envelope (AC1)

The envelope is a **sound discriminated union**, not a phantom generic. `GitDeliveryActionEnvelopeFor<I>`
is parameterised by a single per-kind resolved-input type `I`, with `kind: I["kind"]` and
`resolvedInputs: I`, so `kind === resolvedInputs.kind` holds by construction.
`GitDeliveryActionEnvelope` is the union over all ten per-kind members. Both are exported. The
envelope composes the six elements required by AC1:

1. `resolvedInputs: I` — per-kind typed inputs (discriminated on `kind`).
2. `policyDecision: GitDeliveryPolicyDecision` — outcome of policy evaluation (see D4).
3. `approvalRequirement: GitDeliveryApprovalRequirement` — whether human approval is required.
4. `preview: GitDeliveryActionPreview | undefined` — content-free preview descriptor (counts,
   flags, affected-branch name — no diff content, no secrets, no raw paths).
5. `executionResult: GitDeliveryExecutionResult | undefined` — outcome populated after execution
   lands.
6. `evidenceRef: GitDeliveryEvidenceRef | undefined` — content-free reference; never raw diffs or
   command output.

`parseGitDeliveryActionEnvelope` additionally enforces at runtime that
`value.kind === value.resolvedInputs.kind`, rejecting any envelope whose discriminant disagrees with
its inputs. `GitDeliveryResolvedInputs` is a discriminated union on `kind`. Each member is a separate
interface (`GitDeliveryBranchCreateInputs`, `GitDeliveryStageInputs`, etc.) carrying only the
semantically typed fields that kind requires. No kind leaks another kind's fields. Recovery's
elevated-approval requirement lives on the envelope (`policyDecision` / `approvalRequirement`), not in
its inputs.

`GitDeliveryExecutionResult.errorCode` is a closed `GitDeliveryExecutionErrorCode` union
(`provider-rejected | network-failure | conflict | precondition-failed | timeout | internal-error`),
not a free string, and carries an optional `partialDetail` (attempted/succeeded unit counts) for the
`partial` outcome. `GitDeliveryEvidenceRef` names align with `evidence.ts`
(`sourceGroundedRunId` + `evidenceManifestStableIdHash`).

### D4 — Policy decision and policy packs (AC2, AC3)

`GitDeliveryPolicyDecision` is a discriminated union on `outcome`:

- `{ outcome: "allowed" }` — action may proceed.
- `{ outcome: "blocked"; reason: GitDeliveryBlockReason }` — typed block reason (not a free string).
- `{ outcome: "approval-gated"; requiredApprovers: readonly string[] }` — lists opaque approver
  ids; execution is held until approval is recorded.
- `{ outcome: "constrained"; constraints: readonly GitDeliveryConstraint[] }` — action may
  proceed only after listed typed constraints are satisfied.

`GitDeliveryConstraint` is a discriminated union on `kind`:

- `{ kind: "branch-pattern"; patterns: readonly GitDeliveryBranchPattern[] }` — the target branch
  must match at least one **structured** pattern. A `GitDeliveryBranchPattern` is typed data
  (`{ matchKind: "exact" | "prefix"; value: string }`), not a parsed string. Glob is **intentionally
  excluded** to keep the leaf parse-free; `gitDeliveryBranchNameMatchesPattern` /
  `gitDeliveryBranchNameMatchesAny` are the deterministic matchers. If a later issue needs glob, it
  adds a third `matchKind` with its own matcher, never an embedded mini-language.
- `{ kind: "provider-capability"; capability: GitDeliveryProviderCapability }` — the active
  provider must advertise the required capability (see D5).
- `{ kind: "risk-class-ceiling"; maxRiskClass: GitDeliveryRiskClass }` — a genuine ceiling: an
  action whose default risk-class severity **exceeds** `maxRiskClass` is out of bounds.
  `gitDeliveryRiskClassWithinCeiling(actionKind, ceiling)` compares severities via the frozen
  ordinal table. (This replaces the misnamed/circular `min-risk-class` constraint.)

There are no free-form string constraint payloads. Every constraint kind is a typed discriminant
(AC3).

`GitDeliveryBlockReason` is a string-literal union (not a string):

```
"policy-pack-blocked" | "protected-branch" | "provider-capability-absent"
| "approval-expired" | "risk-class-ceiling" | "no-applicable-rule"
```

The sixth reason, `no-applicable-rule`, is the genuine fail-closed case (neither level had a rule or
a `defaultRule`); it is distinct from an explicit `approval-gated` rule with empty approvers.

### D5 — Policy packs (AC3)

`GitDeliveryRepoPolicyPack` and `GitDeliveryOrgPolicyPack` share the same rule structure
(`GitDeliveryPolicyRule`) but differ in scope:

```typescript
interface GitDeliveryPolicyRule {
  readonly actionKind: GitDeliveryActionKind;
  readonly decision: GitDeliveryRuleDecision;
  readonly requiredApprovers?: readonly string[] | undefined; // when "approval-gated"
  readonly constraints?: readonly GitDeliveryConstraint[] | undefined; // when "constrained"
}

interface GitDeliveryDefaultRule {
  readonly decision: GitDeliveryRuleDecision;
  readonly requiredApprovers?: readonly string[] | undefined;
  readonly constraints?: readonly GitDeliveryConstraint[] | undefined;
}

type GitDeliveryRuleDecision = "allowed" | "blocked" | "approval-gated" | "constrained";
```

Both packs carry an optional `defaultRule`. An org or repo authors deny-by-default as data with
`defaultRule: { decision: "blocked" }`. `defaultRule` is validated by the pack parsers with the same
per-decision required fields as a normal rule.

**Per-level resolution.** For a given context, each level resolves to one of
`{ allowed, blocked, approval-gated(approvers), constrained(constraints), none }`: the rule whose
`actionKind` matches wins; otherwise the level's `defaultRule` applies; otherwise the level is
`none`.

**Combination matrix (first match wins; org = O, repo = R).** `evaluateGitPolicy(orgPack, repoPack,
context)` is a pure function (no IO, no clock) implemented via the `resolveLevel` + `combineDecisions`
helpers:

1. `O == blocked` **or** `R == blocked` → `{ outcome: "blocked", reason: "policy-pack-blocked" }`.
2. `O == approval-gated` → `{ outcome: "approval-gated", requiredApprovers: <O approvers> }`.
3. `R == approval-gated` → `{ outcome: "approval-gated", requiredApprovers: <R approvers> }`.
4. `O == constrained` **or** `R == constrained` → `{ outcome: "constrained", constraints: <O constraints first, then R> }`.
5. `O == allowed` **or** `R == allowed` → `{ outcome: "allowed" }`.
6. else (both `none`) → `{ outcome: "blocked", reason: "no-applicable-rule" }` — fail-closed.

Either level can tighten; org tightening dominates a repo loosen; empty packs fail closed.
`requiredApprovers: []` on an **explicit** `approval-gated` rule means "at least one approver of any
identity" and is NOT the fail-closed case — the fail-closed case is `no-applicable-rule` blocked.

`parseGitPolicyPack` / `parseGitRepoPolicyPack` / `parseGitOrgPolicyPack` return the shared
`GitDeliveryParseResult<T>`. `parseGitPolicyPack` discriminates a repo pack from an org pack by the
presence of `repoId` vs `orgId`.

### D6 — Provider-neutral interfaces (AC4)

The four neutral interfaces are:

| Interface | Covers |
|---|---|
| `GitDeliveryBranchProtection` | Deletion allowed, force-push allowed, linear history required, review count required, status checks required (count only, not names) |
| `GitDeliveryChecksState` | Total, passing, failing, pending (counts); overall status as `passing | failing | pending | skipped` |
| `GitDeliveryPullRequestState` | Neutral PR status: `open | closed | merged` (draftness is the orthogonal `isDraft: boolean`, not a status member); base branch name; head branch name; merge readiness reference |
| `GitDeliveryMergeReadiness` | Ready boolean; blocking reason as `GitDeliveryMergeBlockReason` (typed union, not a string); required approval count (number) |
| `GitDeliveryRemoteTargetPolicy` | Allowed push targets as typed GitDeliveryBranchPattern[] (exact/prefix); force-push globally denied boolean |
| `GitDeliveryProviderCapability` | Named capability (`branch-protection | draft-pr | required-checks | merge-queue | protected-branch-delete`) — what the connected provider supports |

**The rule that keeps providers out of the core:** No interface in `git-delivery-provider.ts` may
use a field name, value, or type drawn from a specific provider's API documentation. Provider
adapters (in keiko-workflows or keiko-server, not in keiko-contracts) are responsible for mapping
provider responses to these neutral interfaces. This rule is enforced by code review and by the fact
that keiko-contracts is a leaf package: it cannot import a provider SDK.

GitHub-to-neutral field mapping (documented here so provider adapters have a reference):

| GitHub API field | Neutral field | Location |
|---|---|---|
| `protected` | (drives whether `GitDeliveryBranchProtection` is present) | branch endpoint |
| `allow_deletions.enabled` | `GitDeliveryBranchProtection.deletionAllowed` | branch protection |
| `allow_force_pushes.enabled` | `GitDeliveryBranchProtection.forcePushAllowed` | branch protection |
| `required_linear_history.enabled` | `GitDeliveryBranchProtection.linearHistoryRequired` | branch protection |
| `required_pull_request_reviews.required_approving_review_count` | `GitDeliveryBranchProtection.requiredReviewCount` | branch protection |
| `required_status_checks` (presence + count) | `GitDeliveryBranchProtection.requiredStatusCheckCount` | branch protection |
| `mergeable` + `mergeable_state` | `GitDeliveryMergeReadiness.ready` + `.blockingReason` | PR endpoint |
| `draft` | `GitDeliveryPullRequestState.isDraft` (orthogonal boolean) | PR endpoint |
| `check_runs[*].conclusion` (aggregated) | `GitDeliveryChecksState.{passing,failing,pending,total}` + `.overallStatus` | check-runs endpoint |

### D7 — AC5 boundary enforcement

Two enforcement mechanisms:

**Mechanism 1 — Terminal policy immutability.** The terminal allowlist for `git` in
`terminal-policy.ts` must not grow to include any mutating subcommand. The test file
`terminal-policy.test.ts` gains a new `describe` block (`"AC5 — governed Git delivery boundary
(ADR-0080)"`) that asserts `isTerminalCommandAllowed("git", [...])` returns `allowed: false` for the
REAL underlying mutating/network commands each governed action kind maps to — not a vacuous
kind-name loop. The covered invocations include:

```
commit -m x
push origin main          push --force origin main
merge feat                merge --abort
branch feat/x
add .                     add -A                     (the real stage commands)
restore --staged .        reset HEAD file            (the real unstage commands)
reset --hard HEAD~1       restore .                  (recovery)
rebase main   cherry-pick abc   revert abc   stash   clean -fd   tag v1
switch -c x   checkout -b x   fetch   pull           (rewrite-adjacent / network)
```

A positive control asserts read-only inspection stays allowed (`git status`, `git log` →
`allowed: true`), proving the boundary is selective rather than deny-everything.

**Mechanism 2 — Typed surface separation.** The test asserts that `GIT_DELIVERY_ACTION_KINDS` is a
typed array value importable from `@oscharko-dev/keiko-contracts` and that none of its members
appear as values in `TERMINAL_COMMAND_RULES[*].allowedSubcommands`. This ensures the governed kind
surface and the terminal allowlist are structurally disjoint.

## Consequences

### Positive

- Risk class is DATA embedded in a frozen lookup table; no code ever infers severity from subcommand
  names or shell arguments (AC2 met by construction).
- Policy evaluator is pure and deterministic; the same input always produces the same decision,
  making audit traces reproducible.
- Provider-neutral interfaces mean the GitHub adapter can be replaced or supplemented (GitLab,
  Gitea) without touching core domain types.
- The lifecycle envelope composes AC1's six required elements; as a sound discriminated union,
  `kind === resolvedInputs.kind` holds by construction and is re-checked at parse time, so a kind
  cannot be paired with another kind's inputs.
- The terminal allowlist remains read-only; widening it to enable Git mutations is architecturally
  impossible without touching both keiko-tools and keiko-contracts separately — two files, two
  reviewers.
- Approval tokens reuse the existing `isApprovalTokenShape` pattern; no new token format to audit.

### Negative

- Policy packs must be pre-composed before reaching the evaluator (no runtime DB lookups in the
  contract layer). keiko-server or keiko-workflows must assemble the packs from storage before
  calling `evaluateGitPolicy`. This is correct by the leaf-package rule but is a constraint later
  slices must respect.
- Three new contract files add indexing and barrel surface cost; each new action kind added in
  future issues requires coordinated additions to `GIT_DELIVERY_ACTION_KINDS`,
  `GIT_DELIVERY_ACTION_RISK_DEFAULTS`, and per-kind resolved-input discriminant members.
- Provider adapter authors must maintain the GitHub-to-neutral mapping table as the GitHub API
  evolves. Drift is a known risk.

### Neutral

- The three-file split (`delivery`, `policy`, `provider`) means a single change to add a new
  action kind touches delivery.ts and policy.ts but not provider.ts. A new provider capability
  touches only provider.ts.
- `evaluateGitPolicy` takes org and repo packs as separate parameters (not a merged pack) so call
  sites cannot accidentally merge them before calling and lose the precedence ordering.
- The `GitDeliveryActionEnvelope` union (over `GitDeliveryActionEnvelopeFor<I>` members) avoids the
  earlier phantom-generic / conditional-type construction. It costs one envelope union member per
  action kind, which is mechanical to extend and free of the per-call-site conditional-type
  instantiation cost.

## Alternatives Considered

### Alternative 1: Single `git-delivery.ts` file for all three concerns

- **Pros**: Fewer files; simpler initial import graph; less barrel boilerplate.
- **Cons**: Provider shapes, policy-pack structures, and core action kinds have different rates of
  change and different owners. A GitHub API field name change would require editing the same file
  as a risk-class ordinal update. At the scale of 10+ action kinds, provider neutrality would erode
  by convenience.
- **Why rejected**: Separation of concerns principle; the three concerns are genuinely independent.
  The additional files are a one-time cost; the benefit is permanent.

### Alternative 2: Reuse `WorkflowHandoffRequest` as the lifecycle envelope

- **Pros**: Reuses established approval-token and evidence-reference patterns; no new envelope type;
  implementors already know the shape.
- **Cons**: `WorkflowHandoffRequest` is a one-shot pre-flight envelope for an agent invocation. Git
  delivery is multi-step: the lifecycle has a preview phase (before execution), an approval phase
  (may be async), an execution phase, and a result phase. The `patchScope` and `expectedChecks`
  fields of `WorkflowHandoffRequest` are semantically wrong for a push or a PR merge. Structural
  confusion between the two shapes would produce runtime errors that type-checking cannot catch.
- **Why rejected**: The shapes are semantically incompatible. The approval-token hash and evidence
  reference patterns are reused; the envelope shape is not.

### Alternative 3: Stringly-typed policy packs with free-form constraint strings

- **Pros**: Maximally flexible; operators can express any constraint without a schema change;
  simpler initial type definition.
- **Cons**: Free-form strings cannot be validated at the contract layer; every consumer must parse
  and interpret strings independently, producing multiple subtly incompatible parsers. Audit code
  cannot reason about constraints without string-matching, which is fragile and misleading (AC3
  explicitly prohibits this). Any typo in a constraint string silently falls through.
- **Why rejected**: AC3 explicitly requires typed constraints. The typed constraint union
  (`branch-pattern | provider-capability | risk-class-ceiling`) covers the concrete use cases from
  Issue #471 scope with room to add members as later issues require. Branch patterns themselves are
  structured data (`exact | prefix`), not embedded glob strings — glob is intentionally excluded to
  keep the leaf parse-free.

### Alternative 4: Embed GitHub field names with a translation layer in the same file

- **Pros**: Explicit mapping is readable in one place; no separate adapter layer required for the
  first delivery.
- **Cons**: GitHub field names in keiko-contracts would make every consumer aware of GitHub specifics.
  A field name change in the GitHub API (or addition of a second provider) would force a breaking
  change in the leaf package, cascading to all consumers. The AC4 criterion explicitly requires
  provider neutrality in core contracts.
- **Why rejected**: AC4. Provider adapters belong in keiko-workflows or keiko-server, which can
  import both the contracts and provider SDKs.

### Alternative 5: Risk class as a numeric constant, no named taxonomy

- **Pros**: Simpler comparisons (`riskOrdinal >= 3`); no union type to maintain.
- **Cons**: Numbers carry no documentation; a `3` in an audit log is meaningless without the
  source. Discriminated string literals (`"protected-or-merge"`) are self-documenting in logs, in
  UI labels, and in policy-pack rule conditions. Adding a new class between existing ordinals
  requires renumbering.
- **Why rejected**: Named taxonomy with an explicit ordinal field (`GIT_DELIVERY_RISK_CLASS_SEVERITY`)
  gives both documentation (the name) and arithmetic (the ordinal) without coupling them.

## Related

- ADR-0019: Modular Package Architecture (leaf-package rule, dependency direction)
- ADR-0018: Terminal allowlist (read-only Git baseline being preserved)
- ADR-0043: Enforced Execution Isolation (boundary enforcement model)
- Issue #471: Define governed Git action contracts, policy packs, and risk semantics (this ADR)
- Issue #470: Epic — governed end-to-end Git delivery
- Issues #472–#479: Later children that build on these contracts

## Date

2026-06-25
