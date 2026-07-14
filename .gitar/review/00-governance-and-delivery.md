@AGENTS.md
@CONTRIBUTING.md
@docs/qa/keiko-for-quality.md
@docs/qa/gitar-review-policy.md
@docs/adr/ADR-0129-product-wide-authority-and-autonomy-model.md
@docs/adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md

# Keiko governance and delivery review

Treat the included documents and every applicable or changed ADR as binding. An ADR overrides
`AGENTS.md`; report any conflict rather than choosing a convenient interpretation.

Review every changed authority, policy, evidence, external-effect, and delivery path against these
invariants:

- A local human selects or accepts the task, mode, Authority Envelope, and deployment ceiling.
- Invalid, expired, missing, exhausted, unsupported, workspace-escaping, sensitive-path, secret-
  exfiltrating, or platform-restricted authority fails closed in every mode.
- Accepted `dev` work may commit and push its feature branch, maintain the PR, and run Auto-Apply
  without per-action human approval. Direct `dev` pushes and force pushes remain denied.
- A raw bot approval or processing check is not final merge authority. Only the direct app-bound
  required checks on the exact current head authorize GitHub native auto-merge.
- Evidence, diagnostics, comments, and manifests contain counts, hashes, scopes, statuses, and safe
  labels only. Do not quote raw secrets, payload bodies, customer data, private endpoints, or PII in
  a review finding.
- A current-head required check cannot reuse stale evidence. Missing, skipped, neutral, cancelled,
  timed-out, differently produced, or unparseable evidence is blocking.

Apply owning-layer fixes to the PR branch, add deterministic negative or boundary tests, and rerun
the complete review after each push. Never force-push, push directly to `dev`, use `gitar unblock`,
dismiss findings to obtain green status, arm auto-merge before direct required checks settle, or
weaken a gate.

Assume every pull request targeting `dev` is a large, completed-epic integration PR. Review all
changed production source, tests for critical behavior, workflows, migrations, manifests, public
contracts, and trust-boundary documentation before binary visual evidence, snapshots, lockfiles,
or generated artifacts. If service limits prevent complete inspection of that executable and
trust-boundary surface, fail closed and identify the unreviewed files instead of approving the PR.
