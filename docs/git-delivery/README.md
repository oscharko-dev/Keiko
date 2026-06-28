# Governed Git Delivery

This directory is the operator and reviewer entry point for Epic #470, governed end-to-end Git
delivery.

Start here:

- [Verification matrix](verification-matrix.md) maps the full path from local mutation through publish,
  pull request, and merge to concrete code, tests, browser evidence, and residual risk.
- [Operator runbook](operator-runbook.md) explains rollout, diagnosis, evidence interpretation, and
  support boundaries.
- [Policy-pack guidance](policy-pack-guidance.md) gives example operating modes for strict
  protected-branch governance, developer self-service publish, and audit-heavy review workflows.
- [Editor integration boundary](editor-integration.md) explains how Epic #1491's editor Git status
  surface composes with Epic #470 without creating a second Git delivery path.
- [Epic closeout summary](epic-470-closeout.md) ties the proof back to the epic invariants and names
  open governance items before epic closure.
- [Issue #479 evidence manifest](evidence/479/README.md) is the machine-checked closure artifact set.

Architecture background:

- [Governed Git delivery contracts](governed-git-contracts.md)
- [Governed Git mutation execution kernel](governed-git-execution-kernel.md)
- [Governed Git approval and preview surface](governed-git-approval-surface.md)
- [Governed Git mutation evidence ledger](governed-git-evidence-ledger.md)
- [Governed local Git flows and commit-intent composition](governed-local-git-flows.md)
- [Governed remote publish](governed-remote-publish.md)
- [Governed GitHub pull request command center](governed-github-pull-request.md)
- [Governed merge](governed-merge.md)
- [Git client repository state, history, remotes, and sync API](git-client-repository-api.md)

Executable closure check:

```text
npm run check:git-delivery-evidence
```
