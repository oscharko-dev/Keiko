# Governed GitHub Pull Request Command Center (Issue #477)

Epic #470 · ADR-0086 · builds on the #476 governed remote publish gateway.

## Purpose

Turn a published branch into a review-ready GitHub pull request through an explicit, governed workflow
rather than a thin API call. The slice delivers a provider-neutral PR orchestration seam with a
GitHub-first adapter, deterministic metadata synthesis, a readiness model that distinguishes "the remote
PR object exists" from "the PR is ready for review", a draft-versus-ready recommendation, reviewer /
label / linkage suggestions, normalized provider-failure states, and content-free evidence for every PR
operation.

## Architecture

The PR layer is a **parallel** execution authority to the publish gateway — never an extension of it. A
pull request shells `gh api` REST calls, not `git push`; the two are structurally independent (different
binary, output shape, failure taxonomy).

| Layer        | Module                                                                      | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contracts    | `keiko-contracts/src/git-pull-request.ts`                                   | Provider-neutral, content-free leaf: the readiness model (`GitPullRequestReadinessSummary` with `objectExists` / `reviewReady` and severity-ranked blockers), the deterministic metadata synthesizer (`synthesizePullRequestMetadata`), the draft-vs-ready recommendation, reviewer/label/linkage suggestions, and the neutral `GitPullRequestRejectionReason` taxonomy with exhaustive disposition/error-code tables. Pure: no IO, no clock, no provider field names.                                                                                           |
| tools        | `keiko-tools/src/git-pr-gateway.ts`                                         | The pure PR gateway: `GitPullRequestCommand` (carries the actual title/body), the narrow two-method `GitPullRequestAdapter` port, the dedicated `gh api` allowlist (`GIT_PULL_REQUEST_COMMAND_RULES`, subcommand `api` only — no merge, no delete), pure argv builders (`buildPrCreateArgv` / `buildPrUpdateArgv` / the draft-toggle GraphQL builders), `classifyGitPullRequestRejection`, `evaluateGitPullRequestEffectivePolicy`, and `runGitPullRequest` returning a kernel-shaped `GitMutationLifecycleResult` the #474 evidence builder consumes unchanged. |
| tools (Node) | `keiko-tools/src/git-pr-node.ts` (on the `./internal/git-mutation` subpath) | `createNodeGitPullRequestAdapter`: shells `gh api` through the shared no-shell spawn boundary. `gh` reads its own token from the keyring or `GH_TOKEN` / `GITHUB_TOKEN`; Keiko never reads the token value. Output is secret-redacted before classification.                                                                                                                                                                                                                                                                                                     |
| server       | `keiko-server/src/gitDelivery/prExecution.ts` + `prRoutes.ts`               | `POST /api/git-delivery/pr/preview` (read-only metadata + readiness + recommendation + policy) and `POST /api/git-delivery/pr/execute` (governed create/update + evidence). Reuses the policy/evidence path. Default `KEIKO_DEFAULT_PR_POLICY_PACK`.                                                                                                                                                                                                                                                                                                             |
| ui           | `keiko-ui/.../cards/GovernedPullRequestCard.tsx`                            | The PR command center: an editable metadata draft, the readiness panel, the recommendation, reviewer/label/linkage suggestions, and the open/update actions. Inline styles via CSS custom properties (globals.css untouched). Outcome conveyed by text + icon, never colour alone.                                                                                                                                                                                                                                                                               |

## Transport and the token boundary (ADR-0086 D2)

The Node adapter shells `gh api` (no `@octokit` npm dependency). The endpoint allowlist permits only:

- `POST /repos/{owner}/{repo}/pulls` (create)
- `PATCH /repos/{owner}/{repo}/pulls/{number}` (update title / body / base)
- `graphql` `markPullRequestReadyForReview` / `convertPullRequestToDraft` (the REST update endpoint
  cannot toggle draft state)

There is **no** merge, delete, or project-board endpoint in the allowlist (merge is the separate #478).
`gh` authenticates itself; the Keiko process never reads or stores the GitHub token.

## Content-free guarantee (ADR-0086 D3)

PR title and body strings flow command → adapter → GitHub and command → UI (for the editable draft). They
**never** enter the evidence record: the ledger stores only `titleByteLength` / `bodyByteLength` (already
defined on `GitDeliveryPrCreateInputs` / `GitDeliveryPrUpdateInputs`). `synthesizePullRequestMetadata`
accepts no file paths, no diff content, and no commit message bodies — only counts, coarse area tokens,
typed enums, and branch names — so the user-editable draft it produces is a derivation, not raw content.

## Readiness ≠ merge-readiness (ADR-0086 D4)

The readiness model answers two distinct questions the existing preflight and provider types do not
express together:

- `objectExists` — has the provider confirmed the PR remote object exists?
- `reviewReady` — is the PR in a non-draft, non-conflict, non-error state appropriate to request review?

Readiness is a **pure derivation** in the contracts leaf, fed by the provider-state interfaces
(`GitDeliveryPullRequestState`, `GitDeliveryChecksState`, `GitDeliveryMergeReadiness`); it is NOT placed
in the snapshot preflight (which has no network access). Merge-readiness (checks passing, approvals
satisfied) belongs to the #478 merge-governance slice.

## Policy (ADR-0086 D6)

`KEIKO_DEFAULT_PR_POLICY_PACK` permits `pr-create` / `pr-update` whose **base** branch is a legitimate
integration target (`dev`, `main`, `release/*`, `feat/*`) within the `protected-or-merge` ceiling; a base
outside the allow-list is blocked with `policy-pack-blocked`. Per-target approval escalation is a
deployment override (`runGitPullRequest` fully supports the `approval-gated` → `approval-required` path).
The PR surface is always registered. It becomes operational when the project worktree is known, `gh` can
authenticate through its own credential sources, provider readiness is available, and policy allows or
approval-gates the requested action.

## Tests and evidence

- contracts: `git-pull-request.test.ts` (synthesis determinism, readiness derivation, recommendation,
  exhaustive rejection taxonomy, guards).
- tools: `git-pr-gateway.test.ts` (argv builders, GitHub-error classifier, effective policy, lifecycle
  gates with a fake adapter).
- server: `gitDelivery/prRoutes.test.ts` (route guards, policy block, content-free evidence,
  normalized rejection, approval-gated hold — all with a fake adapter, no `gh`, no network).
- ui: `GovernedPullRequestCard.test.tsx` + `.a11y.test.tsx` (metadata seeding, dispatch payloads,
  outcome banner, readable API failure alert, WCAG 2.2 AA).
- browser evidence (non-gating, coordinator): `tests/e2e/config/playwright.issue-477-pr-command-center.config.ts` +
  `tests/e2e/pr-command-center-477.spec.ts` drive the real packaged app, proving the UI PR path reaches
  the governed BFF routes and surfaces the policy block with no client-side escape. Run with
  `npm run test:e2e:pr-command-center-477`. Evidence under `docs/git-delivery/evidence/477/`.
