# ADR-0163 — Self-contained release-qualified Coding Workbench runtime

- Status: Accepted (2026-07-27)
- Amends:
  - [ADR-0121](ADR-0121-portable-managed-install-and-release-asset-update-authority.md) D3 by
    accepting the canonical `/Applications/Keiko.app` root and one-time macOS approval flow.
  - [ADR-0137](ADR-0137-server-owned-coding-runtime-contracts.md) D5 by defining the packaged
    qualification and activation chain for all three supported targets.
  - [ADR-0140](ADR-0140-macos-dev-lane-activation-of-the-managed-coding-runtime.md) by completing
    the Wave-5 packaged path without changing the deliberately weaker development lane.

> **Amended 2026-08-23 by ADR-0174 (Coding Workbench north star).** D6's subscription-profile
> activation is not "disabled for this release" but retired for good (ADR-0174 D5). D6's "exactly
> one approved OpenCode-compatible runtime" stays binding for packaged targets while the bridge
> engine ships, and is future-dated to become "at least one approved runtime source" only once
> the bridge is retired (ADR-0174 D12). Every other D6 guarantee — no runtime credential leakage,
> gateway-only model routing, no bare-metal fallback — is unchanged. Affected: D6.

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
architecture-mismatched, stale, or not bound to the source commit and target.

There are exactly three pre-signing lanes, and a lane is a declaration the artifact carries in its
own manifest, never an argument a caller supplies:

1. **Plain staging** (`staging` / `unverified-staging`) — the default output of every manual
   dispatch. It is unsigned, unqualified, and **not activatable**: the runtime refuses it.
