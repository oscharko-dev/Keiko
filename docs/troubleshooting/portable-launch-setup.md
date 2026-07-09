# Portable Launch And Setup Troubleshooting

Use this entry for failures in the archive-first portable launch and first-run managed setup path.
It is intentionally honest about operating-system and organization controls: bundled Node removes
the system Node/npm requirement, but it cannot bypass local security policy.

## Portable download or launcher is blocked by the operating system

| Field             | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| Severity          | Blocker                                                                |
| Surface           | Portable launch/setup                                                  |
| Stable identifier | `portable launcher blocked by Windows SmartScreen or macOS Gatekeeper` |

**Symptom**

The user downloads and extracts the correct portable ZIP, but `Keiko.exe` or `Keiko.app` does not
start. Windows may show a Windows SmartScreen or Defender prompt. macOS may show a Gatekeeper,
quarantine, signing, notarization, or "damaged app" prompt.

**Root Cause**

Portable artifacts are downloaded executable software. Windows SmartScreen, Defender, AppLocker,
WDAC, macOS Gatekeeper, quarantine attributes, missing signing evidence, missing notarization, or
organization-managed allowlists can block downloaded applications before Keiko code runs. This does
not mean Keiko requires system Node/npm; it means the operating system or organization policy
blocked execution of the bundled launcher.

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
- Keep the ZIP artifact, manifest, checksums, signing evidence, and release notes together.
- If an organization blocks public GitHub downloads, distribute the same reviewed release assets
  through an organization-approved mirror or software portal.
- Do not tell users to disable SmartScreen, Gatekeeper, notarization, TLS verification, or
  organization policy as the normal fix.

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

Keiko only promotes portable payloads into a dedicated user-owned managed install root. Setup fails
closed when the selected path is inside `.keiko`, a customer repository, a temporary directory, a
shared/network location, a symlinked path, an organization-managed root, a machine-wide location, or
a location where the current user lacks permissions. This preserves update safety and keeps runtime
state separate from the product payload.

**Diagnostic Steps**

Support operators can inspect the content-free status record and repair result:

```bash
keiko portable status --target windows-x64 --portable-root <extracted-keiko-folder> --managed-root <managed-root> --state-dir <state-root>
keiko repair --state-dir <state-root>
```

The status is expected to be `managed` and `updateEligible: true` only after setup succeeds into an
attested managed root. A `setup-failed` status indicates setup did not mutate an update-eligible
install.

**Resolution**

- Ask the user to choose the default user-owned Keiko location unless there is a clear reason to
  choose a custom user-owned folder.
- Choose a location outside customer repositories, `.keiko`, temporary folders, shared/network
  folders, and machine-wide application folders.
- If the workstation is organization-managed and user-writable application folders are blocked, the
  portable v1 self-managed path is not eligible; use an organization-approved deployment path when
  that later epic exists.

---

## Manually downloaded portable update does not replace the current install

| Field             | Value                                                |
| ----------------- | ---------------------------------------------------- |
| Severity          | High                                                 |
| Surface           | Portable launch/setup, portable update fallback      |
| Stable identifier | `portable manual update fallback refused activation` |

**Symptom**

The user downloads a newer portable ZIP and opens its `Keiko.exe` or `Keiko.app`, but the managed
install remains on the previous version or Keiko reopens the previous version.

**Root Cause**

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

- Prefer the in-app update button for ordinary users.
- If using the manual re-download fallback, use the newer stable ZIP for the same platform target.
- Close stuck Keiko processes only through the normal OS application controls or organization
  support process; do not ask non-technical users to perform terminal cleanup.
- If organization policy prevents process stop or file replacement, use an organization-approved
  software distribution path when that later rollout epic exists.

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
