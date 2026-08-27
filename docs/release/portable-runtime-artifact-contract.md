# Portable Runtime Artifact Contract

Status: Contract baseline for Issue #1947 and staging baseline for Issue #1948. This document
defines the release artifact shape that later portable delivery children must implement and verify.
It does not publish assets or change updater execution logic.

Governing decisions:

- [ADR-0121: Portable managed install and release-asset update authority](../adr/ADR-0121-portable-managed-install-and-release-asset-update-authority.md)
- [ADR-0021: Publish Strategy - Bundled Monorepo Product](../adr/ADR-0021-publish-strategy-bundled-monorepo-product.md)
- [ADR-0099: Governed in-app updates and release-impact contract](../adr/ADR-0099-governed-in-app-updates-and-release-impact-contract.md)
- [Local runtime state contract](../local-runtime-state-contract.md)
- [Portable Launch And Setup Guide](portable-launch-setup-guide.md)
- [Release / Publish Workflow](release-publish-workflow.md)

## Product Contract

Portable v1 is an archive-backed delivery path for stable public releases with platform-specific
promoted journeys. On Windows, ordinary users download and run the signed
`keiko-windows-x64-setup.exe`; setup verifies its embedded canonical ZIP, completes first-run setup
into Keiko's per-user managed install location, and launches Keiko. On macOS, users download the
target ZIP, extract `Keiko.app`, and double-click it to complete first-run setup into the managed app
location. After setup, users launch Keiko from the same native app surface or OS search entry. The
Windows ZIP remains the canonical release payload and support/bootstrap surface, but it is not the
promoted ordinary-user install journey.

Users must not need system Node.js, npm, Yarn, a package manager, build tools, or shell commands on
the primary install/start path. Shell launchers may exist only for support and automated diagnostics.

## Platform Target Matrix

Every stable release that claims portable product delivery must publish exactly these first-class
portable assets as a release-blocking set:

| Platform target | Required asset name     | Archive format | Primary launcher | Runtime target | Signing evidence                              | Stable release requirement                           |
| --------------- | ----------------------- | -------------- | ---------------- | -------------- | --------------------------------------------- | ---------------------------------------------------- |
| `windows-x64`   | `keiko-windows-x64.zip` | ZIP            | `Keiko.exe`      | `win32-x64`    | Authenticode publisher-chain verification     | Required whenever portable delivery is advertised    |
| `macos-arm64`   | `keiko-macos-arm64.zip` | ZIP            | `Keiko.app`      | `darwin-arm64` | Developer ID signature and notarization proof | Equal priority with `macos-x64`; never best-effort   |
| `macos-x64`     | `keiko-macos-x64.zip`   | ZIP            | `Keiko.app`      | `darwin-x64`   | Developer ID signature and notarization proof | Equal priority with `macos-arm64`; never best-effort |

The release is not portable-complete when any target is missing, mislabeled, checksum-mismatched,
unsigned, unnotarized where required, or not represented in reviewed release-impact metadata.

Stable releases also publish `keiko-windows-x64-setup.exe` as an Authenticode-signed companion to
the canonical Windows ZIP. The setup embeds that exact ZIP, installs it under the per-user managed
install root, and verifies that the launched Keiko process remains healthy. If a managed Keiko
installation already exists, setup validates and launches that installation without replacing it;
governed in-app update remains the upgrade authority. The setup is a convenience install surface
for `windows-x64`, not a fourth platform target; release qualification and digest binding still
derive from the ZIP and its reviewed evidence.

## Current Staging Status

The portable release pipeline stages the packed Keiko package, acquires and verifies the target
Node.js runtime and the approved OpenCode runtime, builds the native launcher and governed runtime
helpers, and validates redacted artifact manifests. Stable-tag production jobs additionally perform
Windows signing, macOS signing and notarization, native runtime qualification, release upload, and
published-asset verification. First-run setup promotes the verified bundle into the managed install
root before the Coding Workbench may activate the bundled runtime.

Manifest schema v1 has four explicit pre-publication validation contexts — staging, evaluation,
candidate, and published (plus the `published-contract` context used to validate this document's own
example). Staging manifests use `verificationPolicy: "staging"`,
`verificationStatus: "unverified-staging"`, `signatureVerified: false`,
`notarizationVerified: false`, target-specific `verificationChecks` set to `false`, and
`platformSignatureLocallyVerified: false`. They also use `artifact.assetId: 0` because GitHub
Release asset ids do not exist before upload. Unverified staging and verified unpublished candidates
must use `release.releaseId: 0`, `artifact.assetId: 0`, and matching zero-id release-impact bindings;
any positive pre-upload identity is rejected. After upload, the published context requires positive
ids that exactly match the GitHub API release/asset snapshot. The manifest example below remains the
production-complete contract for artifacts that may be promoted as portable release assets.

### The evaluation lane (ADR-0163 D9)

An explicitly requested `workflow_dispatch` run (`evaluation_build: true`) produces the fourth
context instead of staging. Its declared triple is `verificationPolicy: "evaluation"`,
`verificationStatus: "evaluation-unqualified"`, and reason codes exactly
`["evaluation-artifact", "evaluation-unsigned-allowed"]`, written in the manifest security block,
every sidecar signing block, every native-helper signing block, and the native addon. Its
`runtimeActivation.trustAnchor` is `evaluation-unqualified` — the anchor states plainly that NO
platform seal binds the activation document the runtime reads at discovery. Like staging, it uses
`release.releaseId: 0` and `artifact.assetId: 0`.

