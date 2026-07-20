# ADR-0148 — Workspace Trust binds a root, not a workspace revision

- Status: Accepted
- Amends: [ADR-0147](ADR-0147-multi-root-workspaces-trust-profiles-local-history.md) (trust-record
  binding dimensions only; every other ADR-0147 decision stands)
- Related: [ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md),
  [ADR-0138](ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md)

## Context

ADR-0147 defines a Workspace Trust record as bound to **all** of: manifest reference, manifest
revision, manifest digest, root reference, root identity digest, and the capability-specific
trust-basis digest. A package-script consumer projects `trusted` only when every one of those
dimensions matches the currently derived binding.

Manifest revision and digest are properties of the **workspace**, not of the root the human
actually granted. Every manifest mutation bumps both — including mutations that change no
membership and no authority at all:

- moving focus to another root (`POST /api/workspaces/:workspaceId/focus`, a plain click in the
  multi-root Explorer);
- reordering roots.

The result is that a granted root drops to Restricted Mode on the next click, and re-granting is
futile because the click after that revokes it again. Managed language servers, verification, and
debug launch all gate on this axis, so in a multi-root workspace the persisted trust that #2521 was
built to deliver is not observable in practice.

This was found while auditing epic #2285 before merge. Two adjacent defects with the same root
cause were repaired without an ADR change, because ADR-0147 already required narrower behaviour
there: `replaceWorkspaceManifest` deleted the trust rows for the union of previous and next roots,
and `affectedRootPaths` reported that same union. Those fixes stop the record from being destroyed;
they cannot make it project as trusted again, because the binding comparison is the deciding step.

## Decision

A trust record continues to **record** the manifest reference, revision, and digest as provenance.
The **validity comparison** is narrowed to the dimensions that describe the trusted root itself:

| Dimension | In comparison | Why |
| --- | --- | --- |
| `manifestRef` | yes | The root moving to a different workspace is a different authority context. |
| `rootRef` | yes | Identifies which root was granted. |
| `rootIdentityDigest` | yes | A directory replaced under the same reference must invalidate. |
| `trustBasisDigest` | yes | The approved `package.json` bytes changing must invalidate. |
| `manifestRevision` | **no** | Workspace-level; changes on focus and reorder. |
| `manifestDigest` | **no** | Workspace-level; changes on focus and reorder. |

Membership changes keep invalidating, unchanged, through the two mechanisms ADR-0147 already
mandates: removing a root deletes its trust row atomically with the manifest revision, and adding
or removing a root recomputes every member's effective trust.

## Consequences

This widens trust relative to ADR-0147 as written, so the argument has to be that nothing the
removed dimensions protected is now unprotected. Enumerated:

- **Root directory swapped** — `rootIdentityDigest` changes. Still invalidated.
- **Approved `package.json` changed, including changed-then-restored** — `trustBasisDigest` changes
  and a restricted record is persisted at a newer revision, so restoring the old bytes does not
  resurrect the grant. Unchanged from ADR-0147.
- **Root removed from the workspace** — the trust row is deleted in the same transaction.
- **Root moved into another workspace** — `manifestRef` changes. Still invalidated.
- **Root joins from an absorbed workspace** — it is absent from the target's previous membership
  and therefore invalidates, fail closed.
- **Manifest record corrupt, unreadable, or absent** — resolution raises a coded
  `WORKSPACE_STATE_UNAVAILABLE` and status projects restricted/`state-unavailable` (ADR-0147 D9).

What is no longer invalidated is exactly the set of mutations that change neither the root nor its
approved basis: focus and order. Those carry no authority, which is why root-scoped dispatch
already refuses to derive authority from focus at all (ADR-0147 D1).

Restricted Mode remains a per-root axis that can only narrow the ADR-0125/0138 monotone reducers.
Nothing here widens a deployment ceiling, an Authority Envelope, or a mode.

## Alternatives considered

- **Leave ADR-0147 as written.** Rejected: it ships a trust feature that cannot hold a grant across
  a single click, and the workaround for users is to stop using multi-root workspaces.
- **Exclude focus and order from the manifest digest** so view-only mutations do not bump the
  trust-bearing identity. Rejected as the primary fix: it keeps the ADR-0147 sentence literally true
  but changes what a manifest digest means for every other consumer — dispatch currency, absorbed
  workspace validation, and the ETag preconditions — to fix a problem that belongs to the trust
  axis. Narrowing the trust comparison keeps the change where the defect is.