2. **Evaluation** (`evaluation` / `evaluation-unqualified`) — the explicitly requested, unsigned but
   **activatable** lane defined in D9. It never enters the signed production release bundle, and it
   is never published by default or as a side effect. It IS the payload of the explicitly labeled
   beta **prereleases** cut by `scripts/release-portable-prerelease.mjs` under the owner-approved
   0.3.0 beta program (owner decision, amended after v0.3.0-beta.0 shipped — the same amendment
   that governs the first-run mechanics in D9): draft-first, checksummed, provenance-pinned to the
   producing workflow run, superseded-chain-linked, and macOS-sealed since v0.3.0-beta.1.

   **Amended 2026-08-09 (issue #2802), for the public download program.** The same payload, cut by
   the same script under `--public-release`, is also the payload of Keiko's first public download
   release at the exact stable tag. Publication remains explicit and never a side effect: it is one
   deliberate invocation, the release-impact entry records the `evaluation` signing status, and the
   release notes state it. Three bounds keep this from widening into "unsigned is production":
   the release declares `oneClickEligible: false`, because the portable updater accepts only
   `production` / `verified-production` evidence and must keep doing so; `release-publish.mjs`
   verifies the published downloads against `keiko-portable-evaluation-manifest.json` and re-fetches
   every byte before npm learns the `latest` dist-tag; and D9's waiver list below is unchanged —
   signature, notarization and platform attestation stay waived, everything else stays mandatory.
   ADR-0121 D1 carries the matching amendment.
3. **Production** (`production` / `verified-production`) — the only lane that can produce a
   production-available runtime.

Neither of the first two can produce a production-available runtime, and neither can enter the
release bundle: assembly runs only from a stable-tag push and its own predicates still demand
`verified-production`.

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

At point of use, Windows invokes only the fixed system PowerShell path with a closed environment,
validates both `Keiko.exe` and the attestation carrier through Authenticode, and requires their
verified leaf signer identities to match before the carrier may emit a receipt. This same-release
comparison preserves Azure's short-lived certificate rotation model: it does not pin a leaf
thumbprint, public key, or subject in repository content.

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
binding. The helper's verified signer identity must match the independently verified primary
`Keiko.exe` launcher identity on every admitted read.

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

This prohibition is about FALLBACK, and it stands unchanged. The D9 evaluation payload is not a
fallback: it is the same review-approved OpenCode payload, staged by the same producer, verified by
the same digests, and reached only because the artifact itself declares that lane. Nothing about a
missing or failing prerequisite can select it, and no lane is chosen after another one fails.

**Amendment (ADR-0174, 2026-08-23).** TARGET: the subscription-profile activation named above is
not "disabled for this release" — it is retired for good, along with its model source and runtime
source (ADR-0174 D5). D6's "exactly one approved OpenCode-compatible runtime" stays the binding
rule for packaged targets for as long as the bridge engine is the shipped runtime, and is
future-dated to become "at least one approved runtime source" only once the bridge is retired under
ADR-0174 D12 (roadmap Wave 7.1, `docs/coding-runtime/coding-workbench-north-star-roadmap.md`) — no
packaging change now. Every other D6 guarantee is unchanged: no runtime credential leakage,
gateway-only model routing through Keiko's loopback Model Gateway, and no bare-metal fallback.
Current implementation is unchanged until roadmap Wave 7.1 lands
(docs/coding-runtime/coding-workbench-north-star-roadmap.md); until then the recorded behaviour
above remains the fail-closed implementation.

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

### D9 — One explicitly declared, unsigned evaluation lane may activate

Keiko ships a portable EVALUATION build in which the bundled OpenCode sidecar actually runs without
Apple or Microsoft code signing. The lane exists because platform signing credentials are a
procurement dependency, and a product that cannot be exercised at all until they land cannot be
evaluated at all.

**How it is entered.** Only `workflow_dispatch` with `evaluation_build: true`, which appends one
bare `--evaluation-build` flag to the staging producer. There is no environment variable, no
default, and no checkout marker. The producer then writes `evaluation` / `evaluation-unqualified`
plus the reason codes `evaluation-artifact` and `evaluation-unsigned-allowed` in all four places it
declares a lane — the manifest security block, every sidecar signing block, every native-helper
signing block, and the native addon — and stamps the activation document's `trustAnchor` as
`evaluation-unqualified`. A manifest that declares the lane in some of those places and not others
is rejected by the schema, and an artifact whose activation document is incoherent across those
blocks is refused at discovery.

**Exactly what is waived — and nothing else.** The lane waives the platform signature,
notarization and platform-attestation gates. It waives nothing else:

| Stays mandatory on the evaluation lane                             |
| ------------------------------------------------------------------ |
| `payloadSha256` (recomputed directory-tree digest, at discovery and again at launch) |
| `sizeBytes` shape, `payloadRootPath` equality and safe-relative form |
| `executablePath` containment under the payload root                 |
| `shippedExecutableSha256`, `shippedExecutableTreeAlgorithm`, `shippedExecutableTreeSha256` |
| the exact 11-key sidecar signing set and the target's `signatureKind` |
| license and SBOM evidence path containment plus digests             |
| the complete portable provenance pin (upstream identity, adapter identity, protocol-schema digest, redistribution approval, archive target and digest) |
| both native-helper digests and byte lengths, re-hashed from disk    |
| the closed 12-key secure-read helper shape, its KSR1/KSS1 protocol pin, source commit/path/tree pin, size ceiling and SBOM bom-ref binding |
| the point-of-use same-identity open, link-count and metadata equality, and full re-hash of every byte read |

The waived platform booleans are **asserted present and FALSE**, never skipped. A signing or
security block that omits `verificationChecks`, or asserts any single platform check, or claims
`signatureVerified`, is refused — a half-truthful mix is not a lane.

**What is genuinely given up.** On **macOS** the Endpoint Security system extension is not active:
it requires an Apple-entitled, notarized, user-approved install. Descendant containment is therefore
NOT proven, and process supervision is weaker — the runtime declares the `macos-app-sandbox` backend
and spawns through the dev-lane process backend rather than claiming an Endpoint Security
containment it does not have. On **Windows** the Job Object supervisor needs no signature, so the
native backend and its `windows-job-object` containment are unchanged and real. No integrity
guarantee is given up on either platform; what is given up is platform provenance on both, and
descendant containment on macOS only.

**How an unsigned install launches at all (first-run mechanics).** Amended after v0.3.0-beta.0
shipped: its first customer double-click found three dead ends, each of which is now governed here.

1. *Launch-time containment activation follows the platform anchor, not the artifact.* `portable
   launch` on macOS asks the platform's own verifier — the same release-signature probe that guards
   the lane downgrade above — whether the install carries a release signature. Signed: the strict
   activation contract is unchanged; the root-owned immutable manager must report `active` or the
   launch refuses. Unsigned: activation is **waived** (`waived-unsigned`), because an Endpoint
   Security extension can never load without an Apple-entitled signature, and requiring it turned
   an impossible precondition into a permanent, silent launch failure. The waiver is announced on
   stdout, and the declared-lane honesty (`functional-not-platform-qualified`) is unchanged. The
   anchor deliberately stays outside the artifact: a declaration file must not be able to waive the
   verification that would detect its own rewrite.
2. *The staged app bundle carries an ad-hoc resource seal.* Every Mach-O ships individually
   signed, but Gatekeeper judges the bundle: a signed main executable inside a seal-less bundle is
   reported as "damaged" — a verdict with **no** "Open Anyway" recovery at all. The staging
   producer therefore seals `Keiko.app` ad-hoc (asserting no author, making the bundle internally
   consistent) after the final activation-manifest write, and runs `codesign --verify --deep
   --strict` as the last payload-affecting step so any later mutation fails staging instead of the
   customer journey. Sealing is inside-out: the arm64 linker ad-hoc signs every Mach-O at link
   time but the x86_64 one does not, and `codesign` refuses to seal over unsigned subcomponents,
   so the nested system-extension bundle and the extension manager are ad-hoc signed first
   (digest-safe: both are bound by the outer seal and the install-time identity, computed after
   this step). The Developer ID lane later replaces all of these seals with real signatures.
3. *A double-click failure is visible.* The native launcher marks its child tree with
   `KEIKO_PORTABLE_UI_LAUNCH=1`; only under that exact marker does a failed portable setup or
   launch raise a native alert carrying the recorded stderr reason. Terminals, CI and test runners
   never set the marker — a TTY heuristic is explicitly rejected, since it cannot tell a Finder
   launch from a test runner exercising failure paths.
4. *A pristine same-path install is adopted, never refused (owner decision, platform-neutral).*
   The canonical install gesture moves the bundle to the managed location BEFORE the first launch.
   When the portable root IS the managed root, no registration of any status exists, and the root
   passes the complete portable-root validation, setup attests it in place and launches. The
   original same-path pin (#2966) is relocated, not relaxed: adoption over an EXISTING
   registration stays refused — re-binding a recorded install identity to different bytes at the
   same path is exactly the shape of post-attestation tampering — and an unvalidated root records
   a failure and is never attested.

**How the runtime identity stays bound.** No platform seal binds the evaluation activation document.
Its only bindings are its own internal consistency, the disk re-hash of both native helpers, and the
sidecar payload re-inspection at discovery AND again at launch. The synthesized qualification
receipt is computed over the complete qualification binding — target, source commit, activation
manifest digest, supervisor digest, secure-read digest and sidecar payload digest — so a swapped
supervisor binary still changes the runtime identity. It is deliberately NOT routed through the
platform receipt parser, which would force a macOS receipt to assert `macos-endpoint-security`: a
forged containment claim.

**`SecureWorkspaceTextReadArtifact.signed` is a structural artifact-shape literal, not a signature
claim.** It means "this record is the verified artifact identity". The artifact validator requires
it truthy before the point-of-use verifier runs at all, so setting it `false` on this lane would
silently disable every workspace read with no diagnostic. It stays `true` on every lane; ADR-0140's
dev lane sets it `true` on an ad-hoc-signed helper for the same reason.

**It is never promotable.** The lane is reachable only from the activation entry point, which takes
it as an explicit, closed-by-default argument. The update/promotion entry point takes no lane
argument at all, and the preflight and staging-download predicates are untouched: an evaluation
artifact stays update-INELIGIBLE. The runtime may activate an unsigned sidecar; the product may
never self-update from one. The signing verifier explicitly REJECTS `--policy evaluation` rather
than laundering it into a pull-request-shaped lane.

**It is never silently green.** The readiness contract carries `runtimeEvidenceClass`, REQUIRED
whenever `runtimeAvailable` is true, and the evaluation lane reports ADR-0140's existing
`functional-not-platform-qualified`. Every server-side default along that path resolves to the weak
value, so an unthreaded path degrades to "unverified" and never to "verified". The header pill, the
session context bar, the spoken readiness announcement and the bootstrap setup screen all state
plainly that the runtime is an unverified evaluation runtime; none of them renders it as plain
green. This is the class audit finding F-01 closed, and it must not be reintroduced.

## Consequences

- A customer artifact has no hidden Node.js, npm, OpenCode, supervisor, receipt, or secure-read
  download step.
- Fresh installs no longer depend on update-only metadata.
- Windows activation is tied to the exact shipped Job Object backend instead of a writable JSON
  receipt.
- A release-signed macOS install explicitly pays the one-time administrator, System Extension, and
  Full Disk Access approval cost when those permissions are not preapproved, and cannot start the
  product runtime until the extension is active. An unsigned D9 evaluation install waives that
  activation (`waived-unsigned`) because the platform itself rules the extension out; it starts
  with the weaker, honestly declared containment instead.
- A future Keiko Native distribution may replace the portable host and onboarding surface, but it
  cannot weaken the same Endpoint Security entitlement, user/MDM approval, tree ownership, Model
  Gateway, or authority invariants.
- **Production** macOS artifacts cannot be emitted until the Apple Developer ID and separately
  granted Endpoint Security entitlement are provisioned. This is a release prerequisite, not a code
  fallback. The D9 evaluation lane does not change that: what it publishes is an evaluation
  artifact, never a production one, and its macOS build carries weaker process containment
  precisely because that entitlement is absent. Since the 2026-08-09 amendment above it may be
  published deliberately — as a beta prerelease, or as the public download release that declares
  its `evaluation` status and stays ineligible for the governed one-click update — but it can never
  be presented as, or promoted into, a production-signed artifact.
- An evaluation build is honest about being one, everywhere an operator can see it: the artifact
  name, the manifest lane, the activation trust anchor, the readiness projection, and four UI
  surfaces.

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
- **Enable the development lane in packaged installs.** Still rejected. ADR-0140 structurally
  forbids it — `discoverDevLaneOpenCode` refuses the moment a packaged setup manifest exists — and
  its weaker evidence class cannot satisfy a customer release. The D9 evaluation lane is NOT that
  alternative and is not confined the same way. The dev lane is gated by an environment token plus
  structural checkout markers on a developer's working copy, and it synthesizes its own payload
  metadata from local files. The evaluation lane is a declaration a PACKAGED artifact carries in
  its own manifest, written only when a release explicitly requests it, carrying the complete
  integrity evidence set of a production artifact — every digest, size, containment, license, SBOM
  and provenance predicate — and differing from production only in the platform signature it never
  claims to have.
- **Reuse the existing `development`/`pull-request` lane instead of adding a third.** Rejected for
  three independent reasons. The manifest schema validated the shipped-executable digests only under
  the production policy, so that lane would ship the three digests the runtime demands and never
  check them. Every routine CI pull-request artifact already carries that lane, so teaching the
  runtime to activate it would promote EVERY pull-request build into an activating runtime and make
  "only when explicitly requested" unenforceable. And an operator reading `unsigned-non-production`
  in a shipped bundle learns nothing about evaluation. The machinery is reused; the lane is not.
- **Auto-select Full access after successful setup.** Installation state is not human authorization
  and may never widen the deployment ceiling.
