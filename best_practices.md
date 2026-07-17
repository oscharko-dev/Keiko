# Keiko best practices (Qodo Code Review)

Project-specific standards Qodo checks changed code against. Qodo is Keiko's
advisory, comment-only review product feeding Keiko for Quality (KFQ); it has no
merge authority. Review methodology and the no-merge-authority invariant live in
`.pr_agent.toml`; this file lists the concrete code standards.

Canonical governance — treat as binding, and an ADR overrides `AGENTS.md`:

- `AGENTS.md` and `CONTRIBUTING.md` — the shared contributor and agent contract.
- `docs/qa/keiko-for-quality.md` and `docs/qa/qodo-review-policy.md` — the KFQ gate
  and the Qodo review policy.
- `docs/adr/ADR-0129-product-wide-authority-and-autonomy-model.md` and
  `docs/adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md` — the
  authority model and deterministic `dev` delivery.
- `docs/adr/ADR-0019-modular-package-architecture.md` and
  `docs/adr/ADR-0131-ci-based-sonarcloud-analysis-and-banking-grade-gate.md`,
  plus `SECURITY.md` and `docs/security-and-audit-boundaries.md`.

## Security and trust boundaries

- Validate hostile workspace input, model output, connector data, HTTP input,
  persisted rows, and generated artifacts before processing them. Demand
  deterministic negative tests for malformed, empty, boundary, oversized, hostile,
  expired, replayed, conflicting, unauthorized, unavailable, and partially failed
  inputs; a happy-path test alone is insufficient for a trust boundary.
- Compose policy with stricter-wins semantics and preserve mode-independent hard
  denials. Fail closed on expiry, revocation, permission, dependency, or storage
  failure.
- Keep provider SDKs inside `keiko-model-gateway`; route outbound model HTTP
  through its governed seam, and route file patches through the owning tools
  boundary. Never turn a narrow adapter into a generic proxy or webhook.
- Constrain network destinations, redirects, origins, hosts, methods, headers,
  response bytes, timeouts, and credentials. Keep credentials in the owning secret
  boundary and absent from logs, errors, comments, evidence, fixtures, URLs, and
  durable state.
- Bind authorization, approvals, idempotency, and reconciliation to current
  server-owned state and immutable digests; reject stale, replayed, ambiguous, or
  mismatched state. Enforce origin-bound CSRF for browser mutations and keep
  authentication separate from authorization.
- Preserve exact canonical preview-to-send identity where the product promises it;
  never restore quarantined or omitted content and never add a `send anyway` path.

## Architecture, quality, and evidence

- Package dependencies point inward toward `keiko-contracts`; domain packages do
  not depend on server or UI layers, and provider SDKs stay isolated in
  `keiko-model-gateway`. Cross-package and wire types live in `keiko-contracts`;
  a public export change updates and proves the package-surface contract.
- Product TypeScript stays strict, explicitly typed, warning-free, small, and
  within repository complexity limits. Reject casts or duplication that hide an
  invalid state model.
- Errors stay observable through the owning diagnostic path with redacted context
  and a correlation id where required. Empty catches and silent promise-rejection
  handlers are findings.
- Behavioural fixes include a failure-first regression test that fails without the
  fix and cover both sides of every added guard. Tests are hermetic: no real
  networks, wall-clock sleeps, shared mutable state, or reliance on a free port.
- UI changes use the i18n API, preserve English/German parity, component-scoped
  styling, keyboard and focus behaviour, accessibility checks, and the pinned
  `globals.css` surface. Measured surfaces regenerate Linux-authoritative release
  evidence.
- Architectural behaviour changes update an existing ADR or add the next indexed
  ADR (never renumber); release-impacting changes update the release-impact
  catalog. Coverage evidence represents real changed executable source with
  reserve above the enforced threshold.
