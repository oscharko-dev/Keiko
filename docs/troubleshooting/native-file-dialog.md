# Native OS File/Folder Dialog Runbook

Operator guidance for the native Browse dialogs introduced by Epic #1941 (ADR-0118). The local
Node BFF opens the platform picker (`POST /api/native-file-dialog/open`) and validates every
returned path through the Files policy before the UI sees it. Manual path entry stays available
on every surface that had it, including the Quality Intelligence source path.

All entries follow the [troubleshooting entry template](./_template.md).

---

## Browse button is disabled and the UI says native dialogs are unavailable

| Field             | Value                                                             |
| ----------------- | ----------------------------------------------------------------- |
| Severity          | Low                                                               |
| Surface           | Local UI                                                          |
| Stable identifier | `NATIVE_DIALOG_UNSUPPORTED` / capability `{ "supported": false }` |

**Symptom**

Browse buttons render disabled with the note "Native dialogs are unavailable on this platform.
Enter the path manually."

**Root Cause**

`GET /api/native-file-dialog/capability` reports the BFF host platform. Native adapters exist for
macOS (`darwin`) and Windows (`win32`) only; Linux and other platforms are unsupported in this
delivery wave. The capability reflects the SERVER platform — running the browser on a supported
OS against a BFF on an unsupported one does not enable the dialog, because the BFF is the process
that opens it.

**Diagnostic Steps**

1. `curl -s http://127.0.0.1:1983/api/native-file-dialog/capability` — expect
   `{ "supported": true }` on macOS/Windows hosts.
2. Confirm the BFF host OS (`node -p "process.platform"` on the machine running Keiko).

**Resolution**

Type the absolute path into the input next to the Browse button. On unsupported platforms this is
the intended fallback; a portal-based Linux adapter can enable the capability in a later wave
without UI changes.

---

## Selection succeeds but Keiko cannot read the selected location afterwards (macOS)

| Field             | Value                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------- |
| Severity          | Medium                                                                                  |
| Surface           | Local UI / Workspace                                                                    |
| Stable identifier | Post-selection read errors (e.g. `DENIED`, `INVALID_DIRECTORY`) after a successful pick |

**Symptom**

The Finder dialog opens, the user picks a folder or file, the field fills correctly — but a later
read (indexing, Files window, agent start) fails.

**Root Cause**

macOS privacy protection (TCC) grants are per parent process. The dialog itself is a user
interaction and always works, but reading protected locations (Desktop, Documents, Downloads,
network volumes) afterwards requires the terminal/process that launched Keiko to hold the
corresponding Files-and-Folders permission. This is a platform permission limitation, not a
picker failure. Separately, Keiko's own deny-list intentionally refuses credential locations
(`~/.ssh`, `~/.aws`, …) with `NATIVE_DIALOG_INVALID_SELECTION` at selection time.

**Diagnostic Steps**

1. Reproduce the read failure and note the error code (`DENIED` is Keiko policy;
   permission-shaped read failures on Desktop/Documents/Downloads point to TCC).
2. Check System Settings → Privacy & Security → Files and Folders for the terminal or app that
   launched Keiko.

**Resolution**

Grant the launching terminal/process access to the affected location (or Full Disk Access for
broad workflows), then retry. Keiko deny-list refusals are working as intended and have no
override.

---

## Dialog never appears, or the request fails on Windows

| Field             | Value                                            |
| ----------------- | ------------------------------------------------ |
| Severity          | Medium                                           |
| Surface           | Local UI                                         |
| Stable identifier | `NATIVE_DIALOG_TIMEOUT` / `NATIVE_DIALOG_FAILED` |

**Symptom**

Browse shows no dialog; after a while the UI reports "The native dialog timed out and was
closed." (`NATIVE_DIALOG_TIMEOUT`, 504) or immediately "The native dialog could not be opened."
(`NATIVE_DIALOG_FAILED`, 502).

**Root Cause**

Windows dialogs require an interactive desktop session. Headless services, non-interactive remote
shells, or scheduled-task contexts cannot display one — the helper process then idles until the
10-minute interaction budget kills it (timeout) or exits non-zero (failed). The dialog can also
open BEHIND other windows; the helper uses an invisible top-most owner to bring it forward, but
some focus-stealing-prevention setups still demand a taskbar click. The BFF records a
content-free operator diagnostic (source `native-file-dialog`, exit code and byte counts only)
keyed by the response correlation id.

**Diagnostic Steps**

1. Confirm Keiko runs in an interactive desktop session (not a service, not `ssh` without a
   desktop).
2. Check the taskbar for a PowerShell/dialog window that opened in the background.
3. Correlate the UI error's correlation id with the operator diagnostic record.

**Resolution**

Run Keiko from an interactive desktop session, or type the path manually. If the dialog opens in
the background, click it on the taskbar; the selection then proceeds normally. A second Browse
click while a dialog is open answers `409 NATIVE_DIALOG_ALREADY_OPEN` — close the existing dialog
first.
