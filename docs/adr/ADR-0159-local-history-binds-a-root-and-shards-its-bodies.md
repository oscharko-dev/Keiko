# ADR-0159 — Local history binds a root, and shards its checkpoint bodies

- Status: Accepted
- Amends: [ADR-0147](ADR-0147-multi-root-workspaces-trust-profiles-local-history.md) (D7 body
  placement and D8's local-history substrate row only; every other ADR-0147 decision stands)
- Related: [ADR-0155](ADR-0155-root-scoped-workspace-trust-binding.md),
  [ADR-0046](ADR-0046-local-credential-vault.md)

## Context

The pre-merge audit of epic #2285 raised four defects against the encrypted local-history store
(#2616). Three of them are one decision each; the fourth is a route-level consequence of the same
"a record about a file is not the file" confusion.

**Identity.** ADR-0147 D7 keys history by `workspaceId`. That id is derived from a workspace's
**founding root** and is not stable under membership: adding a root absorbs and deletes the
joiner's own single-root workspace, and a founding root that leaves is re-minted under a
collision discriminator (#2620). The root's `rootRef` does not move in either case — it is derived
from the canonical root path alone and is globally unique across manifests. So the id moved while
the root did not, and every checkpoint the root had captured stranded under an id nothing resolves
to again. Local history was the only per-workspace store in the repository keyed this way; trust
keys by `rootRef`, and settings, snippets and breakpoints key by canonical path.

The index contract closes off the obvious half-measure: `historyIndexEntriesAreValid` requires
every entry's `workspaceId` to equal its index's. A store that a root carries between workspaces
therefore cannot hold two different manifest ids and stay valid — the identity has to be one that
does not change, not one that is merely recorded.

**Write cost.** D8 places checkpoint bodies in a `LocalSecretVault` namespace, and D7 says the
store uses "its own vault file". `LocalSecretVault`'s single-file layout re-reads, re-serialises
and re-writes the whole store on every `set`. Capture runs on the interactive save path, so each
save paid for every checkpoint ever taken. `localHistoryStore.scale.test.ts` measures the bytes each
capture commits by sizing every temp file at its rename; run against the single-file layout it
reports 694 KB committed for a 512-byte checkpoint into a 512 KB store, and 12 KB against the
sharded one. The test asserts the mechanism rather than either number: the body commit for a fixed
checkpoint must not differ between a store holding 512 bytes and one holding 512 KB.

**Orphans.** Retention was bounded over index metadata only, and bodies were deleted by naming the
references an eviction believed it had just removed. A delete that failed once, or a crash between
the body write and the index commit, left ciphertext that no reader can reach and no bound can
reclaim. The index stayed capped at 512 entries while the vault grew without limit.

**Reach.** `localHistoryRoutes.ts` re-resolved a checkpoint's stored path against the live
filesystem on read, pin and delete, so all three returned 404 once the file was deleted or renamed
— the single most valuable thing local history does, failing in exactly the case it exists for.

## Decision

### D1 — A history workspace is a root

Local history is keyed by an identity derived from `rootRef`, not from the manifest. Manifest
membership continues to decide **access** — a root outside every manifest has no history surface at
all, and `IDENTITY_DRIFT`/`NOT_A_MEMBER` still fail closed — but it no longer decides **identity**.

This is the same narrowing [ADR-0155](ADR-0155-root-scoped-workspace-trust-binding.md) applied to
Workspace Trust, for the same reason: the workspace-level dimensions move under mutations that
change nothing about the root.

| Dimension | Selects a checkpoint | Why |
| --- | --- | --- |
| `rootRef` | yes | Identifies whose history this is; stable across join and leave. |
| `rootIdentityDigest` | yes | A directory replaced under the same path must not inherit history. |
| manifest `workspaceId` | **no** | Derived from the founding root; not stable under membership. |

Entry-level scoping, the payload self-binding, and the opaque `entryRef`/`vaultEntryRef` derivation
are unchanged in shape — the value they bind is now the stable one.

### D2 — Checkpoint bodies are sharded, one sealed file per checkpoint

ADR-0147 D7's "its own vault file" is amended to "its own vault namespace". The store keeps a
dedicated directory, environment key name, keychain service and keyfile — the key separation that
sentence exists to guarantee — and reuses the audited `LocalSecretVault`/AES-256-GCM primitive
unchanged. Only placement changes: `createShardedLocalSecretVault` writes one sealed file per
reference instead of one JSON map for the whole vault.

Every property D7 asserts about a body survives verbatim: AES-256-GCM under the store's own key,
0600 files in a 0700 directory, atomic temp-then-rename, symlink-refusing paths, plaintext returned
only by `get`. What changes is that a capture commits its own checkpoint rather than the store.

Two behaviours are NOT identical to the single-file layout and are recorded here so the difference
is a decision rather than a discovery. A store the layout cannot read reports empty instead of
raising, which is why the single-file layout remains the one credentials use: per entry there is
nothing to conflate, but a caller that rewrites config from an enumeration must not adopt this. And
a reference no filename can represent is refused on write — the mapping from reference to filename
must stay injective, or two references would share one file and serve each other's secret.

The single-file layout remains the default for `LocalSecretVault` and stays right where it is
right: a handful of long-lived credentials (ADR-0046). It is wrong for an append-heavy store on an
interactive path.

### D3 — Retention reconciles bodies against the index

Pruning no longer deletes the references it believes it evicted. It deletes every stored body the
committed index does not reference. The index is the only thing that decides which bodies may
exist, which makes each pruning pass self-healing: a delete that failed earlier, and a body written
by a capture that died before its index commit, are both reclaimed by the next pass rather than
never.

Every operation commits the index before reclaiming, so a reconciliation can never remove a body
the committed index still names: capture is body write, index commit, reconcile; deleting an entry
is index commit, then reconcile. Unlinking before the commit — which is what deletion used to do —
inverts the invariant in both directions: a failing index write leaves a committed entry whose body
is gone, permanently unreadable and beyond reconciliation's reach because the index still names it,
and a body that resists deletion makes the entry permanently undeletable.

Reclamation is opportunistic. The committed index is already correct when it runs, so a pass that
cannot enumerate or cannot unlink leaves the work to the next pass instead of failing an operation
that has already succeeded.

### D4 — A checkpoint outlives the file it records

Entry-scoped routes assert containment with the guards that do not depend on the file existing:
path normalization (absolute, NUL, `..` escape), metadata redaction, and the deny list, applied to
the relative path and again to the deepest part of the path that still resolves. Bytes are served
from this store's own encrypted body and never from the workspace file, so existence was never what
made the read safe.

Resolving only the leaf would not be enough. `realpath` fails on a missing leaf, so a dangling entry
under a directory symlinked OUT of the root would skip the check entirely; walking up to the first
segment that does resolve catches an escaping ancestor even when nothing exists at the requested
path. A denied or escaping path is refused whether or not it exists, and the assertion returns no
absolute path — an unresolved candidate must not be handed back in the shape a realpathed one has.

## Consequences

D1 and D2 both change where a checkpoint lives on disk, so a history store written before this
change is not adopted by the store that replaces it. Nothing is destroyed: the ciphertext and its
keyfile stay in the previous `workspace-<digest>` directory under `editor-local-history/`, and an
operator can remove or archive it. This is stated rather than migrated deliberately — a migration
would have to re-derive every checkpoint's references and re-seal every body, which is precisely
the self-binding machinery D7 spends its normative text protecting, for local state from an epic
that merged one day earlier. History already stranded by the membership defect this ADR repairs is
unreachable in exactly the same way and by the same mechanism.

D1 widens what one history store contains: a root keeps its checkpoints across a join, so a
checkpoint captured while the root belonged to another workspace remains readable afterwards. That
is the point, and it does not widen who may read it. Access still requires manifest membership, the
ADR-0141 launcher-attested app session, and a `rootIdentityDigest` match; two roots sharing a
workspace still cannot reach each other's checkpoints, because selection is per-root.

D3 deletes more than the previous implementation did, so the fail-safe direction matters: it only
ever removes bodies the committed index does not name. An index that cannot be read fails closed
with `INDEX_UNAVAILABLE` while the store is opened, before any reconciliation runs, so a corrupt
index can never be read as "no entries are referenced" and used to empty the vault. An index that
is simply absent opens empty and its bodies are reclaimed — correctly, because a body is reachable
only through the index entry whose metadata its payload must re-validate against, so a body with no
entry is already unreadable rather than merely unreferenced.

D4 does not widen the route surface. Filename-bearing metadata and checkpoint content still require
the authenticated app session, and unauthenticated projections stay content-free.

The normative V1 bounds of D7 — 512 entries, 8 MiB/entry, 256 MiB/workspace, 64 MiB pinned, 50
versions/file, 90-day TTL — are unchanged, as is deterministic oldest-accessed-first pruning with
`PINNED_CAPACITY_EXHAUSTED` when pins prevent capacity.

## Alternatives considered

- **Record the manifest `workspaceId` as provenance and merely exclude it from selection**, the
  literal shape of ADR-0155. Rejected: the index contract requires every entry's `workspaceId` to
  equal its index's, so a store carried across workspaces would hold two ids and fail validation.
  The identity itself has to be stable.
- **Hook membership changes and migrate history between workspace directories.** Rejected: the one
  existing seam (`applyRootBindingChanges`) is best-effort and cannot fail a mutation, so a failed
  migration would lose history silently — the defect, rearranged. Deriving identity from the root
  makes the event unnecessary rather than handled.
- **Keep one vault file and batch the writes.** Rejected: it bounds the *number* of whole-store
  rewrites per capture, not their cost. A single write of a 256 MiB store is the defect.
- **Reconcile only at store open.** Rejected: the AC is that pruning cannot leave orphans, and an
  orphan created by an eviction should not wait for a restart. Reconciliation reads filenames and
  never decrypts, so the cost is bounded by entry count, not by stored bytes.
