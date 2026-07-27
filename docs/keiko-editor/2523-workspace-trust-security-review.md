# Workspace Trust UX security review (#2523)

## Scope and reuse

Governing decision:
[ADR-0147](../adr/ADR-0147-multi-root-workspaces-trust-profiles-local-history.md) D3 — canonical
per-root Workspace Trust and Restricted Mode. Its trust-record binding dimensions are since
narrowed by [ADR-0155](../adr/ADR-0155-root-scoped-workspace-trust-binding.md): the
workspace-level manifest revision and digest no longer participate in validity, so focusing or
reordering roots cannot demote a granted root. Every other ADR-0147 decision, including every
boundary reviewed below, stands.

Issue #2523 adds the human-facing prompt, Restricted Mode banners, and per-root management view
defined by that decision. It extends the existing `WorkspaceScriptTrustService`, verification
catalog, command catalog, managed-language status, window registry, and confirmation-dialog
patterns. It does not introduce another trust store, policy reducer, execution path, or durable
browser store.

## Boundary review

- Trust remains a server-owned fact. The browser can request only `grant` or `revoke` for an
  already registered project id; it cannot submit a trust level, canonical identity, digest,
  policy result, Authority Envelope, or capability catalog.
- Successful HTTP responses are treated as hostile. The UI accepts only the exact
  `WorkspaceTrustStatus` contract with matching project id, server ownership, a closed reason, and
  a level-compatible reason. Malformed success bodies leave the root restricted.
- The status projection contains only the user-selected project id, trust level, closed reason,
  and revision. Canonical root references, filesystem identity, manifest and trust-basis digests,
  policy versions, file content, and package-manifest content remain server-side.
- Grant and revoke use the existing same-origin CSRF gate. The server resolves the registered root,
  canonical filesystem identity, and current package-manifest basis again for every transition.
- A trust mutation clears the client capability catalog immediately. Capabilities reappear only
  after a fresh guarded server catalog; revocation therefore fails closed even while refresh is in
  flight.
- Digest or identity invalidation is projected as a closed redacted reason. Package-manifest basis
  changes render the reviewed “workspace manifest changed” explanation without exposing either
  digest or content.
- The UI writes no trust decision or workspace content to local storage, IndexedDB, logs, evidence,
  or another durable browser sink. Window persistence stores only the window descriptor; root
  state is fetched from the existing registered-project and trust stores.

## Human-control and accessibility review

Opening a root never grants trust. The first prompt focuses **Stay restricted**, so Enter keeps the
safe state; grant and revoke each require a consequence-stating confirmation and server
acknowledgement. Restricted Mode remains visible in the editor, command runner, and managed
language surfaces. Component and real-browser axe checks cover the prompt, banner, and management
view, including keyboard focus, forced-color/reduced-motion rules, and 320 px layout at 200% text
zoom.

## Verification evidence

- Contract and server regression tests cover exact status validation, registered-root rejection,
  explicit grant/revoke, and digest invalidation.
- UI regression tests cover malformed successful responses, non-optimistic transitions,
  confirmation focus, safe Enter behavior, honest reason copy, and axe.
- `npm run test:e2e:workspace-trust-2523` exercises the complete real-BFF restricted → trusted →
  revoked journey through user-facing controls.

No trust-boundary weakening, raw-content evidence, secret-bearing diagnostic, or new unresolved
security finding was identified in this scope.
