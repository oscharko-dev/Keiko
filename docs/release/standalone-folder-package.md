# Standalone Folder Package

A standalone folder package is Keiko as one folder that a person unzips and starts by
double-click. Nothing is installed: no installer, no administrator rights, no Node.js on the
machine, nothing downloaded at start. It exists for workplaces where an installation involves
corporate IT ([ADR-0121 D9](../adr/ADR-0121-portable-managed-install-and-release-asset-update-authority.md#d9--a-standalone-folder-package-runs-the-same-payload-in-place)).

It is a third delivery form beside the npm package and the
[portable managed install](portable-launch-setup-guide.md). It carries the same reviewed portable
payload: no file is added, removed or changed.

| Delivery form            | Installs                                   | Updates            | For                                 |
| ------------------------ | ------------------------------------------ | ------------------ | ----------------------------------- |
| npm package              | Into a Node.js project or globally         | Package manager    | Developers                          |
| Portable managed install | Copies Keiko to its managed install folder | In-app, one click  | People who may install software     |
| Standalone folder        | Nothing                                    | Replace the folder | People who may not install anything |

Targets: `macos-arm64`, `macos-x64` and `windows-x64`
([ADR-0183](../adr/ADR-0183-linux-desktop-community-tier.md)).

## What Is In The Folder

```text
Keiko/
  Start Keiko.command | Start Keiko.cmd     start Keiko
  Stop Keiko.command  | Stop Keiko.cmd      stop Keiko
  README.txt  LIESMICH.txt                  one page for the person, English and German
  keiko.config.json                         only in an administrator's package
  system/                                   the Keiko program; not to be opened or changed
```

The start file runs the Node.js runtime inside `system` and opens Keiko in the browser. Keiko keeps
its data in `.keiko-standalone` in the person's user folder, not in this folder. Replacing the
folder with a newer package therefore keeps chats, settings and credentials.

Keiko does not write into the package folder. The qualification started the macOS package from a
read-only folder and compared the Windows folder after a session; neither changed.

## Build A Package

The builder repacks a portable release archive. It needs Node.js and a checkout of this
repository; it needs no build.

```bash
gh release download v<version> --repo oscharko-dev/Keiko \
  --pattern keiko-macos-arm64.zip --pattern macos-arm64-SHA256SUMS.txt

node scripts/build-standalone-package.mjs \
  --target macos-arm64 \
  --archive keiko-macos-arm64.zip \
  --sha256sums macos-arm64-SHA256SUMS.txt \
  --out-dir out
```

The result is `out/keiko-macos-arm64-standalone.zip` and its `.sha256`. The archive must match the
checksum the caller supplies (`--sha256sums` or `--sha256`); an unverified archive is refused. Build
the macOS package on macOS or Linux, where file permissions exist; the Windows package can be built
anywhere.

## The Nested Form

`--layout nested` builds the same package in a second form. Its folder shows the Node.js it runs
with and holds the release archive itself, which the start file unpacks on the first start:

```text
Keiko/
  node/                    the payload's own Node.js (and npm), with licence and source record
  Keiko.zip                the verified portable archive, byte for byte
  Keiko.zip.sha256         its SHA-256
  package.json             Keiko and Node.js versions; engines.node pins the runtime
  package-lock.json        pins package.json; there are no npm dependencies
  .npmrc                   offline=true, engine-strict=true; no registry, no credential
  README.md                English and German
  start.sh  stop.sh        macOS
  start.cmd stop.cmd       Windows
  keiko.config.json        only in an administrator's package
```

```bash
node scripts/build-standalone-package.mjs \
  --target windows-x64 --layout nested \
  --archive keiko-windows-x64.zip \
  --sha256sums windows-x64-SHA256SUMS.txt \
  --out-dir out
```

The result is `out/keiko-windows-x64-standalone-nested.zip` (with `--config`:
`-standalone-nested-team.zip`). `--config`, `--api-key-env` and `--keep-folder` work as for the
folder form.

On the first start, `start.sh` or `start.cmd`:

1. checks `Keiko.zip` against `Keiko.zip.sha256` with the bundled Node.js and refuses a damaged
   archive before anything is unpacked or started;
2. unpacks it with the system's own unpacker (`System32\tar.exe` on Windows, `/usr/bin/ditto` on
   macOS) into `system.partial/`, adds the checksum and renames the folder to `system/`, so `system/`
   is either complete or absent;
3. runs `node/` against `system/` with the same `keiko portable launch --in-place` as the folder
   form.

Later starts use `system/` directly. A package folder whose `Keiko.zip` was replaced by a newer one
(with its checksum) is unpacked again as a whole; stop Keiko first. `stop.sh` or `stop.cmd` runs
`keiko stop` with the bundled Node.js and says so when Keiko was never started from the folder.

What differs from the folder form:

- **The folder must be writable.** The first start creates `system/` in it, so a read-only share or
  a write-protected folder does not work. Keiko itself still writes nothing into the folder.
- **Node.js is in the package twice:** in `node/` and inside the payload. Both are the same pinned
  runtime; the server runs with the payload's own copy.
- **macOS has no double-click start.** Finder opens a `.sh` file in an editor. A person runs
  `sh start.sh` in Terminal. Use the folder form where a double-click is required.
- **npm installs nothing.** The manifests describe and pin the folder; `npm start` with the bundled
  npm runs the start file.

## Prepare A Package For A Team

An administrator can ship the gateway configuration with the package, so that nobody in the team
sees a setup dialog.

1. Start Keiko once yourself and complete **Gateway Setup** with the team's gateway address and
   API key. Keiko verifies the gateway and writes `ui/keiko.config.json` into its state directory
   (`~/.keiko-standalone` for a standalone package). That file holds the verified models and, in
   place of the key, a reference to the key Keiko sealed on your computer.
2. Build the team package with that file and the key:

   ```bash
   read -rs KEIKO_TEAM_API_KEY && export KEIKO_TEAM_API_KEY

   node scripts/build-standalone-package.mjs \
     --target windows-x64 \
     --archive keiko-windows-x64.zip \
     --sha256sums windows-x64-SHA256SUMS.txt \
     --config ~/.keiko-standalone/ui/keiko.config.json \
     --api-key-env KEIKO_TEAM_API_KEY \
     --out-dir out
   ```

   The builder replaces every sealed reference with the key from the named environment variable
   and writes `out/keiko-windows-x64-standalone-team.zip`. Every provider in the file must name
   its `modelId` and `baseUrl`: a package cannot rely on another computer's environment. A configuration that still refers to a
   key sealed on your computer is refused: on another computer that reference names nothing.

3. Put the archive on an internal file share and give the team its path.

On every start Keiko compares the `keiko.config.json` beside the start files with the one it
adopted last. A new or changed file must first load as a gateway configuration; it then replaces
the gateway configuration as a whole. On that same start Keiko seals the key into the person's own
credential vault and removes it from the adopted copy. That step is best effort: if the vault
cannot be written, the key stays in the adopted copy until a later start succeeds, and
`keiko repair` reports it. To rotate the key or change the gateway, distribute a package with the new file. A person
who has Keiko running is told to stop and start it again.

### What The Team Key Costs In Secrecy

The `keiko.config.json` in the package holds the key in plain text. Everyone who can read the file
share, or a copy of the package, can read the key. Encrypting the file would not change that: the
person is not meant to type a password, so the package would carry its own key. Protect the key
where it can be protected:

- Limit the file share to the team.
- Issue a key for this team only, with a budget and an expiry date, and replace it when someone
  leaves. A LiteLLM virtual key does this.
- Never publish a team package. Its file name ends in `-team.zip` for that reason.

## The Download Mark

macOS and Windows mark every file a browser or mail program downloads, and the built-in unzip
passes the mark to every extracted file. A marked program that carries no vendor signature is
stopped at its first start: macOS asks for an approval in System Settings that needs an
administrator, Windows shows "Windows protected your PC". Keiko carries no Apple or Microsoft
signature ([ADR-0121 D7](../adr/ADR-0121-portable-managed-install-and-release-asset-update-authority.md#d7--stable-delivery-uses-protected-platform-neutral-keiko-release-trust)),
so a marked package does not start for a person without administrator rights.

The package starts when the mark never reaches the person's copy:

- A package the builder wrote carries no mark, whatever the source archive carried.
- A copy taken from an internal file share, a USB drive or a software distribution system carries
  no mark.
- A package sent by e-mail, chat or an intranet web page is a download again and carries the mark.

If you downloaded a ready standalone archive with a browser, remove the mark from the archive
before you extract it:

```bash
xattr -d com.apple.quarantine keiko-macos-arm64-standalone.zip
```

```powershell
Unblock-File .\keiko-windows-x64-standalone.zip
```

This does not bypass the operating system's check. An organization that allows only approved
programs (AppLocker or App Control for Business on Windows, a managed allow list on macOS) blocks
an unsigned Keiko with or without the mark, and only that organization can allow it.

## What A Person Does

1. Copy the archive from the place the administrator named and extract it, for example into
   Documents.
2. Double-click `Start Keiko`. A small window shows the start; Keiko opens in the browser.
3. Double-click `Stop Keiko` to end it.

A new version arrives as a new folder: stop Keiko, delete the old folder, use the new one.

## What This Form Does Not Do

- **No in-app update.** Keiko shows "Updates managed by your organization". An install that is
  managed outside the app makes no registry or release request (pinned by
  `update-preflight.test.ts`). The start files declare the folder as managed outside the app.
- **No managed setup.** Nothing is copied to `/Applications` or `%LOCALAPPDATA%\Programs`, and
  there is no Start Menu, Spotlight or Launchpad entry. Do not start `Keiko.app` or `Keiko.exe`
  inside `system`: those are the launchers of the managed install.
- **No Coding Workbench on Windows.** Windows Coding needs the installed gateway service, which an
  administrator installs. The folder form never sets that service up: its start asks for no
  Windows approval, unlike `keiko start` of a managed install, and the Workbench offers no Repair
  (`gateway-service-managed-outside`). An administrator can install the service separately, for
  example with `keiko gateway-service install` from a managed Keiko installation; the folder form
  then uses it and never removes it. Without it, a folder package on Windows offers Chat, Knowledge
  Pods, Jira and the Editor and reports Coding as unavailable. On macOS the Coding Workbench runs with the
  evaluation runtime of an unsigned build.
- **One Keiko per computer account.** Keiko listens on loopback port 1983. A second Keiko of the
  same account, or another program on that port, makes the start end with a message that names the
  port.

## Verify A Package

```bash
shasum -a 256 -c keiko-macos-arm64-standalone.zip.sha256
unzip -p keiko-macos-arm64-standalone.zip Keiko/system/standalone.json
```

`standalone.json` names the target, the Keiko version and the name and SHA-256 of the portable
archive the package was built from. In the nested form, `package.json` (`keiko.archive`) names the
same, and `Keiko.zip` is that archive:

````bash
unzip -p keiko-windows-x64-standalone-nested.zip Keiko/package.json
``` That archive carries the GitHub Artifact Attestation described
in the [portable guide](portable-launch-setup-guide.md#verifying-a-downloaded-artifact).

## Related Documents

- [Standalone folder package troubleshooting](../troubleshooting/standalone-folder-package.md)
- [Portable Launch And Setup Guide](portable-launch-setup-guide.md)
- [Portable Runtime Artifact Contract](portable-runtime-artifact-contract.md)
- [ADR-0046](../adr/ADR-0046-local-credential-vault.md) for the custody of the provisioned key
````
