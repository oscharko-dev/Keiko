# npm Folder Package

An npm folder package is Keiko as one small folder that a person unzips and starts by
double-click, like the [standalone folder package](standalone-folder-package.md). It carries the
Node.js runtime and a pinned lockfile; Keiko itself arrives from the npm registry at the first
start, into the folder's own `node_modules`. Nothing is installed on the computer and no
administrator rights are needed. It exists for workplaces where an installation is not allowed but
an npm registry, often an internal mirror, is the approved way in
([ADR-0121 D9](../adr/ADR-0121-portable-managed-install-and-release-asset-update-authority.md#d9--a-standalone-folder-package-runs-the-same-payload-in-place)).

Choose the folder form by what the workplace allows:

| Form                      | Carries                    | First start                      | For workplaces that             |
| ------------------------- | -------------------------- | -------------------------------- | ------------------------------- |
| Standalone folder package | Node.js and Keiko (200 MB) | Starts at once                   | allow no download at start      |
| npm folder package        | Node.js and a lockfile     | Installs Keiko from the registry | reach an npm registry or mirror |

Targets: `macos-arm64`, `macos-x64` and `windows-x64`
([ADR-0183](../adr/ADR-0183-linux-desktop-community-tier.md)).

## What Is In The Folder

```text
Keiko/
  Start Keiko.command | Start Keiko.cmd     install on first start, then start Keiko
  Stop Keiko.command  | Stop Keiko.cmd      stop Keiko
  README.txt  LIESMICH.txt                  one page for the person, English and German
  package.json  package-lock.json           the exact Keiko version and every checksum
  .npmrc                                    the organization's registry (added by an administrator)
  keiko.config.json                         the gateway access (added by an administrator)
  system/node/                              Node.js and npm, the signed nodejs.org build
  system/keiko-npm.mjs                      start, stop and the administrator's access step
  system/Zugang speichern.command | .cmd    the administrator's access step
  system/npm-package.json                   target, version, source archive and lockfile digests
```

The Node.js runtime is taken from the verified portable release archive of the same Keiko version,
so it is byte for byte the runtime the folder package ships, which is the signed nodejs.org build.
The only programs that run at a double-click are the system shell and that Node.js binary, and npm
writes no download mark on what it installs.

The first start runs `npm ci --ignore-scripts` in the folder. npm installs exactly the versions in
`package-lock.json` and checks every package against its sha512 integrity; no install script runs.
The lockfile is resolved against the public registry; an `.npmrc` that names another registry
makes npm load the same packages from there (npm replaces the registry host and keeps every
checksum). Without one, npm follows the person's own npm configuration, if there is one, and
otherwise the public registry. npm's cache and its log lie in `.keiko-standalone/npm-cache` during
the installation; a successful installation removes them, a failed one keeps the log. A later start
installs again only when the lockfile changed or an earlier installation did not finish. Keiko then
runs `keiko start` with its data in `.keiko-standalone` in the person's user folder, the same data
folder as the folder package, so replacing the folder keeps chats, settings and credentials.

The start declares Keiko managed outside the app, as the folder package does, so on Windows it sets
up no gateway service and asks for no approval. Keiko offers no in-app update for a folder that npm
installed into: a new version arrives as a new folder.

## The Download Mark

A ZIP downloaded with a browser carries the operating system's download mark, and the built-in
unzip passes it on to the start files, which carry no vendor signature. The
[download mark section of the folder package](standalone-folder-package.md#the-download-mark)
applies unchanged: remove the mark from the ZIP before extracting it, or distribute the folder
through an internal share.

```bash
xattr -d com.apple.quarantine keiko-macos-arm64-npm.zip
```

```powershell
Unblock-File .\keiko-windows-x64-npm.zip
```

## What This Form Does Not Do

- **No Coding Workbench on Windows.** The Windows coding runtime is published only inside the
  portable release archive, not as an npm package, so npm installs none and the Workbench reports
  Coding as unavailable, even where an administrator installed the gateway service. Chat,
  Knowledge Pods, Jira and the Editor work. On macOS npm installs the coding runtime package for
  the computer, the same one a global npm installation uses.
- **No in-app update.** A new version arrives as a new folder.
- **One Keiko per computer account,** on loopback port 1983, as for the folder package.

## Build A Package

The builder takes the Node.js runtime and the Keiko version from a portable release archive and
resolves the lockfile against the public npm registry.

```bash
gh release download v<version> --repo oscharko-dev/Keiko \
  --pattern keiko-windows-x64.zip --pattern windows-x64-SHA256SUMS.txt

node scripts/build-standalone-npm-package.mjs \
  --target windows-x64 \
  --archive keiko-windows-x64.zip \
  --sha256sums windows-x64-SHA256SUMS.txt \
  --out-dir out
```

The result is `out/keiko-windows-x64-npm.zip` and its `.sha256`. An unverified archive is refused,
and so is a lockfile that does not install exactly that Keiko version or names a downloaded package
without a sha512 integrity from the public registry. The build sees no npm configuration of the person who
runs it. `--config` and `--api-key-env` work as for the
[folder package](standalone-folder-package.md#prepare-a-package-for-a-team) and write
`keiko-<target>-npm-team.zip`.

## Prepare A Package For A Team

An administrator can prepare the folder once, so that nobody in the team enters anything:

1. **Registry.** If the organization loads npm packages through its own registry, put its
   `.npmrc` next to `Start Keiko`. Without one, npm follows each person's own npm configuration
   and otherwise uses the public registry. The file is ordinary npm configuration; if it carries a
   registry access token, it is as confidential as `keiko.config.json`.
2. **Gateway.** Start Keiko from the folder and complete **Gateway Setup** with the team's gateway
   address and token. Keiko verifies the gateway and its models. Stop Keiko.
3. **Access for everyone.** Double-click `system/Zugang speichern.command` (macOS) or
   `system\Zugang speichern.cmd` (Windows) and paste the token; it is not shown. The step reads the
   configuration Gateway Setup saved, replaces every key sealed on this computer (the models' and
   the reranker's; Gateway Setup uses one gateway token for all of them) with the token and writes
   `keiko.config.json` next to `Start Keiko`. On macOS the file is readable by its owner only; on
   Windows it takes the permissions of the folder.
4. **Pass it on.** Delete the folder's `node_modules`, pack the folder and share it with the team.

On each person's first start, Keiko adopts `keiko.config.json` with the same mechanism as the
folder package (`keiko start --provisioned-config`): it seals the token into the person's own
credential store and keeps the file unchanged. Nobody sees a setup dialog. The file holds the token
in plain text, so [the same protection](standalone-folder-package.md#what-the-team-key-costs-in-secrecy)
applies: share the folder with the team only and use a team token with a budget and an expiry date.

## What A Person Does

1. Extract the folder, for example into Documents.
2. Double-click `Start Keiko`. The first start loads Keiko from the registry, which can take a few
   minutes; Keiko then opens in the browser.
3. Activate a model in Settings > Models, then chat.
4. Double-click `Stop Keiko` to end it.

A new version arrives as a new folder: stop Keiko, delete the old folder, use the new one.

## Verify A Package

```bash
shasum -a 256 -c keiko-windows-x64-npm.zip.sha256
unzip -p keiko-windows-x64-npm.zip Keiko/system/npm-package.json
```

`npm-package.json` names the target, the Keiko version, the portable archive the Node.js runtime
came from and the SHA-256 of the shipped lockfile.
