# Portable Launch And Setup Guide

This guide covers archive-first portable installation and managed setup. Production-signed and
evaluation downloads have different trust guarantees. The updater reliability repair and its native
qualification are tracked by #3403/#3405; a setup smoke or parser test is not proof of a production
built-in update.

## Primary User Journey

The normal user path is intentionally simple:

1. On Windows, download and open `keiko-windows-x64-setup.exe`. On macOS, download the Keiko ZIP
   for the user's architecture from the public GitHub Release.
2. On macOS, extract the ZIP and open the extracted `Keiko` folder.
3. Double-click `Keiko.app` on macOS. The Windows setup companion installs and launches the same
   reviewed portable ZIP automatically.
4. On macOS, approve the one-time Administrator, System Extension, and Full Disk Access dialogs when
   macOS presents them; organization-managed Macs may have these permissions preapproved by MDM.
5. Keiko continues automatically after the required approval and opens its local UI.
6. Start Keiko afterward from the same app surface, Windows search, the Start Menu entry, Finder, or
   Spotlight.

The primary path does not ask users to install Node.js, install npm, run a package manager, type
terminal commands, restart by hand, manually verify the running version, or use the browser's
`Install Keiko` / PWA shortcut action. Browser-managed PWA installation is not a product install
path for portable delivery; see
[ADR-0122](../adr/ADR-0122-portable-first-browser-install-suppression.md).

## Platform Artifacts

Every stable portable release that advertises portable delivery must provide exactly three
first-class artifacts:

| Platform target | Download asset          | Primary launcher |
| --------------- | ----------------------- | ---------------- |
| `windows-x64`   | `keiko-windows-x64.zip` | `Keiko.exe`      |
| `macos-arm64`   | `keiko-macos-arm64.zip` | `Keiko.app`      |
| `macos-x64`     | `keiko-macos-x64.zip`   | `Keiko.app`      |

The release also provides `keiko-windows-x64-setup.exe` as the companion install surface for
the Windows ZIP. It is signed for production releases and unsigned for the explicitly labeled
evaluation program. Users who need the archive-first fallback may still download, extract, and open
`keiko-windows-x64.zip`; both paths delegate managed installation to the same attested portable
lifecycle. Reopening setup validates and launches an existing managed installation without
replacing it. Governed in-app update remains the upgrade path.

macOS arm64 and macOS x64 have the same release-blocking importance. A release is not
portable-complete when either macOS architecture is missing, unsigned, unnotarized where required,
or not covered by the same launch/setup verification.

### Verifying a downloaded artifact