Unlike staging, an evaluation artifact ACTIVATES: the packaged runtime will run its bundled
OpenCode sidecar. What that waives is exactly the platform signature, notarization and attestation
gates. Everything else stays mandatory and identical to production — `payloadSha256`, `sizeBytes`,
`payloadRootPath` equality and containment of `executablePath`, all three `shippedExecutable*`
fields (validated in this context, not only under the production policy), the exact 11-key sidecar
signing set, license and SBOM evidence paths and digests, the complete portable provenance pin, and
both native-helper digests re-hashed from disk at discovery AND again at launch. The waived platform
booleans must be present and `false`, never absent: a manifest that omits `verificationChecks` or
asserts any single platform check is rejected.

An evaluation artifact is never publishable and never update-eligible. The `assemble` job runs only
from a stable-tag push and still requires three mutually consistent `verified-production` targets;
`scripts/verify-portable-runtime-signing.mjs` explicitly refuses `--policy evaluation`; and the
update preflight and staging-download predicates still demand production/verified-production. The
schema shape of an evaluation manifest is pinned in `scripts/__tests__/portable-runtime.test.mjs`
rather than as a second JSON fence here, because `check:portable-manifest` validates only the FIRST
fence in this document under the published-contract context.

## Archive And Evidence Layout

Portable staging produces a target directory containing the final ZIP asset, a payload tree for
layout inspection, and artifact manifest/evidence records. The manifest and evidence files bind
the ZIP bytes by hash and size from outside the ZIP so `artifact.sha256` can describe the actual
release asset without a self-referential manifest checksum.

Every ZIP asset extracts into one top-level `Keiko/` directory. That directory is a bootstrap
payload, not the long-lived self-update target until first-run setup attests and promotes a managed
install.

Windows archive:

```text
windows-x64/
  keiko-windows-x64.zip
  keiko-windows-x64-setup.exe
  manifest/
    portable-manifest.json
  evidence/
    SHA256SUMS.txt
    sbom.cdx.json
    third-party-notices.txt
    signing-verification.json
  payload/
    Keiko/
      Keiko.exe
      .portable/
        setup-manifest.json
      app/
        package.json
        dist/
        node_modules/
        release-impact.catalog.json
      runtime/
        native/
          keiko-secure-workspace-read.exe
          keiko-runtime-supervisor.exe
          keiko-runtime-attestation.exe
        node/
          node.exe
          LICENSE
          NOTICE
          NODE_RUNTIME_SOURCE.json
        sidecars/
          opencode-compatible/
            bin/
              opencode.exe
            evidence/
              LICENSE
              sbom.cdx.json
      support/
        keiko-support.cmd
```

macOS archive:

```text
macos-arm64/
  keiko-macos-arm64.zip
  manifest/
    portable-manifest.json
  evidence/
    SHA256SUMS.txt
    sbom.cdx.json
    third-party-notices.txt
    signing-verification.json
  payload/
    Keiko/
      Keiko.app/
        Contents/
          Info.plist
          MacOS/
            Keiko
            KeikoSystemExtensionManager
          Library/
            SystemExtensions/
              com.oscharko.keiko.runtime-monitor.systemextension/
                Contents/
                  Info.plist
                  MacOS/
                    KeikoRuntimeMonitor
          Resources/
            .portable/
              setup-manifest.json
            app/
              package.json
              dist/
              node_modules/
              release-impact.catalog.json
            runtime/
              native/
                keiko-secure-workspace-read
                keiko-runtime-supervisor
              node/
                bin/node
                LICENSE
                NOTICE
                NODE_RUNTIME_SOURCE.json
              sidecars/
                opencode-compatible/
                  bin/
                    opencode
                  evidence/
                    LICENSE
                    sbom.cdx.json
      support/
        keiko-support.sh
```

Layout rules:

- `Keiko.exe` and `Keiko.app` are the only primary launchers named in user-facing install/start
  instructions.
- `support/` is optional and support-only. It must not be the primary user path and must not be
  referenced from default install/start copy.
- `app/` contains the built root `@oscharko-dev/keiko` product surface from the same source package
  contract as npm publication, not ad hoc copied workspace source.
- `runtime/node/` contains the extracted pinned Node.js runtime for the exact platform target, not
  only the source archive. It is private to this Keiko artifact and must not be installed globally.
- `runtime/node/NODE_RUNTIME_SOURCE.json` records the content-free source archive identity, target,
  version, and SHA-256 digest used to populate the runtime payload.
- `runtime/sidecars/opencode-compatible/` contains the one approved OpenCode coding runtime payload.
  The governed runtime adapter owns its launch authority. The payload is never downloaded during
  customer install, first run, app launch, or portable update outside the normal Keiko release asset
  download.
- `manifest/portable-manifest.json` is the sidecar artifact contract record for build, setup,
  release, and updater children.
