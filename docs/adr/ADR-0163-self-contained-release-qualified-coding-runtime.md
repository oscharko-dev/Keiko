# ADR-0163 — Self-contained release-qualified Coding Workbench runtime

- Status: Accepted (2026-07-27)
- Amends:
  - [ADR-0121](ADR-0121-portable-managed-install-and-release-asset-update-authority.md) D3 by
    accepting the canonical `/Applications/Keiko.app` root and one-time macOS approval flow.
  - [ADR-0137](ADR-0137-server-owned-coding-runtime-contracts.md) D5 by defining the packaged
    qualification and activation chain for all three supported targets.
  - [ADR-0140](ADR-0140-macos-dev-lane-activation-of-the-managed-coding-runtime.md) by completing
    the Wave-5 packaged path without changing the deliberately weaker development lane.

## Context

The portable release contract already produces one ZIP for Windows x64, macOS arm64, and macOS
x64, and each ZIP contains Node.js plus the review-approved OpenCode runtime. The launcher also
copies a downloaded archive into a managed install automatically. Those facts did not
make Coding Workbench release-ready:

- the qualified Windows Job Object supervisor existed in source and CI but was not staged in the
  customer artifact;
- packaged discovery accepted Windows only and looked for an update manifest that a freshly
  extracted first-install ZIP does not contain;
- a freely writable JSON qualification receipt was treated as activation evidence even though it
  had no platform trust anchor;
- packaged activation had no production composition for the secure workspace-read verifier; and
- macOS had no qualified descendant-observation backend, no Endpoint Security System Extension,
  and no first-run activation state for the user approval macOS requires.

Embedding the final archive digest into a receipt inside that same archive is impossible: changing
the receipt changes the archive digest. A first-install activation contract therefore cannot use
the outer ZIP digest as its trust anchor. It must be bound to platform-signed code and to the exact
runtime components that code admits.

The customer contract for this release is explicit:

- the customer downloads one target-specific ZIP, extracts it, and starts Keiko;
- Node.js, OpenCode, supervision, secure-read, and activation evidence are bundled;
- installation and first-run activation require no terminal, package manager, network download, or
  separate runtime setup;
- model endpoints and credentials are still configured once in Keiko's GUI;
- **Ask for approval** is the default deployment ceiling, and no installation event widens it;
- OpenCode is the only packaged Coding Workbench runtime and reaches models only through Keiko's
  Model Gateway; and
- macOS may require the local user to approve Keiko's Endpoint Security System Extension once.

Apple Developer ID signing, notarization, a granted Endpoint Security entitlement, and the
corresponding provisioning material are external release prerequisites for both portable macOS
targets. The paid Apple Developer Program alone does not remove the system-extension approval.
Organization-managed Macs may preapprove it through MDM. Missing credentials, entitlement, user
approval, or an active extension keep Coding Workbench unavailable; they never select the macOS
development lane or a process-group fallback.

The customer contract accepts Apple's required first-run boundary. Keiko installs the signed app at
exactly `/Applications/Keiko.app`; macOS may request administrator authorization, System Extension
approval, and Full Disk Access once. Those dialogs are part of the first start, and MDM may
preinstall or preapprove them. Signing and notarization establish publisher and artifact trust but
do not suppress the System Extension or Full Disk Access consent decisions.

## Decision

### D1 — The release unit is one self-contained, exact-target ZIP

The release matrix remains exactly `windows-x64`, `macos-arm64`, and `macos-x64`. Every production
ZIP contains:

- the primary launcher and packaged application;
- the exact supported Node.js runtime;
- the exact review-approved OpenCode payload and its redistribution evidence;
- the secure workspace-read helper;
- the target's complete runtime supervision backend;
- a platform-anchored activation attestation; and
- on macOS, the Endpoint Security System Extension and its activation manager.

Staging, signing, qualification, assembly, publishing, and fresh-runner smoke checks fail closed if
any required component is absent, duplicated, unsigned, unnotarized where applicable,
architecture-mismatched, stale, or not bound to the source commit and target. Manual staging may
remain unsigned and unqualified, but it can never produce a production-available runtime.