Production release archives and their SBOMs (`<platform-target>-sbom.cdx.json`, also published as
release assets) require GitHub Artifact Attestations in addition to platform code signatures.
Evaluation downloads do not inherit those production guarantees. An
operator can verify a downloaded file independently of Keiko's own release tooling with the
[GitHub CLI](https://cli.github.com/):

```console
gh attestation verify keiko-windows-x64.zip --repo oscharko-dev/Keiko
gh attestation verify keiko-windows-x64-setup.exe --repo oscharko-dev/Keiko
gh attestation verify windows-x64-sbom.cdx.json --repo oscharko-dev/Keiko
```

A successful verification proves the file was built by the recorded `portable-assets` workflow run
at the recorded commit, without needing to trust anything other than GitHub's Sigstore-backed
attestation service. This is independent of, and in addition to, the Authenticode/notarization
signature required for production qualification (see [ADR-0121](../adr/ADR-0121-portable-managed-install-and-release-asset-update-authority.md#d8--release-archives-and-sboms-carry-independently-verifiable-github-artifact-attestations)).
Attestation verification is optional; it is not part of the managed setup journey below.

## Managed Setup

The first launch is a bootstrap launch. It validates the payload, copies Keiko into a stable
target-specific managed install root, creates native app registration, and records a content-free
install attestation under the local Keiko state root.

See [Managed Install Layout](portable-runtime-artifact-contract.md#managed-install-layout) in the
Portable Runtime Artifact Contract for the canonical per-platform managed root table.

The managed install root is separate from `.keiko` runtime state. Runtime state stores local app
state, evidence, and content-free install/update registration; it does not store the portable
payload, customer repositories, credentials, prompts, model output, or raw logs.

Setup must refuse roots that are temporary directories, customer repositories, `.keiko` state
directories, shared/network roots, symlinked paths, or noncanonical machine-wide locations. The
sole macOS exception is `/Applications/Keiko.app`; macOS may request administrator, System
Extension, and Full Disk Access approval once, or MDM may preapprove them.
The canonical `/Applications` parent and every checked app component must remain root-owned,
non-symlinked, and not group- or world-writable. A host policy that weakens those ownership or
write boundaries makes activation fail closed; MDM must preserve or restore the canonical
boundary instead of relocating the app to a writable parent.

## Update Journey

The portable-managed update path uses the existing in-app notice and Update window. One-click
execution is offered only for a fresh eligible candidate on an attested managed installation and
requires explicit confirmation. Download, verification, staging, ownership transfer, activation,
relaunch, target-version proof, and required remediation belong to the same governed attempt.
An expected local-server disconnect is not success: the window must retain safe progress and
reconnect, and success requires verified target startup. Follow the displayed recovery or manual
action if the installation cannot establish that proof; do not clear update state or delete the
managed tree to force another attempt.

Evaluation builds, including 0.3.17, are intentionally manual-only. Their signatures cannot establish
production publisher continuity. The first production transition therefore requires a manual install
using the target release's reviewed instructions, not the Update button. Preserve `.keiko` runtime
state. Do not alter signing metadata, disable platform trust checks, or treat a skipped signing job
as qualification. A production one-click claim additionally requires genuine N−1→N canary results
between two production-signed eligible releases on all three targets; #2198 tracks the external
signing prerequisites. Until those results exist, availability of a newer download is not evidence
that an evaluation installation can update itself.

The npm/Yarn updater remains a developer and compatibility path, not the promoted product journey
for ordinary portable users.

If a user manually downloads a newer portable ZIP and opens that newer `Keiko.exe` or `Keiko.app`
while an older managed Keiko install is already present, the launcher treats it as a safe manual
update fallback. Keiko validates that the clicked package is a stable newer version, stops the
current local Keiko server, keeps an internal previous-install snapshot while swapping the managed
install, relaunches the managed app, and opens Keiko again in the browser. Older, equal, beta, or
malformed packages do not replace the managed install. The browser window itself is not forcibly
closed; it may reconnect or be reopened after relaunch.

## Browser Install Prompt

Keiko's browser tab may still use normal favicon, title, theme-color, and static shell cache
metadata. It must not promote a separate browser-managed `Install Keiko` action for ordinary
portable users. Browser PWA shortcuts do not install the bundled Keiko payload, do not create the
managed install root, and do not participate in portable updater v2.

## Operator Verification

Operators can run the deterministic launch/setup smoke after package build:

```bash
npm run smoke:portable-launch-setup
```

The smoke creates disposable fixtures for `windows-x64`, `macos-arm64`, and `macos-x64`, launches
through the portable setup seam with `PATH` stripped, verifies managed setup registration, verifies
that relaunch uses the managed app root, verifies the manually re-downloaded newer package fallback
stops the old server and swaps to the new managed package for all three targets, validates the
native launcher source uses bundled Node, and checks this documentation remains shell-free on the
primary user path.

When a real portable stage exists, operators can also validate the target directories:

```bash
npm run smoke:portable-launch-setup -- --stage-root .portable-runtime/staging --evidence .portable-runtime/staging/portable-launch-setup-smoke.json
```

Generated smoke evidence is a local release artifact. It must not be committed to Git.

The fixture smoke above proves its named setup/launch seams only. It does not prove installed
production-signed N−1→N mutation, native process-tree containment, a real BFF outage/reconnect, or
recovery after every activation crash boundary. Record those results separately on #3405 with exact
artifact digests and target-native run evidence; do not promote fixture output to a production
qualification claim.

## Related Documents

- [Portable Runtime Artifact Contract](portable-runtime-artifact-contract.md)
- [Release / Publish Workflow](release-publish-workflow.md)
- [Portable updater v2 QA matrix](../qa/portable-updater-v2-qa-matrix.md)
- [Portable product delivery v2 integrated QA](../qa/portable-product-delivery-v2-integrated-qa.md)
- [Portable launch/setup troubleshooting](../troubleshooting/portable-launch-setup.md)
- [Local runtime state contract](../local-runtime-state-contract.md)