- `.portable/setup-manifest.json` is the payload-local first-run setup manifest. It contains the
  non-self-referential subset needed by the launcher/setup path: platform target, package version,
  primary launcher name, bootstrap update ineligibility, and bundled Node runtime target. It does not
  contain archive bytes, absolute paths, customer data, credentials, or release-asset URLs.
- `evidence/` contains sidecar release artifact evidence only. It must be content-free with
  respect to customer data.

## Managed Install Layout

First-run setup promotes the bootstrap payload into a target-specific managed install root before Keiko
enters the normal app/update lifecycle.

Default managed roots:

| Platform target | Managed root                      | Native registration owned by #1950                             |
| --------------- | --------------------------------- | -------------------------------------------------------------- |
| `windows-x64`   | `%LOCALAPPDATA%\\Programs\\Keiko` | User-local Start Menu shortcut pointing to managed `Keiko.exe` |
| `macos-arm64`   | `/Applications/Keiko.app`         | Canonical app bundle registration for Spotlight/Finder launch  |
| `macos-x64`     | `/Applications/Keiko.app`         | Canonical app bundle registration for Spotlight/Finder launch  |

The final realpath must classify as a dedicated Keiko-owned root. It must not be `.keiko`, a
customer repository, a temporary directory, a shared or network root, or a system-managed location
other than the exact `/Applications/Keiko.app` exception accepted by ADR-0163.

The bootstrap extraction directory is not self-update eligible. Only an attested managed root is
portable-update eligible. Staging roots must be siblings of the active managed root on the same
filesystem volume so later update promotion can use crash-safe atomic replacement.

Runtime state remains governed by the local runtime state contract. `.keiko` may store content-free
install/update registration, a bounded managed-root locator needed for reversible portable
repair/uninstall, recovery, remediation, and audit status, but it must not store portable package
payloads, full archives, or customer-content backups. The exact persisted
`portable-install-state.json` record shape is defined in
[Local runtime state contract](../local-runtime-state-contract.md): shared fields
`schemaVersion`, `platformTarget`, `status`, `updateEligible`, `packageVersion`, `stable`, and
`updatedAt`; a managed record may additionally carry an optional `managedRootLocator`
(`default`, `home-relative`, or `absolute-local`) plus managed-only attestation hashes; a
`setup-failed` record carries only a bounded `failureReason` code beyond the shared fields.

## State And Payload Exclusions

Portable archives and their manifest/evidence records must not include:

- `.keiko` runtime state,
- `keiko-ui.db`, memory databases, Local Knowledge stores, or credential vaults,
- `keiko.config.json` and any other local gateway configuration file,
- customer repositories, workspace files, generated patches, or task worktrees,
- secrets, credentials, private endpoints, proxy credentials, or token-bearing material,
- private logs, raw stdout/stderr, package-manager output, prompts, model output, or evidence
  bodies,
- customer document text, vector bytes, screenshots, Figma payloads, or local knowledge content.

Artifact metadata may include counts, hashes, versions, platform labels, release ids, asset ids,
relative paths, and bounded status codes. It must not include absolute customer paths, raw logs,
asset URLs with credentials, or reconstructive customer content.

The protected macOS production stage replaces the packaged server module's single build-time team
placeholder with the reviewed `APPLE_TEAM_ID` before the app is signed. Any package that retains the
placeholder remains intentionally unqualified. Runtime app, manager, Endpoint Security extension,
and secure-read verification must all match that release-pinned team; the identifier is not emitted
in manifests, diagnostics, or evidence.

## Mandatory Product-Owned Coding Runtime

Every newly staged, candidate, and published customer artifact must contain exactly one
`opencode-compatible` coding runtime entry in `sidecarRuntimes[]`. The field remains optional only
for parsing legacy manifests; an absent or empty array is not valid for any newly produced customer
artifact. No second coding runtime, global executable, `PATH` fallback, package-manager install, or
first-run download may satisfy this requirement.

Sidecar payloads are staged from controlled Keiko release inputs by the release pipeline. The
controlled release input is the schema-v2 committed
[`portable-runtime-approvals.json`](../../portable-runtime-approvals.json): it pins the approved
sidecar runtime version and immutable upstream commit with per-target archive and executable-tree
SHA-256 digests, sizes, license evidence, raw protocol-schema provenance, and explicit
redistribution/subscription-auth release approvals. `scripts/prepare-approved-sidecar-payloads.mjs`
materializes the payloads from those pins with archive, executable-tree, license, and raw-schema
digest verification before staging. Sidecar payloads must
not be acquired by customer machines through postinstall scripts, first-run downloads, app-launch
downloads, updater-time side downloads, global npm installs, curl installers, or any other
customer-side tool installation path. Refreshing a frozen sidecar payload is a Keiko release
decision: update the approvals file (for example with
`npm run portable:approve-runtimes -- --opencode-version <v>`), review and merge that diff,
regenerate all three portable artifacts, verify the
new digests/evidence/signing status, and ship through the normal reviewed release flow. The runtime
payload is an inseparable child of that whole-product release: it has no independent promotion,
self-update, downgrade, rollback, or recovery channel.

