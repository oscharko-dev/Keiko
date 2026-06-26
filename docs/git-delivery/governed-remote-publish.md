# Governed Remote Publish (Issue #476)

The governed publish layer turns local commit completion into safe remote delivery. `git push` is no
longer a raw transport call: it is a controlled publish workflow with explicit preview, policy
enforcement, and recovery semantics. This is the point where local quality meets shared-team risk, so
the controls become stricter, not looser.

See ADR-0085 for the design rationale and the boundary decisions.

## Architecture

Remote push is executed by a **separate publish gateway**, never the local mutation adapter (which stays
network-free). The gateway reuses the kernel's pure machinery — preflight, policy evaluation, the
lifecycle-result shape, and the evidence builder — so there is no second policy system and no second
evidence schema.

| Layer        | Module                         | Responsibility                                                                                                                                                       |
| ------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contracts    | `git-delivery*.ts` (unchanged) | push input shape, execution error codes, recovery vocabulary                                                                                                         |
| tools (pure) | `git-publish-gateway.ts`       | `GitPushCommand`, narrow `GitRemotePublishAdapter` port, dedicated push allowlist, `buildPushArgv` (force refused), rejection taxonomy, `runGitPublish` orchestrator |
| tools (Node) | `git-publish-node.ts`          | `createNodeGitPublishAdapter` — runs `git push` through the no-shell spawn boundary with the dedicated allowlist; classifies rejections from git output              |
| tools (pure) | `git-mutation-preflight.ts`    | adds the `non-fast-forward` finding to the push preflight                                                                                                            |
| server       | `pushExecution.ts`             | `executeGovernedPublish`, the default-safe publish policy pack, preview/response projections                                                                         |
| server       | `pushRoutes.ts`                | `POST /api/git-delivery/push/preview` (read-only) and `POST /api/git-delivery/push/execute` (governed)                                                               |
| ui           | `GovernedGitFlowCard.tsx`      | a Publish section: remote/branch inputs, preview, and governed push                                                                                                  |

## Endpoints

### `POST /api/git-delivery/push/preview` (read-only)

Builds the pre-publish risk context from a live worktree snapshot: the remote target, the risk class,
`wouldCreateRemoteBranch` / `forceBlocked` flags, the preflight findings (including `non-fast-forward`
and `no-upstream-configured`), and the **effective** policy outcome for that specific target. Never
mutates, never records evidence.

### `POST /api/git-delivery/push/execute` (governed)

Drives `runGitPublish` end-to-end: preflight → policy → approval → the dedicated push adapter. A
content-free evidence record is appended for **every** terminal outcome (allowed and blocked alike).
A rejected push returns the typed `publishRejectionReason` plus a reused recovery disposition and action
hint so the user can recover without guessing.

Both routes are gated by the `KEIKO_GIT_DELIVERY_ENABLED` capability flag (404 when disabled), bounded
and credential-shape-scanned at the boundary, and CSRF-protected by the central server gate.

## Policy: protected and shared targets are stricter (AC2)

`KEIKO_DEFAULT_PUBLISH_POLICY_PACK` authorises `push` as `constrained` by two constraints:

- a `risk-class-ceiling` of `publish` — which fail-closed **blocks force pushes** (force escalates the
  push to the `recovery-or-rewrite` risk class, which exceeds the publish ceiling); and
- a `branch-pattern` allow-list of safe publish namespaces: `claude/`, `feat/`, `fix/`, `chore/`,
  `docs/`.

A push whose **remote** target does not match a safe namespace — `dev`, `main`, `release/*`, or any
other shared/protected branch — fails the branch-pattern constraint and is blocked with
`policy-pack-blocked`. Protected and shared targets are therefore treated more strictly than ordinary
user branches, purely by policy data. A deployment that prefers approval-gating (rather than blocking)
for a protected target authors a pack with an `approval-gated` rule; the evaluator already supports it.

## Force push is blocked by default (AC4)

