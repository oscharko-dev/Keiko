# Portable Launch And Setup Troubleshooting

Use this entry for failures in the archive-first portable launch and first-run managed setup path.
It is intentionally honest about operating-system and organization controls: bundled Node removes
the system Node/npm requirement, but it cannot bypass local security policy.

## Portable download or launcher is blocked by the operating system

| Field             | Value                                                  |
| ----------------- | ------------------------------------------------------ |
| Severity          | Blocker                                                |
| Surface           | Portable launch/setup                                  |
| Stable identifier | `portable launcher blocked by operating-system policy` |

**Symptom**

The user opens the Windows setup companion, or extracts the correct portable ZIP and opens
`Keiko`, `Keiko.exe`, or `Keiko.app`, but Keiko does not start. Windows SmartScreen or Defender may
show a prompt. macOS may show a Gatekeeper, quarantine, signing, notarization, or "damaged app"
prompt.

**Root Cause**

Portable artifacts are downloaded executable software. Linux execution and mount policy can block
them. Windows SmartScreen, Defender, AppLocker, or WDAC can do the same, as can macOS Gatekeeper,
quarantine attributes, missing signing evidence, missing notarization, or organization-managed
allowlists. This does not mean Keiko requires system Node/npm; it means the operating system or
organization policy blocked execution of the bundled launcher.

**Diagnostic Steps**

Primary user remediation should use the operating-system prompt or organization software catalog.
Support operators can confirm artifact integrity and signing evidence from the release asset
manifest and smoke evidence:

```bash
npm run smoke:portable-launch-setup -- --stage-root .portable-runtime/staging
npm run portable:verify-signing -- --manifest .portable-runtime/staging/macos-arm64/manifest/portable-manifest.json --policy production
```

For Windows policy blocks, ask the organization IT owner whether AppLocker, WDAC, Defender, or
SmartScreen reputation is blocking the downloaded `Keiko.exe`. For macOS policy blocks, ask whether
Gatekeeper, quarantine, or organization-managed notarization policy is blocking `Keiko.app`.

**Resolution**

- Use signed Windows artifacts and signed/notarized macOS artifacts for production releases.
- Use only the Sigstore-qualified `linux-x64` artifact on Linux and preserve its executable modes
  while extracting it.
- Keep the ZIP artifact, manifest, checksums, signing evidence, and release notes together.
- If an organization blocks public GitHub downloads, distribute the same reviewed release assets
  through an organization-approved mirror or software portal.
- Do not tell users to disable SmartScreen, Gatekeeper, notarization, TLS verification, or
  organization policy as the normal fix.

---

## Linux managed coding runtime reports confinement unavailable

| Field             | Value                                                   |
| ----------------- | ------------------------------------------------------- |
| Severity          | Blocker                                                 |
| Surface           | Linux managed coding runtime                            |
| Stable identifier | `runtime confinement unavailable on supported platform` |

**Symptom**

The Linux application and local UI start, but a governed long-lived coding runtime is refused before
its sidecar starts. The activity log records `runtime.confinement.unavailable` or
`runtime.confinement.failed` with redacted policy, artifact, and authority digests.

**Root Cause**

The production Linux runtime requires the `unshare` utility and a functioning unprivileged user and
network namespace implementation. A distribution may omit `util-linux`, disable unprivileged user
namespaces, or apply an organization security profile that denies the namespace operation. Keiko
tests the actual kernel boundary and fails closed; loopback-only filtering or direct sidecar egress
is not an accepted fallback.

**Diagnostic Steps**

- Confirm that the installed release is the `linux-x64` artifact and that its GitHub artifact
  attestation is valid.
- Inspect `<stateDir>/logs/server.log` for the correlation-linked, body-free
  `runtime.confinement.*` event and its stable reason code.
- Ask the Linux or organization administrator whether unprivileged user/network namespaces and the
  distribution's `unshare` package are available to ordinary user processes.

**Resolution**

- Install the distribution-provided `util-linux` package if `unshare` is absent.
- Restore the distribution-supported unprivileged user-namespace policy or use an approved managed
  host where it is enabled.
- Do not run Keiko as root, grant `CAP_NET_ADMIN`, disable host security controls, or bypass the
  requested confinement.

---

## Portable setup cannot create the managed install root

| Field             | Value                                      |
| ----------------- | ------------------------------------------ |
| Severity          | Blocker                                    |
| Surface           | Portable launch/setup                      |
| Stable identifier | `portable setup: managed install root ...` |