OpenCode `1.17.17` is pinned to tag commit
`474abdd7ee60f4b67476cfcef7e5311beff4a824`. Its HTTP/SSE adapter compatibility is bound to the raw
bytes of `packages/sdk/openapi.json` at that commit, SHA-256
`7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de`. The digest input is
`upstream-raw-bytes`; canonicalized or reformatted JSON is not interchangeable. Codex is absent
from approved payloads and support claims until separate human redistribution and subscription-auth
approval is recorded. Pending or missing approval fails closed as `redistribution-unapproved` and
never falls back to a global Codex install.

Sidecar metadata remains content-free. It may record runtime identity, kind, upstream version,
adapter compatibility, platform target, contained relative payload and executable paths, SHA-256
digests, byte sizes, license/SBOM evidence paths and digests, and target-specific signing or
notarization status. It must not record local `sourceRoot` values, absolute paths, customer data,
repository content, prompts, diffs, model output, raw logs, package-manager output, credentials, or
private paths. The Coding Workbench runtime adapter may launch only this verified bundled payload
through the governed native supervisor.

## Manifest Schema Draft

`manifest/portable-manifest.json` is a reviewed, content-free JSON object. Later implementation
children may extract this schema baseline into a machine-enforced schema, but fields below are the
required contract vocabulary.