Force-relevant or history-rewrite-adjacent publishing is blocked by two independent mechanisms:

1. the publish risk ceiling denies it (force is `recovery-or-rewrite`, severity 4 > publish, 2); and
2. `buildPushArgv` refuses to build any force argv (throws on `forcePush === true`).

There is no force path in #476. A future ADR can introduce a governed force path with its own controls
(the "explicit future policy path" the acceptance criterion anticipates).

## Recovery and rejection taxonomy (AC3 / Deliverable 3)

`GitPublishRejectionReason` is a closed union: `non-fast-forward`, `fetch-first`, `no-upstream`,
`auth-failed`, `permission-denied`, `protected-ref`, `remote-unavailable`, `unknown`. The Node executor
classifies a non-zero `git push` exit by matching git's own English status phrases in the
secret-redacted output, then maps the reason to a content-free `GitDeliveryExecutionErrorCode` (recorded
in evidence) and a reused `GitDeliveryRecoveryHint` (disposition + action hint) surfaced live. Raw stderr
never crosses the boundary — only the typed reason, error code, and recovery hint.

| Reason               | Error code            | Disposition  | Action hint                               |
| -------------------- | --------------------- | ------------ | ----------------------------------------- |
| `non-fast-forward`   | `precondition-failed` | user-fixable | resolve-conflicts                         |
| `fetch-first`        | `precondition-failed` | user-fixable | resolve-conflicts                         |
| `no-upstream`        | `precondition-failed` | user-fixable | configure-upstream                        |
| `auth-failed`        | `provider-rejected`   | user-fixable | (none — the precise reason is the signal) |
| `permission-denied`  | `provider-rejected`   | user-fixable | (none)                                    |
| `protected-ref`      | `provider-rejected`   | user-fixable | adjust-policy-target                      |
| `remote-unavailable` | `network-failure`     | retryable    | retry                                     |
| `unknown`            | `provider-rejected`   | user-fixable | (none)                                    |

Non-fast-forward is detected **before** execution too: the push preflight emits a blocking
`non-fast-forward` finding when the snapshot's tracking-ref distance shows the branch is behind (and the
push is not a force push). The authoritative signal remains the execution-time classification.

## Evidence (AC5)

`executeGovernedPublish` appends a content-free evidence record through the existing
`recordGitDeliveryMutationEvidence` / `buildGitDeliveryEvidenceRecord` (which already projects the push
`remoteRefHash`). Every publish attempt — permitted-and-executed, preflight-blocked, policy-blocked,
approval-held, executed-and-rejected — is recorded. Remote publish cannot bypass preview, policy, or
evidence capture.

## Tests

- `packages/keiko-tools/src/git-publish-gateway.test.ts` — argv building (force refused), rejection
  taxonomy, the dedicated allowlist, and the `runGitPublish` lifecycle gates.
- `packages/keiko-tools/src/git-publish-node.integration.test.ts` — the real spawn boundary against
  hermetic bare + working repos: a real push reaches the remote; a real non-fast-forward is classified
  at execution time; a force push is blocked and the remote is untouched; evidence is recorded for
  allowed and blocked attempts; push stays out of the local mutation allowlist.
- `packages/keiko-tools/src/git-mutation-preflight.test.ts` — the `non-fast-forward` preflight finding.
- `packages/keiko-server/src/gitDelivery/pushRoutes.test.ts` — the BFF seam: capability/CSRF gates,
  preview risk context, the default pack's protected-target block, force block, non-fast-forward
  preflight block, rejection surfacing, and evidence recording.
- `packages/keiko-ui/.../GovernedGitFlowCard.test.tsx` / `.a11y.test.tsx` — the Publish section.
- `tests/e2e/git-publish-flow-476.spec.ts` — packaged-app browser evidence that the UI publish path is
  wired through the governed execute response and surfaces a protected-target block (coordinator
  evidence; non-gating). Evidence under `docs/git-delivery/evidence/476/`.
