# Resolve a standalone folder package that does not start or asks for setup

| Field             | Value                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity          | Blocker                                                                                                                                                                                            |
| Surface           | CLI                                                                                                                                                                                                |
| Stable identifier | `Keiko could not start.` / `Keiko is incomplete: files are missing in the folder "system".` / `keiko portable launch: portable setup manifest is unavailable` / `cli.lifecycle.provisioned-config` |

The standalone folder package is described in the
[Standalone Folder Package](../release/standalone-folder-package.md) guide. This page covers a
folder that does not start, starts without the team's configuration, or shows the wrong update
notice.

**Symptom**

One of these, after a double-click on `Start Keiko`:

1. macOS reports that the file "cannot be opened" or "cannot be verified", or Windows shows
   "Windows protected your PC". No Keiko window appears. Started from a terminal on macOS, the
   start file prints nothing and does not end: macOS holds the folder's Node.js runtime before it
   runs.
2. The start window prints `Keiko is incomplete: files are missing in the folder "system".` or
   `keiko portable launch: portable setup manifest is unavailable`, then
   `Keiko could not start.`
3. The start window prints that the port is already in use, then `Keiko could not start.`
4. Keiko opens but asks for a gateway address and an API token, although the administrator shipped
   a configuration.
5. Keiko opens and a chat fails with an error about a missing API key.
6. Keiko shows "Portable setup required" instead of "Updates managed by your organization".
7. After a new package, Keiko still uses the old gateway or key.
8. On macOS the start window prints `keiko portable launch: macOS runtime activation is
incomplete`, then `Keiko could not start.`

**Root Cause**

1. The copy carries the download mark of a browser, mail or chat program. macOS with Gatekeeper
   on, as it ships, and Windows stop an unsigned program that carries it, and Keiko has no Apple or
   Microsoft signature (ADR-0121 D7). An organization's application control can produce the same
   block without any mark.
2. The folder is not complete: the archive was extracted only in part, files were moved out of
   `system`, or an endpoint-protection product removed one. The in-place launch validates the
   payload before it starts anything (ADR-0121 D9).
3. Another Keiko of the same computer account, or another program, already listens on loopback
   port 1983.
4. There is no `keiko.config.json` beside the start files, or it was not adopted. Every start
   records the decision as `cli.lifecycle.provisioned-config` with one closed outcome: `adopted`,
   `unchanged`, `deferred-running`, `overridden`, `absent`, `invalid`, `too-large`, `refused-link`,
   `read-failed`, `write-failed` or `marker-failed`.
5. The shipped configuration still holds a reference to a key that was sealed on the
   administrator's own computer (`apiKeySecretRef`) instead of the key. The builder refuses such a
   file; a package assembled by hand can carry it.
6. Keiko was started through `Keiko.app` or `Keiko.exe` inside `system`, or through `keiko start`
   without the in-place launch. Only `keiko portable launch --in-place` declares the folder as
   managed outside the app.
7. Keiko was running when the new package was started. A running Keiko holds its configuration in
   memory, so the new file is adopted at the next start (`deferred-running`).
8. The payload carries an Apple platform signature. A signed payload's runtime monitor must sit in
   the root-owned application location, which a folder in the user's home can never be, so the
   in-place launch is refused (ADR-0121 D9). The folder form is for the unsigned payload.

**Diagnostic Steps**

```bash
# macOS. 1) Does the copy carry the download mark?
xattr -r "<path-to>/Keiko" | grep -c com.apple.quarantine

# 2) Is the folder complete, and what does the launch say? Run the start file in a terminal.
sh "<path-to>/Keiko/Start Keiko.command"

# 3) What did the last starts record about the provisioned configuration?
RES="<path-to>/Keiko/system/Keiko/Keiko.app/Contents/Resources"
"$RES/runtime/node/bin/node" "$RES/app/dist/cli/index.js" support export --state-dir ~/.keiko-standalone
```

```powershell
# Windows. 1) Does the copy carry the download mark?
Get-Item "<path-to>\Keiko\Start Keiko.cmd" -Stream Zone.Identifier -ErrorAction SilentlyContinue

# 2) Run the start file in a terminal to keep its messages.
& "<path-to>\Keiko\Start Keiko.cmd"

# 3) Export the support report.
$K = "<path-to>\Keiko\system\Keiko"
& "$K\runtime\node\node.exe" "$K\app\dist\cli\index.js" support export --state-dir "$env:USERPROFILE\.keiko-standalone"
```

Read the report with `support analyze`: the `cli.lifecycle.provisioned-config` line names the
outcome, and `update.install-mode.detected` names `portable-it-managed` for a folder that was
started in place.

**Resolution**

1. Take the folder again from the place the administrator named: a copy from a file share carries
   no mark. Whoever downloaded the archive with a browser removes the mark from the archive before
   extracting it (`xattr -d com.apple.quarantine <archive>` on macOS, `Unblock-File <archive>` on
   Windows), or builds the package with `scripts/build-standalone-package.mjs`, whose output
   carries none; see [The Download Mark](../release/standalone-folder-package.md#the-download-mark).
   If the organization's application control blocks Keiko, only that organization can allow it.
   Do not disable Gatekeeper or SmartScreen.
2. Delete the folder and extract the whole archive again. Start Keiko from the extracted folder
   and leave `system` as it is.
3. Stop the other Keiko with its own `Stop Keiko`, or end the other program, and start again.
4. `absent`: the package has no configuration; ask the administrator for the team package.
   `invalid`, `too-large`, `refused-link`, `read-failed`: the file in the package is not usable;
   the administrator rebuilds the package. `overridden`: `KEIKO_CONFIG_FILE` or
   `KEIKO_UI_DATA_DIR` is set for this account, and that location wins. `write-failed`: start
   again; if it stays, check that the user folder is writable, and delete
   `ui/provisioned-config.sha256` in the state directory, which makes the next start adopt the
   file again. `marker-failed`: the configuration is in use; Keiko only could not note that it
   adopted it and adopts it again at the next start.
5. The administrator rebuilds the package with `--config` and `--api-key-env`.
6. Stop Keiko and start it with `Start Keiko`.
7. Stop Keiko and start it again.
8. Use the unsigned standalone package, or install the signed build through the
   [portable managed install](../release/portable-launch-setup-guide.md).
