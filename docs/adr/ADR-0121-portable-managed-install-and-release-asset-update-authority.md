# ADR-0121: Portable managed install and release-asset update authority

## Status

Accepted (Issue #1946, 2026-07-05); amended for the Windows setup companion (Issue #2966,
2026-08-04).

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
- first-run setup into a target-specific managed install folder,
- app registration for normal OS launch/search surfaces,
- `portable-managed` install attestation,
- GitHub Release Asset installability and release-impact compatibility binding,
- explicit one-click portable updates with automatic relaunch and version verification,
- content-free local update state, recovery manifests, and remediation status.

Out of scope:

- Electron, Tauri, browser embedding, tray, background service, privileged helper, or native desktop
  wrapper runtime,
- MSI, MSIX, PKG, DMG, MDM, Jamf, Intune, SCCM, Munki, or organization-managed rollout,
- machine-wide self-update outside the canonical macOS app, or mutation of IT-managed installs,
- rollback, downgrade, beta, canary, prerelease, private-channel, or silent background updates,
- Linux or Windows arm64 portable assets.

## Decision

### D1 — Portable delivery is governed-release-asset-first

Keiko will ship the portable-managed product as governed GitHub Release Assets.

Each stable release will expose exactly three platform-target archive assets:

- `windows-x64`
- `macos-arm64`
- `macos-x64`

Those archives remain the authoritative portable payloads and update inputs. The macOS archives
are the promoted macOS install surface. Windows stable releases additionally expose the signed
`keiko-windows-x64-setup.exe` companion as the promoted ordinary-user Windows install surface; the
Windows ZIP remains the manual and troubleshooting fallback. The setup companion embeds the exact
reviewed `windows-x64` archive and delegates installation and launch to the same portable lifecycle.
It does not create another platform target, payload authority, or update channel.

The three platform targets are release-blocking as a set, and the Windows setup companion is
release-blocking for `windows-x64`. A stable release is not portable-complete when a required
archive or companion is missing, unnotarized where required, or unverified.