```json
{
  "schemaVersion": 1,
  "product": {
    "name": "Keiko",
    "packageName": "@oscharko-dev/keiko",
    "packageVersion": "0.2.11"
  },
  "release": {
    "releaseId": 123456789,
    "releaseTag": "v0.2.11",
    "stable": true,
    "commitSha": "40-hex-reviewed-release-commit"
  },
  "artifact": {
    "platformTarget": "windows-x64",
    "assetId": 123456789,
    "assetName": "keiko-windows-x64.zip",
    "archiveFormat": "zip",
    "sizeBytes": 12345678,
    "sha256": "64-hex-artifact-digest"
  },
  "provenance": {
    "sourceCommitSha": "40-hex-reviewed-release-commit",
    "rootPackageVersion": "0.2.11",
    "rootPackageTarballSha256": "64-hex-root-package-tarball-digest",
    "packagedAppTreeSha256": "64-hex-app-tree-digest",
    "buildWorkflowRunId": 123456789,
    "buildWorkflowAttempt": 1,
    "provenanceStatementPath": "evidence/provenance.intoto.jsonl",
    "provenanceStatementSha256": "64-hex-provenance-statement-digest"
  },
  "runtime": {
    "nodeVersion": "24.0.0",
    "nodePlatform": "win32",
    "nodeArchitecture": "x64",
    "nodeDistribution": "official-nodejs-dist",
    "nodeArchiveSha256": "64-hex-node-runtime-digest"
  },
  "runtimeActivation": {
    "schemaVersion": 1,
    "path": ".portable/runtime-activation.json",
    "sha256": "64-hex-runtime-activation-digest",
    "trustAnchor": "authenticode-attestor"
  },
  "runtimeAttestation": {
    "schemaVersion": 1,
    "carrierKind": "authenticode-executable",
    "executablePath": "runtime/native/keiko-runtime-attestation.exe",
    "shippedSha256": "64-hex-runtime-attestation-digest",
    "sizeBytes": 12288,
    "signing": {
      "signatureKind": "authenticode",
      "verificationStatus": "verified-production",
      "signatureVerified": true,
      "notarizationRequired": false,
      "notarizationVerified": false
    }
  },
  "nativeHelpers": [
    {
      "name": "keiko-secure-workspace-read",
      "kind": "secure-workspace-text-read",
      "platformTarget": "windows-x64",
      "architecture": "x64",
      "executablePath": "runtime/native/keiko-secure-workspace-read.exe",
      "protocol": {
        "schemaVersion": 1,
        "requestMagic": "KSR1",
        "responseMagic": "KSS1"
      },
      "source": {
        "commitSha": "40-hex-reviewed-release-commit",
        "path": "native/secure-workspace-read",
        "treeSha256": "64-hex-secure-read-source-tree-digest"
      },
      "unsignedSha256": "64-hex-secure-read-unsigned-digest",
      "shippedSha256": "64-hex-secure-read-shipped-digest",
      "sizeBytes": 4096,
      "sbomBomRef": "pkg:generic/keiko-secure-workspace-read@0.2.11?platform=windows-x64",
      "signing": {
        "signatureKind": "authenticode",
        "verificationStatus": "verified-production",
        "signatureVerified": true,
        "notarizationRequired": false,
        "notarizationVerified": false
      }
    },
    {
      "name": "keiko-runtime-supervisor",
      "kind": "runtime-process-supervisor",
      "platformTarget": "windows-x64",
      "architecture": "x64",
      "executablePath": "runtime/native/keiko-runtime-supervisor.exe",
      "protocol": {
        "schemaVersion": 1,
        "requestMagic": "KRP1",
        "responseMagic": "KRS1"
      },
      "source": {
        "commitSha": "40-hex-reviewed-release-commit",
        "path": "native/runtime-supervisor/windows",
        "treeSha256": "64-hex-supervisor-source-tree-digest"
      },
      "unsignedSha256": "64-hex-supervisor-unsigned-digest",
      "shippedSha256": "64-hex-supervisor-shipped-digest",
      "sizeBytes": 8192,
      "sbomBomRef": "pkg:generic/keiko-runtime-supervisor@0.2.11?platform=windows-x64",
      "signing": {
        "signatureKind": "authenticode",
        "verificationStatus": "verified-production",
        "signatureVerified": true,
        "notarizationRequired": false,
        "notarizationVerified": false
      }
    }
  ],
  "sidecarRuntimes": [
    {
      "name": "opencode-compatible",
      "kind": "coding-runtime",
      "approvalSchemaVersion": 2,
      "upstream": {
        "owner": "anomalyco",
        "repository": "opencode",
        "name": "opencode",
        "version": "1.17.17",
        "tag": "v1.17.17",
        "commit": "474abdd7ee60f4b67476cfcef7e5311beff4a824"
      },
      "adapterCompatibility": {
        "adapterName": "keiko-coding-sidecar",
        "adapterVersion": "1",
        "transport": "http-sse"
      },
      "protocolSchema": {
        "path": "packages/sdk/openapi.json",
        "url": "https://raw.githubusercontent.com/anomalyco/opencode/474abdd7ee60f4b67476cfcef7e5311beff4a824/packages/sdk/openapi.json",
        "sha256": "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de",
        "hashAlgorithm": "sha256",
        "hashEncoding": "lowercase-hex",
        "digestInput": "upstream-raw-bytes",
        "transport": "http-sse"
      },
      "releaseApproval": {
        "redistribution": {
          "status": "approved",
          "reviewReference": "https://github.com/oscharko-dev/Keiko/issues/2253"
        },
        "subscriptionAuth": {
          "status": "not-applicable",
          "reviewReference": "https://github.com/oscharko-dev/Keiko/issues/2253"
        }
      },
      "license": {
        "spdxId": "MIT",
        "url": "https://raw.githubusercontent.com/anomalyco/opencode/474abdd7ee60f4b67476cfcef7e5311beff4a824/LICENSE",
        "sha256": "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b"
      },
      "archive": {
        "platformTarget": "windows-x64",
        "url": "https://github.com/anomalyco/opencode/releases/download/v1.17.17/opencode-windows-x64.zip",
        "sizeBytes": 69576819,
        "sha256": "0a7fd7730a8efb00c69bce86fabcc0c24668371d821e99078a90dc78b71b4b85"
      },
      "executableTreeAlgorithm": "keiko-directory-tree-sha256-v1",
      "executableTreeSha256": "081a514d31cf00426400e26fb713273ffab91d23c110fa9bac469ad254f3336b",
      "executableSha256": "64-hex-opencode-executable-digest",
      "platformTarget": "windows-x64",
      "payloadRootPath": "runtime/sidecars/opencode-compatible",
      "executablePath": "runtime/sidecars/opencode-compatible/bin/opencode.exe",
      "payloadSha256": "64-hex-opencode-compatible-payload-digest",
      "sizeBytes": 2345678,
      "licenseEvidence": {
        "path": "runtime/sidecars/opencode-compatible/evidence/LICENSE",
        "sha256": "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b"
      },
      "sbomEvidence": {
        "path": "runtime/sidecars/opencode-compatible/evidence/sbom.cdx.json",
        "sha256": "64-hex-opencode-compatible-sbom-digest"
      },
      "signing": {
        "verificationPolicy": "production",
        "verificationStatus": "verified-production",
        "verificationReasonCodes": [],
        "signatureKind": "authenticode",
        "signatureVerified": true,
        "notarizationRequired": false,
        "notarizationVerified": false,
        "verificationChecks": {
          "publisherChainVerified": true,
          "timestampVerified": true
        },
        "shippedExecutableSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "shippedExecutableTreeAlgorithm": "keiko-directory-tree-sha256-v1",
        "shippedExecutableTreeSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    }
  ],
  "packageSurface": {
    "source": "root-npm-package-surface",
    "packageSurfaceGate": "npm run check:package-surface",
    "publishManifestGate": "npm run check:publish-manifests",
    "workspaceSupplyChainGate": "npm run check:workspace-supply-chain"
  },
  "entrypoints": {
    "primaryLauncher": "Keiko.exe",
    "supportLaunchers": ["support/keiko-support.cmd"]
  },
  "installLayout": {
    "installMode": "portable-managed",
    "bootstrapUpdateEligible": false,
    "managedRootKind": "user-local-keiko-owned",
    "sameVolumeStagingRequired": true,
    "stateRootPolicy": "separate-local-runtime-state"
  },
  "stateExclusion": {
    "excludesDotKeiko": true,
    "excludesCustomerData": true,
    "excludesSecrets": true,
    "excludesRawLogs": true,
    "excludesRepositories": true
  },
  "security": {
    "verificationPolicy": "production",
    "verificationStatus": "verified-production",
    "verificationReasonCodes": [],
    "signatureKind": "authenticode",
    "signatureVerified": true,
    "notarizationRequired": false,
    "notarizationVerified": false,
    "verificationChecks": {
      "publisherChainVerified": true,
      "timestampVerified": true
    },
    "verificationSummaryPath": "evidence/signing-verification.json"
  },
  "evidence": {
    "checksumsPath": "evidence/SHA256SUMS.txt",
    "sbomPath": "evidence/sbom.cdx.json",
    "licenseNoticePath": "evidence/third-party-notices.txt"
  },
  "releaseImpact": {
    "catalogPath": "app/release-impact.catalog.json",
    "entryId": "release-impact-entry-id",
    "entryPackageVersion": "0.2.11",
    "entryReleaseTag": "v0.2.11",
    "reviewedBinding": {
      "releaseId": 123456789,
      "releaseTag": "v0.2.11",
      "assetId": 123456789,
      "assetName": "keiko-windows-x64.zip",
      "assetSizeBytes": 12345678,
      "platformTarget": "windows-x64",
      "packageVersion": "0.2.11",
      "nodeRuntimeIdentity": "node-v24.0.0-win32-x64",
      "archiveSha256": "64-hex-artifact-digest",
      "provenanceStatementSha256": "64-hex-provenance-statement-digest",
      "sbomPath": "evidence/sbom.cdx.json",
      "licenseNoticePath": "evidence/third-party-notices.txt",
      "checksumsPath": "evidence/SHA256SUMS.txt",
      "verificationPolicy": "production",
      "verificationStatus": "verified-production",
      "verificationReasonCodes": [],
      "platformSignatureLocallyVerified": true,
      "signatureKind": "authenticode",
      "signatureVerified": true,
      "notarizationRequired": false,
      "notarizationVerified": false,
      "verificationChecks": {
        "publisherChainVerified": true,
        "timestampVerified": true
      },
      "nativeHelpers": [
        {
          "name": "keiko-secure-workspace-read",
          "kind": "secure-workspace-text-read",
          "platformTarget": "windows-x64",
          "architecture": "x64",
          "executablePath": "runtime/native/keiko-secure-workspace-read.exe",
          "protocol": {
            "schemaVersion": 1,
            "requestMagic": "KSR1",
            "responseMagic": "KSS1"
          },
          "source": {
            "commitSha": "40-hex-reviewed-release-commit",
            "path": "native/secure-workspace-read",
            "treeSha256": "64-hex-secure-read-source-tree-digest"
          },
          "unsignedSha256": "64-hex-secure-read-unsigned-digest",
          "shippedSha256": "64-hex-secure-read-shipped-digest",
          "sizeBytes": 4096,
          "sbomBomRef": "pkg:generic/keiko-secure-workspace-read@0.2.11?platform=windows-x64",
          "signing": {
            "signatureKind": "authenticode",
            "verificationStatus": "verified-production",
            "signatureVerified": true,
            "notarizationRequired": false,
            "notarizationVerified": false
          }
        },
        {
          "name": "keiko-runtime-supervisor",
          "kind": "runtime-process-supervisor",
          "platformTarget": "windows-x64",
          "architecture": "x64",
          "executablePath": "runtime/native/keiko-runtime-supervisor.exe",
          "protocol": {
            "schemaVersion": 1,
            "requestMagic": "KRP1",
            "responseMagic": "KRS1"
          },
          "source": {
            "commitSha": "40-hex-reviewed-release-commit",
            "path": "native/runtime-supervisor/windows",
            "treeSha256": "64-hex-supervisor-source-tree-digest"
          },
          "unsignedSha256": "64-hex-supervisor-unsigned-digest",
          "shippedSha256": "64-hex-supervisor-shipped-digest",
          "sizeBytes": 8192,
          "sbomBomRef": "pkg:generic/keiko-runtime-supervisor@0.2.11?platform=windows-x64",
          "signing": {
            "signatureKind": "authenticode",
            "verificationStatus": "verified-production",
            "signatureVerified": true,
            "notarizationRequired": false,
            "notarizationVerified": false
          }
        }
      ],
      "runtimeAttestation": {
        "schemaVersion": 1,
        "carrierKind": "authenticode-executable",
        "executablePath": "runtime/native/keiko-runtime-attestation.exe",
        "shippedSha256": "64-hex-runtime-attestation-digest",
        "sizeBytes": 12288,
        "signing": {
          "signatureKind": "authenticode",
          "verificationStatus": "verified-production",
          "signatureVerified": true,
          "notarizationRequired": false,
          "notarizationVerified": false
        }
      },
      "sidecarRuntimes": [
        {
          "name": "opencode-compatible",
          "kind": "coding-runtime",
          "approvalSchemaVersion": 2,
          "upstream": {
            "owner": "anomalyco",
            "repository": "opencode",
            "name": "opencode",
            "version": "1.17.17",
            "tag": "v1.17.17",
            "commit": "474abdd7ee60f4b67476cfcef7e5311beff4a824"
          },
          "adapterCompatibility": {
            "adapterName": "keiko-coding-sidecar",
            "adapterVersion": "1",
            "transport": "http-sse"
          },
          "protocolSchema": {
            "path": "packages/sdk/openapi.json",
            "url": "https://raw.githubusercontent.com/anomalyco/opencode/474abdd7ee60f4b67476cfcef7e5311beff4a824/packages/sdk/openapi.json",
            "sha256": "7db5cc3bb494b4757655110f2f285b1e70fa586fb5ae2327ffb31d4f0254c7de",
            "hashAlgorithm": "sha256",
            "hashEncoding": "lowercase-hex",
            "digestInput": "upstream-raw-bytes",
            "transport": "http-sse"
          },
          "releaseApproval": {
            "redistribution": {
              "status": "approved",
              "reviewReference": "https://github.com/oscharko-dev/Keiko/issues/2253"
            },
            "subscriptionAuth": {
              "status": "not-applicable",
              "reviewReference": "https://github.com/oscharko-dev/Keiko/issues/2253"
            }
          },
          "license": {
            "spdxId": "MIT",
            "url": "https://raw.githubusercontent.com/anomalyco/opencode/474abdd7ee60f4b67476cfcef7e5311beff4a824/LICENSE",
            "sha256": "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b"
          },
          "archive": {
            "platformTarget": "windows-x64",
            "url": "https://github.com/anomalyco/opencode/releases/download/v1.17.17/opencode-windows-x64.zip",
            "sizeBytes": 69576819,
            "sha256": "0a7fd7730a8efb00c69bce86fabcc0c24668371d821e99078a90dc78b71b4b85"
          },
          "executableTreeAlgorithm": "keiko-directory-tree-sha256-v1",
          "executableTreeSha256": "081a514d31cf00426400e26fb713273ffab91d23c110fa9bac469ad254f3336b",
          "executableSha256": "64-hex-opencode-executable-digest",
          "platformTarget": "windows-x64",
          "payloadRootPath": "runtime/sidecars/opencode-compatible",
          "executablePath": "runtime/sidecars/opencode-compatible/bin/opencode.exe",
          "payloadSha256": "64-hex-opencode-compatible-payload-digest",
          "sizeBytes": 2345678,
          "licenseEvidence": {
            "path": "runtime/sidecars/opencode-compatible/evidence/LICENSE",
            "sha256": "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b"
          },
          "sbomEvidence": {
            "path": "runtime/sidecars/opencode-compatible/evidence/sbom.cdx.json",
            "sha256": "64-hex-opencode-compatible-sbom-digest"
          },
          "signing": {
            "verificationPolicy": "production",
            "verificationStatus": "verified-production",
            "verificationReasonCodes": [],
            "signatureKind": "authenticode",
            "signatureVerified": true,
            "notarizationRequired": false,
            "notarizationVerified": false,
            "verificationChecks": {
              "publisherChainVerified": true,
              "timestampVerified": true
            },
            "shippedExecutableSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "shippedExecutableTreeAlgorithm": "keiko-directory-tree-sha256-v1",
            "shippedExecutableTreeSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          }
        }
      ]
    }
  },
  "updateEligibility": {
    "stableOnly": true,
    "rollbackSupported": false,
    "eligibleAfterSetupOnly": true,
    "requiredPredicates": {
      "managedRootAttested": true,
      "artifactShaVerified": true,
      "platformSignatureLocallyVerified": true,
      "manifestReleaseImpactBound": true,
      "sameVolumeCrashSafePromotionAvailable": true,
      "relaunchVersionVerificationAvailable": true
    },
    "manualOnlyWhen": [
      "managed-root-cannot-be-attested",
      "signature-or-notarization-cannot-be-verified",
      "crash-safe-promotion-unavailable",
      "admin-or-organization-managed-root",
      "prerelease-beta-downgrade-or-rollback"
    ]
  }
}
```