The automatic managed-install copy remains the default first launch. Windows uses its user-local
managed root. Both macOS targets use exactly `/Applications/Keiko.app`; another macOS root is not
release-qualified and cannot activate the Endpoint Security runtime. A downloaded artifact never
asks the customer to select a runtime or install location.

### D2 — Activation evidence is platform-anchored and component-bound

The outer release manifest remains the publication and update contract. Packaged first-run
activation uses a smaller, closed runtime attestation whose identity contains only:

- schema and qualification-suite versions;
- target and source commit;
- supervisor backend and protocol identity;
- exact shipped supervisor, secure-read, and OpenCode payload digests;
- the qualification result; and
- content-free platform evidence flags.

The attestation does not contain the enclosing ZIP digest and does not trust setup or update
metadata as execution authority.

On Windows, a dedicated Authenticode-signed attestation executable emits the closed document. Its
signature is verified independently at point of use, and its component digests must match files
opened from the attested managed root. The attestation is generated only after the exact shipped
supervisor passes the complete Job Object qualification on a fresh Windows runner; signing and
qualification order is part of the release gate.

On macOS, the closed attestation is a sealed app resource. It is written after the exact target
supervisor and system extension pass qualification and before the outer `Keiko.app` Developer ID
signature. Point-of-use verification requires the outer code-resource seal, nested code
signatures, notarization/stapling assessment, exact team identity, required entitlements, and exact
component digests. A copied JSON file outside those trust anchors is never sufficient.

Stale, malformed, failed, differently targeted, differently signed, differently hashed, or
unsealed evidence returns `runtime-unqualified`.

### D3 — Windows uses the shipped Job Object supervisor

The existing KRP1/KRC1/KRS1 native supervisor is staged as
`runtime/native/keiko-runtime-supervisor.exe`. It creates the runtime suspended, assigns it to a
named Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, observes the Job Object
completion port, and resumes only after assignment. Stop, takeover, crash, shutdown, and update
revoke authority before terminating the Job Object. A reusable slot requires the
`ACTIVE_PROCESS_ZERO` accounting proof.

The production qualification executes the exact shipped helper against a root process that creates
a descendant, proves both exit after supervisor termination, proves control-channel loss fails
closed, and binds the passing result into the signed activation attestation. Source-only or
separately compiled fixture success cannot activate a customer install.

### D4 — macOS uses an entitled Endpoint Security System Extension

Each macOS app contains one target-architecture system extension under the canonical app-bundle
system-extension location. The extension:

- observes fork, exec, and exit events through Endpoint Security;
- associates descendants with the server-minted recovery handle from the first admitted spawn;
- rejects an unknown, replayed, expired, or already stopping handle;
- prevents new admitted execs after authority revocation;
- tracks and terminates the complete observed descendant set;
- emits content-free launch and zero-live-descendant proofs over an authenticated local native
  channel; and
- fails closed on queue loss, event loss, client disconnect, identity mismatch, or incomplete exit
  proof.

The macOS supervisor never substitutes a shell, inherited session, or process group for that proof.
The qualification fixture creates descendants across fork and exec, exercises stop and abrupt
control-channel loss, and requires the system extension to prove zero live descendants.

The activation manager submits exactly Keiko's bundled extension through Apple's SystemExtensions
framework and keeps the request alive while local-user approval is pending. After system-extension
activation, the monitor reports a closed `needs-full-disk-access` state when `es_new_client`
returns Apple's `ES_NEW_CLIENT_RESULT_ERR_NOT_PERMITTED`. Keiko opens Apple's documented Full Disk
Access settings page once, continues polling without admitting a runtime, and proceeds
automatically when the monitor becomes `active`. MDM-preapproved machines skip these prompts.

`active` is required before the BFF/UI starts and before `runtimeAvailable` can become true.
Rejection, replacement deferral, entitlement absence, TCC denial, and activation failure remain
content-free unavailable states. Keiko cannot approve either permission on the user's behalf.

### D5 — Packaged secure-read is constructed from the same trust root

Production composition resolves the secure-read helper by name from the closed runtime attestation,
opens it without following links or reparse points, verifies stable file identity and exact bytes,
and verifies its platform signature at every admitted read. On macOS, the verified app resource
seal proves the containing immutable resource tree. On Windows, the signed attestation's exact
helper digest plus independent Authenticode verification supplies the equivalent point-of-use
binding.

