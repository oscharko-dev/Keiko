# ADR-0147: Multi-root workspaces, Workspace Trust, profiles, and local history

## Status

Accepted (Issue #2520, Epic #2285, 2026-07-18).

Amended by Issue #2772 (Epic #2285, 2026-07-27) to add a server-private, path-free filesystem-object
identity while preserving the public V1 root identity contract.

Amended by Issue #2773 (Epic #2285, 2026-07-27) to allow canonical workspace paths in the
launcher-paired local app session while keeping the unpaired workspace-manifest projection
path-free.

Amended by Issue #2774 (Epic #2285, 2026-07-27) to bound the private history index before parsing
and repeat root identity validation immediately before history effects.

Amended by [ADR-0155](ADR-0155-root-scoped-workspace-trust-binding.md) to narrow the trust validity
comparison to root-describing dimensions and the workspace-authority `manifestRef` — a root moving
to a different workspace is a different authority context and still invalidates. Only `manifestRevision`
and `manifestDigest` are excluded from the equality check that governs re-authorization; they remain
recorded as provenance but change on ordinary focus/reorder within the same workspace and were the
false-positive drivers ADR-0155 removed.

The independent architecture, security, and contract-test reviews required by Issue #2520 were
completed before implementation. The maintainer clarified on
[Issue #2520](https://github.com/oscharko-dev/Keiko/issues/2520#issuecomment-5012022731) that
`Human Review Required: No` is controlling for this child, no separate human review or merge
approval is required, and the independent security-reviewer assessment is quality evidence rather
than human approval.

ADR-0147 was allocated while synchronizing the feature line after `origin/dev` assigned ADR-0146.

## Amends and reconciles

This decision explicitly amends:

- [ADR-0088](ADR-0088-task-workspace-domain-contract.md): its scalar `WorkspaceBinding` and
  equality invariant become the preserved V1 compatibility contract. A separately discriminated V2
  binding represents a multi-root editor workspace without changing V1.
- [ADR-0090](ADR-0090-active-task-workspace-binding-and-surface-retargeting.md): its singleton
  pointer selects one workspace manifest, which may contain several ordered roots. D4's
  `cfg`/`linkedRoot` fallback remains legacy unbound/V1 presentation behavior only and is superseded
  for every V2 mutating or executing dispatch. D6's “No contract change” is superseded only by the
  additive V2 family.
- [ADR-0126](ADR-0126-editor-verification-surface-and-problems-aggregation.md) D6: the provisional
  process-local binary package-script grant is absorbed by the persisted canonical per-root trust
  model. Explicit local-human grant intent, canonical root binding, package-manifest invalidation,
  and the existing binary projection remain mandatory.
- [ADR-0133](ADR-0133-editor-m7-personalization-and-resilience-control-plane.md) D1: M11 fulfills
  the reserved profile/per-root extension. The settings order becomes
  `builtInDefault < profile < user < workspace < root < policy/security ceiling` for M7 settings.
  The M7 registry, validation, effects, server ownership, and content-free evidence remain intact.

This decision reconciles, without replacing:

- [ADR-0125](ADR-0125-governed-agent-docking-and-editor-changesets.md) and
  [ADR-0138](ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md):
  Restricted Mode is an independent trust axis folded through the existing stricter-wins reducer,
  never a fourth autonomy mode or a parallel matrix.
- [ADR-0132](ADR-0132-managed-multi-language-lsp-activation-and-configuration.md): managed-LSP
  configuration keeps its own existing precedence/control plane. M11 selects the root whose record
  is evaluated and adds trust as a fail-closed pre-spawn gate; profiles never carry LSP activation,
  approved runtime identities, or provider configuration.
- [ADR-0137](ADR-0137-server-owned-coding-runtime-contracts.md): Code tasks and task-workspace
  provisioning remain single-root and consume V1. The server still resolves live roots and mints
  authority; a browser-provided root reference is routing intent, not authority.
- [ADR-0141](ADR-0141-authenticated-local-app-session-channel.md): content-bearing local-history
  reads and path-bearing workspace-manifest projections reuse the launcher-attested app-session
  boundary and existing session verifier; local-history content retains its distinct authenticated
  fetch channel. Loopback, Origin, CSRF, paths, root references, and checkpoint references remain
  routing facts only.

[ADR-0123](ADR-0123-workspace-multi-window-selection.md) is not amended. Its “workspace” is
transient desktop-window selection/layout state; this record governs durable editor root identity
and authority. No desktop-window selection state becomes a manifest or trust fact.

## Context

Keiko currently has four deliberately separate foundations:

1. `WorkspaceBinding` binds one task worktree to one scalar active, Git Delivery, and editor root.
2. package-script trust is a binary process-memory grant shared by command, verification, and debug
   consumers and bound to the current canonical root and `package.json` digest;
3. M7 settings resolve built-in default, user, workspace, and policy layers; and
4. hot exit encrypts one latest recovery snapshot per file, but there is no local file-history store.

M11 must add multi-root editor workspaces, per-root trust/settings, profiles, and local file history
without weakening those foundations or creating parallel workspace, policy, settings, history,
memory, or evidence subsystems. The contract issue intentionally changes no route, store, server
wiring, browser state, process behavior, or migration execution. It supplies pure vocabulary and
validators for the ordered children to implement.

The highest risks are mixed-root authority, stale trust resurrection, profile import as authority,
and content/history disclosure. A focused root is useful UI context but cannot select authority. A
trusted path string is insufficient identity because the filesystem object at that path can be
replaced. A profile is portable personalization and cannot carry roots or grants. Encrypted local
history is content, not evidence, memory, Git history, chat, or a Code-task transcript.

## Decision

### D1 — One server-owned, ordered workspace manifest

A workspace manifest is a numeric-schema-versioned, revisioned server record with:

- a branded manifest reference and server-computed manifest digest;
- an ordered, non-empty list of at most 32 root descriptors;
- one focused-root reference that must name a current member; and
- for every root, a branded root reference, server-private canonical root, bounded display name,
  server-computed filesystem identity digest, and an explicit tagged source-digest fact.

Root references, canonical roots, and identity digests are unique. Exact duplicate and overlapping
ancestor/descendant canonical roots are rejected. Server implementation additionally rejects
symlink, junction, mount, case-fold, drive, and filesystem-identity aliases after realpath/source
inspection; the leaf contract cannot perform IO. Root order is preserved exactly and covered by the
manifest digest. The digest uses domain-separated, versioned canonical serialization with explicit
length framing; ambiguous string concatenation is prohibited.

The public V1 `rootRef` and `identityDigest` fields and their existing formulas remain compatible;
they continue to carry routing and contract-currency facts. Durable server authority additionally
binds a server-private filesystem-object digest: domain-separated, length-framed SHA-256 over the
exact bigint `dev`, `ino`, and positive `birthtimeNs` values. It contains no canonical or supplied
path and never enters a public contract, evidence, diagnostic, profile, or export. A missing,
zero/negative, unsupported, ambiguous, or mismatched private digest is stored as unavailable and
fails closed for durable trust and effects.

The focused root is presentation state only. It may drive Explorer/search/default navigation but
never supplies a missing root for mutation, execution, trust, an Authority Envelope, or evidence.
Changing focus does not grant access and does not inherit another root's trust.

The existing ADR-0090 singleton pointer remains one pointer, now selecting a manifest instead of
implying that the selected editor workspace contains only one root. Code-task instances continue to
select a single V1 task-workspace binding.

The local app may receive `canonicalRoot` and other absolute paths carried by workspace manifests,
V2 bindings, and manifest mutation results only when the request presents a live launcher-paired
ADR-0141 app session. The browser client waits for its existing boot pairing attempt before its
first manifest read. An unpaired manifest-list request receives a bounded path-free projection;
other unpaired manifest requests return a path-free refusal before lookup, body parsing, or effect.
That refusal includes only the ordinary opaque request correlation ID in addition to its fixed
code and message; it contains no target-derived field, so known and unknown targets remain
byte-identical when requests use the same correlation ID.
This reuses the existing app-session cookie and verifier and introduces no token or authentication
system. Pairing authorizes only this disclosure: a path remains routing intent and never mints
membership, identity, trust, containment, policy, or effect authority.

This amendment is deliberately limited to the ADR-0147 workspace-manifest and V2-binding
projection. It does not migrate or reclassify historical `/api/projects`, ordinary `/api/files`, or
other pre-M11 route families, whose disclosure and authorization boundaries remain governed by
their existing decisions. It therefore makes no product-wide claim that every legacy path-bearing
API now requires an app session.

### D2 — `WorkspaceBinding` V1 is byte-identical; V2 is separate and explicit

The public `WorkspaceBinding` name remains the existing seven-field V1 type:

`schemaVersion`, `workspaceId`, `taskId`, `activeRoot`, `boundSurfaces`, `gitDeliveryRoot`, and
`editorProjectRoot`.

Its closed key set, property order, schema literal `"1"`, validation messages, and
`gitDeliveryRoot === activeRoot === editorProjectRoot` behavior remain unchanged. The explicit alias
`WorkspaceBindingV1` documents that compatibility without forcing existing consumers to narrow a
union. `TASK_WORKSPACE_SCHEMA_VERSION` is not bumped because it also versions unrelated task
workspace instances, events, and activations.

`WorkspaceBindingV2` uses binding-specific schema literal `"2"`. It carries the manifest reference,
revision, digest, ordered roots, and focused-root reference. Each bound root independently carries
its root reference, filesystem identity digest, server-private path, bound surfaces, Git Delivery
root, and editor project root. The per-root invariant is
`gitDeliveryRoot === rootPath === editorProjectRoot`. V2 forbids the scalar V1 fields, duplicate root
dimensions, duplicate per-root surfaces, empty roots, and foreign focus.

`VersionedWorkspaceBinding = WorkspaceBindingV1 | WorkspaceBindingV2` is a separately named
envelope for migration-aware consumers. `validateWorkspaceBinding` dispatches only on exact
`schemaVersion === "2"`; every other value follows the original V1 path so malformed/future values
cannot weaken legacy rejection. V1 builders and consumers are not migrated by this issue.

### D3 — Canonical per-root Workspace Trust and Restricted Mode

The canonical effective trust level is exactly `trusted | restricted`. Missing knowledge uses the
tagged fact union `known | unknown | unavailable | absent`; no `undefined`, empty string, browser
default, or inferred trust is valid. Unknown, unavailable, absent, malformed, corrupt, stale, or
mismatched state resolves to restricted.

A trust record is server-owned. Under
[ADR-0155](ADR-0155-root-scoped-workspace-trust-binding.md), its dimensions split into two roles:

- **Recorded provenance** (documented on the record, not compared): manifest reference, revision,
  and digest.
- **Validity comparison dimensions** (equality-checked to decide whether an existing grant still
  authorizes the current request): root reference and current filesystem identity digest; an
  explicit capability-specific trust-basis digest fact (the current package-script consumer uses
  the exact raw-byte `package.json` digest); trust revision, policy version, reason, and server
  ownership.

The browser may later request grant or revocation for a bounded root reference with concurrency and
idempotency data. It never supplies `trusted`, canonical paths, identity/manifest/source digests,
policy effects, modes, expiry, or an Authority Envelope. The server resolves every live fact.

A package-script consumer projects `trusted` only when canonical trust is trusted and every expected
binding dimension and current trust-basis digest matches. Every other cell projects to today's
`CommandTaskTrustState = "approval-required"`. A digest/root mismatch immediately persists a
restricted invalidation at a newer revision. Restoring the old `package.json` bytes therefore does
not resurrect the prior grant; a new explicit grant is required. A managed task worktree is a
registered project row but never a package-script trust basis of its own: its script decision is
resolved from the repository it was bound from, and holds only while the worktree's `package.json`
is byte-identical to that repository's — the same trust-basis digest this decision already binds
(PR #3381). The existing command, verification, and debug decider seams remain the only consumer
path until #2521 migrates their implementation.

Every durable trust or effect resolution also compares the manifest row's server-private
filesystem-object digest with a fresh inspection. The public V1 identity remains necessary for
dispatch compatibility but is not sufficient to authorize a replaced object or a path alias.

Restricted Mode is a per-root display/projection of this axis, not a `CodingWorkbenchMode`:

| Trust | Read/planning | Mutation | Execution |
| --- | --- | --- | --- |
| current exact `trusted` | `allowed` trust contribution | `allowed` | `allowed` |
| restricted/missing/stale | `allowed` | at least `approval-required` | `denied` |

The contribution is folded with mode, action class, resource scope, risk, hard denials, containment,
budgets, and platform gates through `strictestCodingWorkbenchPolicyEffect`. Trusted is the identity
element. Denied remains absorbing. Trust never changes requested mode, the Coding Workbench mode
deployment ceiling, or any of ADR-0138's 48 matrix cells.

### D4 — Effectful dispatch names one root; the server proves authority again

Every M11 mutating or executing dispatch carries an exact schema, workspace id, manifest
reference/revision/digest, root reference, root identity digest, and closed operation class. There is
no optional root, raw caller-supplied path root, `activeRoot`, or focused-root fallback.

That contract is routing intent, not authority. Before and immediately before an effect, the server
must:

1. resolve the current manifest and prove revision/digest currency;
2. prove the root is a current member and recompute its filesystem/source identity;
3. re-run lexical and realpath containment for each target;
4. resolve current trust and capability-specific basis state;
5. revalidate the Authority Envelope against root, manifest, trust/policy revisions, action class,
   expiry, and budgets; and
6. reject removed, replaced, overlapping, stale, cross-root, or mixed-root requests.

Cross-root mutation transactions remain outside M11 V1. Even when all roots are trusted, one request
cannot blend them without a later atomic-rollback contract.

### D5 — M7 settings gain profile and root layers through one adapter

M7's registry, value parser, setting ids, effects, bounds, and policy ceiling are reused unchanged.
Its public `EditorM7SettingScope`, `EditorM7SettingsLayer`, and legacy resolver are not widened.
M11 adds validated profile and root layer records and one resolver adapter with this total order:

`builtInDefault < profile < user < workspace < root < policy/security ceiling`.

The active profile is a base-personality overlay below explicit user settings. Existing calls that
omit profile/root therefore remain `workspace ?? user ?? default` byte-for-byte. Root settings reuse
M7 workspace-scope admissibility; profile settings reuse user-scope admissibility. Every effective
setting reports the exact source plus profile/root reference where applicable. Policy remains an
annotation/tightening ceiling after source resolution and never rewrites stored user intent.

Managed-LSP configuration does not adopt this source list. Multi-root composition selects one
root's existing ADR-0132 workspace record and then applies that control plane's current precedence.

An existing settings record that predates the private object binding is adopted in place only when
its public V1 root identity matches the live root and a durable private identity is available. Any
public or private mismatch contributes no settings and is never repaired by path equality alone.

### D6 — Profiles are portable personalization, never authority

Profile V1 contains only a branded profile reference, bounded display name, revision, and a
validated M11 profile settings layer. `keybindingOverrides` rides through the existing M7 setting
value and registry; no second keyboard subsystem is introduced. Workspace snippets remain
workspace-scoped, and UI layout remains browser-local and out of profile V1.

Profile V1 is global personalization for settings and keybindings. Its records and active-profile
selection have no workspace/root binding and never adopt or carry either public or private root
identity.

Profiles cannot represent roots, absolute paths, trust, autonomy modes, deployment ceilings,
Authority Envelopes, approval grants, managed-LSP activation/runtime identities, connector scopes,
delivery settings, credentials, auth references, endpoints, snippets, customer text, evidence, or
event history. Unknown fields and future schema versions reject the complete manifest.

Export is assembled server-side from validated stored state, never from browser projection. The V1
closed shape is reconstructed deterministically, making redaction idempotent. String/list values are
revalidated through the closed registry and portable-path classes; invalid imports appear as typed
rejected preview rows in #2529 and are never silently preserved. Import creates a new profile and
cannot overwrite existing state.

### D7 — Local history is encrypted, self-bound, bounded file-checkpoint history

Local history stores only versioned editor file checkpoints for the user's workspace files. It does
not accept Code-task transcripts, prompts, model output, tool activity, command/terminal output,
chat messages, snippets, memory records, Git history bodies, diffs, or evidence bodies.

The clear metadata entry carries branded checkpoint/vault/root references, root identity, portable
relative path plus path digest, predecessor fact, sequence, origin (`user-save | agent-apply |
pre-restore`), timestamps, plaintext digest/byte count, payload-binding digest, encrypted-content
reference, and pin state. There is no plaintext/ciphertext body field.

The encrypted payload must self-bind and revalidate after decryption:

- payload schema and expected vault reference;
- checkpoint id, root id/digest, path digest, predecessor, and sequence;
- origin and capture timestamp; and
- plaintext content digest and exact byte count.

Any wrong-key, tampered, replayed, swapped-reference, schema-skewed, or metadata-mismatched payload
fails closed without returning bytes or deleting unrelated history. The store uses its own vault
file, environment key name, keychain service, and keyfile namespace; it reuses the audited
`LocalSecretVault`/AES-256-GCM primitive but not hot exit's key or records. The keyfile tier remains
honestly documented as weaker, and plaintext exists in process memory during an authorized read.

Capture also fails closed on secret-shaped content itself (#2898), mirroring hot exit's
`containsRedactableSecret` gate (ADR-0065 D2) rather than relying on encryption-at-rest alone: before
any vault or index write, `capture()` scans `input.content` and, on a match, throws
`SECRET_CONTENT_SUPPRESSED` without writing a checkpoint body, an index entry, or any other record of
the attempt — list/entry/read stay exactly as they were before the call. Unlike hot exit's single
overwritten snapshot, a suppressed Local History checkpoint has no prior version to fall back to and
no in-place row to mark, so suppression is a thrown error the caller must handle rather than a stored
`suppressed: true` flag. `captureEditorLocalHistorySafely` maps that error to its own
`FilesContentResponse.localHistoryProtection` status — `{status: "suppressed", reason:
"secret-detected", correlationId}` — kept apart from the unavailable-infrastructure `degraded` status
because a suppression is the protection working as intended, not a failure of it; the editor's save
still succeeds. The 90-day TTL below was reconsidered and deliberately kept: unlike hot exit's single
fire-and-forget recovery snapshot, Local History is a listed, diffable, user-facing checkpoint feed,
so a materially shorter default would reduce the feature's value for its actual purpose (recovering
an earlier revision of ordinary source) without narrowing the risk this change already closes — the
gap was the unfiltered capture of secret-shaped content, not the retention window applied to
everything else.

Normative fixed V1 bounds are 512 entries/workspace, 8 MiB/entry, 256 MiB/workspace, 64 MiB pinned,
50 versions/file, and 90 days TTL. Pruning is deterministic oldest-accessed first with checkpoint-id
tie-break, satisfies count and byte pressure, and never selects pins. If pins prevent required
capacity, new capture returns `PINNED_CAPACITY_EXHAUSTED`; it never deletes pins or grows unbounded.
Capture failure never rolls back a successful save/apply and emits only a correlation id plus closed
content-free reason.

The private metadata index itself is capped at 16 MiB before reading or JSON parsing. Symlinks,
non-regular files, size drift, and a changed opened-file identity fail closed with content-free
codes. Read, pin, and delete routes repeat live public and private root-identity validation
synchronously after asynchronous containment work and immediately before the store effect.

Filename-bearing metadata and checkpoint content require the ADR-0141 launcher-attested app session.
Unauthenticated status/SSE remains content-free and is not widened. Restore in #2531 routes through
the existing governed save/apply/conflict flow and checkpoints the pre-restore state.

A legacy local-history index is adopted and sealed to the private object identity only when every
entry's public V1 root identity matches the live root. A mismatch, unavailable private identity, or
subsequent object replacement makes the index unavailable before read, pin, delete, or restore.
Once the replacement object is independently authorized, it receives a fresh object-bound history
namespace. The superseded encrypted namespace remains quarantined rather than being exposed to the
replacement or deleted as a side effect of an ordinary history request.

### D8 — Each state class has exactly one storage substrate

| State | Substrate | Reason |
| --- | --- | --- |
| Workspace manifest, ordered membership, focus, canonical trust metadata | existing `uiDb`, one transaction domain | Ordered roots, revisions, migration, relational constraints, and atomic root-removal/trust invalidation. Trust metadata is content-free and does not need encryption. |
| User/workspace/root editor settings | existing server-private JSON settings store | Reuses ADR-0133's fingerprinted, bounded, atomic, symlink-refusing owner. |
| Profile records and active-profile pointer | one bounded server-private JSON aggregate beside settings | Small non-secret state; one aggregate avoids a crash-dangling pointer and reuses revision/ETag/idempotency discipline. |
| Local-history metadata index | bounded server-private JSON in the dedicated history directory | Mirrors hot exit's non-secret in-memory/private index, is reconstructable/untrusted, and never stores content. |
| Local-history checkpoint body | dedicated encrypted `LocalSecretVault` namespace | Content requires authenticated encryption and key separation; it never enters plaintext JSON or SQLite. |

Manifest membership and trust invalidation commit atomically. If implementation cannot keep them in
one transaction, every trust record and Authority Envelope must bind the exact manifest digest and
revision before any effect, and cleanup is only secondary. Root removal makes old grants unusable in
the same committed state transition.

### D9 — Forward-only migration and compatibility

#2524 owns migration execution. It creates a one-root manifest from the current active project using
server-derived identity, then keeps V1 task-workspace data unchanged. Migration is transactional,
idempotent, version checked, and fail closed: corrupt/future state yields unavailable/restricted and
cannot authorize an effect. Rollback may remove new M11 state but cannot reinterpret V2 as V1 or
restore invalidated grants.

At M11 introduction, profiles and history had no pre-M11 records. Missing state is tagged `absent`;
unreadable/corrupt state is `unavailable`. Those outcomes are not silently conflated.

The V17 `uiDb` migration backfills the private object digest only for roots whose live public V1
identity still matches the stored descriptor and whose private digest is unique across all
candidates. All other rows retain an explicit `NULL` unavailable binding. Because pre-V17 trust was
never bound to this fact, V17 revokes all legacy trust rows once in the migration transaction; no
grant is inferred or resurrected. Settings and local history migrate lazily under their matching
public-identity adoption rules above.

## Threat model and security invariants

The model includes hostile workspaces and symlinks; browser requests that supply stale roots,
digests, trust, or profile data; same-user loopback processes; corrupt/rolled-back/future local
state; profile files containing paths/secrets/authority; crashes between membership and trust
updates; ciphertext/reference replay; root replacement at the same path; stale Authority Envelopes
and app sessions; and an agent authorized for root A attempting to consume root B.

The implementation children must preserve these invariants:

- browser data never mints root identity, trust, digest, policy, session, or execution authority;
- root focus and profile switching never modify trust or any Authority Envelope;
- every accepted effect resolves exactly one current root, with no focus/active fallback;
- root removal/replacement invalidates grants, settings bindings, sessions, and envelopes before a
  later effect;
- unknown keys are rejected recursively on authority/persisted contracts;
- evidence/diagnostics contain only closed enums, opaque ids/digests, revisions, counts, sizes,
  booleans, timestamps, and correlation ids; and
- local-history content is reachable only through the authenticated channel and never through logs,
  errors, status, SSE, evidence, analytics, or profile export.

## Verification

Failure-first co-located tests must cover:

- exact V1 serialized bytes and old forbidden-field/root-equality behavior;
- valid one/multi-root V2 plus duplicate, overlapping, foreign-focus, mixed-version, and per-root
  divergence rejection;
- paired positive and unpaired path-free workspace-manifest route/browser projections;
- exact-bigint private object identity, unique V17 backfill, unsupported-filesystem denial, and
  one-time legacy trust revocation;
- every trust fact, stale binding dimension, package-basis mismatch, and legacy binary projection;
- exhaustive mode clamp and trust-effect monotonicity, including denied absorption;
- every settings precedence layer and policy-last provenance;
- profile path/secret/authority smuggling and idempotent deterministic export reconstruction;
- hostile getters/proxies, unknown keys, schema skew, malformed brands/digests/instants, bounds, and
  portability paths; and
- history self-binding metadata, index totals/uniqueness, deterministic count/byte retention, pin
  pressure, transcript/raw-content rejection, and cross-root/reference replay expectations.

This issue changes only `keiko-contracts` and ADR documentation. `arch:check` must prove zero runtime
wiring and no new package edge. Public exports require package-surface verification. The contracts
surface is D12-measured, so Linux-authoritative editor evidence is regenerated only after the final
combined contracts tree and committed as the final evidence change.

## Consequences

- Later M11 children receive one contract vocabulary before any store, route, or UI wiring lands.
- Code-task V1 consumers keep compiling and serializing exactly as before.
- Trust becomes durable and root-aware without adding an autonomy mode or policy matrix.
- Profile V1 deliberately contains only settings and keybindings; snippets, managed-LSP state,
  roots, layout, and authority stay out until a separately justified amendment.
- Local history gains stronger identity binding than a literal hot-exit copy and remains separate
  from Code-task transcript, memory, chat, Git history, and evidence stores.
- The cost is explicit versioning, more tagged states, transactional membership/trust storage, and
  an authenticated encrypted-content path; those costs are the controls that make multi-root safe.

## Alternatives considered

### Add optional roots to V1 or rename the V1 union to `WorkspaceBinding`

Rejected. Optional fields weaken the closed-key boundary; a union under the existing public name
breaks scalar consumers and forces out-of-scope wiring.

### Encode Restricted Mode as a fourth mode or a `governed-assist` ceiling

Rejected. It would duplicate or distort ADR-0138. Trust is action-specific: reads remain allowed,
mutations require approval, and execution can be denied. One mode ceiling cannot express that.

### Persist a single unqualified trusted flag

Rejected. It would bypass package-manifest invalidation, resurrect grants after root replacement,
and make future executable capabilities share an ambiguous basis.

### Put trust in independent private JSON beside a SQLite manifest

Rejected. A crash between root removal and trust cleanup could preserve an authority-bearing grant.
The same transaction domain removes that gap.

### Put profiles in browser storage or include trust/runtime state

Rejected. Browser state is not canonical, and import would become an authority-widening path.

### Reuse hot-exit records, `uiDb` plaintext content, Git history, or the memory vault for history

Rejected. Hot exit is one latest recovery snapshot; Git/memory/Code-task records have different
semantics and governance; plaintext SQLite does not protect content. Only the audited encryption
primitive and bounded-retention patterns are reused in a dedicated namespace.

## References

- Epic #2285 and Issue #2520.
- M9 provisional task-trust coordination from Program Epic #2088.
- [ADR-0013](ADR-0013-ui-local-persistence-for-projects-and-chats.md) — transactional `uiDb`
  migration/storage precedent.
- [ADR-0035](ADR-0035-memory-vault-encryption-at-rest.md) — authenticated encryption and honest key
  limitations.
- [ADR-0046](ADR-0046-local-credential-vault.md) — `LocalSecretVault`, key separation, and atomic
  private-vault precedent.
- [ADR-0088](ADR-0088-task-workspace-domain-contract.md),
  [ADR-0090](ADR-0090-active-task-workspace-binding-and-surface-retargeting.md),
  [ADR-0126](ADR-0126-editor-verification-surface-and-problems-aggregation.md),
  [ADR-0132](ADR-0132-managed-multi-language-lsp-activation-and-configuration.md),
  [ADR-0133](ADR-0133-editor-m7-personalization-and-resilience-control-plane.md),
  [ADR-0137](ADR-0137-server-owned-coding-runtime-contracts.md),
  [ADR-0138](ADR-0138-monotonic-product-wide-autonomy-semantics-and-code-task-terminology.md), and
  [ADR-0141](ADR-0141-authenticated-local-app-session-channel.md).
