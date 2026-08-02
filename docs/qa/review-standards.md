# Keiko review standards

These project-specific standards bind every automated reviewer and autonomous coding agent. They
supplement `AGENTS.md`, `CONTRIBUTING.md`, and the Architecture Decision Records. Correct, secure,
verified product behavior is authoritative. ADRs are guardrails, not authority over working code:
an ADR mismatch does not preserve a defect or stop a repair, and agents must decide in favour of
working, clean, secure code before correcting the affected ADR text in the same change. Reviewers
identify defects and verify repairs, but never write to the pull-request branch, approve a gate
bypass, dismiss a finding to obtain green status, or merge.

This correction rule never authorizes weakening human control, authorization, trust boundaries,
package direction, or release gates. A safe repair must preserve those controls and pass their
unchanged gates; uncertainty about the intended control is escalated to the maintainer rather than
resolved by silently widening authority.

Canonical governance:

- `AGENTS.md` and `CONTRIBUTING.md` define the contributor and agent contract.
- `docs/qa/autonomous-quality-gates.md` defines the exact gate topology and thresholds.
- ADR-0129 defines human control; ADR-0019 defines package direction; ADR-0131 defines Sonar
  enforcement; ADR-0167 defines zero-cost autonomous delivery gates.
- `SECURITY.md` and `docs/security-and-audit-boundaries.md` define security boundaries.

## Security and trust boundaries

- Validate hostile workspace input, model output, connector data, HTTP input, persisted rows, and
  generated artifacts before processing them. Demand deterministic negative tests for malformed,
  empty, boundary, oversized, hostile, expired, replayed, conflicting, unauthorized, unavailable,
  and partially failed inputs; a happy-path test alone is insufficient for a trust boundary.
- Compose policy with stricter-wins semantics and preserve mode-independent hard denials. Fail
  closed on expiry, revocation, permission, dependency, storage, or evidence failure.
- Keep provider SDKs inside `keiko-model-gateway`; route outbound model HTTP through its governed
  seam, and route file patches through the owning tools boundary. Never turn a narrow adapter into
  a generic proxy or webhook.
- Constrain network destinations, redirects, origins, hosts, methods, headers, response bytes,
  timeouts, and credentials. Keep credentials in the owning secret boundary and absent from logs,
  errors, comments, evidence, fixtures, URLs, and durable state.
- Bind authorization, approvals, idempotency, and reconciliation to current server-owned state and
  immutable digests; reject stale, replayed, ambiguous, or mismatched state.
- Preserve exact canonical preview-to-send identity where promised. Never restore quarantined or
  omitted content and never add a `send anyway` path.

## Architecture, quality, and evidence

- Package dependencies point inward toward `keiko-contracts`; domain packages do not depend on
  server or UI layers, provider SDKs stay isolated in `keiko-model-gateway`, and cross-package wire
  types live in `keiko-contracts`. Public export changes update the package-surface contract.
- Product TypeScript stays strict, explicitly typed, warning-free, small, and within repository
  complexity limits. Reject casts, dead code, or duplication that hide an invalid state model.
- Errors remain observable through the owning diagnostic path with redacted context and a
  correlation id where required. Empty catches and silent rejection handlers are defects.
- Behavioural fixes include a failure-first regression test that fails without the fix and cover
  both sides of every added guard. Tests are hermetic: no real network, wall-clock sleeps, shared
  mutable state, or reliance on a free port.
- UI changes use the i18n API, preserve English/German parity, component-scoped styling, keyboard
  and focus behaviour, accessibility checks, and the pinned `globals.css` surface.
- Architectural behaviour changes update an existing ADR or add the next indexed ADR. Coverage and
  performance evidence must exercise production entry points and never duplicate the formula it is
  intended to verify.
