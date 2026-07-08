# Portable Launch And Setup Guide

Status: production user/operator guide for Issue #1953. This guide covers the archive-first
portable install and first-run setup journey delivered by #1942. Portable updater v2 is owned by
#1945 and extends this managed install baseline later in the same program branch.

## Primary User Journey

The normal user path is intentionally simple:

1. Download the Keiko ZIP for the user's platform from the public GitHub Release.
2. Extract the ZIP.
3. Open the extracted `Keiko` folder.
4. Double-click `Keiko.exe` on Windows or `Keiko.app` on macOS.
5. Choose the suggested user-owned install location unless the user has a clear reason to choose a
   different user-owned Keiko location.
6. Click `Set up Keiko`.
7. Start Keiko afterward from the same app surface, Windows search, the Start Menu entry, Finder, or
   Spotlight.

The primary path does not ask users to install Node.js, install npm, run a package manager, type
terminal commands, restart by hand, manually verify the running version, or use the browser's
`Install Keiko` / PWA shortcut action. Browser-managed PWA installation is not a product install
path for portable delivery; see
[ADR-0116](../adr/ADR-0116-portable-first-browser-install-suppression.md).

## Platform Artifacts

Every stable portable release that advertises portable delivery must provide exactly three
first-class artifacts:

| Platform target | Download asset          | Primary launcher |
| --------------- | ----------------------- | ---------------- |
| `windows-x64`   | `keiko-windows-x64.zip` | `Keiko.exe`      |
| `macos-arm64`   | `keiko-macos-arm64.zip` | `Keiko.app`      |
| `macos-x64`     | `keiko-macos-x64.zip`   | `Keiko.app`      |

macOS arm64 and macOS x64 have the same release-blocking importance. A release is not
portable-complete when either macOS architecture is missing, unsigned, unnotarized where required,
or not covered by the same launch/setup verification.

## Managed Setup

The first launch is a bootstrap launch. It validates the payload, copies Keiko into a stable
user-owned managed install root, creates user-local app registration, and records a content-free
install attestation under the local Keiko state root.

Default managed roots:

| Platform target | Default managed root              | User-visible registration                     |
| --------------- | --------------------------------- | --------------------------------------------- |
| `windows-x64`   | `%LOCALAPPDATA%\\Programs\\Keiko` | Windows search and Start Menu entry for Keiko |
| `macos-arm64`   | `~/Applications/Keiko.app`        | Finder and Spotlight launch for the Keiko app |
| `macos-x64`     | `~/Applications/Keiko.app`        | Finder and Spotlight launch for the Keiko app |

The managed install root is separate from `.keiko` runtime state. Runtime state stores local app
state, evidence, and content-free install/update registration; it does not store the portable
payload, customer repositories, credentials, prompts, model output, or raw logs.

Setup must refuse roots that are temporary directories, customer repositories, `.keiko` state
directories, shared/network roots, symlinked paths, machine-wide locations, or locations that need
administrator rights by default.

## Update Journey

Portable updater v2 is integrated on the portable product delivery program branch and remains
subject to final program QA before the `dev` PR. The portable-managed update path uses the existing
in-app update notice and update window with one explicit user action. After that action, download,
verification, staging, activation, relaunch, version verification, and required release-impact
remediation handling are managed in-product without asking the user to perform technical update
steps.

The npm/Yarn updater remains a developer and compatibility path, not the promoted product journey
for ordinary portable users.

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
that relaunch uses the managed app root, validates the native launcher source uses bundled Node, and
checks this documentation remains shell-free on the primary user path.

When a real portable stage exists, operators can also validate the target directories:

```bash
npm run smoke:portable-launch-setup -- --stage-root .portable-runtime/staging --evidence .portable-runtime/staging/portable-launch-setup-smoke.json
```

Generated smoke evidence is a local release artifact. It must not be committed to Git.

## Related Documents

- [Portable Runtime Artifact Contract](portable-runtime-artifact-contract.md)
- [Release / Publish Workflow](release-publish-workflow.md)
- [Portable updater v2 QA matrix](../qa/portable-updater-v2-qa-matrix.md)
- [Portable product delivery v2 integrated QA](../qa/portable-product-delivery-v2-integrated-qa.md)
- [Portable launch/setup troubleshooting](../troubleshooting/portable-launch-setup.md)
- [Local runtime state contract](../local-runtime-state-contract.md)
