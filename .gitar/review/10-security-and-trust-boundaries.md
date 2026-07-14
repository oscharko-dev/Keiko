@SECURITY.md
@docs/security-and-audit-boundaries.md

# Security and trust-boundary review

Trace each changed external or privileged flow end to end: contract, validation, authorization,
owning runtime, persistence, evidence, UI bridge, retry, and failure behavior. Review callers and
consumers when the invariant cannot be proved from the changed file alone.

Require all of the following where applicable:

- Validate hostile workspace input, model output, connector data, HTTP input, persisted rows, and
  generated artifacts before processing them.
- Compose policy with stricter-wins semantics and preserve mode-independent hard denials.
- Keep provider SDKs inside `keiko-model-gateway`; route outbound model HTTP through its governed
  seam and route file patches through the owning tools boundary.
- Constrain network destinations, redirects, origins, hosts, methods, headers, response bytes,
  timeouts, and credentials. Never turn a narrow adapter into a generic proxy or webhook.
- Keep credentials in the owning secret boundary, memory-only where specified, and absent from
  logs, errors, comments, evidence, fixtures, URLs, and durable state.
- Bind authorization, approvals, idempotency, and reconciliation to current server-owned state and
  immutable digests. Reject stale, replayed, ambiguous, or mismatched state.
- Preserve exact canonical preview-to-send identity where the product promises it. Never restore
  quarantined or omitted content and never add a `send anyway` path.
- Keep authentication separate from authorization, enforce origin-bound CSRF for browser
  mutations, and fail closed on expiry, revocation, permission, dependency, or storage failures.
- Enforce retention ceilings and deletion evidence without resurrecting zero-retention data or
  retired key material.

Demand deterministic negative tests for malformed, empty, boundary, oversized, hostile, expired,
replayed, conflicting, unauthorized, unavailable, and partially failed inputs. A happy-path test
alone is insufficient for a trust boundary.