Validation rules:

- The top-level portable manifest `schemaVersion` remains `1`. Sidecar entries separately carry
  `approvalSchemaVersion: 2`; schema-v1 sidecar approval and compatibility claims are rejected.
- `nativeHelpers` is additive in schema v1. Legacy manifests without it remain parseable but expose
  no secure-read capability. Every newly staged, signed-candidate, and published artifact contains
  exactly one `keiko-secure-workspace-read` entry at the fixed target path. The entry binds target,
  architecture, `KSR1`/`KSS1`, source commit and tree, unsigned and final signed-byte digests,
  signature/notarization state, and one CycloneDX `bom-ref`; it is not a sidecar runtime.
- `artifact.platformTarget` is one of `windows-x64`, `macos-arm64`, or `macos-x64`.
- `artifact.assetName` must match the platform matrix exactly.
- `artifact.assetId` and `release.releaseId` are exactly `0` for staging and verified unpublished
  candidates. API-bound published manifests require positive values matching the remote snapshot.
- `provenance.buildWorkflowRunId` and `provenance.buildWorkflowAttempt` are the actual GitHub Actions
  run identity, independent of the zero pre-upload Release Asset identity.
- `artifact.sha256`, `runtime.nodeArchiveSha256`, and `release.commitSha` are digests, not paths.
- `provenance.sourceCommitSha`, `provenance.rootPackageTarballSha256`,
  `provenance.packagedAppTreeSha256`, and `provenance.provenanceStatementSha256` bind the packaged
  application surface to the same reviewed release artifact; gate names alone are not provenance.
