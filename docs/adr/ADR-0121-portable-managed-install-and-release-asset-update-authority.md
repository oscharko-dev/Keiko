# ADR-0121: Portable managed install and release-asset update authority

## Status

Accepted (Issue #1946, 2026-07-05); amended for the Windows setup companion (Issue #2966,
2026-08-04); construction surface replaced by a Keiko-owned native bootstrap (Issue #2992,
2026-08-29); platform-neutral release trust adopted for unsigned native delivery (Epic #3403,
2026-09-10); amended with the production-qualified Linux x64 archive (Issue #3451, 2026-09-10).

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
- Linux arm64 or Windows arm64 portable assets.

## Decision

### D1 — Portable delivery is governed-release-asset-first

Keiko will ship the portable-managed product as governed GitHub Release Assets.

Each production stable release will expose exactly four platform-target archive assets:

- `linux-x64`
- `windows-x64`
- `macos-arm64`
- `macos-x64`

Those archives remain the authoritative portable payloads and update inputs. The macOS archives
are the promoted macOS install surface. Windows stable releases additionally expose the
`keiko-windows-x64-setup.exe` companion as the promoted ordinary-user Windows install surface —
the Keiko release manifest binds and signs its exact digest even when the executable has no
Authenticode signature; the
Windows ZIP remains the manual and troubleshooting fallback. The setup companion embeds the exact
reviewed `windows-x64` archive and delegates installation and launch to the same portable lifecycle.
It does not create another platform target, payload authority, or update channel.

The four platform targets are release-blocking as a set, and the Windows setup companion is
release-blocking for `windows-x64`. A stable release is not portable-complete when a required
archive or companion is missing, digest-mismatched, provenance-invalid, or lacks valid Keiko
release trust.

**Where completeness is decided (amended 2026-08-09, issue #2802).** Release-blocking is answered
against the published release, not against a publish input. Before npm learns the `latest`
dist-tag, `scripts/release-publish.mjs` verifies that the production GitHub Release actually carries
all five
downloads and fails closed otherwise. The earlier formulation demanded a qualified asset *manifest*
as an input to the publish job, which is strictly weaker — a well-formed manifest proves nothing
about whether the upload landed — and it was unsatisfiable for the release the owner had scoped,
so it refused every stable release the project could build. Assets that ARE handed in still pass
the full qualified-run provenance and digest binding; assets already on the tag are verified by
presence and by the reviewed metadata bound to them.

**Platform-neutral release trust (amended 2026-09-10, Epic #3403).** Stable archives and the setup
companion do not require Apple Developer ID, Apple notarization, Microsoft Artifact Signing, or any
other platform-vendor subscription. The native evidence remains honest: unsigned artifacts declare
`evaluation` / `evaluation-unqualified` and every platform-signature Boolean remains false. Stable
installability instead requires the Keiko Ed25519 release signature defined by D7. The signed
manifest binds the final GitHub release and asset identifiers, target, version, source commit,
archive digest, size, provenance, SBOM, release-impact record, and native verification state. The
release UI may explain the ordinary first-launch operating-system warning, but that warning is not
an update blocker. A platform signature, when available, is optional defense in depth and never the
only trust anchor.

Each asset must be accompanied by reviewed metadata that binds the artifact name, platform target,
GitHub release id, release tag, asset id, asset name, size in bytes, Keiko version, bundled Node.js
runtime identity, archive SHA-256 digest, package/build provenance, SBOM/license evidence, and
native verification status and Keiko release trust to the same reviewed release-impact entry. Tag or filename matching
alone is insufficient. Any mismatch fails closed before extraction. Artifact metadata is
operational evidence; it must not contain customer paths, credentials, prompts, model output,
repository content, or raw logs.

The Windows setup companion must be bound to the reviewed Windows archive name and digest and be
proven as the only additional top-level PE after the Windows payload inventory is sealed. Its
SHA-256 digest and byte size are bound into the release-signed Windows manifest and verified before
promotion. Optional Authenticode evidence is recorded when present but is not required.

### D2 — Launchers stay thin

The platform entry points are thin native launchers:

- `Keiko.exe`
- `Keiko.app`

They may locate, start, and relaunch the managed install, but they do not introduce Electron,
Tauri, or a native wrapper runtime in this wave. Wrapper ownership remains deferred until a later
decision creates a real need for it.

Native launcher integrity is part of portable installability and is established by the signed
manifest's digest and provenance bindings. Native platform signatures, notarization, and publisher
chains are verified and recorded when present, but their absence does not make a release or
self-update manual-only.

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

The portable update path is explicit and user-confirmed. It consumes ADR-0099's exact candidate
claim, stages and verifies those immutable bytes, transfers ownership, swaps the managed install,
and relaunches. Update state, recovery snapshots, remediation status, and canonical activity evidence
remain bounded local runtime state.

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

The reviewed platform primitives are named here so "equally reviewed" is a checkable claim rather
than a judgement call at implementation time. On Darwin the promotion uses `renameatx_np` with
`RENAME_SWAP` (exchange) or `RENAME_EXCL` (occupied-destination refusal), combined with
`RENAME_NOFOLLOW_ANY`. On Linux the same two operations are `renameat2` with `RENAME_EXCHANGE` and
`RENAME_NOREPLACE`: both are single syscalls with the same fail-closed posture, and neither falls
back to copy+delete. `RENAME_NOFOLLOW_ANY` has no Linux spelling; it refuses the rename when any
path component is a symlink, and every call site passes a directory descriptor plus a single leaf
name, so no intermediate component remains to follow and both operations act on the directory
entries rather than dereferencing a leaf. The guarantee is therefore preserved structurally rather
than dropped. Until this was recorded, the POSIX path used the Darwin spelling unconditionally and
`linux-x64` never compiled, so it was never staged, qualified or attested (#3456).

On Windows, `MoveFileEx` fails with `EPERM`/`EBUSY` while any handle is open on a file in the
tree with incompatible sharing flags (for example, a transient scanner or an executable image).
The existing atomic-publish helper may retry transient contention with bounded backoff; it must not
fall back to copy+delete. Changing the working directory does not unmap the running `node.exe`, and
retrying cannot settle a lock held by the process performing its own replacement. The old process
must exit after a durable, acknowledged ownership transfer, before promotion begins.

#### Native handoff and qualification requirements (#3405)

The reviewed #3404 contract uses the current verified launcher and supervisor copied into a bounded,
activation-specific handoff capsule outside the active, staged, and previous install trees. The
capsule is private local control data: authenticated fixed paths and mechanical plan/receipt bytes
are permitted there, but are never copied into API projections, activity logs, support evidence, or
release artifacts. It is not a package backup or another update state store.

The server persists semantic intent before spawning the coordinator. Native code accepts only the
closed activation-id mode, validates the fixed plan and its authority, and acknowledges the exact
plan digest over the inherited channel. A spawn event alone is not acceptance. Preparation remains
cancelable; after the reviewed cutoff, uncertain failure requires recovery ownership rather than a
new independent update. A missing coordinator capability must fail closed, never select the old
in-process replacement path.

The native coordinator executes finite mechanical steps and records hash-chained intent/completion
receipts. It must prove old-process exit and port release before promotion, contain the new process
tree using the existing platform supervisor, and never kill an unrelated PID. The server remains
the sole semantic transition owner. Startup reconciles durable intent and receipts before normal
routes become ready; exact process, launch identity, loopback port, target version, and verified tree
must agree before success. A failed replacement may restore the previous verified tree only after
proving the owned new process tree has stopped. Once N is verified, restart and cleanup must retain N.

A recovery launch of N−1 is a new process instance with its own server-generated, plan-bound launch
identity. It must attest the original tree and registration, then prove its own PID, version and
loopback binding before readiness opens. Successful restoration settles a **failed update with
recovery settled**, not a successful update, cancellation, or automatic retry. The server commits
that result through revision-checked state; uncertain termination, incomplete restore evidence, or
a persistence failure keeps recovery ownership. A crash between semantic verification and its
native acknowledgement must never authorize restoration of an already verified N.

These are implementation and acceptance requirements, not evidence that native qualification has
completed. Each supported target needs a real same-port N−1→N run through the assembled application,
failure/crash-boundary tests, and a second restart retaining N. Hermetic PR proof is distinct from
the release canary between two actual Keiko-signed eligible releases. That canary requires immutable
release/asset identities and the D7 signature on both versions; it does not require Apple or
Microsoft signing. Until those native journeys and the canary are satisfied, code may merge with
explicit limits but no production one-click claim is permitted. Evaluation releases, including
0.3.17, remain manual-only; changing release metadata or a test verifier cannot make their installed
bytes trusted retroactively.

#### Windows generation consumer and cutover contract (#3405)

This contract freezes the remaining consumer implementation against the production generation
producer in `50160cd10`. It does not enable native acceptance or settle platform qualification.
Mac retains KHP version 2 with 32 fields. Windows requires KHP version 3 with 37 fields; both use
the existing `KHP1` magic, little-endian version/count header and length-prefixed UTF-8 fields.
Fields 0–31 retain their byte order and meaning. Windows appends exactly:

| Index | Field | Required value |
| --- | --- | --- |
| 32 | `cutoverKind` | `windows-generation-v1` |
| 33 | `currentGenerationTreeSha256` | 64 lowercase hexadecimal characters |
| 34 | `candidateGenerationTreeSha256` | 64 lowercase hexadecimal characters |
| 35 | `currentSetupManifestSha256` | 64 lowercase hexadecimal characters |
| 36 | `candidateSetupManifestSha256` | 64 lowercase hexadecimal characters |

Reject cross-target version/count combinations, unknown fields and trailing bytes. Use a
discriminated plan union. The TypeScript encoder and native parser consume the same checked-in
Mac and Windows hexadecimal fixtures; the Mac fixture remains byte-identical. Fields 20/21 remain
whole-root KHT1 input evidence, never terminal Windows root hashes. Field 17 remains a reserved
sibling backup path, required absent at acceptance.

Consumers distinguish install root, selected resource root, application/package paths, runtime
Node, root launcher/setup and generation supervisor. Windows setup/registration schema 2 uses
only the strict six-field `windowsGeneration` binding from the artifact contract. The setup bytes,
launcher digest, package version, target, stable managed eligibility, root identity and registration
must agree with disk. Flat Windows schema 1 stays readable for launch/manual setup and cannot
become one-click eligible through automatic migration. Mac schema 1 is unchanged.
Keep the server parser/resolver internal and CLI authority parsing within its existing boundary.
Shared frozen fixtures prevent boundary-local parser drift. KHT1 has one reviewed TypeScript
authority in the internal security package, exposed only through a narrow workspace subpath to
existing CLI/server dependants. Synchronous CLI attestation and asynchronous server hashing share
the same bounded traversal/hash state machine; preserve cancellation, deadlines and server yielding.
The server's existing handoff-tree module remains a compatibility facade for its current callers
and producer scripts. Introduce no product-facing API, new package-root entry point, trust switch,
verifier injection or user command. The existing private CLI/server normal-startup result may
carry a root-bound, lock-scoped, read-only generation inspection allowance as described below;
it grants neither trust nor deletion authority.

Before prepared WAL or native acceptance, the capsule durably snapshots and revalidates the
current launcher as `coordinator.exe`, current supervisor, `launcher.next`, previous/next setup
manifests and previous/next registrations. Copies use no-follow reads, flush and digest rechecks.
Restoration copies coordinator bytes into a root-local temporary file before atomic replacement;
it never renames an executing coordinator. Candidate generation and plan-owned incoming paths
must be absent at acceptance.

After proven old-process exit and port release, the single coordinator performs this order:

1. Flush promote intent; copy the candidate into `.portable/generations/.incoming-<activationId>`,
   flush and verify KHT1,
   then atomically publish `.portable/generations/<candidateHash>` and rehash.
2. Atomically replace and flush root launcher, then root setup; verify their plan-bound bytes and
   setup binding before recording promote completion.
3. Record register intent, atomically publish and attest next registration, then register completion.
4. Start N through the copied qualified supervisor; complete existing process/tree verification and
   semantic runtime-state acknowledgment.
5. Record cleanup intent; remove only the exact previous generation and plan-owned staging/incoming
   paths, then record cleanup and complete receipts.

Recovery recognizes only monotonic forward prefixes: old authorities; candidate generation added;
candidate launcher selected; candidate setup selected; candidate registration selected. Before
start completion, restore previous registration, setup and launcher in reverse order, attest N−1,
then remove N. After start completion, retain N only when its owned process and all selected
authorities attest; otherwise stop only the proven owned process tree before restoration. After
semantic verification, never restore N−1: finish cleanup idempotently. Non-prefix mixtures require
recovery without speculative repair. Direct active attestation covers generation KHT1, launcher,
setup, registration, selected package/helper identities and existing process/launch/port/version
proof; it introduces no synthetic whole-root projection.

Normal-startup recovery holds the existing mutation lock before ordinary setup/registration
validation. Without a valid nonterminal WAL, maintenance admits exactly the selected generation.
With a validated Windows plan and receipt chain, it admits only the exact current/candidate and
plan-owned incoming paths permitted by the phase; after cleanup completion, only candidate remains.
Third generations, unrelated incoming paths and unbound content remain issues. Generic maintenance
does not delete retained generations; the common recovery owner alone has plan-scoped deletion
authority. The generation-independent support shim retains canonical producer bytes in both inputs;
a future shim change needs a subsequent contract revision.

The existing normal-startup reconciliation result transports any inspection allowance after the
server validates its WAL, session, plan and receipt prefix. The nested allowance identifies
`windows-generation-v1`, the managed root, activation id and exact managed-root-relative resource
roots. The CLI consumes it only through an active inspection capability inside the existing
managed-mutation callback; reuse after callback exit, cross-root reuse and malformed resource paths
fail closed. Rebase the existing payload rules under each permitted resource root; admitting a root
does not admit arbitrary contents. Generic inspection remains selected-generation-only. Repair,
uninstall and removal APIs receive no allowance and refuse extra retained generations. No CLI
receipt parser or additional server package-root entry point is introduced.

One coordinator owns receipt policy, phase classification, deadlines, forward/restore/cleanup and
semantic acknowledgment. Compile-selected platform adapters supply secure filesystem operations,
KHT1 walking, process/port checks and existing supervisor transport. Windows reuses the existing
runtime supervisor and its KRP1/KRC1/KRS1 protocol. The unreleased newline-framed update-recovery
control uses `KUR1` to distinguish it from that unchanged binary supervisor control protocol.
Its `runtimeStateSha256` binds the single bounded raw-byte read of canonical
`<stateDir>/updates/runtime-state.json`. Native validation hashes those exact bytes without JSON
reserialization. Windows reuses the same KUR1 parser and validation contract, with no platform
variant.

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

### D7 — Stable delivery uses protected, platform-neutral Keiko release trust

The mandatory update trust anchor is an Ed25519 signature over a deterministic canonical projection
of the final per-target manifest. The application ships an explicit set of trusted Ed25519 public
keys. The corresponding private key exists only as `KEIKO_PORTABLE_RELEASE_SIGNING_KEY` in the
protected `npm-publish` GitHub environment; build jobs, native runners, repository contents, release
assets, logs, and evidence never receive it.

The protected publisher signs only after GitHub assigns the immutable release id and asset id. The
signed projection includes the manifest schema, metadata version, signing and expiry timestamps,
key id, product version, source commit, release id and tag, target, asset id/name/size/SHA-256,
provenance, evidence paths, release-impact binding, native verification state, and update-eligibility
predicates. Any mutation, target substitution, partial release, unknown key, malformed encoding,
expired metadata, signature failure, or metadata version below an enforced high-water mark fails
closed before download or staging. A target version must also be strictly newer than the installed
version, so a valid older release cannot downgrade an installation.

Key ids are SHA-256 digests of the public SPKI bytes. Rotation is additive: ship a release that
trusts old and new public keys before signing exclusively with the new private key. Removing a key
requires a later reviewed release after the overlap. Compromise response removes the private secret,
publishes a security advisory, and ships a trusted-root update; signatures by unknown or removed keys
remain rejected. Metadata has a bounded lifetime so a captured signed response cannot remain current
indefinitely.

Apple Developer ID, notarization, Authenticode, and RFC 3161 evidence remain supported as optional
defense in depth. When present they must pass their existing strict verifiers and be reported
truthfully; no code path may synthesize positive native evidence. Their absence, provider outage, or
lack of subscriptions does not block publishing or updating. Microsoft SmartScreen and macOS
Gatekeeper warnings are operating-system reputation/user-consent signals, not Keiko artifact
authenticity criteria.

### D8 — Release archives and SBOMs carry independently verifiable GitHub Artifact Attestations

Each of the four portable release archives and its per-target SBOM additionally carries a GitHub
Artifact Attestation: a build-provenance attestation over the archive, an SBOM attestation binding
the archive to its `evidence/sbom.cdx.json` as that attestation's predicate, and a separate
build-provenance attestation over the SBOM document itself so the SBOM file has its own attestation
subject and is independently verifiable (`gh attestation verify <sbom-file>`) without requiring the
archive. All four are generated with GitHub's keyless, Sigstore-backed `actions/attest` action
using an assembly-job-scoped `id-token: write` permission. No release-signing key is exposed to that
job. Linux runtime qualification uses a separate, environment-scoped OIDC grant; Windows and macOS
do not require a native signing credential.

Attestation generation runs once, in the `assemble` job of `.github/workflows/portable-assets.yml`,
strictly after `validatePortableReleaseSet` has proven the reviewed bundle contains exactly four
mutually consistent, release-trust-required targets and the fresh Linux qualification job has
succeeded. A missing, mismatched, or integrity-invalid target fails that gate before any attestation
step runs; there is no path that attests an incomplete release set. The `ci` workflow's root,
per-workspace, and UI CycloneDX SBOMs receive the
same treatment as build-provenance attestations of the SBOM documents themselves, scoped to `push`
events on integration branches, so pull-request and `workflow_dispatch` runs stay pre-signing and do
not accumulate attestations for commits that never ship. A `workflow_dispatch` run produces
`unverified-staging` by default and, when the run explicitly requests the ADR-0163 D9 evaluation
build, `evaluation-unqualified` instead. Neither dispatch mode is attested or can reach `assemble`.
Stable-tag builds also report unsigned native status honestly, but additionally declare
`releaseTrustRequired`; Linux additionally requires its OIDC-attested runtime qualification. Only
that stable path can be assembled and passed to the protected publisher.

This is additive evidence, not a replacement for the existing portable manifest, the content-free
`evidence/signing-verification.json` projection, or the `provenance.intoto.jsonl` statement. Those
remain Keiko's own reviewed, internally validated evidence. A GitHub Artifact Attestation is an
independently, cryptographically verifiable claim anchored to the exact GitHub Actions workflow run
and commit that produced the artifact, checkable by any consumer with `gh attestation verify`
without trusting Keiko's own manifest-validation code. Attestations are supplementary trust evidence
for archive and SBOM consumers; they supplement rather than replace the Keiko manifest signature.
The final publisher additionally requires the Windows setup companion's build-provenance attestation
before release upload so locally replaced setup bytes cannot cross the publish boundary.

## Security and threat model

Security review for implementation under this ADR must cover:

- **Asset authenticity and completeness.** Missing, wrong-platform, malformed, unsigned-manifest,
  expired-metadata, checksum-mismatched, or provenance-mismatched assets are not installable.
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
- **Setup companion launch surface (amended 2026-08-29, issue #2992 — settled).** The companion is
  a Keiko-authored native console bootstrap (`native/setup-bootstrap/keiko-setup-bootstrap.c`,
  compiled by MSVC on the same protected native lane as the portable launcher), with the reviewed
  `windows-x64` archive appended as a hash-bound overlay. It replaces the previous IExpress/WExtract
  self-extractor, whose documented `/C:<command>` switch let a caller substitute the embedded
  install command before any payload code ran — a signature-laundering / LOLBin primitive against
  the Keiko publisher identity that no SED field, switch, or payload-side guard could disable,
  because WExtract handled `/C:` before the embedded command executed. The native bootstrap holds
  three invariants that close that class:
  1. **No command surface.** Its argument grammar is a closed allowlist: `argc == 1`, or every
     argument is case-insensitively `/quiet`/`/Q`. Every other argument — the `/C:` form included —
     is rejected with exit code 87 before any staging directory, extraction, or child process. This
     is an allowlist, never a denylist of known-bad switches, so an unforeseen future switch cannot
     regress it.
  2. **A fixed, verified execution set.** The only programs the bootstrap will run are
     `System32\tar.exe` (resolved from `GetSystemDirectoryW`, never from `PATH`/CWD) and the bundled
     `node.exe` from the extracted payload — and only after the payload's SHA-256 matches the digest
     baked into the bootstrap at build time. It calls the same governed portable CLI steps
     (`portable resolve-root` / `setup` / `launch`) the previous batch called, so the portable
     lifecycle authority (D1, D5) is unchanged.
  3. **Tamper-evident payload.** The expected payload digest and size are baked into the bootstrap
     as compile-time constants and re-verified at run time by streaming the overlay through BCrypt
     SHA-256. The release pipeline appends the overlay and signs the resulting file afterwards
     (`portable-assets.yml`: "Build the Windows setup companion" precedes "Sign the Windows setup
     companion"), so the payload is **inside** what the signature covers: an Authenticode digest
     spans the whole file except the optional header's checksum, the certificate-table data-directory
     entry, and the attribute certificate table appended at the end. The baked digest is therefore
     not a substitute for the signature — it is the binding that still holds when nothing verified
     the signature. Windows does not refuse to execute an unsigned or invalidly-signed binary, so a
     swapped payload is caught by the bootstrap itself rather than by the OS, and the same binding
     protects an `evaluation` (unsigned) companion, which carries the identical closed grammar and
     hash gate. A production-signed companion additionally cannot be leveraged to front arbitrary
     code under the Keiko Authenticode identity. The Windows setup contract suite pins the
     argument-rejection and integrity behavior, and the Windows smoke exercises the real
     install-command path (including the adversarial `/C:` matrix), not extraction alone.

     **Residual — verified bytes vs executed bytes.** The digest gate covers the compressed payload
     as it streams out of the running image, and the staged ZIP is re-verified and then held open
     write- and delete-denied for the whole extraction, so what `tar.exe` consumes is what was
     verified. After extraction the bootstrap checks only that `Keiko.exe`, `node.exe` and the CLI
     entry **exist** before handing them to `CreateProcessW`; their contents are not re-hashed
     against per-file digests. A process already running as the same user could therefore modify an
     unpacked file between extraction and launch. The staging directory name carries 128 CSPRNG bits
     and is created by the bootstrap, so it cannot be pre-created or predicted, and no privilege
     boundary is crossed — this is not the `/C:` signature-laundering class, which was reachable by
     anyone holding the signed binary. Closing it fully requires per-file digests carried inside the
     verified archive and checked immediately before each launch; that is recorded here as accepted
     residual risk rather than claimed as settled.
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
- One platform-neutral public-key trust policy protects every target and remains independent of
  vendor signing subscriptions. Optional native evidence reuses the existing content-free projection.

### Negative

- V1 excludes rollback and organization-managed self-update flows.
- The portable path needs thin per-platform launchers and archive packaging support.
- Portable installs that cannot attest a single managed target must fall back to manual
  instructions.
- Stable portable delivery depends on the protected GitHub publisher environment and the Keiko
  Ed25519 key. Apple or Microsoft signing-service outages have no effect on release availability.

## Alternatives considered

1. Electron, Tauri, or another desktop wrapper first. Rejected because it adds a new runtime owner
   and shifts the wave away from archive-first portable delivery.
2. MSI, MSIX, PKG, or DMG as the primary portable format. Rejected because this issue asks for
   archive-first delivery and a managed install folder.
3. A separate portable compatibility catalog. Rejected because the release-impact catalog already
   owns compatibility and remediation, and a second catalog would drift.
4. GitHub Release notes as the installability authority. Rejected because prose is not a source of
   installability truth.
5. Require native vendor signing for update authenticity. Rejected because it creates two external
   availability dependencies, cannot protect non-native manifest metadata uniformly, and is not
   available for the release. Native signing remains optional defense in depth.
6. Trust only GitHub Artifact Attestations at update runtime. Rejected because offline verification
   requires additional trust-root material and tooling; attestations remain valuable independent
   supply-chain evidence while bundled Ed25519 verification keeps runtime admission deterministic.
7. Distribute a signer or package-manager dependency to users. Rejected because the update must work
   from the bundled product with no npm, CLI, or manually downloaded verification package.

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
- [Optional Native Platform Signing Contract](../release/portable-production-signing-contract.md)
- [Local runtime state contract](../local-runtime-state-contract.md)
- Issue #1946

## Version

| Version | Date       | Change |
| ------- | ---------- | ------ |
| 1.0     | 2026-07-05 | Accepted the portable managed-install and release-asset authority. |
| 1.1     | 2026-09-10 | Added `linux-x64` as the fourth release-blocking archive for Issue #3451 so the production packaging model matches the qualified runtime target set. |

## Amendment history

- **2026-09-10 — Epic #3403:** Replaced mandatory Apple/Microsoft production signing with the
  protected, platform-neutral Ed25519 release-trust contract in D1, D2, D7, and D8. Native signing
  remains strictly verified when present but is no longer an installability, publication, or update
  prerequisite. Stable Windows, macOS, and Linux-hosted updater operation requires no user-installed
  npm, verification CLI, or manually downloaded package.
- **2026-09-05 — Issue #3405:** Clarified exact-candidate execution, acknowledged native handoff,
  canonical evidence versus private control data, and the distinction between implementation proof
  and production-signed qualification. Removed the claim that retries resolve the updater's own
  loaded executable lock; evaluation-to-production continuity remains a manual transition.
- **2026-07-10 — Issue #2199:** Added D7 and its security, alternatives, and operating-contract
  consequences to settle the production Windows and macOS signing trust boundary for Epic #2198.
- **2026-07-11 — Issue #2308:** Added D8 to record GitHub Artifact Attestations (build provenance
  and SBOM) for the then-current three portable release archives and the `ci` workflow's SBOMs.
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
- **2026-08-29 — Issue #2992:** Replaced the setup companion's construction surface. The previous
  IExpress/WExtract self-extractor exposed a `/C:<command>` install-command override that could
  front arbitrary local code under the Keiko signature; it is retired for a Keiko-authored native
  console bootstrap that appends the reviewed archive as a hash-bound overlay, rejects every
  argument outside a `/quiet`/`/Q` allowlist, and runs only `System32\tar.exe` and the
  digest-verified bundled `node.exe`. The accepted residual recorded in the security-and-threat-model
  "Setup companion launch surface" bullet is now settled rather than tracked. D1 and D5 are
  unchanged: the companion still embeds the exact reviewed `windows-x64` archive and delegates
  installation and launch to the same portable lifecycle; only its construction and launch surface
  changed.
- **2026-09-10 — Issue #3451:** Added `linux-x64` as the fourth release-blocking production archive
  and fifth production download after the Windows setup companion. Linux promotion requires the
  protected-workflow OIDC receipt, offline Sigstore verification, exact component/source binding,
  and real namespace-gateway qualification. Historical reviewed three-target releases remain
  readable by the updater but do not satisfy a new production release set.
