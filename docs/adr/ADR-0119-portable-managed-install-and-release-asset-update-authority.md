# ADR-0119: Portable managed install and release-asset update authority

## Status

Accepted (Issue #1946, 2026-07-05).

## Context

Keiko already governs standard package-manager updates through ADR-0099, keeps the product bundled
through ADR-0021, uses shared outbound egress through ADR-0038, and keeps local state and evidence
content-free and machine-owned through ADR-0027, ADR-0048, and the local runtime state contract.

Issue #1946 adds a separate portable product path. That path cannot depend on a package manager at
first run, cannot blur install state with `.keiko`, and cannot invent a separate compatibility
catalog or update authority. It also carries a delivery constraint: the program must converge
through one integration branch and one final human-reviewed PR to `dev` only after integrated
end-to-end QA passes.

This ADR extends the governed update model for the `portable-managed` install mode only. It does not
replace ADR-0099 for npm or Yarn installs.

## Scope

In scope:

- public archive-style portable release assets,
- thin launchers that start and relaunch the existing Keiko Node/BFF/browser product,
- first-run setup into a user-owned managed install folder,
- user-local app registration for normal OS launch/search surfaces,
- `portable-managed` install attestation,
- GitHub Release Asset installability and release-impact compatibility binding,
- explicit one-click portable updates with automatic relaunch and version verification,
- content-free local update state, recovery manifests, and remediation status.

Out of scope:

- Electron, Tauri, browser embedding, tray, background service, privileged helper, or native desktop
  wrapper runtime,
- MSI, MSIX, PKG, DMG, MDM, Jamf, Intune, SCCM, Munki, or organization-managed rollout,
- machine-wide self-update, admin-required happy paths, or mutation of IT-managed installs,
- rollback, downgrade, beta, canary, prerelease, private-channel, or silent background updates,
- Linux or Windows arm64 portable assets.

## Decision

### D1 — Portable delivery is archive-first

Keiko will ship the portable-managed product as archive-first release assets.

Each stable release will expose exactly three first-class portable assets:

- `windows-x64`
- `macos-arm64`
- `macos-x64`

Those assets are the promoted portable delivery path for stable releases. They are the installable
product surface for this wave. The three assets are release-blocking as a set: a stable release is
not portable-complete when one platform is missing, unsigned, unnotarized where required, or
unverified.

Each asset must be accompanied by reviewed metadata that binds the artifact name, platform target,
GitHub release id, release tag, asset id, asset name, size in bytes, Keiko version, bundled Node.js
runtime identity, archive SHA-256 digest, package/build provenance, SBOM/license evidence, and
signing/notarization status to the same reviewed release-impact entry. Tag or filename matching
alone is insufficient. Any mismatch fails closed before extraction. Artifact metadata is
operational evidence; it must not contain customer paths, credentials, prompts, model output,
repository content, or raw logs.

### D2 — Launchers stay thin

The platform entry points are thin native launchers:

- `Keiko.exe`
- `Keiko.app`

They may locate, start, and relaunch the managed install, but they do not introduce Electron,
Tauri, or a native wrapper runtime in this wave. Wrapper ownership remains deferred until a later
decision creates a real need for it.

Native launcher trust is part of portable installability. macOS portable assets must verify the
approved Developer ID signature and notarization status before staging or promotion. Windows
portable assets must verify the approved Authenticode publisher chain before promotion. If a
platform cannot produce and locally verify that proof in v1, portable self-update on that platform
is manual-only.

### D3 — First-run install state is separate from `.keiko`

First run expands the portable archive into a user-owned managed install folder.

That folder is distinct from `.keiko`, which remains the runtime-state root for governed local state
such as update recovery, redacted evidence, and other Keiko-owned runtime data. Portable install
payloads must not be treated as generic runtime state or a shared cache.

The bootstrap archive location is not self-update eligible by itself. First-run setup must attest a
single managed install root before the normal app/update lifecycle starts. User-local app
registration, such as a Windows Start Menu shortcut or a macOS user application entry, is allowed
only as a consequence of explicit setup and must point back to the managed install. Setup must not
write machine-wide OS state or require administrator rights by default.

The managed install root must be a dedicated Keiko-owned realpath separate from `.keiko`, customer
repositories, temporary directories, shared/network roots, and system-managed locations. Every write
must be contained after realpath resolution, and launcher/runtime identity must attest the same root
before every portable update. If ownership, ACLs, a write probe, or root classification shows an
admin-required or organization-managed installation, Keiko emits manual instructions only. V1 must
not prompt for elevation, install a helper service, schedule a task, or register a background
updater.

### D4 — Source-of-truth split

GitHub Release Assets are the authoritative source of portable installability.

For portable-managed installs, asset presence, platform labels, and attached release metadata
determine whether the product is installable. GitHub release prose is informational only.

The release-impact catalog remains the authoritative source of compatibility and remediation.
It records whether a release requires restart, repair, local reindexing, migration, manual review,
or other user action. It is the only compatibility/remediation authority for this release line.

External release and asset metadata lookups must route through the governed server-side egress
surface. Browser-tier code must not fetch GitHub update metadata or portable assets directly. Proxy,
custom-CA, timeout, and byte-limit behavior follows ADR-0038. Proxy URLs with embedded credentials
remain forbidden. If proxy authentication is required, portable self-update is manual-only until a
separate credential-handling decision exists.

### D5 — One-click update reuses the governed updater

Portable-managed installs use the existing governed updater authority rather than a parallel update
system.

The portable update path is explicit and user-confirmed. It stages the candidate archive, verifies
the candidate, swaps it into the managed install, and relaunches. Update state, recovery snapshots,
remediation status, and audit evidence remain content-free local runtime state.

Portable update success means the new managed install is active, Keiko has relaunched, the running
version matches the target stable release, and release-impact remediation is complete or explicitly
safe to defer. A failed download, verification, staging, activation, relaunch, or remediation step
must fail closed and preserve the current working install when safe. This is failure recovery, not a
user-facing rollback feature.

Crash-safe promotion is mandatory because `.keiko/updates` does not store package payload backups.
Portable updates must download, extract, and verify into staging first; they must never remove the
currently launchable tree before the replacement is fully verified. Promotion requires same-volume
atomic rename semantics, or an equally reviewed platform primitive with the same fail-closed
property. If the detected filesystem or layout cannot provide crash-safe promotion, one-click
portable update is rejected as manual-only.

Supported v1 behavior excludes:

- rollback,
- downgrade,
- prerelease or beta channels,
- silent background auto-update,
- admin-required install,
- IT-managed self-update.

If the updater cannot attest a single managed target, it must refuse one-click execution and show
manual instructions only.

The npm/Yarn updater remains a compatibility path under ADR-0099, but portable updater v2 must not
create a legacy/channel tab or ask ordinary users to choose between update mechanisms. The UI should
show the one detected recommended action or an honest blocked/manual state.

### D6 — Program integration is one branch, one final PR

The portable delivery program is integrated through one program branch.

Child implementation work may branch for development and QA, but the only branch that targets `dev`
is the integrated branch after integrated end-to-end QA has passed and a human reviewer has approved
the result.

## Security and threat model

Security review for implementation under this ADR must cover:

- **Asset authenticity and completeness.** Missing, wrong-platform, malformed, unsigned,
  unnotarized, checksum-mismatched, or provenance-mismatched assets are not installable.
- **Archive extraction.** Portable archives are hostile input. Extraction must reject path
  traversal, absolute paths, symlink or hardlink escapes, device/special files, and unexpected
  executable placement before writing into the managed install.
- **Managed-root authority.** Only an attested user-owned managed install root is self-update
  eligible. Unmanaged bootstrap folders, local checkouts, linked packages, transient launchers,
  machine-wide locations, and IT-managed installs are blocked from one-click portable mutation.
- **Running-process replacement.** Platform-specific swap and relaunch mechanics must account for
  locked files on Windows and quarantine/signing behavior on macOS without broadening update
  authority or requiring an always-on helper in v1.
- **External egress.** GitHub metadata and asset fetches use the governed proxy/custom-CA-aware
  server egress path with bounded timeouts and size limits; browser-direct external update fetches
  are forbidden.
- **State and evidence confidentiality.** Update state records target versions, platform target,
  asset ids, manifest digests, hashed/root-free install identity, statuses, bounded warning codes,
  remediation state, and aggregate counts only. They must not persist archive payloads, raw logs,
  absolute install/staging paths, private paths, asset URLs, notarization tickets, tool
  stdout/stderr, credentials, prompts, model output, customer repository files, or package-manager
  output.
- **User control.** Setup and update mutation require explicit local user action. Background checks
  may be read-only, but silent update execution is forbidden.
- **Failure posture.** Verification, staging, swap, relaunch, and remediation failures must be
  visible, resumable where possible, and fail closed. They must not delete `.keiko` runtime state or
  customer files.

## Consequences

### Positive

- Portable release assets have one installability authority.
- Compatibility and remediation stay in the reviewed release-impact catalog instead of drifting into
  release prose.
- The managed install folder stays separate from `.keiko`, which keeps runtime state and install
  payloads from being mixed.
- The portable update path can reuse the existing governed updater and evidence semantics instead of
  creating a second mutation authority.

### Negative

- V1 excludes rollback and organization-managed self-update flows.
- The portable path needs thin per-platform launchers and archive packaging support.
- Portable installs that cannot attest a single managed target must fall back to manual
  instructions.

## Alternatives considered

1. Electron, Tauri, or another desktop wrapper first. Rejected because it adds a new runtime owner
   and shifts the wave away from archive-first portable delivery.
2. MSI, MSIX, PKG, or DMG as the primary portable format. Rejected because this issue asks for
   archive-first delivery and a user-owned managed install folder.
3. A separate portable compatibility catalog. Rejected because the release-impact catalog already
   owns compatibility and remediation, and a second catalog would drift.
4. GitHub Release notes as the installability authority. Rejected because prose is not a source of
   installability truth.

## Compatibility with existing ADRs

- ADR-0021 keeps the bundled monorepo product model that these release assets package.
- ADR-0027 keeps managed install state separate from `.keiko` runtime state.
- ADR-0038 provides the shared proxy- and custom-CA-aware egress path for anonymous metadata fetches.
- ADR-0048 keeps update evidence local, redacted, and content-free.
- ADR-0099 remains the governing update contract for standard npm and Yarn installs; this ADR
  extends it only for `portable-managed` installs.
- The local runtime state contract already names the update recovery state directory and the
  `.keiko` boundary this ADR relies on.

## Related

- [ADR-0021: Publish Strategy - Bundled Monorepo Product](ADR-0021-publish-strategy-bundled-monorepo-product.md)
- [ADR-0027: Workspace state ownership and persistence boundaries](ADR-0027-workspace-state-ownership.md)
- [ADR-0038: Shared proxy- and custom-CA-aware outbound HTTP egress](ADR-0038-outbound-egress.md)
- [ADR-0048: Evidence and Quality Intelligence artifact confidentiality hardening](ADR-0048-evidence-artifact-confidentiality.md)
- [ADR-0099: Governed in-app updates and release-impact contract](ADR-0099-governed-in-app-updates-and-release-impact-contract.md)
- [Local runtime state contract](../local-runtime-state-contract.md)
- Issue #1946
