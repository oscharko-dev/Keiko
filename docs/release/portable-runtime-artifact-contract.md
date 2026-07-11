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

Portable v1 is an archive-first delivery path for stable public releases. The promoted user journey
is: download the platform ZIP, extract it, double-click `Keiko.exe` or `Keiko.app`, complete
first-run setup into a user-owned Keiko-managed install location, and launch Keiko afterward from
the same native app surface or OS search entry.

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

## Current Staging Status

Issue #1948 stages the packed Keiko package, acquires and verifies the target Node.js runtime
archive, extracts that runtime into the portable payload, and validates redacted artifact manifests.
Issue #1983 extends that same substrate with optional product-owned coding sidecar runtime payloads.
It does not perform production signing, macOS notarization, release upload, native launcher
implementation, first-run setup, updater swap, sidecar launch, permission bridging, or model
routing.

Manifest schema v1 has three explicit validation contexts. Staging manifests use
`verificationPolicy: "staging"`,
`verificationStatus: "unverified-staging"`, `signatureVerified: false`,
`notarizationVerified: false`, target-specific `verificationChecks` set to `false`, and
`platformSignatureLocallyVerified: false`. They also use `artifact.assetId: 0` because GitHub
Release asset ids do not exist before upload. Unverified staging and verified unpublished candidates
must use `release.releaseId: 0`, `artifact.assetId: 0`, and matching zero-id release-impact bindings;
any positive pre-upload identity is rejected. After upload, the published context requires positive
ids that exactly match the GitHub API release/asset snapshot. The manifest example below remains the
production-complete contract for artifacts that may be promoted as portable release assets.

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
        node/
          node.exe
          LICENSE
          NOTICE
          NODE_RUNTIME_SOURCE.json
        sidecars/
          opencode-compatible/
            opencode.cmd
            LICENSE.txt
            evidence/
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
          Resources/
            .portable/
              setup-manifest.json
            app/
              package.json
              dist/
              node_modules/
              release-impact.catalog.json
            runtime/
              node/
                bin/node
                LICENSE
                NOTICE
                NODE_RUNTIME_SOURCE.json
              sidecars/
                opencode-compatible/
                  bin/opencode
                  LICENSE.txt
                  evidence/
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
- `runtime/sidecars/<runtime-name>/` may contain optional product-owned coding sidecar runtime
  payloads. These payloads are inert delivery assets until a later governed runtime adapter owns
  launch authority. They are never downloaded during customer install, first run, app launch, or
  portable update outside the normal Keiko release asset download.
- `manifest/portable-manifest.json` is the sidecar artifact contract record for build, setup,
  release, and updater children.
- `.portable/setup-manifest.json` is the payload-local first-run setup manifest. It contains the
  non-self-referential subset needed by the launcher/setup path: platform target, package version,
  primary launcher name, bootstrap update ineligibility, and bundled Node runtime target. It does not
  contain archive bytes, absolute paths, customer data, credentials, or release-asset URLs.
- `evidence/` contains sidecar release artifact evidence only. It must be content-free with
  respect to customer data.

## Managed Install Layout

First-run setup promotes the bootstrap payload into a user-owned managed install root before Keiko
enters the normal app/update lifecycle.

Default managed roots:

| Platform target | Managed root                      | Native registration owned by #1950                             |
| --------------- | --------------------------------- | -------------------------------------------------------------- |
| `windows-x64`   | `%LOCALAPPDATA%\\Programs\\Keiko` | User-local Start Menu shortcut pointing to managed `Keiko.exe` |
| `macos-arm64`   | `~/Applications/Keiko.app`        | User-local app bundle registration for Spotlight/Finder launch |
| `macos-x64`     | `~/Applications/Keiko.app`        | User-local app bundle registration for Spotlight/Finder launch |

Setup may offer a simple user-selected location, but the final realpath must classify as a dedicated
Keiko-owned user-writable root. It must not be `.keiko`, a customer repository, a temporary
directory, a shared or network root, a system-managed location, or an admin-required location.

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

## Optional Product-Owned Sidecar Runtimes

Portable artifacts may carry optional product-owned coding sidecar runtimes in
`sidecarRuntimes[]`. The field is optional, and an empty array is valid, so stable releases can ship
without Coding Workbench enabled. When present, the contract is generic: it can describe one or
more Keiko-owned coding runtimes. `opencode-compatible` is the first fixture shape, not a hard-coded
single-runtime limit.

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
private paths. Execution authority for coding sidecars remains deferred to the Coding Workbench
runtime adapter work; this contract only delivers an inert verified payload.

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
      "executablePath": "runtime/sidecars/opencode-compatible/opencode.cmd",
      "payloadSha256": "64-hex-opencode-compatible-payload-digest",
      "sizeBytes": 2345678,
      "licenseEvidence": {
        "path": "runtime/sidecars/opencode-compatible/LICENSE.txt",
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
          "executablePath": "runtime/sidecars/opencode-compatible/opencode.cmd",
          "payloadSha256": "64-hex-opencode-compatible-payload-digest",
          "sizeBytes": 2345678,
          "licenseEvidence": {
            "path": "runtime/sidecars/opencode-compatible/LICENSE.txt",
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
- `sidecarRuntimes[]` is optional. When present, each entry name must be unique and must use the
  exact payload root `runtime/sidecars/<runtime-name>`.
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
- `security.verificationPolicy` is one of `staging`, `development`, `pull-request`, or
  `production`; `security.verificationStatus` must match that policy and whether the target's
  signature/notarization checks are complete.
- `security.verificationReasonCodes` is a bounded, redacted enum list. It may record policy or
  failure reasons such as `staging-unverified`, `non-production-unsigned-allowed`, or
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
  Authenticode publisher-chain verification.
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
- #1950 implements user-local app registration and reversible content-free install records.
- #1951 implements signing, notarization, checksum, provenance, and artifact verification gates.
- #1983 implements optional product-owned coding sidecar payload staging and manifest validation.
- #1952 attaches all three portable assets and reviewed evidence to GitHub Releases.
- #1953 adds portable launch/setup smoke tests and operator documentation.
- #1945 consumes the managed install and manifest contract for portable updater v2.

Any implementation that needs a different artifact name, platform target, launcher name, managed
root policy, state boundary, or evidence field must update this contract and the governing ADR
before shipping that behavior.
