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

## Which File Do I Need

Download the ZIP for your computer from the GitHub prerelease
`npm-folder-<version>` (`https://github.com/oscharko-dev/Keiko/releases/tag/npm-folder-<version>`).

| Computer             | File                        |
| -------------------- | --------------------------- |
| macOS, Apple silicon | `keiko-macos-arm64.npm.zip` |
| macOS, Intel         | `keiko-macos-x64.npm.zip`   |
| Windows x64          | `keiko-windows-x64.npm.zip` |

Each ZIP has a `.sha256` file beside it. See [Download From GitHub](#download-from-github) for the
commands that download and verify it.

The standalone folder packages (`keiko-<target>.standalone.zip`) are not here. They are assets of
the product release `v<version>`; see the
[standalone folder package guide](standalone-folder-package.md#download-from-a-release).

## The Download Mark

A ZIP downloaded with a browser carries the operating system's download mark, and the built-in
unzip passes it on to the start files, which carry no vendor signature. The
[download mark section of the folder package](standalone-folder-package.md#the-download-mark)
applies unchanged: remove the mark from the ZIP before extracting it, or distribute the folder
through an internal share.

```bash
xattr -d com.apple.quarantine keiko-macos-arm64.npm.zip
```

```powershell
Unblock-File .\keiko-windows-x64.npm.zip
```

## What A Person Does

1. Download the ZIP for your computer, see [Which File Do I Need](#which-file-do-i-need).
2. Remove the download mark, see [The Download Mark](#the-download-mark).
3. Extract the folder, for example into Documents.
4. Double-click `Start Keiko`. The first start loads Keiko from the registry, which can take a few
   minutes; Keiko then opens in the browser.
5. Activate a model in Settings > Models, then chat.
6. Double-click `Stop Keiko` to end it.

A new version arrives as a new folder: stop Keiko, delete the old folder, use the new one.

## Prepare A Package For A Team

An administrator can prepare the folder once, so that nobody in the team enters anything.

1. **Registry.**
   - If the organization loads npm packages through its own registry, put its `.npmrc` next to
     `Start Keiko`.
   - Without one, npm follows each person's own npm configuration and otherwise uses the public
     registry.
   - The file is ordinary npm configuration. If it carries a registry access token, it is as
     confidential as `keiko.config.json`.
2. **Gateway.**
   - Start Keiko from the folder and complete **Gateway Setup** with the team's gateway address and
     token. Keiko verifies the gateway and its models.
   - Stop Keiko.
   - A configuration an earlier Keiko saved does not mark its models, so complete Gateway Setup once
     more before step 3.
3. **Access for everyone.**
   - Double-click `system/Zugang speichern.command` (macOS) or `system\Zugang speichern.cmd`
     (Windows) and paste the token. It is not shown.
   - The step reads the configuration Gateway Setup saved. It replaces the keys sealed on this
     computer for the gateway connection Gateway Setup verified with the token. That connection is
     the models Gateway Setup set up, and the voice provider and the reranker it wired on that
     connection, each marked `"credentialOrigin": "gateway-connection"`.
   - A voice provider whose key was rotated alone has no mark, however its capability reads, and is
     refused like a reranker with its own key.
   - A model or reranker whose key is sealed and that has its own address, header or key is not that
     connection. The step refuses before it asks for the token and names it, so one token never goes
     to another service.
   - A key written into the file as `apiKey` stays as it is, so write that connection's own key into
     the file instead.
   - The step also refuses a model without an id or an address.
   - It also refuses a key Keiko takes from an environment variable of the administrator's computer
     (`KEIKO_MODEL_<ID>_API_KEY`, `KEIKO_RERANKER_API_KEY`, `KEIKO_DEFAULT_API_KEY`), which Gateway
     Setup keeps out of the file. Unset the variable, enter the key in Gateway Setup and run the
     step again.
   - The step writes `keiko.config.json` next to `Start Keiko` as one complete file, replacing an
     older one only when the new one is written. It is readable by its owner only.
   - On Windows the step removes the permissions the folder hands down and grants the file to the
     account that runs it alone (`icacls` from Windows' System32) before the token is written, and
     writes no token when that fails.
   - It refuses to run while `KEIKO_CONFIG_FILE` or `KEIKO_UI_DATA_DIR` names another configuration,
     because the file would not be the one Keiko starts with.
4. **Pass it on.** Delete the folder's `node_modules`, pack the folder and share it with the team.

On each person's first start, Keiko adopts `keiko.config.json` with the same mechanism as the
folder package (`keiko start --provisioned-config`): it seals the token into the person's own
credential store and keeps the file unchanged. Nobody sees a setup dialog. The file holds the token
in plain text, so [the same protection](standalone-folder-package.md#what-the-team-key-costs-in-secrecy)
applies: share the folder with the team only and use a team token with a budget and an expiry date.

## Download From GitHub

After a product release is published and npm reports its version, a release owner runs the
`npm folder packages` workflow (`.github/workflows/npm-folder-publish.yml`) on `dev` with the
version.

- It qualifies each package on its own platform, on native hardware: `macos-15` for `macos-arm64`,
  `macos-15-intel` for `macos-x64`, `windows-2025` for `windows-x64`.
- Only when all three pass, it publishes the exact ZIPs that were tested as the GitHub
  **prerelease** `npm-folder-<version>`.
- The tag `npm-folder-<version>` points at the commit of the product release `v<version>`.
- The prerelease is never marked latest.

| Asset                       | What it is                                                  |
| --------------------------- | ----------------------------------------------------------- |
| `keiko-macos-arm64.npm.zip` | the npm folder package for Apple silicon, and its `.sha256` |
| `keiko-macos-x64.npm.zip`   | the npm folder package for Intel Macs, and its `.sha256`    |
| `keiko-windows-x64.npm.zip` | the npm folder package for Windows x64, and its `.sha256`   |

The release notes name the version and, for each target, the runner it was tested on, the checks
that passed and the digests. Download one package, verify it, remove the download mark and extract
it:

```bash
gh release download npm-folder-<version> --repo oscharko-dev/Keiko \
  --pattern keiko-macos-arm64.npm.zip --pattern keiko-macos-arm64.npm.zip.sha256
shasum -a 256 -c keiko-macos-arm64.npm.zip.sha256
gh attestation verify keiko-macos-arm64.npm.zip --repo oscharko-dev/Keiko
xattr -d com.apple.quarantine keiko-macos-arm64.npm.zip
```

```powershell
gh release download npm-folder-<version> --repo oscharko-dev/Keiko --pattern keiko-windows-x64.npm.zip --pattern keiko-windows-x64.npm.zip.sha256
(Get-FileHash .\keiko-windows-x64.npm.zip -Algorithm SHA256).Hash.ToLower()   # compare with the .sha256 file
gh attestation verify .\keiko-windows-x64.npm.zip --repo oscharko-dev/Keiko
Unblock-File .\keiko-windows-x64.npm.zip
```

About the companion prerelease:

- It is a transport for the tested ZIPs. It is not the product release and grants no update trust:
  an installed Keiko reads only the product release for updates, and an npm folder package never
  offers an in-app update.
- The build provenance attestation is made before the release exists, so a publication that fails
  afterwards can leave an attestation for ZIPs that were never released. That is harmless: nothing
  points a person at them, and the next run attests and publishes the ZIPs it tested.
- If the final check after publication cannot read or confirm the release, the prerelease is
  already public and nothing was removed, because a published release is immutable.
- A release is immutable once published, so a version that already has its prerelease is refused.
- The same qualification runs on a pull request that changes the builder, `scripts/standalone/**`,
  the script or the workflow, but only when the root package version is already published on npm
  and its product release `v<version>` exists. Otherwise the run ends green with a notice.

## What This Form Does Not Do

- **No default project.** The package folder holds Keiko's program files and, in a team package, the
  gateway token, so Keiko never offers it as the folder of the Coding Workbench, Files or Git and
  refuses it for them; the person chooses a folder. Chat works at once and needs no folder.
  `keiko.config.json`, `.npmrc`, the sealed `*.vault` stores and the data folder `.keiko-standalone`
  stay unreadable for the model even inside a chosen folder.
- **No in-app update.** A new version arrives as a new folder.
- **One Keiko per computer account,** on loopback port 1983, as for the folder package.
- **No asset of the product release.** A product release carries the
  [standalone folder packages](standalone-folder-package.md#download-from-a-release), not this
  one. Its lockfile needs the integrity the npm registry reports for the released version. npm
  learns that version only after the release publisher has published the immutable GitHub
  release, so this package is built from the published release. The tested ZIPs are available from
  a companion prerelease, see [Download From GitHub](#download-from-github).

## How It Works

This part is reference material for operators and developers. A person who only wants to start Keiko
does not need it.

### What Is In The Folder

```text
Keiko/
  Start Keiko.command | Start Keiko.cmd     install on first start, then start Keiko
  Stop Keiko.command  | Stop Keiko.cmd      stop Keiko
  README.txt  LIESMICH.txt                  one page for the person, English and German
  package.json  package-lock.json           the exact Keiko version and every checksum
  .npmrc                                    the organization's registry (added by an administrator)
  keiko.config.json                         the gateway access (added by an administrator)
  system/node/                              Node.js and npm, the signed nodejs.org build
  system/native/usearch.node                the Knowledge Pod search index, from the release archive
  system/keiko-npm.mjs                      start, stop and the administrator's access step
  system/Zugang speichern.command | .cmd    the administrator's access step
  system/npm-package.json                   target, version, source archive and lockfile digests
```

- The Node.js runtime and the native search index of Knowledge Pods are taken from the verified
  portable release archive of the same Keiko version.
- Every file the folder keeps is byte for byte the archive's, and the Node.js runtime is the signed
  nodejs.org build.
- The folder leaves out what neither Node.js nor npm runs, because `npm ci --ignore-scripts`
  compiles nothing:
  - the C headers (`system/node/include`)
  - the manuals and documentation (`system/node/share`)
  - the release's CHANGELOG.md and README.md
- It keeps `bin`, `lib` with npm and corepack (on Windows `node.exe`, `npm*`, `npx*` and
  `node_modules`), LICENSE, NOTICE and NODE_RUNTIME_SOURCE.json.
- That is about 11.6 MB of the 61 MB Node.js runtime of a macOS package, packed. The standalone
  folder package ships the payload unchanged and keeps all of it.
- Keiko finds the search index next to that runtime, as it does in the portable payload, so
  Knowledge Pods search with their index.
- The only programs that run at a double-click are the system shell and that Node.js binary, and
  npm writes no download mark on what it installs.

### First-start installation

The first start runs `npm ci --ignore-scripts` with the folder as its `--prefix` and
`--workspaces=false`.

- npm installs into this folder even when it lies inside another npm project or workspace, and
  never changes that project.
- npm installs exactly the versions in `package-lock.json` and checks every package against its
  sha512 integrity. No install script runs.
- The command line also fixes what an inherited `npm_config_*` variable or npm configuration could
  change:
  - no dry run
  - no lockfile-only run
  - no global installation
  - the hoisted layout
  - every production, optional and peer package (an inherited `omit=optional` would leave out the
    Coding runtime)
- Before npm runs, the start refuses:
  - an `npm-shrinkwrap.json` in the folder, which npm would install instead of `package-lock.json`
  - a `node_modules` that is a link, a junction, a file or another account's folder, because
    `npm ci` first empties `node_modules` and would empty the folder a link points to
- After npm ends successfully, the start checks that every package the lockfile names for this
  computer is installed in its version.
  - If one is missing, it records nothing as installed, names the package and keeps Keiko closed,
    so the next start installs again.
  - An optional package with `engines` npm may leave out for this Node.js is not counted, except
    the Coding runtime.
  - Only the packages npm installs here are counted: those the folder's package reaches through
    packages meant for this computer. So an optional package of another computer and the packages
    only it needs, nested or hoisted, are not counted.

### Registry and `.npmrc` rules

The lockfile is resolved against the public registry.

- The folder's `.npmrc` may name one other registry with a single `registry=` line.
  - npm then loads the same packages from there. It replaces the registry host and keeps every
    checksum.
  - A `registry` inherited from an `npm_config_*` variable cannot override it.
  - The line may be quoted and may use `${NAME}` for an environment variable, as npm allows.
- Refused before npm runs:
  - a scoped `@scope:registry` line, or `registry` named twice, because it would send packages of
    that scope elsewhere
  - every line npm would ignore and answer with the public registry:
    - another spelling such as `REGISTRY=`
    - a list (`registry[]=`)
    - a `registry` inside a `[section]`
    - an address that is no http or https URL
- Without an `.npmrc`, npm follows the person's own npm configuration, if there is one, and
  otherwise the public registry.

### npm cache, logs and data folder

- Each installation gets its own npm cache, `.keiko-standalone/npm-cache-<random>`, which is removed
  when it ends. An npm cache that already exists there is never touched.
- npm's log lies in `.keiko-standalone/npm-logs`, and a failed installation names its log.
  - An `npm-logs` that is a link, a file or another account's folder is refused before npm writes.
  - One that the start of another package folder sharing the data folder made a moment before is
    used.
- Both are set on npm's command line so that no `npm_config_*` variable moves them.
- Keiko's data folder is `.keiko-standalone` in the person's user folder, the same data folder as
  the folder package, so replacing the folder keeps chats, settings and credentials.
- A `KEIKO_STATE_DIR` outside the user folder is refused before anything is written.

### Start and stop at the same time

Every start keeps the folder's installation lock (`system/keiko-npm-install.lock`) until Keiko is
open, also one that installs nothing. Each start and stop says how it ended. The rules below decide
who may install, open and stop Keiko when several starts and stops overlap.

#### The lock and its renewal

- Whether a lock is still held is told by renewal, never by a clock. Every holder rewrites its own
  entry every 15 seconds:
  - the start's process, from a worker thread, also while it waits for npm, its `owner-` entry
  - npm's process only its own `npm-` entry
- npm never rewrites the start's entry; it only checks that it is still there. So a start whose
  window was closed stops changing its entry whatever npm does.
- A renewal rewrites the entry's timestamp in place and never empties it, so a failed renewal keeps
  the last valid timestamp.
- npm's own process holds the lock as well while it installs, with its own entry. A start window
  closed during an installation leaves the lock to that npm until it ends; no second npm installs
  beside it.
- npm runs only as part of the lock generation of the start that ran it. Before it does anything,
  npm's process ends with the reason when:
  - the lock is gone
  - the start's entry is not in it
  - another start's lock replaced it
- A running npm ends at once, without writing further, when it finds its own entry or the start's
  gone at a renewal check. Only a takeover of a frozen holder can cause that.

#### Taking over a lock

- A start that finds a lock none of whose entries has a running process number takes it over at
  once.
- If an entry's process number runs, the start watches the lock's entries for up to 60 seconds on
  its own monotonic clock:
  - Any entry that changes means the lock is held. The start then says another start is opening
    Keiko, after up to one renewal interval.
  - None that changes means the holder ended and its process number was reused by another process,
    or the holder is frozen. The lock is taken over.
- No timestamp in a file and no wall-clock jump (a computer that slept, a corrected clock) decides
  this.
- The one remaining limit: a holder that is frozen for longer than that minute and then resumes can
  overlap with the start that took over for at most one renewal interval. The first renewal of the
  resumed npm finds its entry gone and ends it.
- A start whose lock was taken over while it closed it carries out no Stop request, confirmed or
  provisional, and ends with a plain message.
- A start that finds its lock taken over by another start ends with a plain message before it
  writes the installed marker or starts Keiko.

#### What a second start does

- While the first start is still installing or opening Keiko, a second start starts no second
  installation. It says that another start is opening Keiko and that its window says whether Keiko
  opened.
- If the lock is held but its start does not renew (its window was closed during the installation
  and only npm still runs), no window reports that installation and nothing can open Keiko. The
  second start says so and:
  - waits up to 10 minutes for that npm to end
  - takes the lock, then installs and opens Keiko as a normal start
  - if that npm is still running after the 10 minutes, ends with exit code 1 and asks to start
    Keiko again in a minute
- A lock that starts closing during that wait is waited for like any closing lock.
- A start that watches an orphaned installation checks, once the renewal is seen, that the renewing
  start is still in the lock and has not closed it. Otherwise it waits for the closing lock like
  any other.
- A start pressed while a Stop holds the closed lock waits for that Stop (up to 90 seconds) and then
  opens Keiko, so the button pressed last decides.
  - When that lock is still closing after the 90 seconds, nothing opens Keiko for the start. It
    ends with exit code 1 and says that Keiko is still being closed and to start again, never that
    another window opens it.

#### How Stop is recorded

- `Stop Keiko` meanwhile is recorded in the lock. The start then does not open Keiko, or stops it
  again right after it opened, also when Keiko reported a failure as it opened.
- The start carries the Stop out before it lets go of the lock, so no other start opens Keiko in
  between.
- A Stop is recorded only in the lock of a start that began before it was pressed, and a start
  carries out only Stops pressed after it began.
- A Stop is recorded only in a lock whose start's own entry runs and renews. If the start ended
  while its npm still runs, the Stop is not recorded and stops Keiko directly.
- Every stop is carried out while the one who runs it owns the lock.
- Before the start lets go of the lock it closes it:
  - A `Stop Keiko` that the lock accepted is carried out first.
  - One that comes after the lock closed is not recorded. It waits until that start has let go,
    takes the lock itself, closes it and only then stops the open Keiko. So no start opens Keiko
    between its decision and its effect, and it can never stop the Keiko a later start opened. If
    the lock stays held for 90 seconds it says so and does not act.
- A lock a Stop takes is born closed (its closing entry arrives in the same rename), so a start
  that watches it never takes that Stop for a start that opens Keiko.
- If a start that began before the Stop was pressed wins the lock first, the Stop is recorded in
  that start's lock. That start, which does not leave Keiko open, carries it out; the Stop does not
  act itself.
- A start that began after the press is left to open Keiko.
- A start that held the lock at the press and finishes while the Stop waits came before it, so the
  Stop still stops Keiko.
- A Stop whose lock was taken over before it could close it does not act either and asks to be
  pressed again.
- A start whose command line the system refused to run, that refused at once (for example while
  another start is busy), or that failed records nothing, so it never makes a waiting Stop think
  Keiko was restarted.
- When the installation fails, the folder has no Keiko to stop with. The start window then says so
  and that a Keiko opened from another folder is stopped there. A `Stop Keiko` after that stops the
  open Keiko as usual.

#### The Stop handoff

- A Stop that finds only the npm of an ended start holding the lock leaves a handoff
  (`system/keiko-npm-stop-handoff-<token>`, whose token carries the time the Stop was pressed) for
  as long as its stop runs. It renews the handoff every 15 seconds from a worker thread.
- A start that takes the lock watches every handoff at once, up to 90 seconds in all. Then it ends
  with exit code 1 and asks to start again.
- The start opens Keiko as soon as the last handoff is gone, unless one of those Stops was pressed
  at or after the start began. Then it opens nothing and says Keiko was stopped while it was being
  loaded.
- A handoff whose process number does not run, or whose entry does not change for 60 seconds on the
  start's own monotonic clock, belongs to a Stop that ended (its number was reused). The start
  removes it and goes on.
- With the handoff, the stop never lands on the Keiko that start opened.

#### The launch-order record

- A start that has launched Keiko passes the time at which it began to take its lock to Keiko's
  command line (`keiko start --launch-order <ms>`).
- Any other start of that data (the standalone folder package, a plain `keiko start`) is ordered by
  the time its command began.
- The lock's own entry names carry that time, and a Stop's entry the time it was pressed.
- The command line records the latest of these orders in Keiko's data folder (`~/.keiko-standalone`
  by default), which every package folder of the account shares. It does so under the lifecycle
  guard every start and stop of that data takes, so a start that finishes last never lowers a later
  start's order.
- A start that cannot read that record leaves it as it is, since it may hold a later order, and says
  its order was not recorded. A record that holds no order is replaced.
- A stop that cannot clear the record still stops Keiko and logs it.
- Every stop is `keiko stop --unless-launched-after <press>`. Under the same guard, a Stop pressed
  before a start that opened Keiko leaves Keiko open (it says so and asks to be pressed again),
  whichever package folder that start came from and whether it took a lock over meanwhile.

#### The wall-clock caveat

The times in the launch order and in the Stop entries are wall-clock milliseconds, the one clock
different folders can compare. A clock set back during a Stop's wait can make it stop a later
start's Keiko, or leave an earlier one open and ask to be pressed again.

#### When a later start installs again

A later start installs again when:

- the lockfile changed
- an earlier installation did not finish
- the installation record `node_modules/.keiko-npm-installed` is missing
- Keiko's command line is not installed, for example after `node_modules` was deleted

Keiko then runs `keiko start`.

### Managed outside the app

- The start declares Keiko managed outside the app, as the folder package does, whatever the
  computer's environment declares. So on Windows it sets up no gateway service and asks for no
  approval.
- Keiko offers no in-app update for a folder that npm installed into and asks no registry or GitHub
  for one. Its update check reports the installation as managed outside the app.
- A new version arrives as a new folder.

### Coding Workbench on macOS and Windows x64

On macOS and on Windows x64 npm installs the coding runtime package for the computer, the same one
a global npm installation uses, so the Coding Workbench is available in this form on both (Windows
since Keiko 1.5.5, #4068). On Windows a coding run needs no service and no administrator rights.

### Qualification

The qualification (`scripts/testing/qualify-npm-folder-package.mjs`) starts the package the way a
person does, through `Start Keiko.command` or `Start Keiko.cmd` in a folder whose path holds a
space. It proves that:

- the first start installs and exits 0
- `/api/health` reports exactly the release version
- the installation record matches the shipped lockfile
- the folder gained nothing outside `node_modules`
- a second start installs nothing
- the Coding runtime package is present where the release declares one (and the Activity Log names
  it missing where the release declares none, as `managed-runtime-package-missing` or, from a Keiko
  before that distinction, as `npm-runtime-package-missing`)
- the stop file ends Keiko with no process of the folder left

It uses no model, no gateway and no browser.

### Build A Package

The builder takes the Node.js runtime and the Keiko version from a portable release archive and
resolves the lockfile against the public npm registry. Build it once the release is published and
npm reports its version.

```bash
gh release download v<version> --repo oscharko-dev/Keiko \
  --pattern keiko-windows-x64.zip --pattern windows-x64-SHA256SUMS.txt

node scripts/build-standalone-npm-package.mjs \
  --target windows-x64 \
  --archive keiko-windows-x64.zip \
  --sha256sums windows-x64-SHA256SUMS.txt \
  --out-dir out
```

- The result is `out/keiko-windows-x64.npm.zip` and its `.sha256`.
- An unverified archive is refused.
- A lockfile is refused if it does not install exactly that Keiko version or names a downloaded
  package without a sha512 integrity from the public registry.
- The build sees no npm configuration of the person who runs it.
- `--config` and `--api-key-env` work as for the
  [folder package](standalone-folder-package.md#prepare-a-package-for-a-team) and write
  `keiko-<target>.npm-team.zip`.

### Verify A Package

```bash
shasum -a 256 -c keiko-windows-x64.npm.zip.sha256
unzip -p keiko-windows-x64.npm.zip Keiko/system/npm-package.json
```

`npm-package.json` names the target, the Keiko version, the portable archive the Node.js runtime
came from and the SHA-256 of the shipped lockfile.
