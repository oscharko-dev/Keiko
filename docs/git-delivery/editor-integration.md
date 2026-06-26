# Editor And Governed Git Delivery Integration

Epic #1491 and Epic #470 intentionally own different layers of the same product workflow.

## Ownership Boundary

- The editor runtime owns read-only repository awareness: Git availability, repository state, branch
  visibility, file status, and bounded diffs through `/api/git/status` and `/api/git/diff`.
- Governed Git delivery owns repository mutation: branch creation and switching, staging, commit,
  publish, pull request, merge, recovery, policy evaluation, approval, and evidence through
  `/api/git-delivery/*`.
- The command runner owns allowlisted test, build, lint, and run tasks. It must not become a Git
  write fallback.

This keeps the editor inspectable without creating a second delivery system. The editor may launch or
summarize governed Git delivery flows, but it must not implement its own branch, staging, commit, push,
pull request, or merge execution path.

## Issue #1389 Integration Rule

Issue #1389 should use the editor Git status and diff API for passive context, then delegate mutating
Git affordances to the governed Git delivery surfaces or API clients:

- Use `/api/git/status` and `/api/git/diff` for clean/dirty/conflict/read-only diff states.
- Use `governedGit`, `governedPullRequest`, and `governedMerge` windows for write-capable delivery
  flows.
- Use `fetchGitDelivery*` API helpers for any mutating or previewable delivery operation.
- Do not add new server routes that execute Git write commands outside `packages/keiko-server/src/gitDelivery/`.
- Do not widen terminal or command-runner Git permissions to cover delivery workflows.

## Verification

Integration is valid only when these invariants are true:

- Core editing works without Git, GitHub CLI, or a configured remote.
- Read-only Git failures surface as unavailable or degraded editor state.
- Mutating Git workflows remain disabled unless governed Git delivery is trusted for the deployment.
- Every mutating Git action still passes policy, preview or preflight, approval where required, and
  content-free evidence recording.
- No browser code receives shell authority, raw Git command construction authority, or unrestricted
  filesystem mutation authority.
