# Portable Runtime Artifact Contract

Status: Contract baseline for Issue #1947 and staging baseline for Issue #1948. This document
defines the release artifact shape that later portable delivery children must implement and verify.
It does not publish assets or change updater execution logic.

Governing decisions:

- [ADR-0113: Portable managed install and release-asset update authority](../adr/ADR-0113-portable-managed-install-and-release-asset-update-authority.md)
- [ADR-0021: Publish Strategy - Bundled Monorepo Product](../adr/ADR-0021-publish-strategy-bundled-monorepo-product.md)
- [ADR-0099: Governed in-app updates and release-impact contract](../adr/ADR-0099-governed-in-app-updates-and-release-impact-contract.md)
- [Local runtime state contract](../local-runtime-state-contract.md)
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
archive, extracts that runtime into the portable payload, and validates redacted sidecar manifests.
It does not perform production signing, macOS notarization, release upload, native launcher
implementation, first-run setup, or updater swap.

Generated #1948 staging manifests therefore use `signatureVerified: false`,
`notarizationVerified: false`, and `platformSignatureLocallyVerified: false` under an explicit
unverified-staging validation mode. They also use `artifact.assetId: 0` because GitHub Release
asset ids do not exist until #1952 uploads the artifacts. Those artifacts are manual-only staging
outputs until #1951 replaces the metadata with verified signing/notarization evidence and #1952
binds real GitHub Release asset ids. The manifest example below remains the production-complete
contract for artifacts that may be promoted as portable release assets.

## Archive And Evidence Layout

Portable staging produces a target directory containing the final ZIP asset, a payload tree for
layout inspection, and sidecar manifest/evidence records. The sidecars bind the ZIP bytes by hash
and size; they are sidecars rather than in-archive records so `artifact.sha256` can describe the
actual release asset without a self-referential manifest checksum.

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
    "signatureKind": "authenticode",
    "signatureVerified": true,
    "notarizationRequired": false,
    "notarizationVerified": false,
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
      "signatureKind": "authenticode",
      "signatureVerified": true,
      "notarizationRequired": false,
      "notarizationVerified": false
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

- `schemaVersion` is `1` until a later issue deliberately revises the schema.
- `artifact.platformTarget` is one of `windows-x64`, `macos-arm64`, or `macos-x64`.
- `artifact.assetName` must match the platform matrix exactly.
- `artifact.assetId` must be a real non-zero GitHub Release asset id for production manifests.
  `0` is reserved for #1948 unverified staging manifests only.
- `artifact.sha256`, `runtime.nodeArchiveSha256`, and `release.commitSha` are digests, not paths.
- `provenance.sourceCommitSha`, `provenance.rootPackageTarballSha256`,
  `provenance.packagedAppTreeSha256`, and `provenance.provenanceStatementSha256` bind the packaged
  application surface to the same reviewed release artifact; gate names alone are not provenance.
- All path fields are relative to the sidecar staging root or payload resource root. Absolute paths
  are forbidden in manifests.
- `release.stable` and `updateEligibility.stableOnly` must both be `true` for one-click portable
  update eligibility. Prerelease, beta, canary, downgrade, and rollback paths are out of scope.
- `updateEligibility.requiredPredicates` must all be true before the one-click portable updater may
  execute. Any missing platform signature/notarization proof or missing crash-safe same-volume
  promotion capability forces a manual-only path.
- `entrypoints.primaryLauncher` must be `Keiko.exe` for `windows-x64` and `Keiko.app` for both macOS
  targets.
- macOS targets require Developer ID signature and notarization verification. Windows requires
  Authenticode publisher-chain verification.
- The release-impact entry must bind the full reviewed ADR-0113 tuple for the same artifact:
  release id/tag, asset id/name/size, package version, runtime identity, archive digest, build
  provenance, SBOM/license/checksum evidence, platform target, and signing/notarization status.

## Future Child Ownership

This contract intentionally leaves implementation to the remaining portable runtime children:

- #1948 implements portable staging, Node acquisition, archive assembly, and manifest validation.
- #1949 implements thin native launchers and first-run managed setup.
- #1950 implements user-local app registration and reversible content-free install records.
- #1951 implements signing, notarization, checksum, provenance, and artifact verification gates.
- #1952 attaches all three portable assets and reviewed evidence to GitHub Releases.
- #1953 adds portable launch/setup smoke tests and operator documentation.
- #1945 consumes the managed install and manifest contract for portable updater v2.

Any implementation that needs a different artifact name, platform target, launcher name, managed
root policy, state boundary, or evidence field must update this contract and the governing ADR
before shipping that behavior.
