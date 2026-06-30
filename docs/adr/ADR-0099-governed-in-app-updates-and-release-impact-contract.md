# ADR-0099: Governed in-app updates and release-impact contract

## Status

Accepted (Issue #1689, 2026-06-30)

## Date

2026-06-30

## Version

0.2.11

## Context

Keiko is a regulated-delivery tool. A package update can change executable behavior, release
compatibility, and recovery posture, so it must be governed rather than treated as a background
maintenance task.

This issue closes four gaps:

1. Keiko must never auto-update and must not run update execution until the user confirms it.
2. The updater needs a release-impact contract that binds a candidate update to exact package and
   release metadata, with stable public `latest` releases as the v1 installability source of truth
   and supported public releases as the default forward-migration path.
3. The updater must distinguish supported managed installs from unsupported or ambiguous launch
   modes. If the installation target cannot be attested, the updater must show manual instructions
   only.
4. Update state, evidence, and recovery artifacts must stay in Keiko-owned local runtime state and
   must not become a general backup or a shared package cache.

This ADR reuses existing boundaries rather than creating a parallel release system:

- ADR-0021 keeps the product a bundled npm-delivered surface.
- ADR-0024 keeps the PWA/service-worker update path separate from package mutation.
- ADR-0025 keeps the baseline forward-only and current-release oriented.
- ADR-0027 keeps state ownership local and explicit.
- ADR-0030 keeps command execution and workspace boundaries governed.
- ADR-0038 provides the shared outbound egress, proxy, and custom-CA surface for public metadata
  requests.
- ADR-0047 and ADR-0048 keep local knowledge and evidence confidentiality local and content-safe.
- ADR-0080, ADR-0083, and ADR-0085 establish the governed mutation, evidence, and publish
  patterns Keiko already uses for higher-risk writes.
- ADR-0091 and ADR-0093 establish startup reconciliation and failure-recovery patterns that the
  updater must follow, not duplicate.

Scope boundary for Issue #1689:

- In scope: governed update checks, release-impact metadata, managed-install attestation, update
  execution policy, local recovery snapshots, local evidence, and operator-visible warnings.
- Out of scope: shell refresh / PWA activation, generic package-manager wrappers, package-cache
  management, remote backup, and browser-direct registry or GitHub fetches.

## Decision

Keiko will expose a governed update flow with four rules:

1. Update checks are read-only and may inspect only anonymous public metadata plus local state
   inventory.
2. Supported update execution requires an explicit user confirmation inside Keiko.
3. Supported public releases follow a safe forward-migration path by default.
4. Emergency breaking exceptions require a separate human-approved path and are excluded from the
   normal one-click update path unless a verified carry-forward path exists.

### Release impact metadata contract

The updater consumes a release-impact contract that binds the candidate update to the release data
needed to decide whether the update is supported and what it would change.

The v1 contract is anchored to public npm metadata for the stable `latest` channel. Prerelease,
beta, canary, or enterprise-private channels are explicitly out of scope for v1 update execution.
Standard npm packument metadata is not the source for compatibility details. Those fields come from
Keiko's reviewed release-impact catalog.

- `packageName` and `packageVersion` identify the exact package release.
- `distTag` identifies the release channel used for the candidate and must be `latest` for v1
  automatic eligibility.
- `registry` identifies the public package registry used for the anonymous metadata lookup.
- `releaseTag` identifies the Git tag or release label that corresponds to the published package
  version.
- `publishGates` records the release gates that were satisfied before the package was published,
  such as version consistency, publish-manifest validation, package-surface validation, and install
  smoke.
- `supportedFrom` records the public versions that have a reviewed forward compatibility path into
  the release.
- `stateImpact`, `remediation`, and `userActionRequired` record the local state stores or features
  affected by the update and the required carry-forward action, if any.
- `patchNotes` records concise human-readable bullets generated from the reviewed structured
  metadata rather than free-form release prose.

GitHub Release notes or catalog copy are human-readable compatibility inputs only. They are not an
independent trust root. For supported public releases, npm registry metadata is the installability
truth, especially the exact package version and the active dist-tag. Release-impact metadata decides
compatibility and remediation eligibility; package installability alone is not full update success.

The release-impact catalog is the structured v1 source of truth for non-packument fields. It is
source-controlled, append-only for published entries, bundled into the root package, and may be
mirrored through GitHub Release metadata for server-side lookup of newer target releases. The update
service may accept a target release-impact entry only when it binds to the same `packageName`,
`packageVersion`, `distTag`, and `releaseTag` selected from npm `latest` and records reviewed
publish gates for that release. If no matching reviewed entry exists, Keiko may report update
availability, but the candidate is not eligible for one-click execution.

### Supported install modes and execution policy

The updater targets one managed installation only. It must be able to attest all of the following:

- the package manager in use,
- the executable being launched,
- the package root it is mutating, and
- the installed version at that root.

Supported v1 update execution is limited to persistent npm or Yarn installs that satisfy those
checks. The updater must refuse to guess when the launch mode is ambiguous.

Unsupported or ambiguous modes include:

- `npx` / `yarn dlx`,
- dev-checkout launches,
- linked packages,
- PATH drift,
- manual installs with no attested package root.

Those modes receive manual instructions only. They do not enter governed update execution.

Update execution must stay out of generic terminal or package-manager execution paths. It runs
through a dedicated governed server-side update authority with fixed argv, no shell, a bounded
environment, one active session, a policy gate, and fail-closed semantics. The authority must never
guess commands.

Any updater mutation route must use Keiko's existing loopback BFF boundary. State-changing updater
requests require the same Host/Origin validation, JSON request validation, `X-Keiko-CSRF` gate, and
`Cache-Control: no-store` posture as other governed local mutations. Browser code must call only the
local BFF, never the npm registry or GitHub update metadata endpoints directly.

The CLI `keiko update apply` command is a separate governed local entry point, not a browser
mutation route. It is available only to a deliberate local shell user, so Host/Origin and CSRF
protections do not apply. It must still use the same managed-install attestation, policy gate,
fixed argv allowlist, release-impact checks, state-directory session lock, timeout/abort behavior,
and evidence semantics as the BFF authority so CLI and UI update attempts cannot overlap or drift.

### Compatibility and remediation policy

For supported public releases, the default path is safe forward migration or remediation. The
updater should move toward the current supported release line rather than try to preserve an older
state by rewinding or pinning to an unsupported build.

Release-impact metadata must use this closed remediation set:

- `no-action-required`: compatibility is already satisfied after install and restart checks.
- `restart-required`: Keiko must restart or reconnect before the new version is complete.
- `repair-required`: Keiko-owned local runtime state requires the existing repair path or a
  deterministic updater-specific repair.
- `local-knowledge-reindex-required`: Local Knowledge indexes must be rebuilt or refreshed before
  affected search/retrieval features return to normal operation.
- `migration-required`: a deterministic Keiko-owned state migration must run and record completion.
- `manual-review-required`: Keiko cannot safely complete the compatibility step automatically and
  must keep affected functionality degraded or unavailable until the user follows reviewed
  instructions.

Each remediation action must be resumable and stored in local update state with a content-free
status. Package install success is not full update success until every required action is complete
or explicitly marked safe to defer by release-impact metadata. Unaffected workflows remain usable;
affected features must show degraded or unavailable status until their required action completes.

Emergency breaking exceptions are permitted only when all of the following are true:

- a human explicitly approves the exception,
- the rationale is documented,
- the UI shows warning text before execution,
- the exception is excluded from the normal one-click update path unless a verified carry-forward
  path exists, and
- the verified carry-forward path is named in release-impact metadata.

If the carry-forward path is not verified, the exception stays manual and the update does not run.
If the carry-forward path is verified, the update may still run only after the normal explicit user
confirmation plus the exception warning path.

### Recovery snapshots

Recovery snapshots are local-only Keiko-owned artifacts. They capture the minimum local state needed
to explain or recover an interrupted update, but they are not package archives, general backups, or
shared caches.

Snapshots must stay inside Keiko-owned runtime state, use the same local confidentiality rules as
other local state, and remain isolated from browser storage and repository content. They may record
version pointers, attestation data, and remediation outcome state. They must not store package
payloads, full tarballs, or a broad backup copy of the installation.

Snapshot retention is capped to the previous version for each managed installation target. Keiko
keeps only the most recent pre-update snapshot needed to recover or explain the current update from
the immediately previous version. A newer successful pre-update snapshot replaces the older retained
snapshot only after the new snapshot is complete. Failed or interrupted updates keep the active
previous-version snapshot until the update is recovered, completed, or explicitly abandoned; Keiko
does not accumulate historical snapshot archives.

### Runtime state and evidence

Update state remains local. The updater may record its evidence and snapshot references in
Keiko-owned runtime state, but it must not move those records into repository files, browser durable
state, or remote storage.

The evidence record for an update should stay content-free:

- the managed-install attestation result,
- the exact package version and dist-tag considered,
- the release-gate result,
- the user confirmation outcome,
- the update execution result, and
- the recovery snapshot reference.

If the updater cannot prove a single managed target, it must not emit a mutation attempt. It should
emit a manual instruction path only.

### Alternatives considered

1. Rely on `npm update -g`, `npm install -g`, or equivalent standard package-manager tooling. This
   was rejected because package managers know installability, not Keiko's release-impact contract,
   local-state remediation requirements, managed-install attestation, or regulated evidence needs.
2. Keep updates as release notes only: show a version badge and deep link to manual package-manager
   instructions without in-app execution. This is safer than an ungoverned updater, but it does not
   provide a reviewable confirmation path, local remediation status, or recovery evidence for
   managed enterprise installs.
3. Re-run an installer or bootstrap script. This was rejected for v1 because installer scripts have
   a wider command and filesystem surface than the fixed package-manager argv used here, and would
   duplicate install-mode attestation, policy, and rollback evidence outside Keiko's existing
   governed mutation model.

### Security and threat model

Security review for this feature must cover:

- command execution: fixed argv, no shell, one active session, fail-closed command selection, and
  no guessed commands,
- external metadata: anonymous registry lookups only, through the shared outbound egress layer and
  existing proxy/custom-CA configuration, with no browser-direct registry or GitHub fetches,
- snapshots: local-only recovery artifacts, not packages or general backups,
- remediation: explicit user confirmation for supported updates, documented human approval for
  emergency breaking exceptions, and user-visible warning text for exception paths,
- evidence: local, redacted, content-free update evidence only,
- policy gates: managed-install attestation, release-impact binding, and forward-only remediation by
  default,
- local route protection: loopback BFF only, Host/Origin validation, CSRF enforcement, no browser
  direct external update calls, and no-store response handling for mutation state.

### Later child issue gates

Implementation work under this ADR must satisfy these gates before it is considered complete:

- a single managed installation target is identified or the update is rejected,
- release-impact metadata is resolved from a reviewed catalog entry bound to the npm `latest`
  package version and release tag,
- supported public-release updates require explicit confirmation,
- update checks stay anonymous and do not export local inventory,
- supported public releases prefer forward migration or remediation,
- remediation uses the closed vocabulary in this ADR and records resumable local status,
- breaking exceptions require documented human approval and warning text,
- the snapshot and evidence stores remain local-only and Keiko-owned, with snapshot retention capped
  to the previous version,
- updater mutation routes inherit loopback BFF, Host/Origin, CSRF, and no-store protections,
- PWA/service-worker refresh remains separate from product package mutation.

## Consequences

### Positive

- Keiko does not mutate itself in the background.
- The updater has one governed path instead of multiple ad hoc package-manager entry points.
- Release candidates can be tied to a precise package version and release channel.
- Recovery artifacts stay local and bounded.
- The policy surface is explicit enough for later implementation and review.

### Negative

- Some launch modes cannot be upgraded in place and must use manual instructions.
- Emergency breaking updates need an explicit approval path instead of a single default button.
- The update flow has to maintain its own governed execution authority instead of reusing generic
  shell execution.

### Neutral

- PWA/service-worker updates remain a separate browser/runtime concern.
- GitHub Release metadata can remain human-readable release information without becoming a new trust
  root.
- Local recovery artifacts are available for interruption handling, but they are not a backup
  product.

## Compatibility with existing ADRs

- ADR-0021: preserves the bundled npm delivery model.
- ADR-0024: keeps browser/runtime update activation separate from product package mutation.
- ADR-0025: keeps release behavior forward-only.
- ADR-0027: keeps state ownership local.
- ADR-0030: keeps command execution governed.
- ADR-0038: reuses the existing egress, proxy, and CA configuration for anonymous metadata checks.
- ADR-0047 and ADR-0048: keep local state and evidence confidential and local.
- ADR-0080, ADR-0083, ADR-0085: preserve the governed mutation, evidence, and publish patterns.
- ADR-0091 and ADR-0093: reuse the startup reconciliation and failure-recovery posture.

## Related

- [Local runtime state contract](../local-runtime-state-contract.md)
- [Security boundaries](../security-and-audit-boundaries.md)
- [Release publish workflow](../release/release-publish-workflow.md)
