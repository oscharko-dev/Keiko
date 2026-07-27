# ADR-0155 — Workspace Trust binds a root, not a workspace revision

- Status: Accepted
- Amends: [ADR-0147](ADR-0147-multi-root-workspaces-trust-profiles-local-history.md) (trust-record
  binding dimensions only; every other ADR-0147 decision stands)
- Amended by: Issue #2772 (Epic #2285, 2026-07-27), adding the server-private filesystem-object
  binding while preserving the public V1 root identity.
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
| public V1 `rootIdentityDigest` | yes | Preserves dispatch/contract compatibility and detects public binding drift. |
| private object identity digest | yes | Path-free exact `dev`/`ino`/`birthtimeNs` binding detects replacement and aliases. |
| `trustBasisDigest` | yes | The approved `package.json` bytes changing must invalidate. |
| `manifestRevision` | **no** | Workspace-level; changes on focus and reorder. |
| `manifestDigest` | **no** | Workspace-level; changes on focus and reorder. |

Membership changes keep invalidating, unchanged, through the two mechanisms ADR-0147 already
mandates: removing a root deletes its trust row atomically with the manifest revision, and adding
or removing a root recomputes every member's effective trust.

The public V1 `rootRef` and `rootIdentityDigest` remain unchanged. They do not become sufficient
durable authority. The server persists a second, non-public identity: domain-separated,
length-framed SHA-256 over the filesystem's exact bigint `dev`, `ino`, and positive `birthtimeNs`,
with no path input. Every trust projection and effect compares that persisted value with a fresh
inspection. `NULL`, unsupported birth identity, ambiguity, and mismatch all project restricted and
deny durable authority.

The V17 migration backfills only live roots whose public V1 identity still matches and whose private
object digest is unique. It leaves every other private binding `NULL` and revokes all pre-V17 trust
rows once, because those grants predate the new authority fact.

## Consequences

This widens trust relative to ADR-0147 as written, so the argument has to be that nothing the
removed dimensions protected is now unprotected. Enumerated:

- **Root directory swapped or path-aliased** — the private object digest changes or collides. Still
  invalidated even when the public compatibility identity alone would be insufficient.
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

## Addendum — a determined basis, not necessarily a present one (#2613)

ADR-0147 D9 already requires that missing state is tagged `absent` and unreadable state
`unavailable`, and that the two are not silently conflated. The trust implementation conflated them:
`resolveTrustBasisFact` returned `unavailable` both when `package.json` was missing and when it could
not be read, and the record contract required a trusted record's basis to be exactly `known`.

The effect was that a root without an npm manifest could never be granted trust, so a Go, Java,
Python, Rust or shell workspace could never leave Restricted Mode and its managed language server
could never start — a capability M11 advertises but could not deliver.

A trusted record now requires a **determined** basis rather than a present one:

| Basis outcome | Meaning | May carry trust |
| --- | --- | --- |
| `known` | The basis was read. | yes |
| `absent` | It was looked for and definitively is not there. | yes |
| `unavailable` | It exists but could not be read or parsed. | no |
| `unknown` | It could not be determined. | no |

For the package-script capability, `absent` means the root has no scripts to execute at all, so the
grant authorizes nothing that could run. The fail-closed direction is unchanged: a basis that cannot
be determined never carries trust.

Outcome changes invalidate exactly like content changes. A `package.json` appearing in a root that
was granted while it had none moves the live basis from `absent` to `known`, the recorded fact no
longer matches, and the grant is invalidated at a newer revision — the human must grant again.
