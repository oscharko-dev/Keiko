# ADR-0086: Governed GitHub Pull Request Gateway and Metadata Orchestration

## Status

Accepted

## Context

Epic #470 has built the governed Git delivery stack through six prior slices:

- ADR-0080 (#471): typed contract surface — action kinds, risk taxonomy, lifecycle envelope, policy evaluator.
- ADR-0081 (#472): mutation kernel — single local execution authority, preflight evaluators, narrow local adapter port.
- ADR-0082 (#473): approval and preview presentation layer — content-free action sheet, BFF projection route.
- ADR-0083 (#474): evidence ledger — bounded append-only record for every terminal outcome, audit-export route.
- ADR-0084 (#475): first end-user-visible local flows — branch / staging / commit with interactive preview and commit-intent composition.
- ADR-0085 (#476): governed publish gateway — dedicated remote push authority with its own allowlist, rejection taxonomy, and policy pack.

Issue #477 adds the **governed pull request layer**: it turns a published branch into a GitHub pull request (create or update) through an explicit, governed workflow with metadata composition, readiness assessment, policy enforcement, and content-free evidence. This is the first slice that interacts directly with a provider API (GitHub) rather than with the local git binary, so the transport model, auth boundary, and failure-classification strategy each require an explicit decision.

Seven forces constrain the design:

**Force 1 — Separate PR orchestration authority, not push-gateway extension.** The ADR-0085 publish gateway is responsible for `git push` operations only; its narrow `GitRemotePublishAdapter` port has a single `publish(req)` method and its allowlist admits only the `push` subcommand. A pull request operation shells `gh api` REST calls (POST/PATCH/GET), not `git push`. Merging PR execution into the push gateway would create false coupling between two structurally independent operations (a git transport and a provider REST call) and would require expanding the push allowlist in ways that violate its one-subcommand invariant.

**Force 2 — Provider neutrality preserved at the contract layer.** GitHub is the first and currently only provider. However, the ADR-0080 rule — no provider field names or values in keiko-contracts — must continue to hold. The neutral rejection-reason taxonomy and readiness model in the contracts leaf must not reference GitHub REST envelope fields (`message`, `errors[].code`, `mergeable_state`, etc.). The GitHub-specific error classifier belongs in keiko-tools.

**Force 3 — Content-free invariant.** PR title and body strings are legitimate user-authored content that must flow from the user through the gateway to GitHub. They must never enter the evidence record. The ADR-0080 contracts already accommodate this: `GitDeliveryPrCreateInputs` and `GitDeliveryPrUpdateInputs` carry `titleByteLength` and `bodyByteLength` (not the strings). Evidence stores only those byte lengths. A metadata synthesizer may produce a deterministic title/body draft from content-free structured facts (commit counts, file counts, coarse area tokens, change-type and risk enums, branch names), but the draft is user-editable before dispatch and is not persisted to evidence.

**Force 4 — No new npm dependency.** `gh` (the GitHub CLI) is installed and authenticated in the deployment environment. Its keyring or environment-variable auth (GH_TOKEN / GITHUB_TOKEN) is used by gh itself; Keiko never reads or handles the token value. An additional npm package (`@octokit/rest`, `octokit`) would add a supply-chain surface, require token management within Keiko's own process, and duplicate capability the authenticated gh binary already provides. The transport boundary must shell `gh api` with a closed REST-endpoint allowlist, exactly as the publish gateway shells `git push` with its closed subcommand allowlist.

**Force 5 — Readiness is not merge-readiness.** The #477 slice produces and updates a pull request; the #478 slice performs the merge. Issue #477 distinguishes two axes the existing preflight and provider types do not express together: whether the PR remote object exists (`objectExists`) and whether the PR is ready for human review (`reviewReady`). These two axes compose into a four-quadrant readiness space that feeds the draft-vs-ready recommendation. Merge-readiness (checks passing, approvals satisfied, no blocking reviews) belongs to the #478 merge-governance slice, not to PR creation or update.

**Force 6 — Provider failure must map to provider-neutral typed tokens.** GitHub's REST API surfaces errors via HTTP status codes (422 Unprocessable Entity, 403 Forbidden, 404 Not Found, 409 Conflict, 503 Service Unavailable) combined with a JSON body envelope (`{message, errors:[{field,code}]}`). These must not be returned raw to the UI or stored raw in evidence. A typed `GitPullRequestRejectionReason` taxonomy plus an exhaustive disposition table gives users a precise recovery path without exposing GitHub vocabulary in the domain layer.

**Force 7 — No merge execution, no project-board mutation.** This slice is the PR command center: create, update, and preview. Merge execution is #478. Project-board mutations, label creation, and branch deletion are out of scope. The architecture must preserve the seams for those slices without committing to their design.

### Scope boundary (Issue #477)

In scope: a dedicated PR gateway in keiko-tools (pure orchestrator + narrow `gh api` adapter port + PR-only endpoint allowlist + PR metadata synthesizer + readiness model + rejection taxonomy); a Node PR executor that shells `gh api` and classifies rejections; a new contracts leaf `git-pull-request.ts` (readiness types, metadata-draft types, rejection taxonomy, pure derivation functions); server PR preview/execute routes reusing the gateway, ledger, and a default-safe PR policy pack; a new sibling UI card `GovernedPullRequestCard.tsx`.

Out of scope: merge execution (#478), force-push, non-GitHub provider rollout (provider-neutral seams are preserved, not implemented for a second provider), project-board mutation, label creation, automatic reviewer assignment beyond structured suggestion types.

### Cross-branch ADR numbering

The governed-git feat branch uses ADR numbers 0058–0064. An independent voice-digital-twin feat branch independently used 0058–0069. These are non-conflicting while both branches are un-merged to `dev`; numbers are per-branch-local until a feat-to-dev PR is opened. The merge coordinator must verify global ADR sequencing on `dev` before merging.

## Decision

We will introduce a new contracts leaf in keiko-contracts, a dedicated PR gateway in keiko-tools, a Node `gh api` executor on the internal subpath, two new server routes reusing the kernel machinery and the ledger, a default-safe PR policy pack, and a new sibling UI card. keiko-contracts existing modules (`git-delivery.ts`, `git-delivery-policy.ts`, `git-delivery-provider.ts`, `git-delivery-evidence.ts`, `git-delivery-action-sheet.ts`) are **not** modified — the existing PR input shapes, execution error codes, and recovery vocabulary they define are sufficient.

### D1 — The PR gateway is a parallel execution authority in keiko-tools, not an extension of the publish gateway

`packages/keiko-tools/src/git-pr-gateway.ts` (pure) defines:

- `GitPullRequestCommand` — a discriminated union of `GitPrCreateCommand` and `GitPrUpdateCommand`. Each carries the actual title/body strings (the content the `git-delivery.ts` inputs deliberately omit), plus all structured operands (`headBranchName`, `baseBranchName`, `isDraft`, `prExternalId`, etc.). The title and body flow command → adapter → GitHub and command → UI (for the editable metadata draft); they never enter evidence.
- `GitPullRequestAdapter` — the narrow provider port with two typed mutation methods (`createPullRequest(req)` and `updatePullRequest(req)`). The same Node adapter also implements `GitPullRequestInspectionAdapter`: bounded `readPullRequest`, `findPullRequestsByHead` and `readBranchHead` reads for issue-bound reconciliation. No generic `run(args)` escape hatch; the port accepts only the typed request shapes, mirroring the ADR-0081 and ADR-0085 narrow-port discipline.
- `GIT_PULL_REQUEST_ALLOWED_SUBCOMMANDS` — a closed allowlist containing only the `api` subcommand of `gh`, and `GIT_PULL_REQUEST_COMMAND_RULES`, which denies the file-input and pagination flags that could read an arbitrary file or walk beyond the targeted resource. Structurally separate from both `GIT_MUTATION_ALLOWED_SUBCOMMANDS` and `GIT_PUBLISH_ALLOWED_SUBCOMMANDS`; adding to one never touches the others. The allowlist does not enumerate REST paths: which endpoints and methods can be reached is decided by the pure argv builders below, because every `gh api` invocation is assembled by exactly one of them.
- `buildPrApiArgv(req)`, `buildPrReadArgv`, `buildPrReadByHeadArgv`, `buildPrReadBranchHeadArgv` and the draft-state GraphQL builders — pure argv builders for `gh api` invocations. Each builder fixes its endpoint and method: `/repos/{owner}/{repo}/pulls` POST (create), `/repos/{owner}/{repo}/pulls/{number}` PATCH (update), the three bounded GET reads (by number, by head branch, branch head), and the two `markPullRequestReadyForReview` / `convertPullRequestToDraft` GraphQL mutations. No builder exists for merge, delete or project-board endpoints, so they are unreachable. Builders validate owner/repo and branch operands (no NUL, no whitespace, no leading `-`, no flag injection) and emit deterministic `gh api --method POST/PATCH ... --field title=... --field body=...` argument arrays. A builder never constructs a URL from unvalidated user input; the endpoint is assembled from validated, typed fields only, and `gitPrArgvIsGoverned` lets tests prove structurally that no argv leaves the `api` subcommand.
- `evaluateGitPullRequestEffectivePolicy(decision, context, inputs)` — the effective policy outcome for a specific PR target, resolving a `constrained` decision's constraints against the target branch (mirrors `evaluateGitPublishEffectivePolicy`).
- `runGitPullRequest(request, deps)` — the PR lifecycle orchestrator. It reuses `evaluateGitPreflight` (pr-create and pr-update already map to `preflightNoLocalPrecondition`; no modification to `git-mutation-preflight.ts`), `evaluateGitPolicy`, and the `GitMutationLifecycleResult` shape (so the #474 evidence builder consumes it unchanged). It returns a `GitPullRequestLifecycleResult` wrapping the lifecycle result with the live rejection reason when the provider rejected the operation.

The local kernel (`runGitMutation`), the local adapter, and the publish gateway (`runGitPublish`) are **unchanged**.

### D2 — Transport is `gh api` subprocess with a dedicated PR endpoint allowlist; no new npm dependency; token never handled by Keiko

`packages/keiko-tools/src/git-pr-node.ts` (Node executor) implements `GitPullRequestAdapter`. It:

- Shells `gh api` using the existing keiko-tools no-shell spawn boundary (`runCommand`, `exec.ts`) with the dedicated `GIT_PULL_REQUEST_COMMAND_RULES` allowlist. The allowlist admits only the `api` subcommand and denies file-input flags; the endpoint and method of every invocation come from the D1 builders (create POST, update PATCH, the bounded GET reads, and the two draft-state GraphQL mutations), which are the only way an argv is produced. No merge, delete, or project-board endpoint has a builder.
- Passes the process environment through (`processEnv: process.env`) so `gh` reads its own token from the keyring or from `GH_TOKEN`/`GITHUB_TOKEN` in the environment. Keiko never reads the token value; it is opaque to the server process.
- Secret-redacts subprocess stdout/stderr before any classification or logging, exactly as the publish node adapter does. Raw API responses never leave the executor. A closed `GitPullRequestIdentity` projection may leave it for UI and durable reconciliation; the lifecycle evidence separately selects only `GitDeliveryExecutionResult` fields.
- Classifies a non-OK HTTP status or non-zero exit via `classifyGitPullRequestRejection`, which matches error tokens in the redacted output and maps them to a typed `GitPullRequestRejectionReason`.

`gh` is treated as an authenticated system binary. Keiko does not perform auth setup and has no auth-token lifecycle; write admission remains bound to the active server-owned runtime Authority Envelope.

Issue-bound create and reconciliation explicitly select `github.com`; ambient `GH_HOST` cannot
redirect them. `canonicalGitHubIdentity: true` selects the same bounded identity projection on
create and returns the number, provider id, canonical URL, repository identities, base/head
refs and full SHAs, state and draft flag. Invalid, truncated or mismatched responses never imply
success. Requests are captured before asynchronous execution. Finding an existing PR queries
all states for the exact owner/head, returns at most two matches, and deliberately omits a base
filter so a retargeted or closed PR is visible. A separate exact branch-reference read returns
only a commit SHA. Provider read failures and malformed responses stay typed; no title/body or
credential fields enter this projection. A successful create response is one observation, not
an atomic expected-head guarantee: the issue-bound owner must re-read remote state before
recording exact-revision success.

### D3 — Content-free guarantee preserved; metadata synthesis produces a deterministic, user-editable draft from structured facts

Evidence records contain only `titleByteLength` and `bodyByteLength` (reusing the fields already defined on `GitDeliveryPrCreateInputs` and `GitDeliveryPrUpdateInputs`). The actual title and body strings flow command → adapter → GitHub and command → UI (for the metadata-editor surface), but never into the evidence record or any content-free wire payload.

The new contracts leaf `git-pull-request.ts` defines:

- `GitPullRequestChangeNarrative` — a content-free structured summary of the change set: `commitCount`, `fileCount`, a small frozen array of coarse area tokens (`areas: readonly string[]`, bounded at production to ≤ 5 tokens derived from top-level path segments), `touchesTests: boolean`, and `changeType: GitPrChangeType` (a typed enum: `feat | fix | refactor | docs | chore | test | mixed`).
- `GitPullRequestRiskDigest` — derived from the existing `GitDeliveryRiskClass` and the policy decision: `riskClass`, `riskSeverity`, `policyOutcome`, `isDraft: boolean`.
- `synthesizePullRequestMetadata(narrative, riskDigest, headBranch, baseBranch)` — a **pure, deterministic** function in the contracts leaf that produces a `GitPullRequestMetadataDraft`. The draft carries a `composedTitle` (≤ 72 bytes, assembled from `changeType`, the dominant area token, and commit count), structured body sections (`summarySection`, `riskSection`, `changeNarrativeSection` — each a typed record, not a free string), and a `riskNarrative` (a human-readable string composed from typed enums only, never from diff content). The draft is user-editable in the UI before dispatch; the composed strings are suggestions, not mandates.

This design satisfies the content-free invariant by construction: `synthesizePullRequestMetadata` accepts no file paths, no diff content, no commit message bodies, and no raw subprocess output. Its inputs are counts, area tokens, enums, and branch names.

### D4 — Readiness distinguishes object-existence from review-readiness; readiness is a pure derivation in the contracts leaf, not in snapshot preflight

A new `GitPullRequestReadinessSummary` in `git-pull-request.ts` carries:

- `schemaVersion: typeof GIT_PULL_REQUEST_SCHEMA_VERSION` — pinned literal.
- `objectExists: boolean` — whether the PR remote object has been confirmed to exist on the provider (fed by a provider snapshot, not derived from the local worktree).
- `reviewReady: boolean` — whether the PR is in a non-draft, non-conflict, non-error state and is appropriate to request review on. This is the AC3 "ready for review" distinction.
- `blockers: readonly GitPullRequestReadinessBlocker[]` — a severity-ranked list of structured blockers, each with a `code: GitPullRequestReadinessBlockerCode`, `severity: "blocking" | "advisory"`, and `remediation: "user-actionable" | "internal"`.

`GitPullRequestReadinessBlockerCode` is a closed union over the concrete blocker codes: `head-unpublished | base-missing | head-equals-base | draft-pr | required-checks-failing | approval-insufficient | merge-conflict | provider-error`.

The pure functions `gitPullRequestReadinessFor(providerState, prCreateInputs)` and `gitPullRequestRecommendationFor(readiness, riskDigest)` derive readiness and a draft-vs-ready recommendation respectively from the provider state facts and the risk digest. Both are in the contracts leaf: no IO, no clock, no network. The server gathers provider facts via the `GitDeliveryPullRequestState`, `GitDeliveryChecksState`, and `GitDeliveryMergeReadiness` interfaces (already defined in `git-delivery-provider.ts`) and passes them as inputs; the leaf performs only the pure derivation.

This split keeps readiness derivation testable without a running server and avoids the temptation to conflate PR creation readiness with merge readiness (a #478 concern). The existing `preflightNoLocalPrecondition` in `git-mutation-preflight.ts` is **not modified**: pr-create and pr-update have no snapshot-derivable local precondition, which remains correct. Provider-side readiness is a separate, later derivation step.

### D5 — Provider-failure normalization: neutral rejection-reason enum in contracts leaf, raw GitHub classifier in keiko-tools

`GitPullRequestRejectionReason` is a closed union in `git-pull-request.ts`: `already-exists | base-missing | head-unpublished | validation-error | permission-denied | not-found | rate-limited | provider-unavailable | unknown`. The contracts leaf also defines exhaustive disposition and error-code tables (`GIT_PR_REJECTION_ERROR_CODE`, `GIT_PR_REJECTION_DISPOSITION`) mapping every reason to a `GitDeliveryExecutionErrorCode` and a `GitDeliveryRecoveryDisposition` (both reused from existing contracts).

`classifyGitPullRequestRejection(output: string): GitPullRequestRejectionReason` lives in `git-pr-gateway.ts` (keiko-tools), not in the contracts leaf. It matches GitHub's English error tokens (from the redacted subprocess output: HTTP status lines, `message:` lines, `errors[].code` tokens) against a phrase table. The owning-layer split mirrors the action-sheet pattern: the neutral enum and disposition tables live in the contracts leaf (change slowly, are test-driven in isolation), while the GitHub-specific phrase matcher lives in keiko-tools (changes as the GitHub API evolves, is tested with realistic output fixtures).

Raw subprocess output never crosses the executor boundary. Only the typed reason, the contract error code, and the recovery hint are returned from the adapter.

### D6 — Default PR policy pack (server): pr-create and pr-update constrained by base-branch namespace and active Authority Envelope

`KEIKO_DEFAULT_PR_POLICY_PACK` (server, alongside `KEIKO_DEFAULT_PUBLISH_POLICY_PACK` and `KEIKO_DEFAULT_LOCAL_GIT_POLICY_PACK`) authorises `pr-create` and `pr-update` as `constrained` by two constraints:

1. A `risk-class-ceiling` of `protected-or-merge` — the natural ceiling for PR operations (risk class 3), which permits pr-create/pr-update (both at class 3 by default) and blocks anything above (recovery-or-rewrite at class 4).
2. A `branch-pattern` allow-list for the **base** branch: `dev`, `main`, a `release/` prefix, and a `feat/` prefix — the shared integration targets this deployment considers legitimate PR bases (opening a PR *to* a protected base is a governed, normal operation, in contrast to a direct push to one, which the #476 publish pack blocks). A PR whose base branch falls outside this list is blocked with `policy-pack-blocked`.

The policy evaluator (`evaluateGitPolicy`) selects a rule by `actionKind`, then the PR gateway resolves a `constrained` decision's branch-pattern against the base target. Per-target approval escalation (requiring a human approval token before opening a PR to a specific protected base) is therefore expressed by a deployment-supplied override pack with an `approval-gated` rule, not by the default pack: `runGitPullRequest` fully supports the `approval-gated` → `approval-required` path (a unit test injects such a pack and asserts the adapter is never called without a valid token). Keeping the default pack `constrained` rather than `approval-gated` reflects that the governed gate for *merging* (where approvals belong) is the #478 slice; opening or updating a PR to a known integration base is itself the reviewable artifact.

The default pack is fail-closed: all action kinds not explicitly covered by a rule fall through to the `defaultRule: { decision: "blocked" }`. Governed PR delivery additionally requires a current server-owned runtime Authority Envelope; no environment switch grants delivery authority.

That Authority Envelope is checked again immediately before provider dispatch. A continuity denial
returns the correlated 403 contract without spawning and is retained in the shared mutation ledger as
`blocked` / `authority-denied` / `policy-forbidden`; PR success, governance blocks, provider rejection,
and snapshot failures also emit through the shared body-free activity-log lifecycle.

Force-push for a PR update (e.g. force-updating the head branch after a rebase) is out of scope for this slice. The PR gateway has no force operand; any head-branch force push must use the ADR-0085 publish gateway with a future explicit policy path.

### D7 — A new sibling card GovernedPullRequestCard.tsx, not an extension of GovernedGitFlowCard

We will introduce `GovernedPullRequestCard.tsx` as a new sibling card registered in the `WindowsRegistry` under a new `"governedPullRequest"` window kind, rather than adding a pull request section to the existing `GovernedGitFlowCard`.

The rationale is threefold:

1. **Card scope and size.** `GovernedGitFlowCard` already has four sections (Branch, Staging, Commit, Publish); it is currently 700+ LOC. A full PR surface (metadata editor, readiness summary, blockers, actions, policy explanation) would push it past the 1000-LOC god-module threshold (ADR-0019 D6 guidance) and would make the test surface unseparable: a change to the commit-intent display would risk the PR-readiness tests and vice versa.
2. **Lifecycle independence.** The PR workflow starts from "after a publish" — it is logically downstream of the push, not a phase of the branch→stage→commit→push sequence. A separate card can be opened independently (to update an existing PR without going through the local flow) and can survive across sessions without coupling to the local-flow state machine.
3. **Test separability.** Integration tests for the PR card (server-layer tests with a fake `GitPullRequestAdapter` seam, Playwright preview tests) are independent of the GovernedGitFlowCard test suite. Mixing them in a single component would require separate describe blocks at minimum and shared fixture state at worst.

The `GovernedPullRequestCard` is launched from the "PR" action button in the Publish section of `GovernedGitFlowCard` (a `registerOpenWindow("governedPullRequest", ...)` call), preserving the user's governed flow context without bloating the existing card. The governed publish state (head branch name, remote alias) is passed as initial props.

`globals.css` is **not modified** (ADR-0051 gate). All card styling uses inline styles via existing CSS custom properties (`var(--space-4)`, `var(--fg-muted)`, `var(--text-body-sm)`, etc.), mirroring the pattern established in `GovernedGitFlowCard.tsx`.

### D8 — AC5 test strategy: fake-adapter integration tests gate CI; Playwright e2e covers the read-only preview and blocked states

**Server integration tests** (`packages/keiko-server/src/gitDelivery/prRoutes.test.ts`) inject a deterministic fake `GitPullRequestAdapter` seam (no `gh` subprocess, no network). They assert:
- Policy-awareness: a PR whose base is outside the allowed-namespace constraint is blocked with `policy-pack-blocked` before the adapter is called.
- Evidence append: a `succeeded` execute path records a content-free evidence record with `titleByteLength`/`bodyByteLength` but no title/body strings.
- Error-code projection: a fake adapter returning `rejection-reason: "validation-error"` produces the correct `provider-rejected` error code in the response.
- Approval-gated escalation: a PR targeting a `main` base without an approval token returns `approval-required` from the execute route.

These tests run in the `ci` job (the required gating check) and require no live GitHub credentials.

**Playwright e2e** (non-gating, coordinator evidence, `tests/e2e/config/playwright.issue-477-pr-command-center.config.ts`, `test:e2e:pr-command-center-477`): drives the real packaged app to assert the read-only preview path (policy outcome display, readiness blockers, metadata-draft editor render) and the blocked state when the base branch is outside the policy namespace. No live `gh api` calls are made in CI.

### D9 — Issue-bound template seed and trusted closing reference

Issue-bound Workbench draft creation resolves only repository defaults at the root, `.github`
or `docs` through the existing governed workspace read. Discovery is capped at 1,024 directory
entries per location; case-insensitive `pull_request_template` names with `.md`, `.txt` or no
extension are accepted. Custom-template collections are not selected. Multiple defaults,
unsupported defaults, read/alias/encoding failures, files larger than 32,768 UTF-8 bytes,
redaction-changing content, unsafe format characters or existing managed markers fail closed.
Accepted template bytes remain outside the contracts-owned empty versioned region, followed
by one server-generated `Closes #N` from the frozen `CodingWorkbenchIssueBinding`.

Untrusted title/template closing directives are rejected by the shared contracts scan; commit
messages use that same scan. Subsequent managed-region replacement must preserve the trusted
closing line and all other outside bytes. Branch-inferred `Refs` remain advisory in the generic
flow and never become closing directives. An accepted server-owned issue binding is the sole
source of an automatic closing reference. The issue-bound default base comes from the verified
workspace provision; branch-name inference and model text cannot select it. Existing generic
policy and metadata behavior remain available.

The owning runtime snapshot schema retains a bounded `DraftDeliveryRecord` alongside the verified
commit, with an independent compare-and-swap revision and explicit push/PR/recovery phases.
It binds the run, authority and workspace digests, frozen issue, origin, exact base/head,
verified proposal and recovery identity. It contains no title, body, credential or reusable
approval. Upgrading a populated schema 23 to 24 preserves its issue and verified commit. A
restart may restore these observations; it must not recreate authority or replay an effect.

A fresh accepted retry may adopt only the matching durable intent of its acknowledged, released
predecessor. The store follows at most 32 same-task, same-workspace, same-issue predecessor links
to the original successful verified-commit receipt; cycles, missing provenance and target changes
are refused. Adoption installs a new `recovery-required` record under the new run and authority,
without copying approval or a successful commit into that run. Reconciliation must precede another
effect proposal. Referenced predecessor snapshots are retained against pruning so retry cannot
silently lose its verification source.

### D10 — A dedicated `pr-description-apply` action kind, its own mint route, and a description authority that admits it outside a running Code task (#3399, epic #3384 correction 4)

V1 places a validated, Model-Gateway-generated description into the one versioned managed body
region without title, base, or draft-state authority. `GitPullRequestAdapter.updatePullRequest`
always patches title, body and base together and may toggle draft state, so it is not safe for
this body-only guarantee. The apply is a distinct `GitDeliveryActionKind` —
`"pr-description-apply"` — never a reuse of `"pr-update"`: a shared kind would let the policy-pack
layer hold only one decision for two operations with different blast radii (full metadata mutation
versus a byte-bounded body region), collapsing a real authority distinction the pack exists to
express. `KEIKO_DEFAULT_PR_POLICY_PACK` carries an explicit `approval-gated` rule for it
(`requiredApprovers: []`, ADR-0080 D5's "any approver" shape), mirroring `pr-create`/`pr-update`'s
entries; its real, unconditional enforcement is the description service's own approval
continuation (`PrDescriptionApprovals`, mint via `issueApproval`, redeem via
`consumeApproval`/`executeApproved`) at the route/service layer, exactly as the commit, push, and
PR mint routes (`/api/git-delivery/{commit,push,pr}/approve`) enforce ADR-0138 D2 unconditionally
rather than through the pack's own decision — `evaluateGitPullRequestEffectivePolicy`
(keiko-tools/git-pr-gateway.ts) remains closed over `"pr-create" | "pr-update"`, so the pack rule
does not (yet) reach that kernel evaluator; the description service's own base-branch check reuses
the `pr-update` constraint as a documented proxy pending that kernel's own extension.

The apply is reachable from two admission sources. Under a running Code task, the existing
run-bound `gitDeliveryAuthorityGate` for the `"pull-request"` operation admits it exactly as it
already admits `pr-create`/`pr-update`. Outside a running run — a Git-connected Chat turn or a
post-terminal Workbench job — `authorizeGitDelivery` (runBoundAuthority.ts) additionally accepts a
server-minted, bounded **description authority** (`CodingRuntimeAuthorityService`, the same owner
as `ActiveGitDeliveryRunAuthority`) for this one operation only. The authority is minted for a
single immutable `(remoteDigest, PR identity or base/head pair, snapshotDigest)` scope, its
`effectiveMode` is `resolveEffectiveCodingWorkbenchMode(requested, deploymentCeiling)`, and it
carries no workspace-write or command action classes — a scope change, TTL expiry, or explicit
revocation removes it, and admission always re-derives the scope fresh rather than trusting a
value cached at a prior call. The SAME authority separately admits model egress of snapshot
content for description generation (`authorizeGitDeliveryModelEgress`), since that effect has no
Git operation shape (no argv, adapter, or branch target) to gate through
`GitDeliveryAuthorityRequest.operation`. `prDescriptionRoutes.ts` composes one stateful
`PrDescriptionApplicationService` per (project, repository, PR), created lazily and reused across
the preview → approve → apply lifecycle so the in-flight proposal and its approval continuation
survive across the separate HTTP calls; the `context()` provider re-derives admission fresh on
every internal call rather than caching it, so a revoked or drifted authority is observed on the
very next call. Full production composition of description generation (Model Gateway config and
capability) remains #3398's scope; until composed, the route fails closed as unavailable rather
than degrading to a fabricated or unvalidated description.

### D11 — A dedicated `pr-mark-ready` action kind and approval operation close the approval-less draft->ready transition; no title/body/base PATCH is bundled with the mutation (#3389, epic #3384 corrections 1/2/7)

The generic `pr-update` command's `convertFromDraft` flag reached the draft->ready GraphQL
mutation (`buildPrMarkReadyGraphqlArgv`) under the run-bound authority gate alone: the mint route
that exists for `pr-create`/`pr-update` (`POST /api/git-delivery/pr/approve`, D1/D2) binds a claim
to the exact `GitPullRequestCommand`, but that binding carries no readiness digest, no draft-state
invariant, and no re-verified base/head SHA — it proves "this exact title/body/base/draft-flag
combination was approved," not "the PR was observed still a draft at these exact commits when the
human approved marking it ready." A claim minted for an ordinary metadata edit was therefore
indistinguishable, at the approval layer, from a claim for the ready-for-review transition. Since
D10 already established that one action kind cannot honestly carry two different blast radii under
one policy decision, the same reasoning applies here with a sharper edge: `pr-update` is
`constrained` by base-branch namespace (D6); `pr-mark-ready` is a one-way, human-facing readiness
signal to the outside world that deserves its own approval-gated decision, its own bound facts, and
its own execution path.

`GitDeliveryActionKind` gains `"pr-mark-ready"`, `GitDeliveryApprovalOperation` gains a distinct
`"pr-mark-ready"` member (never redeemable by a claim minted for the generic `"pr"` operation, and
vice versa — a claim's binding hash covers `operation` alongside `command`), and
`KEIKO_DEFAULT_PR_POLICY_PACK` carries an explicit `approval-gated` rule for it (`requiredApprovers:
[]`, the same ADR-0080 D5 shape D10 uses), mirroring D10's own note that this pack rule is
documentation and mintability parity — the real, unconditional enforcement is the mark-ready
execute route's own claim resolution (`prMarkReadyExecution.ts`), exactly as commit, push, PR, and
PR-description-apply enforce ADR-0138 D2 at their own route layer rather than through the pack's
decision. `packages/keiko-server/src/gitDelivery/prRoutes.ts` closes the approval-less path at
request validation: a `pr-update` command with `convertFromDraft: true` is rejected unconditionally
(`GIT_DELIVERY_PR_BAD_REQUEST`), before any approval is even consulted — the transition is
reachable only through `POST /api/git-delivery/pr/mark-ready/{approve,execute}`. `convertToDraft`
(ready->draft) is unaffected; it remains a legitimate `pr-update` field.

The mint (`/mark-ready/approve`) performs no IO: it binds the caller-supplied `ownerAndRepo`, PR
number, base/head SHA and a readiness digest (the CI-readiness `requirementsDigest` the caller's
most recent read produced) into the claim, plus a server-computed `remoteDigest`
(`codingWorkbenchRemoteDigest`, epic #3384 correction 6 — every same-repository match keys on the
canonical remote identity, never the per-checkout `repositoryId`) and a `transitionPayloadDigest`
scoping the claim to this exact PR's fixed transition shape. The execute route
(`GitPullRequestMarkReadyAdapter.markPullRequestReady`, `git-pr-node.ts`) is a NEW, narrower port —
deliberately separate from `GitPullRequestAdapter` — that never PATCHes title, body or base: it
re-reads the live `GitPullRequestIdentity` (the same canonical read D2's `readPullRequest` already
performs) IMMEDIATELY BEFORE the mutation and refuses with `precondition-failed` (no spawn beyond
the read) unless the observed head/base SHA match the claim and the PR is still a draft; runs ONLY
the existing `buildPrMarkReadyGraphqlArgv` mutation; then re-reads the identity again and reports
`succeeded` only when the read-back confirms `isDraft === false` on the same head. A `gh` exit code
of `0` alone never proves the transition — only the read-back does. Any mismatch at either read
revokes the claim's effect and performs nothing further; the claim itself remains exactly one-use
via the existing approval-store `consume()` regardless of the adapter outcome, so a claim that hits
drift can never be retried against the same or a different PR revision.

The coding runtime exposes neither merge, auto-merge scheduling, nor issue-close mutations through
this or any other route: the mark-ready adapter's only possible spawns are the canonical PR-identity
read and the fixed `markPullRequestReadyForReview` mutation, both pinned structurally in
`git-pr-node.test.ts`.

## Consequences

### Positive

- PR orchestration becomes governed end-to-end (policy, approval, evidence) with no second policy system, no new evidence schema, and no npm dependency — the `gh` binary's keyring auth and the kernel's pure machinery are reused.
- The content-free invariant is preserved by construction: title and body never enter evidence; `synthesizePullRequestMetadata` accepts no raw content; the rejection classifier operates only on redacted output.
- Readiness (object-exists, review-ready, blockers) is a pure derivation in the contracts leaf, testable without a running server or a live GitHub connection.
- The PR card is a first-class workspace window with its own lifecycle, not a section in an already-complex card. Test surfaces are separable.
- The narrow `GitPullRequestAdapter` port is the seam for a future non-gh transport (direct octokit, GitLab adapter, etc.) without touching the gateway orchestrator.

### Negative

- Shelling `gh api` adds a new subprocess dependency. Unlike `git`, `gh` must be separately installed and authenticated. If `gh` is absent or unauthenticated, the PR gateway will produce an `internal-error` or `permission-denied` at execution time; there is no pre-flight check for `gh` availability (reachability is classified at execution time, consistent with ADR-0085's treatment of remote availability).
- A new `"governedPullRequest"` window kind in `WindowsRegistry` adds two new registration entries (descriptor meta + window renderer), maintaining the same registration overhead as the existing governed-git window.
- Metadata synthesis (`synthesizePullRequestMetadata`) produces deterministic drafts from a small vocabulary. Teams with non-conventional branch-name patterns or uncommon area-token sets will get less useful title suggestions. The draft is always user-editable; the synthesis is advisory.

### Neutral

- The PR allowlist (`GIT_PULL_REQUEST_COMMAND_RULES`) is structurally independent of the push allowlist and the read-only inspection rules. Adding a PR sub-path (e.g. for fetching PR reviews in a future slice) touches only the PR rules.
- `KEIKO_DEFAULT_PR_POLICY_PACK` encodes this repository's base-branch conventions. A deployment with different conventions overrides it via injected server config; no default behaviour changes until governed git delivery is explicitly enabled.
- The governed-git branch uses ADR numbers 0058–0064; the merge coordinator resolves the global sequence at feat-to-dev merge.

## Alternatives Considered

### Alternative 1: Extend the publish gateway (git-publish-gateway.ts) to handle PR operations

- **Pros**: One gateway file; reuses the existing `GitRemotePublishAdapter` port pattern and the publish allowlist infrastructure.
- **Cons**: The publish gateway shells `git push`; a PR operation shells `gh api`. These are structurally different: different binaries, different subprocess outputs, different rejection taxonomies, different argv-building concerns. Merging them into one file would require the allowlist to cover both `push` subcommands and `gh api` endpoint patterns, eroding the one-subcommand invariant that makes the publish allowlist auditable. The narrow publish port (`publish(req)`) cannot accommodate the two-method PR port (`createPullRequest`, `updatePullRequest`) without becoming a union type or a generic method — either of which reintroduces the escape hatch the narrow-port discipline was designed to prevent.
- **Why rejected**: Force 1. The two operations are independent in command, binary, output shape, and failure taxonomy. Structural independence is the right boundary; a thin shared pattern (narrow port, dedicated allowlist, lifecycle orchestrator) is sufficient reuse.

### Alternative 2: Add @octokit/rest (or octokit) as an npm dependency

- **Pros**: Type-safe API client; no subprocess; richer response types; native TypeScript; no `gh` install requirement.
- **Cons**: Adds a supply-chain surface (octokit is maintained externally; its transitive dependencies change). Requires Keiko to read and manage the GitHub token value (breaking the "token never handled by Keiko" invariant of Force 4). Token handling in-process introduces a new secret-management concern: the token can appear in memory dumps, structured logs, and error traces if not redacted everywhere it flows. The gh binary's keyring integration (on macOS/Linux) handles this boundary by design.
- **Why rejected**: Force 4. The `gh api` subprocess transport preserves the token-isolation invariant at the process boundary, exactly as `git push` authenticates via git's credential helper without Keiko ever seeing the credential. Adding a library means Keiko's process becomes the token custodian; that is a security posture change that requires its own explicit ADR decision.

### Alternative 3: Put PR readiness derivation inside git-mutation-preflight.ts (as a new preflight kind)

- **Pros**: One location for all preflight logic; preflight already handles pr-create and pr-update (even if trivially via `preflightNoLocalPrecondition`); readiness could extend the existing finding vocabulary.
- **Cons**: The `GitWorktreeSnapshot` (the preflight input) carries local git facts (staged count, behind count, current branch name). Provider state (whether a PR object exists on GitHub, whether checks are passing, whether approvals are satisfied) is not derivable from the local snapshot without a network call. Forcing provider facts into the preflight evaluator either requires a new network-reading preflight path (contradicting the preflight invariant that it is a pure derivation over local snapshot data) or requires threading provider state through the snapshot (widening `GitWorktreeSnapshot` in ways that couple local snapshot reading to provider API calls). `preflightNoLocalPrecondition` correctly returns no findings for pr-create/pr-update; the distinction between "no local precondition" and "provider says head branch is unpublished" is a genuine semantic gap that belongs in a separate readiness model.
- **Why rejected**: Force 5 (readiness is not a local precondition). Readiness is a pure derivation over provider state facts that the server gathers separately. Placing it in the contracts leaf as a standalone pure function keeps the preflight invariant intact and makes readiness testable without a snapshot reader.

### Alternative 4: Extend GovernedGitFlowCard with a pull request accordion section

- **Pros**: One card, one window kind; the user's governed flow context (head branch, remote) is immediately available without cross-window communication.
- **Cons**: `GovernedGitFlowCard` is already 700+ LOC with four sections. Adding a full PR surface (metadata editor, readiness summary, blockers, policy explanation, preview/execute actions) would push it past 1000 LOC. The PR lifecycle (create/update/close) is independent of the local flow lifecycle (branch/stage/commit/push): a user updating an existing PR has no reason to navigate through the local-flow sections. A single card mixes two distinct user-intent flows with different data dependencies, making testing harder (one fake adapter seam would need to cover both local-mutation and PR operations) and making state management more complex (the local-flow state machine and the PR state machine are independent).
- **Why rejected**: D7. Lifecycle independence, test separability, and god-module avoidance collectively outweigh the minor convenience of single-card co-location. The GovernedPullRequestCard is launched from the Publish section of GovernedGitFlowCard, preserving the flow without bloating the existing card.

## Related

- ADR-0080: Governed Git delivery contracts (PR input shapes, execution error codes, recovery vocabulary reused unchanged; provider-neutral PR state interfaces reused)
- ADR-0081: Governed Git mutation execution kernel (preflight pr-create/pr-update → `preflightNoLocalPrecondition` unchanged; lifecycle result shape reused)
- ADR-0082: Governed Git approval and preview surface (read-only BFF preview pattern; action-sheet recovery vocabulary reused)
- ADR-0083: Governed Git mutation evidence ledger (`recordGitDeliveryMutationEvidence` / `buildGitDeliveryEvidenceRecord` pr-create/pr-update projection reused)
- ADR-0084: Governed local Git flows (GovernedGitFlowCard extended with "PR" launch button in Publish section)
- ADR-0085: Governed remote publish gateway (parallel gateway pattern mirrored; publish gateway unchanged)
- ADR-0019: Modular Package Architecture (leaf-package rule; dependency direction; `arch:check`; god-module threshold)
- ADR-0051: Design System visual-regression and acceptance gate (globals.css untouched; inline CSS vars only)
- ADR-0043: Enforced Execution Isolation (sandbox network policy; `gh api` uses `inherit` network, same as push)
- Issue #477: GitHub-first pull request command center and metadata orchestration (this ADR)
- Issue #478: Merge governance (next child; extends provider execution; NOT in this slice)
- Issue #470: Epic — governed end-to-end Git delivery
- ADR-0087: Governed merge gateway (downstream merge authority and protected-branch enforcement)
- ADR-0138: Monotonic product-wide autonomy semantics (the mint-route-plus-unconditional-approval
  pattern D10's `pr-description-apply` follows, mirroring the commit/push/PR mint routes)
- Epic #3384 / Issue #3399: Apply a managed Keiko description through the governed pull request
  update path (D10's action kind, mint route, and description authority)

## Date

2026-06-26


The draft ledger retains its original successful commit receipt internally, independently of
subsequent commit proposals. A new verified head updates that proof atomically with the draft
record. Restart validates the retained proof through the acknowledged bounded predecessor lineage
and never restores approval. Schema v25 adds the bounded internal receipt column; the existing
v23/v24 migration text remains unchanged, and the source receipt is absent from public snapshots.

For a pre-v25 row whose latest result is still a valid successful commit, the existing validated
receipt can seed this retained source. If an earlier version already replaced that success with a
failed or pending result and stored no source receipt, migration cannot reconstruct the missing
proof. Delivery fails closed and requires fresh verification and an approved commit; a pending
proposal's parent SHA is never accepted as a substitute for a successful commit receipt.
