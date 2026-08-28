# Resolve a Windows portable install that flashes a console and exits

| Field             | Value                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Severity          | Blocker                                                                                                                                                                                                                                          |
| Surface           | CLI                                                                                                                                                                                                                                              |
| Stable identifier | `Keiko could not start: the installation is incomplete.` / `Keiko could not start: the application bundle is damaged.` / `Keiko could not prepare its launch environment.` / `Keiko could not start its bundled runtime.` / silent console flash |

The Windows counterpart to the
[macOS portable first-launch runbook](./macos-portable-first-launch.md). Use it when the Windows
portable asset does not bring up the web UI.

**Symptom**

Double-clicking `Keiko.exe` from the extracted portable ZIP (or the setup companion) shows a
console window that opens and closes immediately, and no browser tab opens. Depending on the
installed version, either nothing else happens at all, or one of four native dialogs appears:

1. `Keiko could not start: the installation is incomplete.`
2. `Keiko could not start: the application bundle is damaged.`
3. `Keiko could not prepare its launch environment.`
4. `Keiko could not start its bundled runtime.`

A related report: the setup companion stays alive as a background process after the CLI phase is
aborted.

**Root Cause**

`Keiko.exe` is a thin native launcher built as a `/SUBSYSTEM:WINDOWS` binary that spawns the
bundled `runtime\node\node.exe` against `app\dist\cli\index.js portable launch`.