**Symptom**

The first launch opens, but setup fails before Keiko becomes available from Windows search, the Start
Menu, Finder, or Spotlight. The setup record may report `setup-failed`, and remediation may say that
the selected location is not allowed or cannot be attested.

**Root Cause**

Keiko only promotes portable payloads into an attested target-specific managed install root.
Windows uses its user-local root; macOS uses exactly `/Applications/Keiko.app` under the reviewed
ownership and permission checks. Setup fails closed for `.keiko`, customer repositories, temporary
or shared/network locations, symlinks, unattested organization-managed roots, other machine-wide
locations, or insufficient permissions. This preserves update safety and keeps runtime state
separate from the product payload.

**Diagnostic Steps**

Support operators can inspect the content-free status record and repair result:

```bash
keiko portable status --target windows-x64 --portable-root <extracted-keiko-folder> --managed-root <managed-root> --state-dir <state-root>
keiko repair --state-dir <state-root>
```

A `managed` status establishes installation state, not candidate eligibility. One-click execution
additionally requires current preflight, production signing continuity, and all other update gates.
Evaluation artifacts remain manual-only even when setup succeeds. A `setup-failed` record must not
be interpreted as permission to mutate a previously attested installation.

**Resolution**

- Use the target's default managed location: `%LOCALAPPDATA%\Programs\Keiko` on Windows or exactly
  `/Applications/Keiko.app` on macOS. Do not relocate the macOS app to bypass its approved root.
- Keep customer repositories, `.keiko`, temporary folders, and shared/network folders separate.
- If organization policy blocks the required location or approvals, ask the IT owner to resolve the
  policy through its existing software process. Do not weaken ownership checks or imply that Keiko
  provides an enterprise rollout feature.

---

## Manually downloaded portable update does not replace the current install

| Field             | Value                                                |
| ----------------- | ---------------------------------------------------- |
| Severity          | High                                                 |
| Surface           | Portable launch/setup, portable update fallback      |
| Stable identifier | `portable manual update fallback refused activation` |

**Symptom**

The user downloads a newer portable ZIP and opens its `Keiko`, `Keiko.exe`, or `Keiko.app`, but the
managed install remains on the previous version or Keiko reopens the previous version.

**Root Cause**

Current evaluation releases require reviewed manual installation, and the repaired native coordinator
still refuses update acceptance pending qualification. The automatic fallback described below is the
qualified release contract, not evidence that a current release can replace an installation this way.

The manual re-download fallback only replaces an already-attested managed install when the clicked
package is valid, stable, newer than the managed install, and the current local Keiko server can be
stopped before the file swap. It refuses older, equal, beta, malformed, wrong-platform, or
unattested packages. If the swap cannot finish safely, Keiko restores the previous managed install
from its internal previous-install snapshot and relaunches the previous app where possible.

**Diagnostic Steps**

Support operators should check the content-free portable install state and update logs, then verify
that the clicked artifact is the correct platform target and newer stable release. If the local UI
could not stop, inspect the existing local UI port and process state with the standard local UI
troubleshooting entries.

**Resolution**

- Prefer the in-app update button only when current preflight offers an eligible candidate.
- Evaluation-to-production transition is manual-only; follow the target release's reviewed manual
  installation instructions while preserving `.keiko` state. Do not relabel evaluation signatures.
- If using the manual re-download fallback, use the newer stable ZIP for the same platform target.
- Close stuck Keiko processes only through the normal OS application controls or organization
  support process; do not ask non-technical users to perform terminal cleanup.
- If organization policy prevents process stop or file replacement, use an organization-approved
  software distribution path when that later rollout epic exists.

---

## Windows update leaves `Keiko.exe` missing next to a `.keiko-previous-*` folder

| Field             | Value                                                                 |
| ----------------- | --------------------------------------------------------------------- |
| Severity          | Blocker                                                               |
| Surface           | Portable install, in-app auto-update                                  |
| Stable identifier | `portable Windows atomic rename EPERM/EBUSY during managed-root swap` |

**Symptom**

After a Windows install, upgrade, or in-app update, `Keiko.exe` is missing from the managed root
and a sibling folder named `.keiko-previous-*` is present. The previous version may still be
inside that sibling. First-run setup may also fail with a rename error even though the payload
extracted cleanly.

**Root Cause**

