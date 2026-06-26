# Governed Git Delivery Operator Runbook

This runbook is for maintainers and operators who support and audit governed Git delivery.
It assumes the implementation from Epic #470 is present and verified by the
[verification matrix](verification-matrix.md).

## Rollout prerequisites

1. Confirm each workspace that should use governed Git delivery is registered and has an available Git
   worktree. The surface is part of the deployment; routes are not hidden behind a deployment enable
   flag.

2. Confirm `gh` is installed and authenticated for PR and merge operations. Keiko does not read or store
   GitHub tokens; the `gh` process owns credential lookup through its keyring or `GH_TOKEN` /
   `GITHUB_TOKEN`.

3. Confirm policy packs are loaded from trusted server-side configuration. Clients may request action
   intent, but clients do not assert policy decisions or approval state as authority.

4. Confirm evidence storage is writable if audit export is required. Evidence append is best-effort for
   response availability, but support readiness requires monitoring evidence write failures.

## Operating modes

Use [policy-pack guidance](policy-pack-guidance.md) to choose a mode:

- strict protected-branch governance for regulated integration branches;
- developer self-service publish for low-risk feature branch delivery;
- audit-heavy review workflow for high-risk teams that require approval holds on remote operations.

## Common workflow

1. Create or switch to an issue branch through the governed local flow.
2. Stage changes through governed staging.
3. Preview the commit. Resolve message-policy violations and intent warnings before execution.
4. Execute the commit. Confirm the result and evidence reference.
5. Preview publish. Resolve protected target, force push, upstream, or non-fast-forward blockers.
6. Execute publish only when the preview is allowed or approved.
7. Open or update the pull request through the governed PR command center.
8. Preview merge. Confirm readiness, eligible strategy, and final approval.
9. Execute merge only after the approval and readiness gates pass.

## Troubleshooting

| Symptom                                      | Likely cause                                                                                                                                | Operator action                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Governed Git route reports unavailable       | The project is unknown, the worktree cannot be read, provider tooling is missing, credentials are absent, or policy has no applicable rule. | Register the workspace, fix Git/provider prerequisites, authenticate `gh`, or configure the policy pack; do not use an enable flag.                               |
| Commit preview blocks on message policy      | Conventional Commit or issue-link policy failed.                                                                                            | Fix the message. The failed draft is not persisted in evidence.                                                                                                   |
| Local mutation blocks before execution       | Preflight found detached HEAD, missing branch, no changes, or unsafe worktree state.                                                        | Follow the typed finding and rerun preview.                                                                                                                       |
| Publish blocks a protected/shared target     | Default publish policy allows only safe branch namespaces.                                                                                  | Publish to a safe namespace or author an explicit approval-gated override.                                                                                        |
| Publish rejects after execution              | Provider rejected the push, commonly non-fast-forward, no upstream, auth, permission, or protected ref.                                     | Use the typed rejection reason; do not retry unchanged when disposition is user-fixable.                                                                          |
| PR create/update blocks                      | Base branch policy or provider readiness failed.                                                                                            | Select an allowed base or fix provider state.                                                                                                                     |
| Merge button is disabled                     | Readiness gate found blocking checks, approvals, conflicts, branch protection, draft state, or merge queue position.                        | Resolve provider readiness first. Keiko must not attempt the merge while blockers remain.                                                                         |
| Merge rejects after readiness passed         | Provider state changed, rate limit occurred, permission changed, or head SHA changed.                                                       | Re-read readiness, refresh approval if needed, and retry only when typed disposition permits.                                                                     |
| Evidence is missing for a terminal operation | Evidence persistence failed after response or the block occurred before the kernel evidence path.                                           | Inspect server evidence storage. For commit message-policy blocks, use route response and issue evidence; kernel evidence starts after message-policy acceptance. |

## Evidence interpretation

Evidence records are designed to be content-free:

- repo identities, remote refs, provider external ids, and workflow ids are hashed;
- approval token values are never recorded, only token hashes and approval metadata;
- raw provider stdout/stderr is redacted and normalized to typed reason codes;
- records carry counts, branch names, action kinds, lifecycle phase, outcome class, and recovery hints.

Treat `blocked`, `approval-required`, `rejected`, `failed`, and `recovery-required` as terminal governed
outcomes for audit purposes. A terminal outcome is not necessarily a successful repository mutation.

## Residual limits

- Browser evidence for #475-#478 uses deterministic route interception. It proves packaged UI wiring and
  no-bypass behavior, not live provider availability.
- GitHub is the only implemented remote provider in this epic. Contracts preserve provider neutrality,
  but GitLab, Gitea, Bitbucket, and on-prem SCM adapters are future work.
- `gh` availability and authentication are deployment prerequisites for PR and merge provider operations.
- Force push is blocked by default and no governed force-push feature ships in this epic.
- Commit message-policy rejection is shown to the user with typed codes before the kernel runs; it does
  not append a kernel evidence record because no mutation was attempted.
- Evidence append is best-effort and should be monitored before regulated rollout.

## Verification before rollout

Run at least:

```text
npm run check:git-delivery-evidence
npm run typecheck
npm run lint
npm run arch:check
npm run arch:check:negative
npm test
```

For browser-visible changes, refresh:

```text
npm run test:e2e:git-delivery-475
npm run test:e2e:git-publish-476
npm run test:e2e:pr-command-center-477
npm run test:e2e:merge-governance-478
```