The process port uses the fixed helper path, empty environment, no shell, no caller-controlled
arguments, and a server-owned safe working directory. Failure to construct this port keeps the
complete packaged runtime unavailable.

### D6 — OpenCode is mandatory and remains behind Keiko

Every production target contains exactly one approved OpenCode-compatible runtime. Production
discovery rejects zero, multiple, unapproved, stale, or tampered payloads. OpenCode receives no
provider credential and no unrestricted provider endpoint. All model traffic is capability-bound
to Keiko's loopback Model Gateway; the gateway remains the only package permitted to load provider
SDKs and credentials.

Codex subscription activation remains disabled for this release. No missing OpenCode prerequisite
falls back to Codex, a globally installed executable, `PATH`, npm, a network download, or a
development payload.

### D7 — Installation never widens authority

The installed deployment ceiling defaults to `governed-assist` (**Ask for approval**). The operator
may later select a higher existing product mode through the authenticated GUI when deployment
configuration permits it. Setup, system-extension approval, model configuration, runtime
qualification, and successful first launch do not select **Supervised workspace** or **Full
access**.

The three existing modes and their monotonic stricter-wins policy remain the only authority model.

### D8 — Release and first-run claims are executable gates

Before a production artifact can enter the exact-three bundle:

1. native compiler/analyzer and protocol tests pass for the target;
2. the exact staged supervisor, secure-read helper, OpenCode payload, attestation carrier, and
   macOS extension are inventoried;
3. every native executable is signed, and macOS nested bundles are signed leaf-to-root with exact
   role-specific entitlements;
4. the exact shipped backend passes descendant containment and reap qualification on a fresh native
   runner;
5. the activation attestation is generated and sealed by the platform trust anchor;
6. the rebuilt archive, outer manifest, SBOM, provenance, and release-impact binding are
   re-derived and verified;
7. a clean disposable extraction performs automatic managed installation without network or
   developer tooling;
8. both macOS targets prove installation and execution from `/Applications`, System Extension
   activation, Full Disk Access handling, and automatic continuation after approval; and
9. production discovery proves either an available closed runtime or the exact expected
   content-free macOS approval state.

The checks run with signing credentials removed before payload execution. A qualification job may
produce evidence but cannot publish or widen a manifest. Assembly still requires all three exact
targets from one commit and one successful stable-tag workflow.

## Consequences

- A customer artifact has no hidden Node.js, npm, OpenCode, supervisor, receipt, or secure-read
  download step.
- Fresh installs no longer depend on update-only metadata.
- Windows activation is tied to the exact shipped Job Object backend instead of a writable JSON
  receipt.
- macOS explicitly pays the one-time administrator, System Extension, and Full Disk Access approval
  cost when those permissions are not preapproved, and cannot start the product runtime until the
  extension is active.
- A future Keiko Native distribution may replace the portable host and onboarding surface, but it
  cannot weaken the same Endpoint Security entitlement, user/MDM approval, tree ownership, Model
  Gateway, or authority invariants.
- Production macOS artifacts cannot be emitted until the Apple Developer ID and separately granted
  Endpoint Security entitlement are provisioned. This is a release prerequisite, not a code
  fallback.

## Alternatives rejected

- **Ship the existing ZIP and document `npm install` or a global OpenCode executable.** This
  violates the self-contained customer contract and makes local machine state execution authority.
- **Trust `.portable/runtime-supervisor-qualification.json`.** A customer or attacker can replace a
  plain adjacent JSON file; shape validation is not provenance.
- **Put the ZIP digest inside its own receipt.** This is self-referential and has no stable fixed
  point.
- **Use a POSIX process group on macOS.** ADR-0137 already rejects inherited group membership as
  descendant-ownership proof.
- **Treat notarization as Endpoint Security authorization.** Notarization and the Endpoint Security
  entitlement are distinct, and macOS or MDM still controls extension activation.
- **Enable the development lane in packaged installs.** ADR-0140 structurally forbids it and its
  weaker evidence class cannot satisfy a customer release.
- **Auto-select Full access after successful setup.** Installation state is not human authorization
  and may never widen the deployment ceiling.