Windows rename can fail with `EPERM` or `EBUSY` when a file has an incompatible open handle or
executable-image mapping. A scanner, indexer, or preview may cause transient contention, but the
updater's own loaded `node.exe` is a different case: changing the working directory and retrying
does not unmap it. The reviewed repair transfers durable ownership to a verified native coordinator
outside the install tree, then proves old-process exit before promotion. Missing handoff proof must
fail closed. A rename retry is not proof of process termination, and copy+delete is not a safe
replacement for the atomic promotion contract.

**Diagnostic Steps**

- Confirm a `.keiko-previous-*` sibling exists next to the managed root (typically under
  `%LOCALAPPDATA%\Programs\`).
- Check `<stateDir>/logs/server.log` for `security.fs.atomic-rename-retried` or
  `security.fs.atomic-rename-failed` (`extra.attempts` and `errorKind` only; no paths).
- See also [Windows portable first-launch](./windows-portable-first-launch.md) when Defender
  quarantined extracted files rather than locking them during the swap.

**Resolution**

- Preserve the managed, staged, and previous trees and the update state until recovery ownership is
  settled. A remaining previous tree is not permission to rename it over a running target.
- Follow the displayed recovery/manual action or the release's reviewed reinstall instructions.
  There is no `keiko portable repair` subcommand. Do not invent a repair command, delete lock/WAL
  files, or ask users to rename installation folders as the normal fix.
- Retry only after the current attempt is terminal and preflight offers a new eligible attempt.
  If recovery remains required, collect canonical evidence and escalate through support.
- Do not disable antivirus or create broad directory exclusions. An IT owner can investigate the
  actual policy event without weakening the updater's trust checks.

---

## Update reconnects without a verified result

**Symptom**

The Update window disconnects during relaunch, reconnects with recovery required, or does not report
the intended target version as verified.

**Root Cause**

An expected BFF outage is not a terminal outcome. Startup must reconcile the durable session and
activation receipts and prove the exact target process, launch identity, port, and verified tree.
Wrong/stale version, failed launch, persistence failure, and incomplete cleanup are not success.

**Diagnostic Steps**

Support operators should reconstruct the attempt from the canonical activity log:

```bash
keiko support analyze <state-root>/logs/server.log
```

Use explicit candidate/session and parent-correlation links to follow the attempt across relaunch.
Missing evidence is a diagnostic gap, not permission to infer success from matching versions or
nearby timestamps. Do not upload private handoff plans, runtime state, certificates, or raw command
output as evidence.

**Resolution**

Allow the bounded reconnect to finish and follow the displayed action. Do not clear browser state,
delete recovery files, kill an unrelated port owner, or force another update to manufacture a clean
status. Once the target is verified, cleanup recovery must retain it rather than restore N−1. A
persisting recovery result requires support review of the bounded activity timeline.

---

## Keiko starts but the browser cannot reach the local app

| Field             | Value                               |
| ----------------- | ----------------------------------- |
| Severity          | High                                |
| Surface           | Portable launch/setup, local UI     |
| Stable identifier | `local port unavailable or blocked` |

**Symptom**

The managed launcher starts, but the browser does not open Keiko or the health check never becomes
available. Existing troubleshooting may show that the local loopback port is occupied or blocked.

**Root Cause**

Keiko still runs a local Node/BFF/browser product internally. The bundled Node runtime removes the
system Node/npm requirement, but Keiko still needs a local loopback port, local filesystem
permissions for the selected project and state directory, and network/proxy access for configured
model providers or release downloads. Firewalls, endpoint protection, proxy policy, or another
process using the local port can prevent the local UI from becoming reachable.

**Diagnostic Steps**

Use the existing local UI entries for port and health failures:

```bash
keiko status
tail -n 200 .keiko/ui.log
```

If `.keiko/ui.log` reports `EADDRINUSE`, follow the port-conflict entry in
[Troubleshooting Guide](README.md#2-port-is-already-in-use). If release downloads fail later,
confirm whether a proxy or firewall blocks GitHub Release Asset downloads.

**Resolution**

- Free the occupied local port or start Keiko on an allowed local port.
- Keep loopback traffic allowed for the Keiko process.
- If a proxy or firewall blocks public GitHub Release Assets, use an approved organization mirror
  for the same reviewed artifacts.
- Do not replace the portable launcher with shell startup commands as the primary user path.

## Windows setup companion reports a failure and closes

| Field             | Value                                          |
| ----------------- | ---------------------------------------------- |
| Severity          | Blocker                                        |
| Surface           | Portable launch/setup, Windows setup companion |
| Stable identifier | `windows setup companion step failed`          |

**Symptom**

`keiko-windows-x64-setup.exe` prints a numbered step (`[1/6] … [6/6] …`), then the specific failure
reason for that step and a `Keiko setup failed. See the message above.` line, before the window
closes (on a double-click the window stays open at `Press any key to close this window.` so the
reason is readable). Keiko does not end up running.

**Root Cause**

The setup companion is a Keiko-owned native bootstrap (ADR-0121, issue #2992): it verifies the
embedded portable archive against a digest baked into the signed binary, extracts it to a temporary
folder with `System32\tar.exe`, and then drives the same governed portable lifecycle
(`resolve-root` → `setup` → `launch`) the manual ZIP uses. Each numbered step maps to one failure
class, and each maps to a stable process exit code for scripted (`/quiet`) installs:

| Message                                                                     | Exit    | Cause                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `The setup package is damaged. Download keiko-windows-x64-setup.exe again.` | 11 / 12 | The running installer's own bytes could not be parsed, or the embedded archive's SHA-256 did not match the digest baked into the signed installer — a truncated download or a tampered/relinked file. |
| `Keiko setup could not create its temporary staging folder.`                | 13      | `%TEMP%` is unwritable, full, or redirected.                                                                                                                                                          |
| `Keiko setup could not unpack the embedded package.`                        | 14      | `System32\tar.exe` failed (missing on very old Windows builds, or blocked by policy).                                                                                                                 |
| `Keiko setup payload did not contain the expected application files.`       | 15      | The extracted tree is incomplete — usually an interrupted extraction or an endpoint-protection product removing files mid-unpack.                                                                     |
| `Keiko setup could not resolve the managed install root.`                   | 16      | The portable CLI could not determine a managed install location (see "cannot create the managed install root" above).                                                                                 |
| `Keiko setup could not complete the governed installation.`                 | 17      | The governed `portable setup` step failed; the CLI printed the specific reason above this line.                                                                                                       |
| `Keiko started but did not report healthy.`                                 | 18      | The app launched but its health check did not pass in the allotted window — a blocked loopback port or a runtime that exits early.                                                                    |
| `Keiko is running, but its temporary files could not be removed.`           | 19      | The install succeeded; only the temporary staging folder under `%TEMP%\Keiko-install-*` could not be deleted (a lingering antivirus handle). Keiko is usable.                                         |
| `Keiko setup: unsupported argument …`                                       | 87      | An argument other than `/quiet` (or `/Q`) was passed. The installer accepts no install-command override by design; run it with no arguments, or `/quiet` for an unattended install.                   |

**Diagnostic Steps**

```powershell
# 1) Run the installer from a terminal so the failure line stays visible, and capture the exit code.
.\keiko-windows-x64-setup.exe
"exit code: $LASTEXITCODE"

# 2) Unattended (scripted) install — same steps, no pauses; the exit code is the failure class above.
.\keiko-windows-x64-setup.exe /quiet
"exit code: $LASTEXITCODE"

# 3) If it reported the package is damaged (11/12), byte-verify the download before retrying.
Get-FileHash .\keiko-windows-x64-setup.exe -Algorithm SHA256
```

**Resolution**

- **11 / 12 (damaged package):** re-download `keiko-windows-x64-setup.exe` from the release and
  compare its SHA-256 to the release notes before running it. Do not attempt to "repair" the file.
- **13 / 14 / 15 (staging, extraction, contents):** confirm `%TEMP%` is writable and has space,
  then check the endpoint-protection block log for a file removed under `%TEMP%\Keiko-install-*`
  during the install, and add the reviewed installer to that product's allowlist before retrying.
- **16 / 17 (resolve-root, setup):** the governed CLI printed the specific cause above the failure
  line — follow it, or see "Portable setup cannot create the managed install root" above.
- **18 (unhealthy):** confirm loopback traffic is allowed for the Keiko process and the local port
  is free, then re-run; the fallback is the manual ZIP started from `Keiko.exe`.
- **19 (cleanup):** Keiko is installed and running; remove the leftover `%TEMP%\Keiko-install-*`
  folder manually once any antivirus scan on it has finished.
- **87 (unsupported argument):** run the installer with no arguments, or `/quiet` for an unattended
  install. The setup companion deliberately exposes no way to substitute the install command.