**Where completeness is decided (amended 2026-08-09, issue #2802).** Release-blocking is answered
against the published release, not against a publish input. Before npm learns the `latest`
dist-tag, `scripts/release-publish.mjs` verifies that the GitHub Release actually carries all four
downloads and fails closed otherwise. The earlier formulation demanded a qualified asset *manifest*
as an input to the publish job, which is strictly weaker — a well-formed manifest proves nothing
about whether the upload landed — and it was unsatisfiable for the release the owner had scoped,
so it refused every stable release the project could build. Assets that ARE handed in still pass
the full qualified-run provenance and digest binding; assets already on the tag are verified by
presence and by the reviewed metadata bound to them.

**Signing status for the 0.3.x public evaluation program (amended 2026-08-09, issue #2802).** A
stable release may carry `evaluation` signing status: bundles that are sealed — `codesign --verify
--deep --strict` passes, so macOS does not report a damaged app — but carry no Apple Developer ID,
no notarization, and no Azure trusted publisher. This is the release owner's scope decision for
Keiko's first public download release and it is bounded three ways: the status is recorded in the
reviewed release-impact entry, the release notes state it together with the first-launch steps it
implies (right-click → Open on macOS, the SmartScreen notice on Windows), and D7 is untouched —
production signing credentials, their protected environments, and the signed-lane verification
remain exactly as specified. When the signing subscriptions are in place, the production lane
supersedes this status without a further amendment.

Each asset must be accompanied by reviewed metadata that binds the artifact name, platform target,
GitHub release id, release tag, asset id, asset name, size in bytes, Keiko version, bundled Node.js
runtime identity, archive SHA-256 digest, package/build provenance, SBOM/license evidence, and
signing/notarization status to the same reviewed release-impact entry. Tag or filename matching
alone is insufficient. Any mismatch fails closed before extraction. Artifact metadata is
operational evidence; it must not contain customer paths, credentials, prompts, model output,
repository content, or raw logs.

The Windows setup companion must be bound to the reviewed Windows archive name and digest, carry
its own Authenticode chain and RFC3161 timestamp verification, and be proven as the only additional
top-level PE after the Windows payload inventory is sealed.

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

First run expands the portable archive into a dedicated managed install folder. Windows remains
user-local under `%LOCALAPPDATA%\Programs\Keiko`. The two release-qualified macOS targets install
at exactly `/Applications/Keiko.app`, because Apple's Endpoint Security activation contract
requires the containing app to run from `/Applications`.

That folder is distinct from `.keiko`, which remains the runtime-state root for governed local state
such as update recovery, redacted evidence, and other Keiko-owned runtime data. Portable install
payloads must not be treated as generic runtime state or a shared cache.

The bootstrap archive location is not self-update eligible by itself. First-run setup must attest a
single managed install root before the normal app/update lifecycle starts. App registration, such
as a Windows Start Menu shortcut or the canonical macOS application bundle, is allowed only as a
consequence of explicit setup and must point back to the managed install. A writable
`/Applications` directory permits direct promotion for a local administrator. An administrator
dialog may be shown when macOS requires it, and MDM may install the app or preapprove the required
permissions. No terminal command or separate package-manager setup is part of the customer flow.

The managed install root must be a dedicated Keiko-owned realpath separate from `.keiko`, customer
repositories, temporary directories, shared/network roots, and system-managed locations, with one
closed exception: a release-qualified macOS target may use exactly `/Applications/Keiko.app`.
Other children of `/Applications` and all other system-managed locations remain denied. Every
write must be contained after realpath resolution, and launcher/runtime identity must attest the
same root before every portable update. Organization-managed installations remain immutable to
Keiko's self-updater unless the same managed-root authority is attested. V1 does not install an
always-on privileged helper, schedule a task, or register a background updater.

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

The manual re-download fallback is part of the same portable-managed authority rather than a second
update channel. If a user opens a newer portable release asset while an older attested managed
install exists, the launcher may validate the clicked package locally, stop the running Keiko UI,
promote the newer stable package into the managed root with the same previous-install snapshot and
atomic-swap semantics, and relaunch the managed app. The fallback must reject equal, older,
prerelease, beta, wrong-platform, malformed, or unattested packages; it must not expose rollback or
ask ordinary users to run shell cleanup.

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

### D7 — Production signing uses protected, provider-managed trust

Production portable signing is an extension of this ADR's installability authority, not a second
artifact or evidence contract. The operator boundary and implementation interface are defined in the
[Portable Production Signing Contract](../release/portable-production-signing-contract.md).

Windows production artifacts use an Azure Artifact Signing **Basic** account with a **PublicTrust**
certificate profile. The GitHub workload authenticates to Azure with environment-bound OIDC and has
only `Artifact Signing Certificate Profile Signer` at the certificate-profile resource scope. Azure
retains the non-exportable signing key and provides the RFC 3161 timestamp service. Repository,
environment, or runner secrets must not contain a Windows signing private key or an Azure client
secret. A `PublicTrust Test` profile is forbidden for production. The account and profile aliases
select the signing resource but are not recoverable signer identity. Every signed PE must verify both a
valid Public Trust/code-signing chain and the exact reviewed subscriber identity-validation EKU
`1.3.6.1.4.1.311.97.<subscriber suffix>`. The workflow must not pin a rotating leaf thumbprint, public
key, or certificate subject.

macOS production artifacts use a Developer ID Application identity with hardened runtime. Every
embedded Mach-O is signed leaf-to-root before the app; each target app is submitted with a team App
Store Connect API key through `notarytool`, accepted, stapled, and assessed locally before its final
archive is created. Apple certificate/key material exists only as protected environment secrets and is
decoded into owner-only, per-run temporary storage and a generated temporary keychain. Cleanup is
unconditional and a cleanup failure fails the job. The notarization key is a dedicated team key with
the least-privilege `Developer` role; broader roles and unrelated use are forbidden. Team keys apply
across all apps and cannot be restricted to Keiko alone, so this operational isolation is mandatory.

Production signing is permitted only on protected native runners for a reviewed stable tag in the
`portable-release-signing` GitHub environment. The same native job must sign, calculate or verify the
artifact digest, verify every Windows PE against the exact reviewed subscriber identity-validation EKU
and valid Public Trust/code-signing chain or verify macOS against the expected Developer ID identity and
Team ID, and produce the platform booleans consumed by the existing signing verifier. A later job, a
manually supplied Boolean, or the Ubuntu bundle assembler cannot assert that proof. Missing
configuration, unavailable tools, provider failure, revoked identity, incomplete signing, failed
notarization, failed stapling, failed assessment, or partial target completion fails closed and cannot
produce or promote `verified-production`.

The evidence remains the existing portable manifest and `evidence/signing-verification.json`
projection. Provider logs, certificate bodies, notarization logs, credentials, private paths, and raw
stdout/stderr are forbidden. The raw subscriber EKU is protected configuration and must not appear in
posted or committed evidence. Azure's short-lived leaf certificate rotation is not an identity change:
verification binds the Public Trust/code-signing chain and reviewed subscriber identity-validation EKU
rather than pinning a leaf thumbprint, public key, certificate subject, account, or profile alias. An
intentional subscriber identity EKU change requires a reviewed amendment to the signing contract and
renewed qualification.

Authenticode establishes publisher and artifact integrity but does not guarantee that Microsoft
SmartScreen will suppress warnings for every new file hash. SmartScreen reputation remains a
Microsoft-controlled signal and is not an installability acceptance criterion.

### D8 — Release archives and SBOMs carry independently verifiable GitHub Artifact Attestations

Each of the three portable release archives and its per-target SBOM additionally carries a GitHub
Artifact Attestation: a build-provenance attestation over the archive, an SBOM attestation binding
the archive to its `evidence/sbom.cdx.json` as that attestation's predicate, and a separate
build-provenance attestation over the SBOM document itself so the SBOM file has its own attestation
subject and is independently verifiable (`gh attestation verify <sbom-file>`) without requiring the
archive. All three are generated with GitHub's keyless, Sigstore-backed `actions/attest` action
using the same environment-scoped `id-token: write` OIDC mechanism already established for Windows
production signing in D7 — no new secret material or credential class is introduced.

Attestation generation runs once, in the `assemble` job of `.github/workflows/portable-assets.yml`,
strictly after `validatePortableReleaseSet` has proven the reviewed bundle contains exactly three
mutually consistent, qualification-bound targets. A missing, mismatched, or non-production target
fails that gate before any attestation step runs; there is no path that attests an incomplete or
unverified release set. The `ci` workflow's root, per-workspace, and UI CycloneDX SBOMs receive the
same treatment as build-provenance attestations of the SBOM documents themselves, scoped to `push`
events on integration branches, so pull-request and `workflow_dispatch` runs stay pre-signing and do
not accumulate attestations for commits that never ship. A `workflow_dispatch` run produces
`unverified-staging` by default and, when the run explicitly requests the ADR-0163 D9 evaluation
build, `evaluation-unqualified` instead. Neither is a production lane, neither is attested, and
neither can reach the `assemble` job — which runs only from a stable-tag push and still demands
three mutually consistent `verified-production` targets.

This is additive evidence, not a replacement for the existing portable manifest, the content-free
`evidence/signing-verification.json` projection, or the `provenance.intoto.jsonl` statement. Those
remain Keiko's own reviewed, internally validated evidence. A GitHub Artifact Attestation is an
independently, cryptographically verifiable claim anchored to the exact GitHub Actions workflow run
and commit that produced the artifact, checkable by any consumer with `gh attestation verify`
without trusting Keiko's own manifest-validation code. Attestations are supplementary trust evidence
for archive and SBOM consumers; they do not replace the existing signing/notarization acceptance
criteria. The final publisher additionally requires the Windows setup companion's build-provenance
attestation before release upload so locally replaced setup bytes cannot cross the publish boundary.

## Security and threat model

Security review for implementation under this ADR must cover:

- **Asset authenticity and completeness.** Missing, wrong-platform, malformed, unsigned,
  unnotarized, checksum-mismatched, or provenance-mismatched assets are not installable.
- **Archive extraction.** Portable archives are hostile input. Extraction must reject path
  traversal, absolute paths, symlink or hardlink escapes, device/special files, and unexpected
  executable placement before writing into the managed install.
- **Managed-root authority.** Only an attested target-specific managed install root is self-update
  eligible. Unmanaged bootstrap folders, local checkouts, linked packages, transient launchers,
  noncanonical machine-wide locations, and IT-managed installs are blocked from one-click portable
  mutation. `/Applications/Keiko.app` is the sole macOS system-location exception.
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
- **Signing workload identity.** Production signing is restricted by both the protected GitHub
  environment and exact stable-tag workflow guards. Azure federation is repository- and
  environment-bound, uses no client secret, and grants signer authority only at the selected
  certificate profile. Every PE must independently match the reviewed subscriber identity-validation
  EKU as well as the Public Trust/code-signing chain.
- **Ephemeral Apple material.** Imported Developer ID and notarization credentials are masked,
  owner-readable only, never passed on command lines, and removed in an always-run cleanup step
  together with the temporary keychain. Cleanup failure blocks promotion.
- **Setup companion launch surface.** The Windows companion's IExpress launch fields must name an
  absolute `System32\cmd.exe` interpreter. A `.cmd` payload is not an executable image, so naming
  the script alone never reaches the installer, and naming `cmd.exe` without a path would let the
  extraction directory or `PATH` choose the interpreter that runs before the payload is validated.
  The path is resolved on the build host and embedded literally, because inside a SED a `%name%`
  token is an IExpress `[Strings]` reference rather than an environment variable. Accepted residual:
  WExtract's documented `/C:<command>` switch can still substitute the install command at invocation
  time. It is unreachable for a user running the companion normally and grants an actor who can
  already execute locally no new authority over Keiko state, but it does let a Keiko-signed binary
  front arbitrary local code. Replacing the construction surface is tracked in issue #2992 and is
  not settled by this ADR.
- **Evidence provenance.** Native verification booleans are trusted only when produced in the same
  protected native job as signing and bound to the artifact digest and approved durable platform
  identity: the Windows subscriber EKU and Public Trust/code-signing chain, or the macOS Developer ID
  identity and Team ID. Cross-job declarations and assembly-time reconstruction are not signing proof.

## Consequences

### Positive

- Portable release assets have one installability authority.
- Compatibility and remediation stay in the reviewed release-impact catalog instead of drifting into
  release prose.
- The managed install folder stays separate from `.keiko`, which keeps runtime state and install
  payloads from being mixed.
- The portable update path can reuse the existing governed updater and evidence semantics instead of
  creating a second mutation authority.
- Windows private-key custody stays with Azure, Apple key material stays ephemeral on protected native
  runners, and both platforms reuse the existing content-free signing evidence projection.

### Negative

- V1 excludes rollback and organization-managed self-update flows.
- The portable path needs thin per-platform launchers and archive packaging support.
- Portable installs that cannot attest a single managed target must fall back to manual
  instructions.
- Stable portable delivery depends on protected GitHub environments and available Azure and Apple
  signing/notarization services; an outage blocks production promotion while secret-free staging
  remains available.

## Alternatives considered

1. Electron, Tauri, or another desktop wrapper first. Rejected because it adds a new runtime owner
   and shifts the wave away from archive-first portable delivery.
2. MSI, MSIX, PKG, or DMG as the primary portable format. Rejected because this issue asks for
   archive-first delivery and a managed install folder.
3. A separate portable compatibility catalog. Rejected because the release-impact catalog already
   owns compatibility and remediation, and a second catalog would drift.
4. GitHub Release notes as the installability authority. Rejected because prose is not a source of
   installability truth.
5. Exportable OV/EV keys or a self-hosted Windows signing token in GitHub. Rejected because Azure
   Artifact Signing provides managed key custody and OIDC-scoped workload authorization.
6. Azure `PublicTrust Test` for production. Rejected because test profiles do not establish the
   production publisher trust required by this ADR.
7. An individual App Store Connect API key for notarization. Rejected because the production
   `notarytool` path requires a team key and a shared, revocable release identity.

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
- [Portable Production Signing Contract](../release/portable-production-signing-contract.md)
- [Local runtime state contract](../local-runtime-state-contract.md)
- Issue #1946

## Amendment history

- **2026-07-10 — Issue #2199:** Added D7 and its security, alternatives, and operating-contract
  consequences to settle the production Windows and macOS signing trust boundary for Epic #2198.
- **2026-07-11 — Issue #2308:** Added D8 to record GitHub Artifact Attestations (build provenance
  and SBOM) for the three portable release archives and the `ci` workflow's SBOMs.
- **2026-07-27 — ADR-0163:** Accepted `/Applications/Keiko.app` as the sole system-managed root
  exception for release-qualified macOS bundles. Administrator, System Extension, and Full Disk
  Access approval dialogs are part of the one-time first start; MDM may preinstall or preapprove
  them. Windows and every other system-managed path remain unchanged and fail closed.
- **2026-08-09 — Issue #2802:** Amended D1 twice for Keiko's first public download release.
  Portable completeness is now verified against the published GitHub Release before npm learns the
  `latest` dist-tag, replacing the weaker demand for a qualified manifest as a publish input; and a
  stable release may carry `evaluation` signing status (sealed, no Developer ID, no notarization,
  no Azure trusted publisher) when the reviewed release-impact entry records it and the release
  notes state it. D7 and the production signing lane are unchanged.
- **2026-08-07 — ADR-0163 D9:** Amended D8's `workflow_dispatch` sentence. A dispatch run is no
  longer necessarily `unverified-staging`: an explicitly requested evaluation build produces
  `evaluation-unqualified`. Neither is attested and neither can reach `assemble`. D7 is unchanged
  and remains the sentence that keeps production signing unrelaxed.
