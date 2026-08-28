# Resolve a Windows portable install that flashes a console and exits

| Field             | Value                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity          | Blocker                                                                                                                                                                                      |
| Surface           | CLI                                                                                                                                                                                          |
| Stable identifier | `Keiko could not start: the installation is incomplete.` / `Keiko could not start: the application bundle is damaged.` / `Keiko could not start its bundled runtime.` / silent console flash |

The Windows counterpart to the
[macOS portable first-launch runbook](./macos-portable-first-launch.md). Use it when the Windows
portable asset does not bring up the web UI.

**Symptom**

Double-clicking `Keiko.exe` from the extracted portable ZIP (or the setup companion) shows a
console window that opens and closes immediately, and no browser tab opens. Depending on the
installed version, either nothing else happens at all, or one of three native dialogs appears:

1. `Keiko could not start: the installation is incomplete.`
2. `Keiko could not start: the application bundle is damaged.`
3. `Keiko could not start its bundled runtime.`

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
  CLI with `node --check`, and reports every bootstrap failure through a native dialog. The three
  dialogs above therefore mean a genuinely broken or incomplete extraction, not the launcher
  defect: (1) `runtime\node\node.exe` or `app\dist\cli\index.js` is missing or unreadable, (2) the
  bundled CLI is truncated or otherwise unparseable, (3) the child process could not be created.
  A partial ZIP extraction, an antivirus quarantine of a file inside the extracted folder, and
  running `Keiko.exe` from a folder that lost sibling directories all produce exactly these states.
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
- If an endpoint-protection product quarantined a file inside the extracted folder, restore it or
  allowlist the folder, then re-run the launcher. A missing bundled file is what dialogs 1 and 2
  report.
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