- All path fields are relative to the sidecar staging root or payload resource root. Absolute paths
  are forbidden in manifests.
- `sidecarRuntimes[]` remains optional only for legacy manifest parsing. Newly produced staging,
  candidate, and published manifests require exactly one entry named `opencode-compatible` at the
  exact payload root `runtime/sidecars/opencode-compatible`.
- OpenCode entries are exact-key bound to repository `anomalyco/opencode`, version `1.17.17`, tag
  `v1.17.17`, commit `474abdd7ee60f4b67476cfcef7e5311beff4a824`, and HTTP/SSE transport.
- OpenCode protocol compatibility is the raw-byte SHA-256 of commit-addressed
  `packages/sdk/openapi.json`; `hashAlgorithm`, `hashEncoding`, and `digestInput` must be `sha256`,
  `lowercase-hex`, and `upstream-raw-bytes` respectively.
- Every included sidecar requires approved redistribution and applicable subscription-auth gates.
  Codex remains absent while either gate is unapproved; absence cannot activate a global-install or
  first-run-download fallback.
- Sidecar `license` is normalized from the schema-v2 approval and must retain its SPDX id,
  commit-addressed source URL, and SHA-256. Its digest must match `licenseEvidence.sha256`.
- Sidecar `platformTarget` must match the parent artifact target. A Windows sidecar cannot be
  carried by a macOS artifact, and macOS arm64 and macOS x64 sidecars are independently verified.
