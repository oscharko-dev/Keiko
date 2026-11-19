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
  system/native/usearch.node                the Knowledge Pod search index, from the release archive
  system/keiko-npm.mjs                      start, stop and the administrator's access step
  system/Zugang speichern.command | .cmd    the administrator's access step
  system/npm-package.json                   target, version, source archive and lockfile digests
```

The Node.js runtime and the native search index of Knowledge Pods are taken from the verified
portable release archive of the same Keiko version; every file the folder keeps is byte for byte
the archive's, and the Node.js runtime is the signed nodejs.org build. The folder leaves out what
neither Node.js nor npm runs, because `npm ci --ignore-scripts` compiles nothing: the C headers
(`system/node/include`), the manuals and documentation (`system/node/share`) and the release's
CHANGELOG.md and README.md. It keeps `bin`, `lib` with npm and corepack (on Windows `node.exe`,
`npm*`, `npx*` and `node_modules`), LICENSE, NOTICE and NODE_RUNTIME_SOURCE.json. That is about
11.6 MB of the 61 MB Node.js runtime of a macOS package, packed. The standalone folder package ships
the payload unchanged and keeps all of it. Keiko finds the search index next
to that runtime, as it does in the portable payload, so Knowledge Pods search with their index. The
only programs that run at a double-click are the system shell and that Node.js binary, and npm writes
no download mark on what it installs.

The first start runs `npm ci --ignore-scripts` with the folder as its `--prefix` and
`--workspaces=false`, so npm installs into this folder even when it lies inside another npm project
or workspace, and never changes that project. npm installs exactly the versions in
`package-lock.json` and checks every package against its sha512 integrity; no install script runs.
The command line also fixes what an inherited `npm_config_*` variable or npm configuration could
change: no dry run, no lockfile-only run, no global installation, the hoisted layout, and every
production, optional and peer package (an inherited `omit=optional` would leave out the Coding
runtime). After npm ends successfully, the start checks that every package the lockfile names for
this computer is installed in its version; if one is missing, it records nothing as installed,
names the package and keeps Keiko closed, so the next start installs again. An optional package
with `engines` npm may leave out for this Node.js is not counted, except the Coding runtime. Only
the packages npm installs here are counted: those the folder's package reaches through packages
meant for this computer, so an optional package of another computer and the packages only it
needs, nested or hoisted, are not.

Before npm runs, the start refuses an `npm-shrinkwrap.json` in the folder, which npm would install
instead of `package-lock.json`, and a `node_modules` that is a link, a junction, a file or another
account's folder, because `npm ci` first empties `node_modules` and would empty the folder a link
points to.

The lockfile is resolved against the public registry. The folder's `.npmrc` may name one other
registry with a single `registry=` line; npm then loads the same packages from there (npm replaces
the registry host and keeps every checksum), and a `registry` inherited from an `npm_config_*`
variable cannot override it. A scoped `@scope:registry` line, or `registry` named twice, is refused
before npm runs, because it would send packages of that scope elsewhere. So is every line npm would
ignore and answer with the public registry: another spelling such as `REGISTRY=`, a list
(`registry[]=`), a `registry` inside a `[section]`, and an address that is no http or https URL.
The line may be quoted and may use `${NAME}` for an environment variable, as npm allows. Without an
`.npmrc`, npm follows the person's own npm configuration, if there is one, and otherwise the public
registry.

Each installation gets its own npm cache, `.keiko-standalone/npm-cache-<random>`, which is removed
when it ends; an npm cache that already exists there is never touched. npm's log lies in
`.keiko-standalone/npm-logs`, and a failed installation names its log; an `npm-logs` that is a
link, a file or another account's folder is refused before npm writes; one that the start of another
package folder sharing the data folder made a moment before is used. Both are set on npm's command
line so that no `npm_config_*` variable moves them. Keiko's data folder is `.keiko-standalone` in the
person's user folder, the same data folder as the folder package, so replacing the folder keeps
chats, settings and credentials. A `KEIKO_STATE_DIR` outside the user folder is refused before
anything is written.

A second start while the first is still installing or opening Keiko starts no second installation:
it says that another start is opening Keiko and that its window says whether Keiko opened. When
the lock is held but its start does not renew (its window was closed during the installation and
only npm still runs), no window reports that installation and nothing can open Keiko, so the second
start says so, waits up to 10 minutes for that npm to end, takes the lock and then installs and
opens Keiko as a normal start; if that npm is still running after the 10 minutes, the start ends
with exit code 1 and asks to start Keiko again in a minute. A lock that starts closing during that wait is waited
for like any closing lock. Every start keeps the folder's installation lock
(`system/keiko-npm-install.lock`) until Keiko is open, also one that installs nothing. `Stop Keiko`
meanwhile is recorded in that lock: the start then does not open Keiko, or stops it again right
after it opened, also when Keiko reported a failure as it opened. It carries the Stop out before it
lets go of the lock, so no other start opens Keiko in between. When the installation fails, the
folder has no Keiko to stop with: the start window then says so and that a Keiko opened from
another folder is stopped there. A `Stop Keiko` after that stops the open Keiko as usual. Before the start lets go of the lock it
closes it: a `Stop Keiko` that the lock accepted is carried out first, and one that comes after the
lock closed is not recorded: it waits until that start has let go, takes the lock itself, closes it
and only then stops the open Keiko, so no start opens Keiko between its decision and its effect and
it can never stop the Keiko a later start opened (if the lock stays held for 90 seconds it says so
and does not act). A lock a Stop takes is born closed (its closing entry arrives in the same rename), so a start that watches it never takes that Stop for a start that opens Keiko. A start that has launched Keiko passes the time at which it began to take its lock to Keiko's command line (`keiko start --launch-order <ms>`), and any other start of that data (the standalone folder package, a plain `keiko start`) is ordered by the time its command began; the lock's own entry names carry that time, and a Stop's entry the time it was pressed. The command line records the latest of these orders in Keiko's data folder (`~/.keiko-standalone` by default), which every package folder of the account shares, under the lifecycle guard every start and stop of that data takes, so a start that finishes last never lowers a later start's order. A start that cannot read that record leaves it as it is, since it may hold a later order, and says its order was not recorded; a record that holds no order is replaced. A stop that cannot clear the record still stops Keiko and logs it. Every stop is `keiko stop --unless-launched-after <press>`: under the same guard, a Stop pressed before a start that opened Keiko leaves Keiko open (it says so and asks to be pressed again), whichever package folder that start came from and whether it took a lock over meanwhile. A Stop is recorded only in the lock of a start that began before it was pressed, and a start carries out only Stops pressed after it began. A start whose command line the system refused to run, that refused at once (for example while another start is busy), or that failed records nothing, so it never makes a waiting Stop think Keiko was restarted. A start that held the lock at the press and finishes while the Stop waits came before it, so the Stop still stops Keiko. The times are wall-clock milliseconds, the one clock different folders can compare: a clock set back during a Stop's wait can make it stop a later start's Keiko, or leave an earlier one open and ask to be pressed again. Every stop is carried out while the one
who runs it owns the lock; a Stop that finds only the npm of an ended start holding the lock leaves a handoff
(`system/keiko-npm-stop-handoff-<token>`, whose token carries the time the Stop was pressed) for as long as its stop runs and renews it every 15 seconds from a worker thread. A
start that takes the lock watches every handoff at once (up to 90 seconds in all, then it ends with exit code 1 and asks to start again)
and opens Keiko as soon as the last one is gone, unless one of those Stops was pressed at or after the start began: then it opens nothing and says Keiko was stopped while it was being loaded. A handoff whose process number does not run, or whose entry does not change for 60 seconds on the start's
own monotonic clock, belongs to a Stop that ended (its number was reused): the start removes it and goes on. A start whose lock
was taken over while it closed it carries out no Stop request, confirmed or provisional, and ends with a plain message. A start
that watches an orphaned installation checks, once the renewal is seen, that the renewing start is still in the lock and has not
closed it; otherwise it waits for the closing lock like any other. With the handoff, the stop never lands on the Keiko that start
opened. A Stop whose lock was taken over before it could close it
does not act either and asks to be pressed again. If a start that began before the Stop was pressed wins the lock first, the Stop is recorded in that start's lock
instead and that start, which does not leave Keiko open, carries it out; the Stop does not act itself. A start that began after
the press is left to open Keiko. A
start pressed while a Stop holds the closed lock waits for that Stop (up to 90 seconds) and then opens
Keiko, so the button pressed last decides; when that lock is still closing after the 90 seconds, nothing opens Keiko for the start,
so it ends with exit code 1 and says that Keiko is still being closed and to start again, never that another window opens it. A start that finds its lock taken over by another start ends with a plain message
before it writes the installed marker or starts Keiko. Whether a lock is still held is told by renewal, never by a clock: every holder
rewrites its own entry every 15 seconds: the start's process (from a worker thread, also while it
waits for npm) its `owner-` entry, and npm's process only its own `npm-` entry. npm never rewrites
the start's entry; it only checks that it is still there, so a start whose window was closed stops
changing its entry whatever npm does. A start that finds a lock none of whose entries has a running process number takes it over
at once. If an entry's process number runs, the start watches the lock's entries for up to 60
seconds on its own monotonic clock: any entry that changes means the lock is held (the start then
says another start is opening Keiko, after up to one renewal interval), and none that changes means
the holder ended and its process number was reused by another process, or the holder is frozen, and
the lock is taken over. No timestamp in a file and no wall-clock jump (a computer that slept, a
corrected clock) decides this. The one remaining limit: a holder that is frozen for longer than that
minute and then resumes can overlap with the start that took over for at most one renewal interval;
the first renewal of the resumed npm finds its entry gone and ends it. A `Stop Keiko` is recorded
only in a lock whose start's own entry runs and renews: if the start ended while its npm still runs,
the Stop is not recorded and stops Keiko directly. npm's own process holds the lock as well while it
installs, with its own entry, and a start window closed during an installation leaves the lock to
that npm until it ends; no second npm installs beside it. npm runs only as part of the lock generation of the start
that ran it: before it does anything, npm's process ends with the reason when the lock is gone,
when the start's entry is not in it, or when another start's lock replaced it. A running npm ends at
once, without writing further, when it finds its own entry or the start's gone at a renewal check (only a
takeover of a frozen holder can cause that). A renewal rewrites the entry's timestamp in place and
never empties it, so a failed renewal keeps the last valid timestamp. Each start and
stop says how it ended. A later start installs again when the lockfile changed, an earlier
installation did not finish, the installation record `node_modules/.keiko-npm-installed` is
missing or Keiko's command line is not installed, for example after `node_modules` was deleted.
Keiko then runs `keiko start`.

The start declares Keiko managed outside the app, as the folder package does, whatever the
computer's environment declares, so on Windows it sets up no gateway service and asks for no
approval. Keiko offers no in-app update for a folder that npm installed into and asks no registry or
GitHub for one: its update check reports the installation as managed outside the app. A new version
arrives as a new folder.

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

## What This Form Does Not Do

- **No Coding Workbench on Windows.** The Windows coding runtime is published only inside the
  portable release archive, not as an npm package, so npm installs none and the Workbench reports
  Coding as unavailable, even where an administrator installed the gateway service. Chat,
  Knowledge Pods, Jira and the Editor work. On macOS npm installs the coding runtime package for
  the computer, the same one a global npm installation uses.
- **No default project.** The package folder holds Keiko's program files and, in a team package, the
  gateway token, so Keiko never offers it as the folder of the Coding Workbench, Files or Git and
  refuses it for them; the person chooses a folder. Chat works at once and needs no folder.
  `keiko.config.json`, `.npmrc`, the sealed `*.vault` stores and the data folder `.keiko-standalone`
  stay unreadable for the model even inside a chosen folder.
- **No in-app update.** A new version arrives as a new folder.
- **One Keiko per computer account,** on loopback port 1983, as for the folder package.
- **No release asset.** A release carries the
  [standalone folder packages](standalone-folder-package.md#download-from-a-release), not this
  one. Its lockfile needs the integrity the npm registry reports for the released version. npm
  learns that version only after the release publisher has published the immutable GitHub
  release, so this package is built from the published release.

## Build A Package

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

The result is `out/keiko-windows-x64.npm.zip` and its `.sha256`. An unverified archive is refused,
and so is a lockfile that does not install exactly that Keiko version or names a downloaded package
without a sha512 integrity from the public registry. The build sees no npm configuration of the person who
runs it. `--config` and `--api-key-env` work as for the
[folder package](standalone-folder-package.md#prepare-a-package-for-a-team) and write
`keiko-<target>.npm-team.zip`.

## Prepare A Package For A Team

An administrator can prepare the folder once, so that nobody in the team enters anything:

1. **Registry.** If the organization loads npm packages through its own registry, put its
   `.npmrc` next to `Start Keiko`. Without one, npm follows each person's own npm configuration
   and otherwise uses the public registry. The file is ordinary npm configuration; if it carries a
   registry access token, it is as confidential as `keiko.config.json`.
2. **Gateway.** Start Keiko from the folder and complete **Gateway Setup** with the team's gateway
   address and token. Keiko verifies the gateway and its models. Stop Keiko. A configuration an
   earlier Keiko saved does not mark its models, so complete Gateway Setup once more before step 3.
3. **Access for everyone.** Double-click `system/Zugang speichern.command` (macOS) or
   `system\Zugang speichern.cmd` (Windows) and paste the token; it is not shown. The step reads the
   configuration Gateway Setup saved and replaces the keys sealed on this computer for the gateway
   connection Gateway Setup verified (the models it set up, and the voice provider and the reranker it
   wired on that connection, each marked `"credentialOrigin": "gateway-connection"`) with the
   token. A voice provider whose key was rotated alone has no mark, however its capability reads,
   and is refused like a reranker with its own key. A
   model or reranker whose key is sealed and that has its own address, header or key is not that
   connection: the step refuses before it asks for the token and names it, so one token never goes
   to another service. A key written into the file as `apiKey` stays as it is, so write that
   connection's own key into the file instead. It
   also refuses a model without an id or an address, and a key Keiko takes from an environment
   variable of the administrator's computer (`KEIKO_MODEL_<ID>_API_KEY`, `KEIKO_RERANKER_API_KEY`,
   `KEIKO_DEFAULT_API_KEY`), which Gateway Setup keeps out of the file: unset the variable, enter
   the key in Gateway Setup and run the step again. The
   step writes `keiko.config.json` next to `Start Keiko` as one complete file, replacing an older one
   only when the new one is written; it is readable by its owner only. On Windows the step removes
   the permissions the folder hands down and grants the file to the account that runs it alone
   (`icacls` from Windows' System32) before the token is written, and writes no token when that
   fails. It refuses to run while `KEIKO_CONFIG_FILE` or `KEIKO_UI_DATA_DIR`
   names another configuration, because the file would not be the one Keiko starts with.
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
shasum -a 256 -c keiko-windows-x64.npm.zip.sha256
unzip -p keiko-windows-x64.npm.zip Keiko/system/npm-package.json
```

`npm-package.json` names the target, the Keiko version, the portable archive the Node.js runtime
came from and the SHA-256 of the shipped lockfile.