- **Versions up to 0.3.5** (the state user finding
  [#3013](https://github.com/oscharko-dev/Keiko/issues/3013) reported): the launcher spawned the
  console-mode Node child with creation flags `0`. A GUI-subsystem parent owns no console, so
  Windows allocated a fresh console window for the child — the window users saw appear. Every
  failure inside `portable launch` wrote to that console's stderr, which was destroyed the instant
  Node exited, so the message was unreadable. The failure notifier existed only on macOS at the
  time, so a Windows failure produced no dialog either. This class was tracked as
  [#3072](https://github.com/oscharko-dev/Keiko/issues/3072) and repaired by
  [#3075](https://github.com/oscharko-dev/Keiko/pull/3075) (shipped in **0.3.6**).
- **0.3.6 and later**: the launcher distinguishes a shell start from an Explorer double-click via
  `AttachConsole(ATTACH_PARENT_PROCESS)`, starts the child with `CREATE_NO_WINDOW` for a
  double-click (no window ever flashes), pre-flights the bundled runtime and CLI, pre-parses the
  CLI with `node --check`, and reports four specific bootstrap-failure classes through a native
  dialog: (1) `bootstrap_artifact_unusable()` finds `runtime\node\node.exe` or
  `app\dist\cli\index.js` missing, unreadable, or a directory wearing the artifact's name —
  "the installation is incomplete"; (2) `node --check` fails to pre-parse the CLI bundle without
  executing it — "the application bundle is damaged"; (3)
  `SetEnvironmentVariableW(L"KEIKO_PORTABLE_UI_LAUNCH", L"1")` fails, so the CLI's own failure
  notifier could never have activated anyway — "Keiko could not prepare its launch environment";
  (4) `CreateProcessW` itself fails to create the Node child — "Keiko could not start its bundled
  runtime". Dialogs 1 and 2 do mean a genuinely broken or incomplete extraction: a partial ZIP
  extraction, an antivirus quarantine of a file inside the extracted folder, or running
  `Keiko.exe` from a folder that lost sibling directories all produce exactly these states.
  Dialog 4 does not by itself prove that — `CreateProcessW` can equally fail on a corrupt PE image
  or **access denied**, so an endpoint-protection product or a policy blocking process creation
  from the extracted folder raises the identical dialog on an otherwise intact install. Other
  setup failures in the same code path — resolving the launcher's own directory, building the
  runtime/CLI paths, quoting the launch arguments, and formatting the final command line into the
  fixed-size command buffer — return with no dialog and no console line at all; they are not
  currently reported, and would surface only as the fully silent exit described above.
- **Setup companion staying alive**: `portable launch` starts the UI server detached and
  unreferenced, so the server intentionally outlives the installer that started it. That is the
  designed handoff, not a leak — the running process is Keiko itself. It is stopped with
  `keiko stop`, not by ending the installer.

**Diagnostic Steps**

```powershell
# Windows PowerShell, from the extracted portable folder.
# 1) Which version is this? Anything below 0.3.6 predates the launcher repair.
Get-Content .\app\package.json | Select-String '"version"'

# 2) Are the two bootstrap artifacts present and non-empty?
Get-Item .\runtime\node\node.exe, .\app\dist\cli\index.js | Format-List FullName, Length

# 3) Run the launcher from a terminal — a shell start keeps console semantics,
#    so the CLI's own output stays visible instead of dying with the window.
.\Keiko.exe

# 4) What did the managed install record?
Get-Content $env:USERPROFILE\.keiko\portable-install-state.json
Get-Content $env:USERPROFILE\.keiko\ui.log -Tail 200
```

If step 1 reports a version below 0.3.6, the flash-and-exit is the known launcher defect (entry 1),
regardless of what the other steps show. If step 2 shows a missing or zero-length file, the
extraction is incomplete or a file was quarantined. If step 3 prints a specific `portable launch`
error, that message is the real finding and the console flash was only hiding it.

**Resolution**

- Update to **0.3.6 or later** and re-download the release asset. The fix ships inside the staged
  artifact itself, so an already-extracted older folder stays broken.
- Extract the full ZIP with a tool that preserves the directory tree (Windows Explorer's built-in
  extractor or `tar.exe -xf`), and start `Keiko.exe` from the extracted folder. Do not run it out
  of a temporary viewer inside the archive, and do not move `Keiko.exe` away from its sibling
  `app\`, `runtime\`, and `.portable\` folders — it resolves everything relative to its own
  location.
- If an endpoint-protection product quarantined a file inside the extracted folder, **verify the
  exact file you are about to restore** — never the folder. `Keiko.exe` executes binaries out of
  that folder, so a folder-wide exception extends trust to whatever else lands there later. Which
  check applies depends on what was quarantined, because only part of the payload is individually
  signed:

  - **An executable** (`Keiko.exe`, `runtime\node\node.exe`, the `runtime\native\*.exe` helpers, a
    bundled sidecar `.exe`). Production Windows assets sign every one of these, with an Authenticode
    chain and an RFC3161 timestamp (ADR-0121), so verify that specific path and confirm the
    publisher is the expected one:

    ```powershell
    # Substitute the quarantined path. A production asset returns Status: Valid.
    Get-AuthenticodeSignature .\runtime\node\node.exe | Format-List Path, Status, SignerCertificate
    ```

  - **Anything else** (`app\dist\cli\index.js`, bundled modules, assets). These are payload files
    inside the signed archive and carry no signature of their own, so there is nothing to verify
    file-by-file. Do not restore them from quarantine — re-extract from a freshly downloaded release
    asset instead.

  If verification fails, is unavailable, or the publisher is not the expected one, do not restore or
  allow the file: download the release asset again and re-extract. Re-extracting a fresh download is
  always the safer path than restoring from quarantine. A missing or unreadable bundled file is what
  dialog 1 reports, and a truncated or unparseable CLI bundle is what dialog 2 reports.

- `Keiko could not prepare its launch environment.` (dialog 3) is not an extraction problem —
  `SetEnvironmentVariableW` failed on an otherwise-intact install. Re-run from a normal user
  session rather than a locked-down or heavily restricted process environment, and compare
  against a shell start (step 3), which does not depend on that call succeeding.
- `Keiko could not start its bundled runtime.` (dialog 4) means `CreateProcessW` failed to create
  the Node child. Reinstalling fixes it when `runtime\node\node.exe` is corrupt or incomplete, but
  the identical dialog also appears when the OS or an endpoint-protection/policy product denies
  process creation from the extracted folder — check that product's block log before assuming the
  extraction itself is broken. Any exception follows the same rule as above: verify the release
  signature, then scope it to the verified executable rather than to the folder.
- If the setup companion appears to hang after the CLI phase, check whether Keiko is already
  serving (`keiko status`). A running detached UI server is the expected outcome; stop it with
  `keiko stop` rather than by killing the installer.
- When a launch still fails, run `Keiko.exe` from PowerShell (step 3) and report that output on the
  finding. Do not replace the launcher with a hand-written shell command as the primary user path.

**Related**

- [Portable Launch And Setup Troubleshooting](./portable-launch-setup.md) — SmartScreen/Gatekeeper
  blocks, managed install-root refusals, manual-update refusals, and local port failures.
- [macOS portable first-launch runbook](./macos-portable-first-launch.md) — the same first-launch
  class on macOS.