- Sidecar `executablePath`, `licenseEvidence.path`, and `sbomEvidence.path` must be contained
  relative paths under that sidecar payload root. Traversal, absolute paths, `.keiko`, customer
  repository paths, temp roots, private paths, raw logs, package-manager output, prompts, diffs,
  model output, and credentials are forbidden.
- Sidecar archive, executable-tree, executable, payload, license-evidence, SBOM-evidence, and
  protocol-schema SHA-256 values bind independently reviewed inputs to the staged bytes. Any
  mismatch fails closed before spawn or promotion.
- Sidecar signing metadata uses the same bounded verification vocabulary as the parent artifact.
  Production validation requires a verified signature plus the shipped executable fields
  `shippedExecutableSha256`, `shippedExecutableTreeAlgorithm`, and
  `shippedExecutableTreeSha256`. These fields are signed evidence for the executable bytes and
  executable tree that Keiko stages and checks before production staging or sidecar pre-spawn.
  The upstream `executableSha256`, `executableTreeAlgorithm`, and `executableTreeSha256` fields
  remain immutable provenance for the approved upstream release; shipped evidence does not replace
  or rewrite that upstream record. macOS sidecars also require Developer ID, notarization,
  stapling, and assessment proof where applicable.
- `release.stable` and `updateEligibility.stableOnly` must both be `true` for one-click portable
  update eligibility. Prerelease, beta, canary, downgrade, and rollback paths are out of scope.
- `security.verificationPolicy` is one of `staging`, `development`, `pull-request`, `evaluation`, or
  `production`; `security.verificationStatus` must match that policy and whether the target's
  signature/notarization checks are complete.
- `security.verificationReasonCodes` is a bounded, redacted enum list. It may record policy or
  failure reasons such as `staging-unverified`, `non-production-unsigned-allowed`,
  `evaluation-artifact`, `evaluation-unsigned-allowed`, or
  `macos-staple-unverified`, but it must never store certificate subjects, team ids, account ids,
  keychain names, private endpoints, or raw signing/notarization output.
- `security.verificationChecks` stores target-specific redacted booleans only:
  `publisherChainVerified` and `timestampVerified` for Windows; `developerIdVerified`,
  `notarizationVerified`, `stapleVerified`, and `assessmentVerified` for both macOS architectures.
- `updateEligibility.requiredPredicates` must all be true before the one-click portable updater may
  execute. Any missing platform signature/notarization proof or missing crash-safe same-volume
  promotion capability forces a manual-only path.
- `entrypoints.primaryLauncher` must be `Keiko.exe` for `windows-x64` and `Keiko.app` for both macOS
  targets.
- macOS targets require Developer ID signature and notarization verification. Windows requires
  Authenticode publisher-chain verification. Windows point-of-use admission additionally invokes
  the fixed system verifier with a closed environment and requires every runtime attestation carrier
  and privileged helper to have the same verified leaf signer identity as `Keiko.exe`.
- macOS point-of-use admission derives the qualified outer app's closed Developer ID TeamIdentifier
  and requires the app seal, system-extension manager, Endpoint Security extension, and secure-read
  helper to verify under that same team identity. Raw team ids remain forbidden in persisted evidence.
- The release-impact entry must bind the full reviewed ADR-0121 tuple for the same artifact:
  release id/tag, asset id/name/size, package version, runtime identity, archive digest, build
  provenance, SBOM/license/checksum evidence, platform target, signing/notarization status, and any
  included `sidecarRuntimes[]` entries.
- Whole-product crash-safe promotion is the only sidecar promotion path. Failure preserves the
  current complete install; there is no independent sidecar update, rollback, or downgrade.

## Future Child Ownership

This contract intentionally leaves implementation to the remaining portable runtime children:

- #1948 implements portable staging, Node acquisition, archive assembly, and manifest validation.
- #1949 implements thin native launchers and first-run managed setup.
- #1950 implements native app registration and reversible content-free install records.
- #1951 implements signing, notarization, checksum, provenance, and artifact verification gates.
- #1983 introduced product-owned coding sidecar payload staging and manifest validation; ADR-0163
  and #2762 make the single approved OpenCode payload mandatory for customer artifacts.
- #1952 attaches all three portable assets and reviewed evidence to GitHub Releases.
- #1953 adds portable launch/setup smoke tests and operator documentation.
- #1945 consumes the managed install and manifest contract for portable updater v2.

Any implementation that needs a different artifact name, platform target, launcher name, managed
root policy, state boundary, or evidence field must update this contract and the governing ADR
before shipping that behavior.
